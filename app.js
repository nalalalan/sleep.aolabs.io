const root = document.documentElement;
const body = document.body;
const entryButton = document.getElementById("entry-button");
const audioButton = document.getElementById("audio-button");
const thoughtShell = document.getElementById("thought-shell");
const thoughtButton = document.getElementById("thought-button");
const thoughtInput = document.getElementById("thought-input");
const ambientCanvas = document.getElementById("ambient-canvas");

const DURATION_MS = 13 * 60 * 1000;
const AUTO_START_MS = 12 * 1000;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (value) => value * value * (3 - 2 * value);

let startedAt = 0;
let running = false;
let frame = 0;
let ambientFrame = 0;
let lastAmbientDraw = 0;
let thoughtTimer = 0;
let autoStartTimer = 0;
let audio = null;

function setVar(name, value) {
  root.style.setProperty(name, value);
}

function updateSequence(now = performance.now()) {
  if (!running) return;

  const raw = clamp((now - startedAt) / DURATION_MS);
  const eased = smoothstep(raw);
  const entryFade = clamp(raw / 0.16);
  const late = clamp((raw - 0.22) / 0.56);
  const veryLate = clamp((raw - 0.72) / 0.28);

  setVar("--shutdown", eased.toFixed(4));
  setVar("--blackout", (Math.pow(eased, 1.85) * 0.88).toFixed(4));
  setVar("--stage-brightness", (1 - eased * 0.72).toFixed(3));
  setVar("--stage-contrast", (1 - eased * 0.5).toFixed(3));
  setVar("--stage-saturation", (1 - eased * 0.46).toFixed(3));
  setVar("--field-blur", `${(3 + eased * 18).toFixed(2)}px`);
  setVar("--drift-duration", `${(28 + eased * 118).toFixed(1)}s`);
  setVar("--breath-duration", `${(8.5 + eased * 8.5).toFixed(1)}s`);
  setVar("--control-opacity", Math.max(0.025, 1 - smoothstep(late) * 0.975).toFixed(4));
  setVar("--entry-opacity", Math.max(0.035, 1 - smoothstep(entryFade) * 0.965).toFixed(4));
  setVar("--button-scale", Math.max(0.52, 1 - smoothstep(late) * 0.48).toFixed(4));
  setVar("--thought-opacity", Math.max(0, 1 - smoothstep(clamp((raw - 0.42) / 0.26))).toFixed(4));

  if (raw > 0.58) {
    closeThought(true);
    thoughtButton.disabled = true;
  }

  if (raw > 0.82) body.classList.add("is-near-black");
  if (raw >= 1) {
    body.classList.add("is-finished");
    lowerAudio(0.002);
    cancelAnimationFrame(frame);
    return;
  }

  lowerAudio(0.03 * (1 - eased) + 0.004);
  frame = requestAnimationFrame(updateSequence);
}

function drawAmbient(time = performance.now()) {
  if (!ambientCanvas) return;
  const context = ambientCanvas.getContext("2d", { alpha: false });
  if (!context) return;

  const rect = ambientCanvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));

  if (ambientCanvas.width !== width || ambientCanvas.height !== height) {
    ambientCanvas.width = width;
    ambientCanvas.height = height;
  }

  const shutdown = Number.parseFloat(getComputedStyle(root).getPropertyValue("--shutdown")) || 0;
  const t = time / 1000;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = width / ratio;
  const h = height / ratio;

  const base = context.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, "#100806");
  base.addColorStop(0.38, "#1a0d09");
  base.addColorStop(0.72, "#0a0504");
  base.addColorStop(1, "#030201");
  context.fillStyle = base;
  context.fillRect(0, 0, w, h);

  const breath = 0.5 + Math.sin(t * 0.58) * 0.5;
  const warm = context.createRadialGradient(w * 0.39, h * 0.72, 0, w * 0.42, h * 0.72, Math.max(w, h) * (0.58 + breath * 0.025));
  warm.addColorStop(0, `rgba(225, 135, 102, ${0.23 * (1 - shutdown * 0.72)})`);
  warm.addColorStop(0.36, `rgba(120, 61, 42, ${0.24 * (1 - shutdown * 0.58)})`);
  warm.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = warm;
  context.fillRect(0, 0, w, h);

  const upper = context.createRadialGradient(w * 0.68, h * 0.28, 0, w * 0.68, h * 0.28, Math.max(w, h) * 0.48);
  upper.addColorStop(0, `rgba(237, 201, 158, ${0.06 * (1 - shutdown)})`);
  upper.addColorStop(0.48, `rgba(68, 35, 26, ${0.1 * (1 - shutdown * 0.4)})`);
  upper.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = upper;
  context.fillRect(0, 0, w, h);

  context.globalCompositeOperation = "screen";
  for (let i = 0; i < 18; i += 1) {
    const y = h * (0.12 + i * 0.051);
    const amp = h * (0.012 + (i % 5) * 0.0028) * (1 - shutdown * 0.55);
    const phase = t * (0.026 + i * 0.0014) + i * 0.73;
    const line = context.createLinearGradient(0, y - amp, w, y + amp);
    line.addColorStop(0, "rgba(0,0,0,0)");
    line.addColorStop(0.22, `rgba(245, 195, 147, ${0.012 + i * 0.0007})`);
    line.addColorStop(0.58, `rgba(214, 122, 96, ${0.017 + i * 0.0008})`);
    line.addColorStop(1, "rgba(0,0,0,0)");
    context.strokeStyle = line;
    context.lineWidth = 0.85 + i * 0.045;
    context.beginPath();
    context.moveTo(-w * 0.08, y + Math.sin(phase) * amp);
    for (let x = -w * 0.08; x <= w * 1.08; x += w / 11) {
      const drift = Math.sin(phase + x * 0.0042 + i) * amp;
      const sag = Math.cos(phase * 0.72 + x * 0.0028) * amp * 0.5;
      context.lineTo(x, y + drift + sag + (x / w - 0.5) * amp * 0.7);
    }
    context.stroke();
  }

  context.globalCompositeOperation = "multiply";
  const shadow = context.createRadialGradient(w * 0.42, h * 0.7, Math.min(w, h) * 0.18, w * 0.5, h * 0.56, Math.max(w, h) * 0.76);
  shadow.addColorStop(0, "rgba(255,255,255,.88)");
  shadow.addColorStop(0.58, "rgba(68,39,29,.8)");
  shadow.addColorStop(1, "rgba(0,0,0,.9)");
  context.fillStyle = shadow;
  context.fillRect(0, 0, w, h);
  context.globalCompositeOperation = "source-over";

}

