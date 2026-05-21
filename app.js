const root = document.documentElement;
const body = document.body;
const entryButton = document.getElementById("entry-button");
const audioButton = document.getElementById("audio-button");
const thoughtShell = document.getElementById("thought-shell");
const thoughtButton = document.getElementById("thought-button");
const thoughtInput = document.getElementById("thought-input");

const DURATION_MS = 13 * 60 * 1000;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (value) => value * value * (3 - 2 * value);

let startedAt = 0;
let running = false;
let frame = 0;
let thoughtTimer = 0;
let audio = null;

function setVar(name, value) {
  root.style.setProperty(name, value);
}

function updateSequence(now = performance.now()) {
  if (!running) return;

  const raw = clamp((now - startedAt) / DURATION_MS);
  const eased = smoothstep(raw);
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

function startSequence() {
  if (running) return;
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

entryButton.addEventListener("click", startSequence);
audioButton.addEventListener("click", toggleAudio);
thoughtButton.addEventListener("click", openThought);
thoughtInput.addEventListener("input", saveThought);
thoughtInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeThought(false);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
