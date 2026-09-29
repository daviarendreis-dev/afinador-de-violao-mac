/* ============================================================
   AFINADOR DE VIOLÃO EM TEMPO REAL
   ============================================================
   Módulos:
   1. AudioCapture       - Captura do microfone
   2. PitchDetector      - Detecção de frequência (autocorrelação)
   3. NoteMapper         - Mapeamento frequência -> nota
   4. WaveRenderer       - Renderização das ondas no Canvas
   5. TunerApp           - Orquestração principal
   ============================================================ */

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
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// ===================== MÓDULO 1: CAPTURA DE ÁUDIO =====================
class AudioCapture {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.source = null;
    this.buffer = null;
    this.isActive = false;
  }

  async start() {
    if (this.isActive) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 4096; // Alta resolução para detecção precisa
      this.analyser.smoothingTimeConstant = 0;

      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.source.connect(this.analyser);

      this.buffer = new Float32Array(this.analyser.fftSize);
      this.isActive = true;
      return true;
    } catch (err) {
      console.error("Erro ao acessar microfone:", err);
      throw err;
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.source = null;
    this.isActive = false;
  }

  getSamples() {
    if (!this.analyser || !this.buffer) return null;
    this.analyser.getFloatTimeDomainData(this.buffer);
    return this.buffer;
  }

  getSampleRate() {
    return this.audioContext ? this.audioContext.sampleRate : 44100;
  }
}

// ===================== MÓDULO 2: DETECÇÃO DE PITCH =====================
/**
 * Algoritmo de Autocorrelação com normalização (ACF)
 *
 * A autocorrelação mede a similaridade de um sinal com uma versão
 * deslocada de si mesmo. Para um sinal periódico de período T,
 * a autocorrelação atinge seu máximo em atrasos múltiplos de T.
 *
 * Fórmula: R(τ) = Σ_{i=0}^{N-τ-1} x[i] * x[i+τ]
 *
 * O primeiro pico após o cruzamento de zero (excluindo τ=0)
 * corresponde ao período fundamental da onda.
 * Frequência = sampleRate / período
 */
class PitchDetector {
  constructor() {
    this.minFreq = 70; // Abaixo de E2 (82.41) com margem
    this.maxFreq = 400; // Acima de E4 (329.63) com margem
  }

  /**
   * Detecta a frequência fundamental via autocorrelação.
   * @param {Float32Array} buffer - Amostras de áudio no domínio do tempo
   * @param {number} sampleRate - Taxa de amostragem (Hz)
   * @returns {number|null} Frequência detectada em Hz, ou null
   */
  detect(buffer, sampleRate) {
    const SIZE = buffer.length;
    const minLag = Math.floor(sampleRate / this.maxFreq);
    const maxLag = Math.floor(sampleRate / this.minFreq);

    // 1. Calcular RMS para verificar se há sinal suficiente
    let rms = 0;
    for (let i = 0; i < SIZE; i++) {
      rms += buffer[i] * buffer[i];
    }
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return null; // Silêncio

    // 2. Autocorrelação
    const correlations = new Float32Array(maxLag);
    for (let lag = 0; lag < maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < SIZE - lag; i++) {
        sum += buffer[i] * buffer[i + lag];
      }
      correlations[lag] = sum;
    }

    // 3. Encontrar o primeiro pico após o primeiro vale (cruzamento)
    let foundPeak = false;
    let peakLag = -1;
    let peakValue = -Infinity;

    // Pular região inicial (lag 0 até minLag)
    for (let lag = minLag; lag < maxLag; lag++) {
      // Detectar mudança de tendência (subida -> descida)
      if (
        correlations[lag] > correlations[lag - 1] &&
        correlations[lag] > correlations[lag + 1]
      ) {
        // É um pico local
        if (!foundPeak) {
          // Primeiro pico significativo após o mínimo
          if (correlations[lag] > 0.3 * correlations[0]) {
            foundPeak = true;
            peakLag = lag;
            peakValue = correlations[lag];
          }
        }
      }
    }

    if (peakLag === -1) return null;

    // 4. Refinamento parabólico do pico (interpolação)
    // Ajusta uma parábola em torno do pico para maior precisão
    const y1 = correlations[peakLag - 1];
    const y2 = correlations[peakLag];
    const y3 = correlations[peakLag + 1];
    const a = (y1 + y3 - 2 * y2) / 2;
    const b = (y3 - y1) / 2;
    let refinedLag = peakLag;
    if (a !== 0) {
      refinedLag = peakLag - b / (2 * a);
    }

    // 5. Calcular frequência
    const freq = sampleRate / refinedLag;

    // Validar faixa
    if (freq < this.minFreq || freq > this.maxFreq) return null;

    return freq;
  }
}