function animateAmbient(time) {
  if (time - lastAmbientDraw > 120) {
    drawAmbient(time);
    lastAmbientDraw = time;
  }

  ambientFrame = requestAnimationFrame(animateAmbient);
}

function cancelAutoStart() {
  window.clearTimeout(autoStartTimer);
}

function queueAutoStart() {
  cancelAutoStart();
  autoStartTimer = window.setTimeout(() => {
    if (!running && window.location.hash !== "#paper") startSequence();
  }, AUTO_START_MS);
}

function initAmbient() {
  if (!ambientCanvas) return;
  drawAmbient();
  window.addEventListener("resize", () => drawAmbient(), { passive: true });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) {
    ambientFrame = requestAnimationFrame(animateAmbient);
  }
}

function startSequence() {
  if (running) return;
  cancelAutoStart();
  running = true;
  startedAt = performance.now();
  body.classList.add("is-softening");
  entryButton.setAttribute("aria-label", "softening");
  frame = requestAnimationFrame(updateSequence);
}

function makeNoiseBuffer(context, seconds = 2) {
  const frameCount = context.sampleRate * seconds;
  const buffer = context.createBuffer(1, frameCount, context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;

  for (let i = 0; i < frameCount; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }

  return buffer;
}

function createAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;

  const context = new AudioContext();
  const source = context.createBufferSource();
  const lowpass = context.createBiquadFilter();
  const gain = context.createGain();
  const compressor = context.createDynamicsCompressor();

  source.buffer = makeNoiseBuffer(context, 3);
  source.loop = true;
  lowpass.type = "lowpass";
  lowpass.frequency.value = 520;
  lowpass.Q.value = 0.4;
  gain.gain.value = 0.028;

  source.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(gain);
  gain.connect(context.destination);
  source.start();

  return { context, source, gain };
}

function lowerAudio(level) {
  if (!audio?.gain || audio.context.state === "closed") return;
  audio.gain.gain.setTargetAtTime(level, audio.context.currentTime, 2.8);
}

async function toggleAudio() {
  startSequence();

  if (!audio) {
    audio = createAudio();
    if (!audio) return;
  }

  if (audio.context.state === "suspended") {
    await audio.context.resume();
  }

  const isOn = audioButton.classList.toggle("audio-on");
  const target = isOn ? 0.032 : 0.0001;
  audio.gain.gain.setTargetAtTime(target, audio.context.currentTime, 0.8);
}

function openThought() {
  startSequence();
  if (thoughtButton.disabled) return;
  thoughtShell.classList.add("is-open");
  thoughtShell.classList.remove("is-fading");
  window.clearTimeout(thoughtTimer);
  thoughtInput.focus({ preventScroll: true });
}

function closeThought(fast = false) {
  if (!thoughtShell.classList.contains("is-open")) return;
  thoughtShell.classList.add("is-fading");
  window.clearTimeout(thoughtTimer);
  thoughtTimer = window.setTimeout(() => {
    thoughtShell.classList.remove("is-open", "is-fading");
    thoughtInput.value = "";
  }, fast ? 250 : 1800);
}

function saveThought() {
  const value = thoughtInput.value.trim();
  if (value) {
    localStorage.setItem("sleep.tomorrow", JSON.stringify({
      text: value,
      savedAt: new Date().toISOString()
    }));
  }
  window.clearTimeout(thoughtTimer);
  thoughtTimer = window.setTimeout(() => closeThought(false), 4200);
}

function syncPaperVisibility() {
  const paper = document.getElementById("paper");
  const visible = window.location.hash === "#paper";
  paper?.classList.toggle("is-visible", visible);
  body.classList.toggle("is-reading-paper", visible);

  if (visible) {
    cancelAutoStart();
    window.requestAnimationFrame(() => paper?.scrollIntoView({ block: "start" }));
  } else if (!running) {
    window.scrollTo(0, 0);
    queueAutoStart();
  }
}

entryButton.addEventListener("click", startSequence);
audioButton.addEventListener("click", toggleAudio);
thoughtButton.addEventListener("click", openThought);
thoughtInput.addEventListener("input", saveThought);
thoughtInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeThought(false);
});
window.addEventListener("hashchange", syncPaperVisibility);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const scriptUrl = new URL("service-worker.js", window.location.href);
    navigator.serviceWorker.register(scriptUrl, { scope: "./" }).catch(() => {});
  });
}

initAmbient();
syncPaperVisibility();
