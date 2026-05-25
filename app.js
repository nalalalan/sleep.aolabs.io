const root = document.documentElement;
const body = document.body;
const entryButton = document.getElementById("entry-button");
const audioButton = document.getElementById("audio-button");
const thoughtShell = document.getElementById("thought-shell");
const thoughtButton = document.getElementById("thought-button");
const thoughtInput = document.getElementById("thought-input");
const ambientCanvas = document.getElementById("ambient-canvas");
const recordSection = document.getElementById("record");
const recordState = document.getElementById("record-state");
const recordContent = document.getElementById("record-content");
const recordRefresh = document.getElementById("record-refresh");
const recordUpdated = document.getElementById("record-updated");
const recordTokenForm = document.getElementById("record-token-form");
const recordTokenInput = document.getElementById("record-token-input");

const DURATION_MS = 13 * 60 * 1000;
const AUTO_START_MS = 4 * 1000;
const IDLE_RELEASE_AFTER_MS = 5 * 60 * 1000;
const IDLE_RELEASE_FADE_MS = 5 * 60 * 1000;
const READ_TOKEN_KEY = "sleep.readToken";
const LIVE_API_BASE = "https://sleep.aolabs.io";
const configuredApiBase = document.querySelector("meta[name='sleep-api-base']")?.content || "";
const API_BASE = (configuredApiBase || (location.hostname === "aolabs.io" ? LIVE_API_BASE : "")).replace(/\/$/, "");
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (value) => value * value * (3 - 2 * value);

let startedAt = 0;
let lastInteractionAt = performance.now();
let running = false;
let frame = 0;
let ambientFrame = 0;
let lastAmbientDraw = 0;
let thoughtTimer = 0;
let autoStartTimer = 0;
let audio = null;
let recordLoading = false;

function setVar(name, value) {
  root.style.setProperty(name, value);
}

function updateSequence(now = performance.now()) {
  if (!running) return;

  const raw = clamp((now - startedAt) / DURATION_MS);
  const eased = smoothstep(raw);
  const release = smoothstep(clamp((now - Math.max(startedAt, lastInteractionAt) - IDLE_RELEASE_AFTER_MS) / IDLE_RELEASE_FADE_MS));
  const entryFade = clamp(raw / 0.16);
  const late = clamp((raw - 0.22) / 0.56);
  const veryLate = clamp((raw - 0.72) / 0.28);

  setVar("--shutdown", eased.toFixed(4));
  setVar("--drowse", smoothstep(clamp(raw / 0.62)).toFixed(4));
  setVar("--idle-release", release.toFixed(4));
  setVar("--blackout", Math.min(0.96, Math.pow(eased, 1.85) * 0.88 + release * 0.58).toFixed(4));
  setVar("--stage-brightness", Math.max(0.16, 1 - eased * 0.72 - release * 0.38).toFixed(3));
  setVar("--stage-contrast", Math.max(0.42, 1 - eased * 0.5 - release * 0.22).toFixed(3));
  setVar("--stage-saturation", Math.max(0.26, 1 - eased * 0.46 - release * 0.24).toFixed(3));
  setVar("--field-blur", `${(3 + eased * 18).toFixed(2)}px`);
  setVar("--drift-duration", `${(28 + eased * 118).toFixed(1)}s`);
  setVar("--breath-duration", `${(8.5 + eased * 8.5).toFixed(1)}s`);
  setVar("--control-opacity", Math.max(0, (1 - smoothstep(late) * 0.975) * (1 - release)).toFixed(4));
  setVar("--entry-opacity", Math.max(0, (1 - smoothstep(entryFade) * 0.965) * (1 - release)).toFixed(4));
  setVar("--button-scale", Math.max(0.52, 1 - smoothstep(late) * 0.48).toFixed(4));
  setVar("--thought-opacity", Math.max(0, (1 - smoothstep(clamp((raw - 0.42) / 0.26))) * (1 - release)).toFixed(4));

  body.classList.toggle("is-released", release > 0.55);

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
    if (!running && window.location.hash === "#transition") startSequence();
  }, AUTO_START_MS);
}

