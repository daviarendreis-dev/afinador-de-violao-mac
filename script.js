/* ============================================================
   AFINADOR DE VIOLÃO EM TEMPO REAL
   ============================================================
   Módulos:
   1. AudioCapture       - Captura do microfone (filtro anti-aliasing)
   2. PitchDetector      - Detecção de frequência (MPM + downsampling)
   3. NoteMapper         - Mapeamento frequência -> nota / corda
   4. WaveRenderer       - Renderização das ondas no Canvas
   5. PresetManager      - Presets de afinação + referência A4
   6. Metronome          - Metrônomo de precisão (Web Audio API)
   7. TunerApp           - Orquestração principal
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

// ===================== PRESETS DE AFINAÇÃO =====================
/**
 * Frequências das cordas na referência A4 = 440 Hz.
 * Ao trocar o A4, todas as frequências são recalculadas via:
 *   freq_nova = freq_440 * (A4_novo / 440)
 */
const TUNING_PRESETS = {
  standard: {
    label: "Padrão (E A D G B E)",
    strings: [
      { note: "E2", freq: 82.41 },
      { note: "A2", freq: 110.0 },
      { note: "D3", freq: 146.83 },
      { note: "G3", freq: 196.0 },
      { note: "B3", freq: 246.94 },
      { note: "E4", freq: 329.63 },
    ],
  },
  dropD: {
    label: "Drop D (D A D G B E)",
    strings: [
      { note: "D2", freq: 73.42 },
      { note: "A2", freq: 110.0 },
      { note: "D3", freq: 146.83 },
      { note: "G3", freq: 196.0 },
      { note: "B3", freq: 246.94 },
      { note: "E4", freq: 329.63 },
    ],
  },
  ebStandard: {
    label: "Eb Standard (Eb Ab Db Gb Bb Eb)",
    strings: [
      { note: "D#2", freq: 77.78 },
      { note: "G#2", freq: 103.83 },
      { note: "C#3", freq: 138.59 },
      { note: "F#3", freq: 185.0 },
      { note: "A#3", freq: 233.08 },
      { note: "D#4", freq: 311.13 },
    ],
  },
  openG: {
    label: "Open G (D G D G B D)",
    strings: [
      { note: "D2", freq: 73.42 },
      { note: "G2", freq: 98.0 },
      { note: "D3", freq: 146.83 },
      { note: "G3", freq: 196.0 },
      { note: "B3", freq: 246.94 },
      { note: "D4", freq: 293.66 },
    ],
  },
  dadgad: {
    label: "DADGAD (D A D G A D)",
    strings: [
      { note: "D2", freq: 73.42 },
      { note: "A2", freq: 110.0 },
      { note: "D3", freq: 146.83 },
      { note: "G3", freq: 196.0 },
      { note: "A3", freq: 220.0 },
      { note: "D4", freq: 293.66 },
    ],
  },
};

const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F",
  "F#", "G", "G#", "A", "A#", "B",
];

// Chaves usadas em localStorage
const STORAGE_KEYS = {
  PRESET: "afinador.preset",
  A4: "afinador.a4",
  SINGLE_STRING: "afinador.singleString",
  BPM: "afinador.bpm",
  TIME_SIG: "afinador.timeSig",
};

// ===================== MÓDULO 5: PRESET MANAGER =====================
/**
 * Gerencia o preset de afinação ativo e a referência A4.
 * Responsável por:
 *   - Carregar/salvar em localStorage
 *   - Recalcular frequências quando A4 muda
 *   - Notificar listeners (TunerApp) quando algo muda
 */
class PresetManager {
  constructor() {
    this.presetKey = this.loadPreset();
    this.a4 = this.loadA4();
    this.listeners = [];
    this.rebuild();
  }