// ===================== MÓDULO 3: MAPEAMENTO DE NOTAS =====================
class NoteMapper {
  /**
   * Converte frequência para nota musical mais próxima.
   * Usa a fórmula MIDI:
   *   n = 12 * log2(f / 440) + 69
   * onde n é o número MIDI (69 = A4 = 440 Hz).
   */
  static freqToNote(freq) {
    const midi = 12 * Math.log2(freq / 440) + 69;
    const roundedMidi = Math.round(midi);
    const cents = Math.round((midi - roundedMidi) * 100);
    const noteIndex = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;
    return {
      note: NOTE_NAMES[noteIndex] + octave,
      cents: cents,
      midi: roundedMidi,
    };
  }

  /**
   * Calcula o desvio em cents entre a frequência detectada
   * e a frequência alvo.
   *
   * Fórmula: cents = 1200 * log2(f_detectada / f_alvo)
   */
  static centsDeviation(freq, targetFreq) {
    if (!freq || !targetFreq || freq <= 0) return 0;
    return Math.round(1200 * Math.log2(freq / targetFreq));
  }

  /**
   * Encontra a corda mais próxima da frequência detectada.
   */
  static findClosestString(freq) {
    if (!freq) return STRINGS[0];
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
   * Renderiza as ondas sobrepostas.
   *
   * MATEMÁTICA DA RENDERIZAÇÃO:
   *
   * A onda alvo (ideal) é modelada como:
   *   y_alvo(t) = A * sin(2π * f_alvo * t)
   *
   * A onda atual (capturada) é modelada como:
   *   y_atual(t) = A_real * sin(2π * f_detectada * t + φ)
   *
   * Para o gráfico, mapeamos o tempo t para coordenadas x do canvas:
   *   x = (t / T_janela) * largura
   *
   * A amplitude é mapeada para y:
   *   y = centroY - amplitude * escala
   *
   * Usamos uma janela temporal de ~3 períodos da frequência alvo
   * para visualização clara.
   */
  render(targetFreq, detectedFreq, rms, sampleBuffer, sampleRate) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const centerY = H / 2;

    // Limpar
    ctx.clearRect(0, 0, W, H);

    // Fundo gradiente sutil
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(10, 10, 20, 0.9)");
    grad.addColorStop(0.5, "rgba(15, 15, 30, 0.9)");
    grad.addColorStop(1, "rgba(10, 10, 20, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Linha central (eixo zero)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(W, centerY);
    ctx.stroke();

    // Grade vertical sutil
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    for (let i = 0; i <= 8; i++) {
      const x = (W / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // ---- ONDA ALVO (VERDE) ----
    // y_alvo(t) = A * sin(2π * f_alvo * t)
    if (targetFreq && targetFreq > 0) {
      const amplitude = H * 0.35;
      // Janela de 3 períodos da frequência alvo
      const period = 1 / targetFreq;
      const windowTime = period * 3;
      const numPoints = W;

      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 230, 118, 0.7)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(0, 230, 118, 0.3)";
      ctx.shadowBlur = 8;

      for (let px = 0; px < numPoints; px++) {
        // Mapear pixel -> tempo dentro da janela
        const t = (px / numPoints) * windowTime;
        // Equação da onda alvo
        const y = amplitude * Math.sin(2 * Math.PI * targetFreq * t);
        const canvasY = centerY - y;
        if (px === 0) ctx.moveTo(px, canvasY);
        else ctx.lineTo(px, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ---- ONDA ATUAL (AZUL/LARANJA) ----
    if (detectedFreq && detectedFreq > 0 && sampleBuffer) {
      const amplitude = H * 0.35;

      // Usar a forma de onda real capturada para renderização
      // Normalizar e desenhar as amostras diretamente
      const buffer = sampleBuffer;

      // Detectar cor baseada na proximidade
      let color, shadowColor;
      if (targetFreq) {
        const cents = 1200 * Math.log2(detectedFreq / targetFreq);
        if (Math.abs(cents) < 5) {
          color = "rgba(0, 230, 118, 0.9)"; // Verde = afinado
          shadowColor = "rgba(0, 230, 118, 0.4)";
        } else if (Math.abs(cents) < 20) {
          color = "rgba(0, 198, 255, 0.9)"; // Azul = próximo
          shadowColor = "rgba(0, 198, 255, 0.4)";
        } else {
          color = "rgba(255, 165, 0, 0.9)"; // Laranja = longe
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

      // Encontrar amplitude máxima para normalização
      let maxVal = 0.001;
      for (let i = 0; i < buffer.length; i++) {
        maxVal = Math.max(maxVal, Math.abs(buffer[i]));
      }

      for (let px = 0; px < W; px++) {
        const idx = Math.floor((px / W) * buffer.length);
        // Amostra normalizada
        const sample = buffer[idx] / maxVal;
        // y_atual(t) = A_real * sin(2π * f_detectada * t + φ) -> representado diretamente pelas amostras
        const y = sample * amplitude;
        const canvasY = centerY - y;
        if (px === 0) ctx.moveTo(px, canvasY);
        else ctx.lineTo(px, canvasY);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ---- LEGENDA ----
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textAlign = "left";

    // Alvo
    ctx.fillStyle = "rgba(0, 230, 118, 0.8)";
    ctx.fillRect(12, 12, 16, 3);
    ctx.fillStyle = "rgba(0, 230, 118, 0.6)";
    ctx.fillText("Onda Alvo (ideal)", 34, 17);

    // Atual
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
    this.selectedString = STRINGS[0]; // E2
    this.currentFreq = 0;
    this.currentRms = 0;
    this.lastDetectedFreq = 0;
    this.animationId = null;
    this.smoothingFreq = 0;

    this.bindEvents();
    this.renderIdle();
  }

  bindEvents() {
    // Botão do microfone
    this.micBtn.addEventListener("click", () => this.toggleMic());

    // Botão automático/manual
    this.autoBtn.addEventListener("click", () => {
      this.autoMode = !this.autoMode;
      this.autoBtn.classList.toggle("active", this.autoMode);
      this.autoBtn.textContent = this.autoMode ? "Automático" : "Manual";
      if (!this.autoMode) {
        // Selecionar a corda mais próxima da frequência atual
        if (this.lastDetectedFreq > 0) {
          const closest = NoteMapper.findClosestString(this.lastDetectedFreq);
          this.selectString(closest);
        } else {
          this.selectString(STRINGS[0]);
        }
      }
      this.updateStringButtons();
    });

    // Botões de corda
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
  }

  selectString(str) {
    this.selectedString = str;
    this.updateStringButtons();

    // Re-renderizar imediatamente com a nova corda alvo
    if (!this.isRunning) {
      // Microfone desligado: renderizar apenas a onda alvo
      this.renderIdle();
    } else {
      // Microfone ligado: re-renderizar com onda alvo + onda capturada
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

  // ✅ ÚNICO renderIdle — com fallback para sampleRate
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

    // Calcular RMS para visualização
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) {
      rms += buffer[i] * buffer[i];
    }
    rms = Math.sqrt(rms / buffer.length);
    this.currentRms = rms;

    // Detectar frequência
    let detectedFreq = this.detector.detect(buffer, sampleRate);

    // Suavização (média móvel) para reduzir jitter
    if (detectedFreq) {
      if (this.smoothingFreq === 0) {
        this.smoothingFreq = detectedFreq;
      } else {
        this.smoothingFreq = this.smoothingFreq * 0.7 + detectedFreq * 0.3;
      }
      this.lastDetectedFreq = this.smoothingFreq;
    } else {
      // Decaimento suave quando não há detecção
      this.smoothingFreq *= 0.95;
      if (this.smoothingFreq < 1) this.smoothingFreq = 0;
    }

    this.currentFreq = this.smoothingFreq;

    // Modo automático: selecionar corda mais próxima
    if (this.autoMode && this.currentFreq > 0) {
      const closest = NoteMapper.findClosestString(this.currentFreq);
      if (closest.note !== this.selectedString.note) {
        this.selectedString = closest;
        this.updateStringButtons();
      }
    }

    // Atualizar UI
    this.updateReadings(this.currentFreq, buffer, sampleRate);
  }

  updateReadings(freq, buffer, sampleRate) {
    const target = this.selectedString;

    if (freq && freq > 0) {
      // Mapear para nota
      const noteInfo = NoteMapper.freqToNote(freq);
      const cents = NoteMapper.centsDeviation(freq, target.freq);

      // Atualizar nota
      this.noteValue.textContent = target.note;

      // Atualizar frequência
      this.freqValue.textContent = freq.toFixed(1) + " Hz";

      // Atualizar cents
      const centsStr = (cents > 0 ? "+" : "") + cents + " ¢";
      this.centsValue.textContent = centsStr;

      // Classe de cor
      this.centsValue.className = "value cents";
      if (Math.abs(cents) < 5) {
        this.centsValue.classList.add("tuned");
      } else if (cents < 0) {
        this.centsValue.classList.add("flat");
      } else {
        this.centsValue.classList.add("sharp");
      }

      // Barra indicadora (mapear -50 a +50 cents para 0% a 100%)
      const clampedCents = Math.max(-50, Math.min(50, cents));
      const percent = ((clampedCents + 50) / 100) * 100;
      this.indicator.style.left = percent + "%";

      // Cor do indicador
      if (Math.abs(cents) < 5) {
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
      // Sem sinal
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

    // Renderizar canvas
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
});