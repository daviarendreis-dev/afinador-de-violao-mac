// --- 1. CONFIGURAÇÕES E CONSTANTES DE AFINAÇÃO DO VIOLÃO ---
const GUITAR_STRINGS = [
  { name: "E2", freq: 82.41 },
  { name: "A2", freq: 110.0 },
  { name: "D3", freq: 146.83 },
  { name: "G3", freq: 196.0 },
  { name: "B3", freq: 246.94 },
  { name: "E4", freq: 329.63 },
];

// Variáveis de Estado
let audioCtx = null;
let analyser = null;
let buffer = null;
let isListening = false;
let targetFreq = 82.41;
let detectedFreq = 0;
let phase = 0; // Utilizado para animar o deslocamento da onda no Canvas

// Elementos DOM
const startBtn = document.getElementById("startBtn");
const stringSelect = document.getElementById("stringSelect");
const noteDisplay = document.getElementById("noteDisplay");
const freqDisplay = document.getElementById("freqDisplay");
const centsDisplay = document.getElementById("centsDisplay");
const canvas = document.getElementById("waveCanvas");
const ctx = canvas.getContext("2d");

// Redimensiona o Canvas dinamicamente de acordo com o CSS
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// --- 2. CAPTURA DE ÁUDIO & PROCESSAMENTO (Web Audio API) ---
startBtn.addEventListener("click", async () => {
  if (isListening) return;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048; // Define o tamanho do buffer no domínio do tempo

    buffer = new Float32Array(analyser.fftSize);
    source.connect(analyser);

    isListening = true;
    startBtn.disabled = true;
    startBtn.textContent = "Microfone Ativo";

    // Inicia o loop de renderização e análise
    renderLoop();
  } catch (err) {
    alert("Erro ao acessar o microfone: " + err.message);
  }
});

// --- 3. ALGORITMO DE AUTOCORRELAÇÃO (Detecção de $f_0$) ---
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;

  // Cálculo da Energia do Sinal (Root Mean Square)
  for (let i = 0; i < SIZE; i++) {
    const val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);

  // Limiar de silêncio (evita ruído de fundo)
  if (rms < 0.01) return -1;

  // Autocorrelação com Limites de Busca (Filtro para frequências do violão ~60Hz a ~400Hz)
  const r1 = 0;
  const r2 = SIZE / 2;
  let c = new Float32Array(SIZE);

  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE - i; j++) {
      c[i] = c[i] + buf[j] * buf[j + i];
    }
  }

  // Encontra o primeiro pico após o declínio inicial
  let d = 0;
  while (c[d] > c[d + 1]) d++;

  let maxval = -1,
    maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }

  let T0 = maxpos;

  // Interpolação Parabólica para maior precisão sub-sample
  const x1 = c[T0 - 1],
    x2 = c[T0],
    x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}

// --- 4. LÓGICA DE AFINAÇÃO ---
function getClosestString(freq) {
  let closest = GUITAR_STRINGS[0];
  let minDiff = Math.abs(freq - GUITAR_STRINGS[0].freq);

  for (let i = 1; i < GUITAR_STRINGS.length; i++) {
    const diff = Math.abs(freq - GUITAR_STRINGS[i].freq);
    if (diff < minDiff) {
      minDiff = diff;
      closest = GUITAR_STRINGS[i];
    }
  }
  return closest;
}

function calculateCents(freq, target) {
  // Fórmula de conversão de Frequência para Cents: 1200 * log2(f_atual / f_alvo)
  return Math.floor(1200 * Math.log2(freq / target));
}

// --- 5. RENDERIZADOR CANVAS & MATEMÁTICA VISUAL ---
/*
      EXPLICAÇÃO MATEMÁTICA DO RENDERIZADOR:
      
      A representação gráfica simula as ondas no domínio do tempo usando as equações:
      
      1. Onda Alvo (Ideal - Verde):
         $y_{alvo}(x) = A \cdot \sin(2\pi \cdot f_{alvo} \cdot t + \phi)$
         Renderizada para representar a vibração perfeita da nota selecionada.

      2. Onda Atual (Capturada - Laranja):
         $y_{atual}(x) = A_{real} \cdot \sin(2\pi \cdot f_{detectada} \cdot t + \phi)$
         Renderizada utilizando a frequência fundamental capturada pelo microfone.

      Quando a nota afinada está próxima do alvo, as duas ondas entram em fase e coincidem 
      visualmente no Canvas.
    */
function drawWaveforms() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const width = canvas.width;
  const height = canvas.height;
  const centerY = height / 2;
  const amplitude = height * 0.25; // Normaliza a amplitude para 25% da altura total do Canvas

  // Escala visual do tempo (fator de zoom horizontal)
  const timeScale = 0.00005;

  // A) Desenhar Onda Alvo (Verde)
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#00e676";

  for (let x = 0; x < width; x++) {
    const t = x * timeScale;
    // Equação de Onda Senoidal Ideal: y = A * sin(2 * PI * f * t + fase)
    const y =
      centerY + amplitude * Math.sin(2 * Math.PI * targetFreq * t + phase);

    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // B) Desenhar Onda Atual Capturada (Laranja) - Apenas se houver som
  if (detectedFreq > 0) {
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ff9100";

    for (let x = 0; x < width; x++) {
      const t = x * timeScale;
      // Equação de Onda Capturada: y = A * sin(2 * PI * f_detectada * t + fase)
      const y =
        centerY + amplitude * Math.sin(2 * Math.PI * detectedFreq * t + phase);

      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Incrementa a fase para simular a propagação contínua da onda
  phase += 0.05;
}

// --- 6. LOOP PRINCIPAL DE EXECUÇÃO ---
function renderLoop() {
  analyser.getFloatTimeDomainData(buffer);
  const freq = autoCorrelate(buffer, audioCtx.sampleRate);

  if (freq !== -1) {
    detectedFreq = freq;
    freqDisplay.textContent = `${detectedFreq.toFixed(2)} Hz`;

    // Determina a nota alvo conforme a seleção do usuário (Modo Auto ou Manual)
    let activeString;
    const mode = stringSelect.value;

    if (mode === "auto") {
      activeString = getClosestString(detectedFreq);
    } else {
      activeString = GUITAR_STRINGS.find((s) => s.name === mode);
    }

    targetFreq = activeString.freq;
    noteDisplay.textContent = activeString.name;

    // Cálculo de Afinação (Cents)
    const cents = calculateCents(detectedFreq, targetFreq);

    if (Math.abs(cents) <= 5) {
      centsDisplay.textContent = "Afinado!";
      centsDisplay.style.color = "#00e676";
    } else if (cents < -5) {
      centsDisplay.textContent = `Abaixo (${cents} cents)`;
      centsDisplay.style.color = "#ff9100";
    } else {
      centsDisplay.textContent = `Acima (+${cents} cents)`;
      centsDisplay.style.color = "#ff9100";
    }
  } else {
    detectedFreq = 0;
    freqDisplay.textContent = `0.00 Hz`;
    centsDisplay.textContent = "Toque uma corda...";
    centsDisplay.style.color = "var(--text-muted)";
  }

  drawWaveforms();
  requestAnimationFrame(renderLoop);
}
