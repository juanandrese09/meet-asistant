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
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const serverUrlInput = document.getElementById("serverUrlInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const settingsSave = document.getElementById("settingsSave");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const progressLabel = document.getElementById("progressLabel");

let isRecording = false;
let timerInterval = null;
let recordingStartTime = null;
let toastTimeout = null;
let sseSource = null;

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

const PROGRESS_LABELS = {
  uploading: "Subiendo audio...",
  saving: "Guardando audio...",
  transcribing: "Transcribiendo con Whisper...",
  transcribed: "Transcripcion completa",
  summarizing: "Generando resumen con AI...",
  done: "Procesamiento completo",
  error: "Error en el procesamiento",
};

// ── Settings
function loadSettings() {
  chrome.storage.local.get(["ma_server_url", "ma_api_key"], (data) => {
    serverUrlInput.value = data.ma_server_url || "https://meet-asistant.vercel.app";
    apiKeyInput.value = data.ma_api_key || "";
  });
}

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("show");
});

settingsSave.addEventListener("click", () => {
  const url = serverUrlInput.value.replace(/\/+$/, "");
  const key = apiKeyInput.value.trim();
  const settings = {};
  if (url && /^https?:\/\//.test(url)) {
    settings.ma_server_url = url;
  }
  if (key) {
    settings.ma_api_key = key;
  } else {
    settings.ma_api_key = "";
  }
  chrome.storage.local.set(settings, () => {
    showToast("success", "Configuracion guardada", ICONS.check, { duration: 2000 });
    settingsPanel.classList.remove("show");
  });
});

loadSettings();

// ── SSE progress streaming
function connectSSE(sessionId) {
  if (sseSource) { sseSource.close(); sseSource = null; }
  chrome.storage.local.get(["ma_server_url", "ma_api_key"], (data) => {
    const serverUrl = data.ma_server_url || "https://meet-asistant.vercel.app";
    const apiKey = data.ma_api_key || "";
    const url = `${serverUrl}/progress`;

    sseSource = new EventSource(url);

    sseSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.sessionId && parsed.sessionId !== sessionId) return;

        const label = PROGRESS_LABELS[parsed.status] || "Procesando...";
        progressLabel.textContent = label;
        progressFill.style.width = `${parsed.progress || 0}%`;

        if (parsed.status === "done" || parsed.status === "error") {
          setTimeout(() => {
            if (sseSource) { sseSource.close(); sseSource = null; }
            progressBar.classList.remove("show");
          }, 1500);
        }
      } catch {}
    };

    sseSource.onerror = () => {
      if (sseSource) { sseSource.close(); sseSource = null; }
    };
  });
}

function showProgress() {
  progressBar.classList.add("show");
  progressFill.style.width = "0%";
  progressLabel.textContent = "Iniciando...";
}

// ── Dashboard button
dashboardBtn.addEventListener("click", () => {
  chrome.storage.local.get(["ma_server_url"], (data) => {
    const serverUrl = data.ma_server_url || "https://meet-asistant.vercel.app";
    chrome.tabs.create({ url: `${serverUrl}/dashboard` });
  });
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

  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    showToast("error", "Abre una pagina web con audio (Meet, YouTube, etc.)", ICONS.error);
    return;
  }

  btn.disabled = true;
  setStatus("processing", "Iniciando captura de audio...");

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
  btnText.textContent = "Procesando...";
  setStatus("processing", "Deteniendo y transcribiendo...");
  showProgress();
  stopTimer();

  chrome.runtime.sendMessage({ action: "stopRecording" }, (response) => {
    btn.disabled = false;
    setRecordingUI(false);

    if (response?.success) {
      if (response.sessionId) {
        connectSSE(response.sessionId);
      }
      const msg = response.summary
        ? "Transcripcion guardada. Abre el dashboard para ver los detalles."
        : response.message || "Listo";
      showToast("success", msg, ICONS.check, { duration: 6000 });
    } else {
      const errMsg = response?.error || "Error desconocido";
      showToast("error", errMsg, ICONS.error, {
        persist: true,
        retry: () => {
          hideToast();
          setStatus("idle", "Listo para grabar");
        },
      });
      progressBar.classList.remove("show");
    }
  });
}

// ── UI state
function setRecordingUI(recording) {
  isRecording = recording;
  if (recording) {
    btnText.textContent = "Detener grabacion";
    btn.classList.add("recording");
    setStatus("recording", "Grabando audio de la reunion");
    timerEl.classList.add("show");
    startTimer();
  } else {
    btnText.textContent = "Iniciar grabacion";
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
    type === "success" ? "Exito" :
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