  loadPreset() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.PRESET);
      return saved && TUNING_PRESETS[saved] ? saved : "standard";
    } catch {
      return "standard";
    }
  }

  loadA4() {
    try {
      const saved = parseFloat(localStorage.getItem(STORAGE_KEYS.A4));
      if (saved >= 415 && saved <= 445) return saved;
    } catch {
      /* ignore */
    }
    return 440;
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEYS.PRESET, this.presetKey);
      localStorage.setItem(STORAGE_KEYS.A4, String(this.a4));
    } catch {
      /* localStorage indisponível — ignora */
    }
  }

  /**
   * Recalcula as frequências do preset ativo aplicando o fator A4.
   *
   *   freq_ajustada = freq_440 * (A4 / 440)
   *
   * Ex.: E2 = 82.41 Hz. Com A4 = 432:
   *   82.41 * (432 / 440) = 80.91 Hz
   */
  rebuild() {
    const preset = TUNING_PRESETS[this.presetKey];
    const factor = this.a4 / 440;

    this.strings = preset.strings.map((s) => ({
      note: s.note,
      freq: s.freq * factor,
      freq440: s.freq,
    }));

    this.minFreq = Math.min(...this.strings.map((s) => s.freq));
  }

  setPreset(key) {
    if (!TUNING_PRESETS[key]) return;
    this.presetKey = key;
    this.rebuild();
    this.save();
    this.emit();
  }

  setA4(value) {
    const v = Math.max(415, Math.min(445, Math.round(value)));
    if (v === this.a4) return;
    this.a4 = v;
    this.rebuild();
    this.save();
    this.emit();
  }

  getStringByNote(note) {
    return this.strings.find((s) => s.note === note) || this.strings[0];
  }

  onChange(cb) {
    this.listeners.push(cb);
  }

  emit() {
    for (const cb of this.listeners) cb();
  }
}

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

      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();

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

      this.lowpassFilter = this.audioContext.createBiquadFilter();
      this.lowpassFilter.type = "lowpass";
      this.lowpassFilter.frequency.value = CONFIG.LOWPASS_CUTOFF;
      this.lowpassFilter.Q.value = 0.7;

      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;

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

// ===================== MÓDULO 2: DETECÇÃO DE PITCH =====================
class PitchDetector {
  constructor() {
    this.downsampleFactor = 1;
    this.effectiveSampleRate = 44100;
    this.initialized = false;

    this.MAX_DOWNSAMPLED_SIZE = 512;
    this.MAX_LAG = 64;

    this.downsampled = new Float32Array(this.MAX_DOWNSAMPLED_SIZE);
    this.nsdf = new Float32Array(this.MAX_LAG);
  }

  initialize(sampleRate) {
    this.downsampleFactor = Math.max(
      1,
      Math.round(sampleRate / CONFIG.TARGET_SAMPLE_RATE),
    );
    this.effectiveSampleRate = sampleRate / this.downsampleFactor;

    const maxLagNeeded = Math.ceil(this.effectiveSampleRate / CONFIG.MIN_FREQ);
    if (maxLagNeeded > this.MAX_LAG) {
      this.MAX_LAG = maxLagNeeded + 4;
      this.nsdf = new Float32Array(this.MAX_LAG);
    }
    this.initialized = true;
  }

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
   * @param {Float32Array} rawBuffer
   * @param {number} rawSampleRate
   * @param {number} [minFreq] - Filtro dinâmico (modo "só uma corda")
   * @param {number} [maxFreq]
   */
  detect(rawBuffer, rawSampleRate, minFreq, maxFreq) {
    if (!this.initialized) this.initialize(rawSampleRate);

    const fMin = minFreq || CONFIG.MIN_FREQ;
    const fMax = maxFreq || CONFIG.MAX_FREQ;

    // RMS
    let rms = 0;
    for (let i = 0; i < rawBuffer.length; i++) {
      rms += rawBuffer[i] * rawBuffer[i];
    }
    rms = Math.sqrt(rms / rawBuffer.length);
    if (rms < CONFIG.RMS_THRESHOLD) return null;

    // Downsampling
    const size = this.downsample(rawBuffer, this.downsampleFactor);
    const buffer = this.downsampled;

    // NSDF
    const minLag = Math.floor(this.effectiveSampleRate / fMax);
    const maxLag = Math.min(
      Math.floor(this.effectiveSampleRate / fMin),
      Math.floor(size / 2),
    );

    if (maxLag <= minLag) return null;

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
      nsdf[tau] = energy > 0 ? (2 * acf) / energy : 0;
    }

    // Pico principal
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

    if (maxVal < CONFIG.CLARITY_THRESHOLD * CONFIG.PEAK_THRESHOLD_RATIO) {
      return null;
    }