function resetTransitionState() {
  cancelAutoStart();
  running = false;
  cancelAnimationFrame(frame);
  closeThought(false);
  thoughtButton.disabled = false;
  body.classList.remove("is-softening", "is-released", "is-near-black", "is-finished");
  entryButton.setAttribute("aria-label", "soften");
  setVar("--shutdown", "0");
  setVar("--blackout", "0");
  setVar("--drowse", "0");
  setVar("--idle-release", "0");
  setVar("--control-opacity", ".86");
  setVar("--entry-opacity", "1");
  setVar("--thought-opacity", "1");
  setVar("--button-scale", "1");
  setVar("--stage-brightness", "1");
  setVar("--stage-contrast", "1");
  setVar("--stage-saturation", "1");
  setVar("--field-blur", "2px");
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
  lastInteractionAt = startedAt;
  body.classList.add("is-softening");
  entryButton.setAttribute("aria-label", "softening");
  frame = requestAnimationFrame(updateSequence);
}

function noteInteraction() {
  lastInteractionAt = performance.now();
  body.classList.remove("is-released");
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

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (!hours) return `${mins}m`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatNightDate(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function stageTotal(stageMinutes, keys) {
  return keys.reduce((sum, key) => sum + (stageMinutes?.[key] || 0), 0);
}

function renderRecordBoundary(message, detail = "") {
  if (!recordContent) return;
  recordContent.innerHTML = `
    <div class="record-boundary" role="status">
      <strong>${message}</strong>
      <p>${detail || "No synced nights yet. After Samsung Health writes a completed Galaxy Watch sleep session to Health Connect, the Android bridge sends it here."}</p>
    </div>
  `;
}

function renderRecordSummary(data) {
  if (!recordContent) return;
  const latest = data.latest;
  const maxDuration = Math.max(1, ...data.trend.map((night) => night.durationMinutes || 0));
  const bars = data.trend.map((night) => {
    const stages = night.stageMinutes || {};
    const segments = [
      ["deep", stages.deep],
      ["rem", stages.rem],
      ["light", stages.light],
      ["sleeping", stages.sleeping],
      ["unknown", stages.unknown],
      ["awake", stages.awake],
      ["outOfBed", stages.outOfBed]
    ].filter(([, minutes]) => minutes > 0);
    const fallback = segments.length ? "" : `<span class="night-segment sleeping" style="height:${Math.max(4, (night.durationMinutes / maxDuration) * 100)}%"></span>`;
    return `
      <div class="night-bar" title="${night.sleepDate}: ${formatMinutes(night.durationMinutes)}">
        <div class="night-bar-stack" style="height:${Math.max(16, (night.durationMinutes / maxDuration) * 160)}px">
          ${segments.map(([stage, minutes]) => `<span class="night-segment ${stage}" style="height:${Math.max(2, (minutes / Math.max(1, night.durationMinutes)) * 100)}%"></span>`).join("")}
          ${fallback}
        </div>
        <span class="night-date">${formatNightDate(night.sleepDate)}</span>
      </div>
    `;
  }).join("");

  const rows = data.nights.map((night) => {
    const stages = night.stageMinutes || {};
    return `
      <div class="night-row">
        <span class="night-primary">${formatNightDate(night.sleepDate)}</span>
        <span>${formatMinutes(night.durationMinutes)}</span>
        <span>${formatMinutes(stageTotal(stages, ["awake", "outOfBed"]))}</span>
        <span>${formatMinutes(stageTotal(stages, ["light", "sleeping"]))}</span>
        <span>${formatMinutes(stages.deep || 0)}</span>
        <span>${formatMinutes(stages.rem || 0)}</span>
      </div>
    `;
  }).join("");

  recordContent.innerHTML = `
    <div class="record-summary">
      <div>
        <span class="record-label">Latest sleep</span>
        <span class="record-value">${formatMinutes(latest.durationMinutes)}</span>
        <span class="record-meta">${formatNightDate(latest.sleepDate)} · ${formatDateTime(latest.startTime)} to ${formatDateTime(latest.endTime)}</span>
      </div>
      <div>
        <span class="record-label">7-night avg</span>
        <span class="record-value">${formatMinutes(data.averageDurationMinutes)}</span>
        <span class="record-meta">${data.nightCount} ${data.nightCount === 1 ? "night" : "nights"} stored</span>
      </div>
      <div>
        <span class="record-label">Asleep avg</span>
        <span class="record-value">${formatMinutes(data.averageAsleepMinutes)}</span>
        <span class="record-meta">awake time excluded</span>
      </div>
    </div>

    <div class="record-list">
      <h2>Daily sleep hours</h2>
      <div class="night-row night-header">
        <span>Date</span>
        <span>Total</span>
        <span>Awake</span>
        <span>Light</span>
        <span>Deep</span>
        <span>REM</span>
      </div>
      ${rows}
    </div>

    <div class="record-chart">
      <h2>Daily bars</h2>
      <div class="night-bars">${bars}</div>
    </div>
  `;
}

async function loadRecord() {
  if (!recordContent || recordLoading) return;
  recordLoading = true;
  recordUpdated.textContent = "Loading record.";

  const token = localStorage.getItem(READ_TOKEN_KEY) || "";
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  try {
    const response = await fetch(`${API_BASE}/api/sleep/summary`, { headers });
    if (response.status === 401) {
      recordTokenForm.hidden = false;
      recordState.textContent = "Private sleep log locked.";
      recordUpdated.textContent = "Read token required.";
      renderRecordBoundary("Read token required.", "Enter the read token once in this browser to load nightly sleep hours.");
      return;
    }

    if (!response.ok) {
      recordState.textContent = "Sleep API unavailable.";
      recordUpdated.textContent = `API returned ${response.status}.`;
      renderRecordBoundary("Sleep API unavailable.", "The record route is live, but the backend is not returning sleep state right now.");
      return;
    }

    const data = await response.json();
    recordTokenForm.hidden = true;

    if (!data.recordCount) {
      recordState.textContent = "No synced sleep sessions yet.";
      recordUpdated.textContent = "Waiting for first bridge sync.";
      renderRecordBoundary("No Health Connect records yet.");
      return;
    }

    recordState.textContent = "Health Connect sleep records received.";
    recordUpdated.textContent = data.lastCapturedAt ? `Last bridge sync ${formatDateTime(data.lastCapturedAt)}.` : `Generated ${formatDateTime(data.generatedAt)}.`;
    renderRecordSummary(data);
  } catch (error) {
    recordState.textContent = "Sleep API unreachable.";
    recordUpdated.textContent = "Local or live backend not reachable.";
    renderRecordBoundary("Sleep API unreachable.", "The page loaded, but the sleep record backend could not be reached from this browser.");
  } finally {
    recordLoading = false;
  }
}

function syncPanelVisibility() {
  const paper = document.getElementById("paper");
  const transition = document.getElementById("transition");
  const paperVisible = window.location.hash === "#paper";
  const transitionVisible = window.location.hash === "#transition";
  const recordVisible = !paperVisible && !transitionVisible;
  paper?.classList.toggle("is-visible", paperVisible);
  recordSection?.classList.toggle("is-visible", recordVisible);
  body.classList.toggle("is-reading-paper", paperVisible);
  body.classList.toggle("is-reading-record", recordVisible);
  body.classList.toggle("is-reading-transition", transitionVisible);

  if (paperVisible) {
    resetTransitionState();
    window.requestAnimationFrame(() => paper?.scrollIntoView({ block: "start" }));
  } else if (transitionVisible) {
    window.requestAnimationFrame(() => transition?.scrollIntoView({ block: "start" }));
    queueAutoStart();
  } else {
    resetTransitionState();
    window.requestAnimationFrame(() => recordSection?.scrollIntoView({ block: "start" }));
    loadRecord();
  }
}

entryButton.addEventListener("click", startSequence);
audioButton.addEventListener("click", toggleAudio);
thoughtButton.addEventListener("click", openThought);
thoughtInput.addEventListener("input", saveThought);
thoughtInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeThought(false);
});
recordRefresh?.addEventListener("click", loadRecord);
recordTokenForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = recordTokenInput.value.trim();
  if (token) localStorage.setItem(READ_TOKEN_KEY, token);
  loadRecord();
});
document.addEventListener("pointerdown", noteInteraction, { passive: true });
document.addEventListener("keydown", noteInteraction);
window.addEventListener("hashchange", syncPanelVisibility);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const scriptUrl = new URL("service-worker.js", window.location.href);
    navigator.serviceWorker.register(scriptUrl, { scope: "./" }).catch(() => {});
  });
}

initAmbient();
syncPanelVisibility();
