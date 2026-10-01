/* ============================================================
   AFINADOR DE VIOLÃO EM TEMPO REAL
   ============================================================
   Módulos:
   1. AudioCapture       - Captura do microfone (com filtro anti-aliasing)
   2. PitchDetector      - Detecção de frequência (MPM + downsampling + buffers reutilizados)
   3. NoteMapper         - Mapeamento frequência -> nota / corda
   4. WaveRenderer       - Renderização das ondas no Canvas
   5. TunerApp           - Orquestração principal
   ============================================================ */

// ===================== CONFIGURAÇÃO GLOBAL =====================
const CONFIG = {
  FFT_SIZE: 4096,
  TARGET_SAMPLE_RATE: 2000,
  LOWPASS_CUTOFF: 800,
  MIN_FREQ: 70,
  MAX_FREQ: 400,
  RMS_THRESHOLD: 0.01,
  PEAK_THRESHOLD_RATIO: 0.3,
  CLARITY_THRESHOLD: 0.85,
  SMOOTHING_NEW: 0.3,
  SMOOTHING_OLD: 0.7,
  SMOOTHING_DECAY: 0.95,
};

// ===================== CONSTANTES =====================
const STRINGS = [
  { note: "E2", freq: 82.41 },
  { note: "A2", freq: 110.0 },
  { note: "D3", freq: 146.83 },
  { note: "G3", freq: 196.0 },
  { note: "B3", freq: 246.94 },
  { note: "E4", freq: 329.63 },
];

const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F",
  "F#", "G", "G#", "A", "A#", "B",
];

// ⚠️ NÃO colocar código executável aqui antes das classes.
//    O bloco de teste do PitchDetector deve ficar NO FINAL do
//    arquivo, dentro do DOMContentLoaded, ou comentado.