    // Interpolação parabólica
    let refinedPos = maxPos;
    if (maxPos > 0 && maxPos < maxLag - 1) {
      const y1 = nsdf[maxPos - 1];
      const y2 = nsdf[maxPos];
      const y3 = nsdf[maxPos + 1];
      const a = (y1 + y3 - 2 * y2) / 2;
      const b = (y3 - y1) / 2;
      if (a !== 0) refinedPos = maxPos - b / (2 * a);
    }

    const freq = this.effectiveSampleRate / refinedPos;
    if (freq < fMin || freq > fMax) return null;
    return freq;
  }
}

// ===================== MÓDULO 3: MAPEAMENTO DE NOTAS =====================
class NoteMapper {
  static freqToNote(freq, a4 = 440) {
    const midi = 12 * Math.log2(freq / a4) + 69;
    const roundedMidi = Math.round(midi);
    const cents = Math.round((midi - roundedMidi) * 100);
    const noteIndex = ((roundedMidi % 12) + 12) % 12;
    const octave = Math.floor(roundedMidi / 12) - 1;
    return {
      note: NOTE_NAMES[noteIndex] + octave,
      noteName: NOTE_NAMES[noteIndex],
      octave,
      cents,
      midi: roundedMidi,
    };
  }

  static centsDeviation(freq, targetFreq) {
    if (!freq || !targetFreq || freq <= 0) return 0;
    return Math.round(1200 * Math.log2(freq / targetFreq));
  }

  static findClosestString(freq, strings, a4 = 440) {
    if (!freq || !strings || strings.length === 0) return null;

    const detected = NoteMapper.freqToNote(freq, a4);
    const exact = strings.find((s) => s.note === detected.note);
    if (exact) return exact;

    let closest = strings[0];
    let minDiff = Infinity;
    for (const s of strings) {
      const diff = Math.abs(1200 * Math.log2(freq / s.freq));
      if (diff < minDiff) {
        minDiff = diff;
        closest = s;
      }
    }
    return closest;
  }
}

