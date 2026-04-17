const btn = document.getElementById("recordBtn");
const btnText = document.getElementById("recordBtnText");
const dashboardBtn = document.getElementById("dashboardBtn");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const timerEl = document.getElementById("timer");
const timerValue = document.getElementById("timerValue");
const toast = document.getElementById("toast");
const toastLabel = document.getElementById("toastLabel");
const toastText = document.getElementById("toastText");
const toastRetry = document.getElementById("toastRetry");

let isRecording = false;
let timerInterval = null;
let recordingStartTime = null;
let toastTimeout = null;

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

// ── Dashboard button
dashboardBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://meet-asistant.vercel.app/dashboard" });
});

// ── Check recording state on open
chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
  if (response?.recording) {
    recordingStartTime = response.startTime || Date.now();
    setRecordingUI(true);
  }
});

// ── Record button
btn.addEventListener("click", handleRecordClick);

async function handleRecordClick() {
  if (isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  hideToast();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Allow any http(s) tab so users can test/record audio from any source
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    showToast("error", "Abre una página web con audio (Meet, YouTube, etc.)", ICONS.error);
    return;
  }

  btn.disabled = true;
  setStatus("processing", "Iniciando captura de audio…");

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });

    chrome.runtime.sendMessage(
      { action: "startRecording", tabId: tab.id, streamId },
      (response) => {
        btn.disabled = false;
        if (response?.success) {
          recordingStartTime = Date.now();
          setRecordingUI(true);
        } else {
          setStatus("idle", "Listo para grabar");
          showToast("error", response?.error || "No se pudo iniciar", ICONS.error);
        }
      }
    );
  } catch (err) {
    btn.disabled = false;
    setStatus("idle", "Listo para grabar");
    showToast("error", err.message, ICONS.error);
    console.error("tabCapture error:", err);
  }
}

async function stopRecording() {
  btn.disabled = true;
  btnText.textContent = "Procesando…";
  setStatus("processing", "Deteniendo y transcribiendo…");
  showToast("info", "Enviando audio al servidor. Esto puede tomar unos segundos…", ICONS.info, { persist: true });
  stopTimer();

  chrome.runtime.sendMessage({ action: "stopRecording" }, (response) => {
    btn.disabled = false;
    setRecordingUI(false);

    if (response?.success) {
      const msg = response.summary
        ? "Transcripción guardada. Abre el dashboard para ver los detalles."
        : response.message || "Listo";
      showToast("success", msg, ICONS.check, { duration: 6000 });
    } else {
      const errMsg = response?.error || "Error desconocido";
      showToast("error", errMsg, ICONS.error, {
        persist: true,
        retry: () => {
          hideToast();
          // The audio was already sent — can't really retry the capture,
          // but we can at least reset UI so user knows they can record again
          setStatus("idle", "Listo para grabar");
        },
      });
    }
  });
}

// ── UI state
function setRecordingUI(recording) {
  isRecording = recording;
  if (recording) {
    btnText.textContent = "Detener grabación";
    btn.classList.add("recording");
    setStatus("recording", "Grabando audio de la reunión");
    timerEl.classList.add("show");
    startTimer();
  } else {
    btnText.textContent = "Iniciar grabación";
    btn.classList.remove("recording");
    timerEl.classList.remove("show");
    setStatus("idle", "Listo para grabar");
    stopTimer();
    recordingStartTime = null;
  }
}

function setStatus(variant, text) {
  statusEl.classList.remove("recording", "processing");
  if (variant === "recording") statusEl.classList.add("recording");
  if (variant === "processing") statusEl.classList.add("processing");
  statusText.textContent = text;
}

// ── Timer
function startTimer() {
  updateTimerDisplay();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  if (!recordingStartTime) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const pad = (n) => String(n).padStart(2, "0");
  timerValue.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ── Toast
function showToast(type, text, iconSvg, opts = {}) {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  toast.className = `toast show ${type}`;
  toastLabel.innerHTML = (iconSvg || "") + " " + (
    type === "success" ? "Éxito" :
    type === "error"   ? "Error" :
                         "Info"
  );
  toastText.textContent = text;

  if (opts.retry) {
    toastRetry.style.display = "block";
    toastRetry.onclick = opts.retry;
  } else {
    toastRetry.style.display = "none";
    toastRetry.onclick = null;
  }

  const duration = opts.duration ?? (type === "error" ? 0 : 4000);
  if (!opts.persist && duration > 0) {
    toastTimeout = setTimeout(hideToast, duration);
  }
}

function hideToast() {
  toast.classList.remove("show");
  toastRetry.style.display = "none";
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}