// ===================== MÓDULO 1: CAPTURA DE ÁUDIO =====================
class AudioCapture {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.lowpassFilter = null;
    this.stream = null;
    this.source = null;
    this.buffer = null;
    this.isActive = false;
  }

  /**
   * Inicia a captura de áudio.
   *
   * ⚠️ IMPORTANTE (iOS Safari / Chrome mobile):
   * O AudioContext é criado no estado "suspended" por padrão em
   * navegadores mobile. Ele SÓ pode ser retomado dentro de um
   * "user gesture" (click, touch, keydown).
   *
   * Grafo de áudio:
   *   source (mic) → lowpassFilter (anti-aliasing) → analyser
   *
   * O filtro passa-baixa é essencial para que o downsampling
   * no PitchDetector não introduza aliasing. Frequências acima
   * de ~800 Hz são atenuadas antes de serem decimadas.
   */
  async start() {
    if (this.isActive) return;

    try {
      // 1. Pedir permissão do microfone
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // 2. Criar o AudioContext
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();

      // 3. RESUME — essencial em iOS Safari
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      if (this.audioContext.state !== "running") {
        await this.waitForRunning(this.audioContext, 1000);
      }

      if (this.audioContext.state !== "running") {
        throw new Error(
          `AudioContext não pôde ser iniciado (estado: ${this.audioContext.state})`,
        );
      }

      // 4. Filtro passa-baixa anti-aliasing (BiquadFilterNode)
      //    — corta frequências acima de LOWPASS_CUTOFF para que
      //      o downsampling no PitchDetector não cause aliasing.
      this.lowpassFilter = this.audioContext.createBiquadFilter();
      this.lowpassFilter.type = "lowpass";
      this.lowpassFilter.frequency.value = CONFIG.LOWPASS_CUTOFF;
      this.lowpassFilter.Q.value = 0.7; // Butterworth-like

      // 5. Analyser
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;

      // 6. Conectar grafo: source → lowpass → analyser
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.source.connect(this.lowpassFilter);
      this.lowpassFilter.connect(this.analyser);

      this.buffer = new Float32Array(this.analyser.fftSize);
      this.isActive = true;
      return true;
    } catch (err) {
      console.error("Erro ao acessar microfone:", err);
      this.stop();
      throw err;
    }
  }

  waitForRunning(ctx, timeoutMs) {
    return new Promise((resolve) => {
      if (ctx.state === "running") return resolve();

      const start = Date.now();
      const check = () => {
        if (ctx.state === "running") return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
  }

  async suspend() {
    if (this.audioContext && this.audioContext.state === "running") {
      try {
        await this.audioContext.suspend();
      } catch (e) {
        console.warn("suspend() falhou:", e);
      }
    }
  }

  async resume() {
    if (this.audioContext && this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
        if (this.audioContext.state !== "running") {
          await this.waitForRunning(this.audioContext, 500);
        }
      } catch (e) {
        console.warn("resume() falhou:", e);
      }
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
    this.lowpassFilter = null;
    this.source = null;
    this.isActive = false;
  }

  getSamples() {
    if (!this.analyser || !this.buffer) return null;
    if (this.audioContext && this.audioContext.state !== "running") {
      return null;
    }
    this.analyser.getFloatTimeDomainData(this.buffer);
    return this.buffer;
  }

  getSampleRate() {
    return this.audioContext ? this.audioContext.sampleRate : 44100;
  }
}

// ===================== MÓDULO 2: DETECÇÃO DE PITCH (MPM OTIMIZADO) =====================
/**
 * Detector de pitch usando MPM (McLeod Pitch Method) com downsampling
 * e buffers pré-alocados.
 *
 * ══════════════════════════════════════════════════════════════════
 * OTIMIZAÇÕES APLICADAS
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. DOWNSAMPLING (44100 Hz → ~2000 Hz)
 *    Após o filtro passa-baixa do AudioCapture, o sinal é decimado
 *    por um fator inteiro. Isso reduz drasticamente o maxLag:
 *      - ANTES: maxLag = 44100 / 70 ≈ 630
 *      - DEPOIS: maxLag = 2000 / 70 ≈ 28
 *    → ~22× menos lags por frame.
 *
 *    IMPORTANTE: o downsampling só é seguro porque o filtro
 *    passa-baixa em 800 Hz remove as frequências que sofreriam
 *    aliasing (acima de Nyquist/2 = 1000 Hz).
 *
 * 2. BUFFERS REUTILIZADOS
 *    Em vez de alocar Float32Array dentro de detect() a cada frame,
 *    pré-alocamos no construtor e reutilizamos. Isso elimina
 *    ~60 alocações/segundo e reduz pressão no GC.
 *
 * 3. MPM (McLeod Pitch Method)
 *    Usa NSDF (Normalized Square Difference Function) que é
 *    robusta contra harmônicos e decaimento de amplitude:
 *      n'(τ) = 2 * ACF(τ) / m(τ)
 *
 * ══════════════════════════════════════════════════════════════════
 * CUSTO COMPUTACIONAL
 * ══════════════════════════════════════════════════════════════════
 *   ANTES:  4096 × 630 ≈ 2.6M multiplicações/frame
 *   DEPOIS:  ~186 ×  28 ≈ 5.2k multiplicações/frame
 *   → ~500× menos operações 🚀
 *
 *   @60fps: 2.6M × 60 = 156M ops/s → 5.2k × 60 = 312k ops/s
 */
class PitchDetector {
  constructor() {
    // Fator de downsampling calculado na primeira chamada
    // (depende do sampleRate real do dispositivo)
    this.downsampleFactor = 1;
    this.effectiveSampleRate = 44100;
    this.initialized = false;

    // Buffers pré-alocados (reutilizados a cada frame).
    // Tamanhos generosos para acomodar qualquer sampleRate.
    // MAX_DOWNSAMPLED_SIZE = 4096 / 22 ≈ 187 (mas deixamos folga)
    this.MAX_DOWNSAMPLED_SIZE = 512;
    this.MAX_LAG = 64; // para 2000 Hz / 70 Hz ≈ 28 (dobramos por segurança)

    this.downsampled = new Float32Array(this.MAX_DOWNSAMPLED_SIZE);
    this.correlations = new Float32Array(this.MAX_LAG);
    this.nsdf = new Float32Array(this.MAX_LAG);
  }

  /**
   * Inicializa os parâmetros dependentes do sampleRate.
   * Chamado apenas uma vez, na primeira detecção.
   */
  initialize(sampleRate) {
    this.downsampleFactor = Math.max(
      1,
      Math.round(sampleRate / CONFIG.TARGET_SAMPLE_RATE),
    );
    this.effectiveSampleRate = sampleRate / this.downsampleFactor;

    // Recalcular tamanhos máximos necessários
    const maxLagNeeded = Math.ceil(
      this.effectiveSampleRate / CONFIG.MIN_FREQ,
    );

    // Se os buffers pré-alocados forem pequenos, realocar
    if (maxLagNeeded > this.MAX_LAG) {
      this.MAX_LAG = maxLagNeeded + 4;
      this.correlations = new Float32Array(this.MAX_LAG);
      this.nsdf = new Float32Array(this.MAX_LAG);
    }

    this.initialized = true;
  }

  /**
   * Downsampling por decimação.
   * Escreve no buffer reutilizável this.downsampled.
   * Retorna o número de amostras efetivamente escritas.
   */
  downsample(inputBuffer, factor) {
    const outputLength = Math.min(
      Math.floor(inputBuffer.length / factor),
      this.MAX_DOWNSAMPLED_SIZE,
    );

    for (let i = 0; i < outputLength; i++) {
      this.downsampled[i] = inputBuffer[i * factor];
    }

    return outputLength;
  }

  /**
   * Detecta a frequência fundamental.
   *
   * @param {Float32Array} rawBuffer - Amostras originais (~44.1 kHz)
   * @param {number} rawSampleRate - Taxa de amostragem original
   * @returns {number|null} Frequência detectada em Hz, ou null
   */
  detect(rawBuffer, rawSampleRate) {
    // Inicialização preguiçosa (apenas na primeira chamada)
    if (!this.initialized) {
      this.initialize(rawSampleRate);
    }

    // ============ 1. RMS no buffer ORIGINAL ============
    //    Usar o buffer original mantém consistência com a UI,
    //    que exibe o nível de sinal capturado.
    let rms = 0;
    for (let i = 0; i < rawBuffer.length; i++) {
      rms += rawBuffer[i] * rawBuffer[i];
    }
    rms = Math.sqrt(rms / rawBuffer.length);
    if (rms < CONFIG.RMS_THRESHOLD) return null;

    // ============ 2. DOWNSAMPLING ============
    //    O filtro passa-baixa já foi aplicado no AudioCapture
    //    (BiquadFilterNode antes do analyser), então aqui só
    //    precisamos decimar.
    const size = this.downsample(rawBuffer, this.downsampleFactor);
    const buffer = this.downsampled;

    // ============ 3. NSDF (Normalized Square Difference Function) ============
    const minLag = Math.floor(this.effectiveSampleRate / CONFIG.MAX_FREQ);
    const maxLag = Math.min(
      Math.floor(this.effectiveSampleRate / CONFIG.MIN_FREQ),
      Math.floor(size / 2),
    );

    // Reutilizar buffer de correlações (zerar apenas o trecho usado)
    const nsdf = this.nsdf;
    for (let tau = 0; tau < maxLag; tau++) {
      let acf = 0;
      let energy = 0;
      const limit = size - tau;
      for (let i = 0; i < limit; i++) {
        const a = buffer[i];
        const b = buffer[i + tau];
        acf += a * b;
        energy += a * a + b * b;
      }
      // n'(τ) = 2 * ACF(τ) / m(τ)
      nsdf[tau] = energy > 0 ? (2 * acf) / energy : 0;
    }

    // ============ 4. ENCONTRAR PICO PRINCIPAL ============
    let pos = minLag;
    while (pos < maxLag - 1 && nsdf[pos] > 0) pos++;
    while (pos < maxLag - 1 && nsdf[pos] <= 0) pos++;

    if (pos >= maxLag - 1) return null;

    let maxPos = pos;
    let maxVal = nsdf[pos];

    for (let i = pos; i < maxLag - 1; i++) {
      if (nsdf[i] > nsdf[i - 1] && nsdf[i] >= nsdf[i + 1]) {
        if (nsdf[i] > maxVal) {
          maxVal = nsdf[i];
          maxPos = i;
        }
      }
    }

    // Verificar clareza mínima
    if (maxVal < CONFIG.CLARITY_THRESHOLD * CONFIG.PEAK_THRESHOLD_RATIO) {
      return null;
    }

    // ============ 5. INTERPOLAÇÃO PARABÓLICA ============
    //    Ajusta uma parábola em torno do pico para precisão
    //    sub-amostra:
    //      x_peak = x - b / (2a)
    let refinedPos = maxPos;
    if (maxPos > 0 && maxPos < maxLag - 1) {
      const y1 = nsdf[maxPos - 1];
      const y2 = nsdf[maxPos];
      const y3 = nsdf[maxPos + 1];
      const a = (y1 + y3 - 2 * y2) / 2;
      const b = (y3 - y1) / 2;
      if (a !== 0) {
        refinedPos = maxPos - b / (2 * a);
      }
    }

    // ============ 6. FREQUÊNCIA ============
    //    IMPORTANTE: usar effectiveSampleRate, não rawSampleRate!
    const freq = this.effectiveSampleRate / refinedPos;

    if (freq < CONFIG.MIN_FREQ || freq > CONFIG.MAX_FREQ) return null;

    return freq;
  }
}

// ===================== MÓDULO 3: MAPEAMENTO DE NOTAS =====================
class NoteMapper {
  /**
   * Converte frequência para nota musical mais próxima.
   * Fórmula MIDI:
   *   n = 12 * log2(f / 440) + 69
   */
  static freqToNote(freq) {
    const midi = 12 * Math.log2(freq / 440) + 69;
    const roundedMidi = Math.round(midi);
    const cents = Math.round((midi - roundedMidi) * 100);
    const noteIndex = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;
    return {
      note: NOTE_NAMES[noteIndex] + octave,
      noteName: NOTE_NAMES[noteIndex],
      octave: octave,
      cents: cents,
      midi: roundedMidi,
    };
  }

  /**
   * Calcula o desvio em cents entre a frequência detectada
   * e a frequência alvo.
   * Fórmula: cents = 1200 * log2(f_detectada / f_alvo)
   */
  static centsDeviation(freq, targetFreq) {
    if (!freq || !targetFreq || freq <= 0) return 0;
    return Math.round(1200 * Math.log2(freq / targetFreq));
  }

  /**
   * Encontra a corda mais próxima da frequência detectada,
   * PRIORIZANDO a nota cromática.
   *
   * Se o usuário tocar um E2 a 78 Hz (meio tom abaixo), comparar
   * por cents com todas as cordas pode escolher A2 (110 Hz) que
   * está a +600 cents, em vez de E2 (82.41 Hz) que está a -95 cents.
   *
   * SOLUÇÃO:
   *   1. Encontra a nota cromática mais próxima (arredondamento MIDI)
   *   2. Prioriza cordas com a MESMA nota cromática
   *   3. Se não houver, cai para a mais próxima por cents
   */
  static findClosestString(freq) {
    if (!freq) return STRINGS[0];

    const detected = NoteMapper.freqToNote(freq);
    const detectedNote = detected.note;

    const exactMatch = STRINGS.find((s) => s.note === detectedNote);
    if (exactMatch) return exactMatch;

    let closest = STRINGS[0];
    let minDiff = Infinity;
    for (const s of STRINGS) {
      const diff = Math.abs(1200 * Math.log2(freq / s.freq));
      if (diff < minDiff) {
        minDiff = diff;
        closest = s;
      }
    }
    return closest;
  }
}

// ===================== MÓDULO 4: RENDERIZAÇÃO DE ONDAS =====================
class WaveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  /**
   * Renderiza as ondas sobrepostas com janela de tempo fixa (20 ms).
   *
   * y_alvo(t) = A * sin(2π * f_alvo * t)
   * y_atual(t) = A_real * sin(2π * f_detectada * t + φ)
   *
   * Janela fixa faz com que cada corda mostre um número diferente
   * de ciclos visíveis:
   *   E2 -> ~1.65 ciclos | A2 -> ~2.20 | D3 -> ~2.94
   *   G3 -> ~3.92       | B3 -> ~4.94 | E4 -> ~6.59
   */
  render(targetFreq, detectedFreq, rms, sampleBuffer, sampleRate) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const centerY = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Fundo gradiente
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(10, 10, 20, 0.9)");
    grad.addColorStop(0.5, "rgba(15, 15, 30, 0.9)");
    grad.addColorStop(1, "rgba(10, 10, 20, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Linha central
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(W, centerY);
    ctx.stroke();

    // Grade vertical
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    for (let i = 0; i <= 8; i++) {
      const x = (W / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // ---- ONDA ALVO (VERDE) ----
    if (targetFreq && targetFreq > 0) {
      const amplitude = H * 0.35;
      const windowTime = 0.02;
      const numPoints = W;

      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 230, 118, 0.9)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(0, 230, 118, 0.4)";
      ctx.shadowBlur = 10;

      for (let px = 0; px < numPoints; px++) {
        const t = (px / numPoints) * windowTime;
        const y = amplitude * Math.sin(2 * Math.PI * targetFreq * t);
        const canvasY = centerY - y;
        if (px === 0) ctx.moveTo(px, canvasY);
        else ctx.lineTo(px, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(0, 230, 118, 0.9)";
      ctx.fillText(targetFreq.toFixed(2) + " Hz", W - 12, 17);
    }

    // ---- ONDA ATUAL (AZUL/LARANJA) ----
    if (detectedFreq && detectedFreq > 0 && sampleBuffer) {
      const amplitude = H * 0.35;

      let color, shadowColor;
      if (targetFreq) {
        const cents = 1200 * Math.log2(detectedFreq / targetFreq);
        if (Math.abs(cents) < 5) {
          color = "rgba(0, 230, 118, 0.9)";
          shadowColor = "rgba(0, 230, 118, 0.4)";
        } else if (Math.abs(cents) < 20) {
          color = "rgba(0, 198, 255, 0.9)";
          shadowColor = "rgba(0, 198, 255, 0.4)";
        } else {
          color = "rgba(255, 165, 0, 0.9)";
          shadowColor = "rgba(255, 165, 0, 0.4)";
        }
      } else {
        color = "rgba(0, 198, 255, 0.9)";
        shadowColor = "rgba(0, 198, 255, 0.4)";
      }

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 10;

      const buffer = sampleBuffer;
      const samplesInWindow = Math.min(
        buffer.length,
        Math.floor(sampleRate * 0.02),
      );

      let maxVal = 0.001;
      for (let i = 0; i < samplesInWindow; i++) {
        maxVal = Math.max(maxVal, Math.abs(buffer[i]));
      }

      for (let px = 0; px < W; px++) {
        const idx = Math.floor((px / W) * samplesInWindow);
        const sample = buffer[idx] / maxVal;
        const y = sample * amplitude;
        const canvasY = centerY - y;
        if (px === 0) ctx.moveTo(px, canvasY);
        else ctx.lineTo(px, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.textAlign = "right";
      ctx.fillStyle = color;
      ctx.fillText(detectedFreq.toFixed(2) + " Hz", W - 12, H - 12);
    }

    // ---- LEGENDA ----
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(0, 230, 118, 0.8)";
    ctx.fillRect(12, 12, 16, 3);
    ctx.fillStyle = "rgba(0, 230, 118, 0.6)";
    ctx.fillText("Onda Alvo (ideal)", 34, 17);

    ctx.fillStyle = "rgba(0, 198, 255, 0.8)";
    ctx.fillRect(12, 30, 16, 3);
    ctx.fillStyle = "rgba(0, 198, 255, 0.6)";
    ctx.fillText("Onda Capturada", 34, 35);
  }
}

// ===================== MÓDULO 5: APLICAÇÃO PRINCIPAL =====================
class TunerApp {
  constructor() {
    // Elementos DOM
    this.micBtn = document.getElementById("micBtn");
    this.autoBtn = document.getElementById("autoBtn");
    this.stringBtns = document.querySelectorAll(".string-btn");
    this.noteValue = document.getElementById("noteValue");
    this.freqValue = document.getElementById("freqValue");
    this.centsValue = document.getElementById("centsValue");
    this.indicator = document.getElementById("indicator");
    this.statusText = document.getElementById("statusText");
    this.canvas = document.getElementById("waveCanvas");

    // Módulos
    this.audio = new AudioCapture();
    this.detector = new PitchDetector();
    this.renderer = new WaveRenderer(this.canvas);

    // Estado
    this.isRunning = false;
    this.autoMode = true;
    this.selectedString = STRINGS[0];
    this.currentFreq = 0;
    this.currentRms = 0;
    this.lastDetectedFreq = 0;
    this.animationId = null;
    this.smoothingFreq = 0;
    this.detectedNote = null;

    // Estado de visibilidade
    this.wasRunningBeforeHidden = false;

    this.bindEvents();
    this.renderIdle();
  }

  bindEvents() {
    // Botão do microfone
    this.micBtn.addEventListener("click", () => this.toggleMic());

    this.autoBtn.addEventListener("click", () => {
      this.autoMode = !this.autoMode;
      this.autoBtn.classList.toggle("active", this.autoMode);
      this.autoBtn.textContent = this.autoMode ? "Automático" : "Manual";
      if (!this.autoMode) {
        if (this.lastDetectedFreq > 0) {
          const closest = NoteMapper.findClosestString(this.lastDetectedFreq);
          this.selectString(closest);
        } else {
          this.selectString(STRINGS[0]);
        }
      }
      this.updateStringButtons();
    });

    this.stringBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (this.autoMode) {
          this.autoMode = false;
          this.autoBtn.classList.remove("active");
          this.autoBtn.textContent = "Manual";
        }
        const note = btn.dataset.note;
        const str = STRINGS.find((s) => s.note === note);
        if (str) this.selectString(str);
      });
    });

    // Pausar em background (economia de bateria)
    document.addEventListener("visibilitychange", () => {
      this.handleVisibilityChange();
    });

    // Alguns navegadores disparam "pagehide" em vez de
    // "visibilitychange" ao trocar de app no mobile.
    window.addEventListener("pagehide", () => {
      if (this.isRunning) {
        this.audio.suspend();
      }
    });
  }

  async handleVisibilityChange() {
    if (document.hidden) {
      if (this.isRunning) {
        this.wasRunningBeforeHidden = true;
        await this.audio.suspend();
        if (this.animationId) {
          cancelAnimationFrame(this.animationId);
          this.animationId = null;
        }
      }
    } else {
      if (this.wasRunningBeforeHidden && this.isRunning) {
        await this.audio.resume();
        this.wasRunningBeforeHidden = false;
        if (!this.animationId) {
          this.loop();
        }
      }
    }
  }

  selectString(str) {
    this.selectedString = str;
    this.updateStringButtons();

    if (!this.isRunning) {
      this.renderIdle();
    } else {
      const buffer = this.audio.getSamples();
      const sampleRate = this.audio.getSampleRate();
      this.renderer.render(
        this.selectedString.freq,
        this.currentFreq,
        this.currentRms,
        buffer,
        sampleRate,
      );
    }
  }

  updateStringButtons() {
    this.stringBtns.forEach((btn) => {
      btn.classList.toggle(
        "active",
        btn.dataset.note === this.selectedString.note,
      );
    });
  }

  async toggleMic() {
    if (this.isRunning) {
      this.stop();
    } else {
      await this.start();
    }
  }

  async start() {
    try {
      this.micBtn.textContent = "⏳ Iniciando...";
      this.micBtn.disabled = true;
      await this.audio.start();
      this.isRunning = true;
      this.micBtn.textContent = "⏹ Parar Microfone";
      this.micBtn.classList.add("active");
      this.micBtn.disabled = false;
      this.statusText.textContent = "Ouvindo...";
      this.statusText.className = "status-text idle";
      this.loop();
    } catch (err) {
      this.micBtn.textContent = "🎤 Ativar Microfone";
      this.micBtn.disabled = false;
      this.statusText.textContent = "Erro ao acessar microfone";
      this.statusText.className = "status-text sharp";
    }
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.audio.stop();
    this.micBtn.textContent = "🎤 Ativar Microfone";
    this.micBtn.classList.remove("active");
    this.statusText.textContent = "Aguardando áudio...";
    this.statusText.className = "status-text idle";
    this.currentFreq = 0;
    this.smoothingFreq = 0;
    this.detectedNote = null;
    this.wasRunningBeforeHidden = false;
    this.renderIdle();
    this.resetReadings();
  }

  resetReadings() {
    this.noteValue.textContent = "--";
    this.freqValue.textContent = "-- Hz";
    this.centsValue.textContent = "-- ¢";
    this.centsValue.className = "value cents";
    this.indicator.style.left = "50%";
    this.indicator.style.background = "#444";
    this.indicator.style.color = "#444";
  }

  renderIdle() {
    this.renderer.render(
      this.selectedString.freq,
      0,
      0,
      null,
      this.audio.getSampleRate() || 44100,
    );
  }

  loop() {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(() => this.loop());

    const buffer = this.audio.getSamples();
    if (!buffer) return;

    const sampleRate = this.audio.getSampleRate();

    // RMS
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) {
      rms += buffer[i] * buffer[i];
    }
    rms = Math.sqrt(rms / buffer.length);
    this.currentRms = rms;

    // Detectar frequência (MPM + downsampling)
    let detectedFreq = this.detector.detect(buffer, sampleRate);

    // Suavização temporal
    if (detectedFreq) {
      if (this.smoothingFreq === 0) {
        this.smoothingFreq = detectedFreq;
      } else {
        this.smoothingFreq =
          this.smoothingFreq * CONFIG.SMOOTHING_OLD +
          detectedFreq * CONFIG.SMOOTHING_NEW;
      }
      this.lastDetectedFreq = this.smoothingFreq;
      this.detectedNote = NoteMapper.freqToNote(this.smoothingFreq);
    } else {
      this.smoothingFreq *= CONFIG.SMOOTHING_DECAY;
      if (this.smoothingFreq < 1) {
        this.smoothingFreq = 0;
        this.detectedNote = null;
      }
    }

    this.currentFreq = this.smoothingFreq;

    // Modo automático
    if (this.autoMode && this.currentFreq > 0) {
      const closest = NoteMapper.findClosestString(this.currentFreq);
      if (closest.note !== this.selectedString.note) {
        this.selectedString = closest;
        this.updateStringButtons();
      }
    }

    this.updateReadings(this.currentFreq, buffer, sampleRate);
  }

  updateReadings(freq, buffer, sampleRate) {
    const target = this.selectedString;

    if (freq && freq > 0) {
      const detected = this.detectedNote || NoteMapper.freqToNote(freq);
      const cents = NoteMapper.centsDeviation(freq, target.freq);

      this.noteValue.textContent = detected.note;
      this.freqValue.textContent = freq.toFixed(1) + " Hz";

      const centsStr = (cents > 0 ? "+" : "") + cents + " ¢";
      this.centsValue.textContent = centsStr;

      const noteMismatch = detected.note !== target.note;

      this.centsValue.className = "value cents";
      if (noteMismatch) {
        this.centsValue.classList.add(cents < 0 ? "flat" : "sharp");
      } else if (Math.abs(cents) < 5) {
        this.centsValue.classList.add("tuned");
      } else if (cents < 0) {
        this.centsValue.classList.add("flat");
      } else {
        this.centsValue.classList.add("sharp");
      }

      const clampedCents = Math.max(-50, Math.min(50, cents));
      const percent = ((clampedCents + 50) / 100) * 100;
      this.indicator.style.left = percent + "%";

      if (noteMismatch) {
        const dir = cents < 0 ? "▼" : "▲";
        const word = cents < 0 ? "Abaixo" : "Acima";
        this.statusText.textContent = `${dir} ${word} (${detected.note})`;
        this.statusText.className =
          "status-text " + (cents < 0 ? "flat" : "sharp");
        this.indicator.style.background = cents < 0 ? "#ffa500" : "#ff4b2b";
        this.indicator.style.color = cents < 0 ? "#ffa500" : "#ff4b2b";
      } else if (Math.abs(cents) < 5) {
        this.indicator.style.background = "#00e676";
        this.indicator.style.color = "#00e676";
        this.statusText.textContent = "✓ Afinado";
        this.statusText.className = "status-text tuned";
      } else if (cents < 0) {
        this.indicator.style.background = "#ffa500";
        this.indicator.style.color = "#ffa500";
        this.statusText.textContent = "▼ Abaixo";
        this.statusText.className = "status-text flat";
      } else {
        this.indicator.style.background = "#ff4b2b";
        this.indicator.style.color = "#ff4b2b";
        this.statusText.textContent = "▲ Acima";
        this.statusText.className = "status-text sharp";
      }
    } else {
      this.noteValue.textContent = target.note;
      this.freqValue.textContent = "-- Hz";
      this.centsValue.textContent = "-- ¢";
      this.centsValue.className = "value cents";
      this.indicator.style.left = "50%";
      this.indicator.style.background = "#444";
      this.indicator.style.color = "#444";
      this.statusText.textContent = "Aguardando som...";
      this.statusText.className = "status-text idle";
    }

    this.renderer.render(
      target.freq,
      freq,
      this.currentRms,
      buffer,
      sampleRate,
    );
  }
}

// ===================== INICIALIZAÇÃO =====================
document.addEventListener("DOMContentLoaded", () => {
  window.tunerApp = new TunerApp();

  // Teste opcional do PitchDetector 
   runPitchDetectorSelfTest();
});

/**
 * Teste de precisão do PitchDetector com senoides sintéticas.
 * Espera-se erro < 1 cent em todas as cordas.
 * Rodar apenas manualmente no console: runPitchDetectorSelfTest();
 */
function runPitchDetectorSelfTest() {
  const testFreqs = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];
  const sr = 44100;
  const detector = new PitchDetector();
  detector.initialize(sr);

  console.log("=== Teste do PitchDetector ===");
  testFreqs.forEach((f) => {
    const buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
    }
    const detected = detector.detect(buf, sr);
    if (detected) {
      const cents = 1200 * Math.log2(detected / f);
      console.log(
        `${f.toFixed(2)} Hz → ${detected.toFixed(2)} Hz (${cents >= 0 ? "+" : ""}${cents.toFixed(2)} ¢)`,
      );
    } else {
      console.log(`${f.toFixed(2)} Hz → NÃO DETECTADO`);
    }
  });
}