// ===================== MÓDULO 4: RENDERIZAÇÃO =====================
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

  render(targetFreq, detectedFreq, rms, sampleBuffer, sampleRate) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const centerY = H / 2;

    ctx.clearRect(0, 0, W, H);

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(10, 10, 20, 0.9)");
    grad.addColorStop(0.5, "rgba(15, 15, 30, 0.9)");
    grad.addColorStop(1, "rgba(10, 10, 20, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(W, centerY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    for (let i = 0; i <= 8; i++) {
      const x = (W / 8) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Onda alvo
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

    // Onda capturada
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

      const windowTime = 0.02;
      for (let px = 0; px < W; px++) {
        const t = (px / W) * windowTime;
        const y = amplitude * Math.sin(2 * Math.PI * detectedFreq * t);
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

    // Legenda
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

// ===================== MÓDULO 6: METRÔNOMO =====================
/**
 * Metrônomo de precisão usando o clock do AudioContext.
 *
 * ══════════════════════════════════════════════════════════════════
 * POR QUE NÃO USAR setInterval DIRETAMENTE?
 * ══════════════════════════════════════════════════════════════════
 * setInterval() sofre drift por:
 *   - Throttling em abas em background (~1s mínimo)
 *   - Jitter do event loop do navegador
 *   - Acúmulo de erros de arredondamento
 *
 * SOLUÇÃO — agendamento em duas camadas:
 *   1. Um setInterval "grosso" a cada 25 ms apenas agenda
 *      cliques num horizonte de 100 ms à frente.
 *   2. Cada clique é agendado via audioContext.currentTime, que
 *      é um relógio de precisão controlado pela thread de áudio.
 *
 * Isso elimina o drift porque o tempo de cada clique é calculado
 * em incrementos exatos de 60/bpm segundos a partir do startTime,
 * nunca a partir do "agora".
 *
 * ══════════════════════════════════════════════════════════════════
 * SÍNTESE DO CLIQUE
 * ══════════════════════════════════════════════════════════════════
 * Sem samples externos: usamos um OscillatorNode com envelope
 * de amplitude curto (attack instantâneo, decay ~50 ms).
 *
 * Para o ACENTO (1º tempo do compasso), usamos frequência mais
 * aguda (1500 Hz) e volume ligeiramente maior que o tempo normal
 * (800 Hz).
 */
class Metronome {
  /**
   * @param {AudioContext} audioContext — reaproveita o do AudioCapture
   */
  constructor(audioContext) {
    this.ctx = audioContext;
    this.isPlaying = false;
    this.bpm = 120;
    this.beatsPerBar = 4;
    this.beatUnit = 4;
    this.currentBeat = 0;
    this.nextNoteTime = 0;
    this.timerId = null;

    // Horizonte de agendamento à frente (evita jitter do event loop)
    this.lookahead = 0.1; // 100 ms
    // Intervalo do agendador (bem menor que o lookahead)
    this.scheduleInterval = 25; // 25 ms

    // Nó de ganho dedicado (isolado do analisador do microfone)
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = 0.7;
    // Conectar direto ao destino (alto-falante), NÃO ao analisador
    this.outputGain.connect(this.ctx.destination);

    // Callback para o indicador visual
    this.onBeat = null; // (beatIndex, isAccent) => void
  }

  setBpm(bpm) {
    this.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  }

  setTimeSignature(sig) {
    const [num, den] = sig.split("/").map(Number);
    this.beatsPerBar = num;
    this.beatUnit = den;
  }

  /**
   * Duração de uma batida em segundos.
   * O BPM é sempre referente à unidade do denominador.
   * Para 6/8 com 120 BPM, cada colcheia dura 60/120 = 0.5s.
   */
  get beatDuration() {
    return 60 / this.bpm;
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.currentBeat = 0;
    // Agenda o primeiro clique um pouco à frente para não cortar
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.scheduler();
    this.timerId = setInterval(
      () => this.scheduler(),
      this.scheduleInterval,
    );
  }

  stop() {
    this.isPlaying = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.currentBeat = 0;
    if (this.onBeat) this.onBeat(-1, false);
  }

  /**
   * Agenda todos os cliques que caibam no horizonte lookahead.
   * Usa this.ctx.currentTime (relógio de áudio) como referência.
   */
  scheduler() {
    if (!this.isPlaying) return;

    const now = this.ctx.currentTime;
    while (this.nextNoteTime < now + this.lookahead) {
      this.scheduleClick(
        this.nextNoteTime,
        this.currentBeat === 0, // acento no 1º tempo
      );
      this.advanceBeat();
    }
  }

  advanceBeat() {
    this.nextNoteTime += this.beatDuration;
    this.currentBeat = (this.currentBeat + 1) % this.beatsPerBar;
  }

  /**
   * Sintetiza um clique com envelope ADSR curto.
   *
   * @param {number} time — quando disparar (currentTime)
   * @param {boolean} isAccent — se é o 1º tempo do compasso
   */
  scheduleClick(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = isAccent ? 1500 : 800;

    // Envelope: ataque instantâneo, decay exponencial ~50 ms
    const peak = isAccent ? 0.9 : 0.5;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(peak, time + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

    osc.connect(env);
    env.connect(this.outputGain);

    osc.start(time);
    osc.stop(time + 0.06);

    // Notifica UI no momento correto
    if (this.onBeat) {
      const beatIndex = isAccent ? 0 : this.currentBeat;
      const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (this.isPlaying) this.onBeat(beatIndex, isAccent);
      }, delayMs);
    }
  }
}

// ===================== MÓDULO 7: APLICAÇÃO PRINCIPAL =====================
class TunerApp {
  constructor() {
    // DOM
    this.micBtn = document.getElementById("micBtn");
    this.autoBtn = document.getElementById("autoBtn");
    this.singleStringBtn = document.getElementById("singleStringBtn");
    this.presetSelect = document.getElementById("presetSelect");
    this.a4Input = document.getElementById("a4Input");
    this.stringSelector = document.getElementById("stringSelector");
    this.noteValue = document.getElementById("noteValue");
    this.freqValue = document.getElementById("freqValue");
    this.centsValue = document.getElementById("centsValue");
    this.indicator = document.getElementById("indicator");
    this.statusText = document.getElementById("statusText");
    this.canvas = document.getElementById("waveCanvas");

    // Módulos
    this.presets = new PresetManager();
    this.audio = new AudioCapture();
    this.detector = new PitchDetector();
    this.renderer = new WaveRenderer(this.canvas);

    // Estado
    this.isRunning = false;
    this.autoMode = true;
    this.singleStringMode = this.loadSingleString();
    this.selectedString = this.presets.strings[0];
    this.currentFreq = 0;
    this.currentRms = 0;
    this.lastDetectedFreq = 0;
    this.animationId = null;
    this.smoothingFreq = 0;
    this.detectedNote = null;
    this.isTuned = false;
    this.wasRunningBeforeHidden = false;

    // Estado do metrônomo
    this.metronome = null;
    this._metronomeOwnContext = null;
    this.metronomeBpm = this.loadBpm();
    this.metronomeTimeSig = this.loadTimeSig();

    this.buildPresetDropdown();
    this.rebuildStringButtons();
    this.bindEvents();

    // Reagir a mudanças de preset/A4
    this.presets.onChange(() => {
      this.rebuildStringButtons();
      this.selectString(this.presets.strings[0]);
      this.renderIdle();
    });

    this.syncSingleStringButton();

    // Inicializa UI do metrônomo
    this.setMetronomeBpm(this.metronomeBpm);
    this.rebuildBeatIndicator();
    if (this.timeSigSelect) {
      this.timeSigSelect.value = this.metronomeTimeSig;
    }

    this.renderIdle();
  }

  // ---------- Persistência ----------
  loadSingleString() {
    try {
      return localStorage.getItem(STORAGE_KEYS.SINGLE_STRING) === "1";
    } catch {
      return false;
    }
  }

  saveSingleString() {
    try {
      localStorage.setItem(
        STORAGE_KEYS.SINGLE_STRING,
        this.singleStringMode ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }

  loadBpm() {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEYS.BPM), 10);
      if (v >= 40 && v <= 240) return v;
    } catch {
      /* ignore */
    }
    return 120;
  }

  saveBpm() {
    try {
      localStorage.setItem(STORAGE_KEYS.BPM, String(this.metronomeBpm));
    } catch {
      /* ignore */
    }
  }

  loadTimeSig() {
    try {
      const v = localStorage.getItem(STORAGE_KEYS.TIME_SIG);
      if (["2/4", "3/4", "4/4", "6/8"].includes(v)) return v;
    } catch {
      /* ignore */
    }
    return "4/4";
  }

  saveTimeSig() {
    try {
      localStorage.setItem(STORAGE_KEYS.TIME_SIG, this.metronomeTimeSig);
    } catch {
      /* ignore */
    }
  }

  // ---------- Dropdown ----------
  buildPresetDropdown() {
    this.presetSelect.innerHTML = "";
    for (const [key, preset] of Object.entries(TUNING_PRESETS)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = preset.label;
      this.presetSelect.appendChild(opt);
    }
    this.presetSelect.value = this.presets.presetKey;
    this.a4Input.value = String(this.presets.a4);
  }

  // ---------- Botões de corda dinâmicos ----------
  rebuildStringButtons() {
    this.stringSelector.innerHTML = "";
    for (const str of this.presets.strings) {
      const btn = document.createElement("button");
      btn.className = "string-btn";
      btn.dataset.note = str.note;
      btn.dataset.freq = str.freq;

      const match = str.note.match(/^([A-G]#?)(-?\d+)$/);
      const noteName = match ? match[1] : str.note;
      const octave = match ? match[2] : "";

      btn.innerHTML = `${noteName}<span class="note-label">${octave}</span>`;

      btn.addEventListener("click", () => {
        if (this.autoMode) {
          this.autoMode = false;
          this.autoBtn.classList.remove("active");
          this.autoBtn.textContent = "Manual";
        }
        const s = this.presets.getStringByNote(str.note);
        if (s) this.selectString(s);
        this.syncSingleStringButton();
      });

      this.stringSelector.appendChild(btn);
    }
    this.updateStringButtons();
  }

  updateStringButtons() {
    const btns = this.stringSelector.querySelectorAll(".string-btn");
    btns.forEach((btn) => {
      btn.classList.toggle(
        "active",
        btn.dataset.note === this.selectedString.note,
      );
    });
  }

  // ---------- Eventos ----------
  bindEvents() {
    this.micBtn.addEventListener("click", () => this.toggleMic());

    this.autoBtn.addEventListener("click", () => {
      this.autoMode = !this.autoMode;
      this.autoBtn.classList.toggle("active", this.autoMode);
      this.autoBtn.textContent = this.autoMode ? "Automático" : "Manual";
      if (!this.autoMode) {
        if (this.lastDetectedFreq > 0) {
          const closest = NoteMapper.findClosestString(
            this.lastDetectedFreq,
            this.presets.strings,
            this.presets.a4,
          );
          if (closest) this.selectString(closest);
        } else {
          this.selectString(this.presets.strings[0]);
        }
      }
      this.syncSingleStringButton();
    });

    this.singleStringBtn.addEventListener("click", () => {
      this.singleStringMode = !this.singleStringMode;
      this.saveSingleString();
      this.syncSingleStringButton();
    });

    this.presetSelect.addEventListener("change", () => {
      this.presets.setPreset(this.presetSelect.value);
    });

    this.a4Input.addEventListener("change", () => {
      const v = parseFloat(this.a4Input.value);
      if (!isNaN(v)) {
        this.presets.setA4(v);
        this.a4Input.value = String(this.presets.a4);
      }
    });

    // Background
    document.addEventListener("visibilitychange", () => {
      this.handleVisibilityChange();
    });
    window.addEventListener("pagehide", () => {
      if (this.isRunning) this.audio.suspend();
    });

    // ---------- METRÔNOMO ----------
    this.bpmRange = document.getElementById("bpmRange");
    this.bpmInput = document.getElementById("bpmInput");
    this.bpmDisplay = document.getElementById("bpmDisplay");
    this.timeSigSelect = document.getElementById("timeSigSelect");
    this.metronomeBtn = document.getElementById("metronomeBtn");
    this.beatIndicator = document.getElementById("beatIndicator");

    if (this.bpmRange) {
      this.bpmRange.addEventListener("input", () => {
        const v = parseInt(this.bpmRange.value, 10);
        this.setMetronomeBpm(v);
      });
    }

    if (this.bpmInput) {
      this.bpmInput.addEventListener("change", () => {
        const v = parseInt(this.bpmInput.value, 10);
        this.setMetronomeBpm(v);
      });
    }

    if (this.timeSigSelect) {
      this.timeSigSelect.addEventListener("change", () => {
        this.metronomeTimeSig = this.timeSigSelect.value;
        this.saveTimeSig();
        if (this.metronome) {
          this.metronome.setTimeSignature(this.metronomeTimeSig);
        }
        this.rebuildBeatIndicator();
      });
    }

    if (this.metronomeBtn) {
      this.metronomeBtn.addEventListener("click", () => {
        this.toggleMetronome();
      });
    }
  }

  // ---------- Metrônomo ----------
  /**
   * O metrônomo precisa de um AudioContext. Se o microfone
   * ainda não foi ligado, criamos um contexto avulso só para ele.
   *
   * IMPORTANTE: o AudioContext pode estar "suspended" em mobile.
   * Como o toggle é disparado por clique (user gesture), o resume()
   * funciona sem problemas.
   */
  async ensureMetronome() {
    if (this.metronome) return this.metronome;

    let ctx = this.audio.audioContext;
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
          console.warn("resume() do metrônomo falhou:", e);
        }
      }
      this._metronomeOwnContext = ctx;
    }

    this.metronome = new Metronome(ctx);
    this.metronome.setBpm(this.metronomeBpm);
    this.metronome.setTimeSignature(this.metronomeTimeSig);
    this.metronome.onBeat = (beatIndex, isAccent) => {
      this.updateBeatIndicator(beatIndex, isAccent);
    };

    this.rebuildBeatIndicator();
    return this.metronome;
  }

  setMetronomeBpm(v) {
    this.metronomeBpm = Math.max(40, Math.min(240, v));
    if (this.bpmRange) this.bpmRange.value = String(this.metronomeBpm);
    if (this.bpmInput) this.bpmInput.value = String(this.metronomeBpm);
    if (this.bpmDisplay) {
      this.bpmDisplay.textContent = `${this.metronomeBpm} BPM`;
    }
    if (this.metronome) {
      this.metronome.setBpm(this.metronomeBpm);
    }
    this.saveBpm();
  }

  async toggleMetronome() {
    const m = await this.ensureMetronome();
    if (m.isPlaying) {
      m.stop();
      this.metronomeBtn.textContent = "▶ Iniciar";
      this.metronomeBtn.classList.remove("active");
      this.updateBeatIndicator(-1, false);
    } else {
      // Garantir que o AudioContext está rodando
      if (m.ctx.state === "suspended") {
        try {
          await m.ctx.resume();
        } catch (e) {
          console.warn("resume() ao iniciar metrônomo falhou:", e);
        }
      }
      m.start();
      this.metronomeBtn.textContent = "⏹ Parar";
      this.metronomeBtn.classList.add("active");
    }
  }

  /** Constrói os pontinhos do compasso dinamicamente */
  rebuildBeatIndicator() {
    if (!this.beatIndicator) return;
    const beats = this.getBeatsPerBar();
    this.beatIndicator.innerHTML = "";
    for (let i = 0; i < beats; i++) {
      const dot = document.createElement("div");
      dot.className = "beat-dot";
      if (i === 0) dot.classList.add("accent-dot");
      this.beatIndicator.appendChild(dot);
    }
  }

  /** Atualiza o pontinho ativo */
  updateBeatIndicator(beatIndex, isAccent) {
    if (!this.beatIndicator) return;
    const dots = this.beatIndicator.querySelectorAll(".beat-dot");
    dots.forEach((d, i) => {
      d.classList.remove("active", "accent");
      if (i === beatIndex) {
        d.classList.add("active");
        if (isAccent) d.classList.add("accent");
      }
    });
  }

  getBeatsPerBar() {
    const [num] = this.metronomeTimeSig.split("/").map(Number);
    return num || 4;
  }

  // ---------- UI / Estado ----------
  syncSingleStringButton() {
    const enabled = !this.autoMode;
    this.singleStringBtn.disabled = !enabled;
    this.singleStringBtn.style.opacity = enabled ? "1" : "0.4";
    this.singleStringBtn.classList.toggle(
      "active",
      enabled && this.singleStringMode,
    );
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
        if (!this.animationId) this.loop();
      }
    }
  }

  selectString(str) {
    if (!str) return;
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

  async toggleMic() {
    if (this.isRunning) this.stop();
    else await this.start();
  }

  async start() {
    try {
      this.micBtn.textContent = "⏳ Iniciando...";
      this.micBtn.disabled = true;
      await this.audio.start();
      this.isRunning = true;
      this.isTuned = false;
      this.micBtn.textContent = "⏹ Parar Microfone";
      this.micBtn.classList.add("active");
      this.micBtn.disabled = false;
      this.statusText.textContent = "Ouvindo...";
      this.statusText.className = "status-text idle";

      // Se o metrônomo já existia com contexto próprio, recicla
      // com o novo contexto (do microfone) para economizar recursos.
      if (this._metronomeOwnContext && this.audio.audioContext) {
        const wasPlaying = this.metronome && this.metronome.isPlaying;
        if (this.metronome) this.metronome.stop();
        this._metronomeOwnContext.close().catch(() => {});
        this._metronomeOwnContext = null;
        this.metronome = null;
        this.ensureMetronome().then((m) => {
          if (wasPlaying) {
            m.start();
            if (this.metronomeBtn) {
              this.metronomeBtn.textContent = "⏹ Parar";
              this.metronomeBtn.classList.add("active");
            }
          }
        });
      }

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

    // Parar metrônomo se estiver rodando
    if (this.metronome && this.metronome.isPlaying) {
      this.metronome.stop();
      if (this.metronomeBtn) {
        this.metronomeBtn.textContent = "▶ Iniciar";
        this.metronomeBtn.classList.remove("active");
      }
      this.updateBeatIndicator(-1, false);
    }

    this.audio.stop();
    this.micBtn.textContent = "🎤 Ativar Microfone";
    this.micBtn.classList.remove("active");
    this.statusText.textContent = "Aguardando áudio...";
    this.statusText.className = "status-text idle";
    this.currentFreq = 0;
    this.smoothingFreq = 0;
    this.detectedNote = null;
    this.isTuned = false;
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

  finishTuning() {
    if (this.isTuned) return;
    this.isTuned = true;
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.audio.stop();
    this.micBtn.textContent = "🎤 Ativar Microfone";
    this.micBtn.classList.remove("active");
    this.micBtn.disabled = false;
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

  /**
   * Calcula a faixa de detecção para o modo "só uma corda".
   * ±1 semitom em torno da corda alvo.
   */
  getDetectionRange() {
    if (this.singleStringMode && !this.autoMode) {
      const f = this.selectedString.freq;
      return { min: f * Math.pow(2, -1 / 12), max: f * Math.pow(2, 1 / 12) };
    }
    const strings = this.presets.strings;
    const minString = Math.min(...strings.map((s) => s.freq));
    const maxString = Math.max(...strings.map((s) => s.freq));
    return { min: minString * 0.85, max: maxString * 1.15 };
  }

  loop() {
    if (!this.isRunning) return;
    this.animationId = requestAnimationFrame(() => this.loop());

    const buffer = this.audio.getSamples();
    if (!buffer) return;

    const sampleRate = this.audio.getSampleRate();

    let rms = 0;
    for (let i = 0; i < buffer.length; i++) {
      rms += buffer[i] * buffer[i];
    }
    rms = Math.sqrt(rms / buffer.length);
    this.currentRms = rms;

    const range = this.getDetectionRange();
    let detectedFreq = this.detector.detect(
      buffer,
      sampleRate,
      range.min,
      range.max,
    );

    if (detectedFreq) {
      if (this.smoothingFreq === 0) {
        this.smoothingFreq = detectedFreq;
      } else {
        this.smoothingFreq =
          this.smoothingFreq * CONFIG.SMOOTHING_OLD +
          detectedFreq * CONFIG.SMOOTHING_NEW;
      }
      this.lastDetectedFreq = this.smoothingFreq;
      this.detectedNote = NoteMapper.freqToNote(
        this.smoothingFreq,
        this.presets.a4,
      );
    } else {
      this.smoothingFreq *= CONFIG.SMOOTHING_DECAY;
      if (this.smoothingFreq < 1) {
        this.smoothingFreq = 0;
        this.detectedNote = null;
      }
    }

    this.currentFreq = this.smoothingFreq;

    if (this.autoMode && this.currentFreq > 0) {
      const closest = NoteMapper.findClosestString(
        this.currentFreq,
        this.presets.strings,
        this.presets.a4,
      );
      if (closest && closest.note !== this.selectedString.note) {
        this.selectedString = closest;
        this.updateStringButtons();
      }
    }

    this.updateReadings(this.currentFreq, buffer, sampleRate);
  }

  updateReadings(freq, buffer, sampleRate) {
    const target = this.selectedString;

    if (freq && freq > 0) {
      const detected =
        this.detectedNote ||
        NoteMapper.freqToNote(freq, this.presets.a4);
      const cents = NoteMapper.centsDeviation(freq, target.freq);

      this.noteValue.textContent = detected.note;
      this.freqValue.textContent = freq.toFixed(1) + " Hz";
      this.centsValue.textContent =
        (cents > 0 ? "+" : "") + cents + " ¢";

      const noteMismatch = detected.note !== target.note;
      const isInTune = !noteMismatch && Math.abs(cents) < 5;

      this.centsValue.className = "value cents";
      if (noteMismatch) {
        this.centsValue.classList.add(cents < 0 ? "flat" : "sharp");
      } else if (isInTune) {
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
      } else if (isInTune) {
        this.indicator.style.background = "#00e676";
        this.indicator.style.color = "#00e676";
        this.statusText.textContent = "Parabens! Seu violao esta afinado";
        this.statusText.className = "status-text tuned";
        this.finishTuning();
        return;
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

// ===================== REGISTRO DO SERVICE WORKER =====================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    if (
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1"
    ) {
      navigator.serviceWorker
        .register("./service-worker.js")
        .then((reg) => console.log("SW registrado:", reg.scope))
        .catch((err) => console.warn("SW falhou:", err));
    }
  });
}

// ===================== INICIALIZAÇÃO =====================
document.addEventListener("DOMContentLoaded", () => {
  window.tunerApp = new TunerApp();
});