let stopTimeout = null;

const DEFAULT_SERVER_URL = "https://meet-asistant.vercel.app";

async function getServerConfig() {
  try {
    const data = await chrome.storage.local.get(["ma_server_url", "ma_api_key"]);
    return {
      serverUrl: data.ma_server_url || DEFAULT_SERVER_URL,
      apiKey: data.ma_api_key || "",
    };
  } catch {
    return { serverUrl: DEFAULT_SERVER_URL, apiKey: "" };
  }
}

async function getRecordingState() {
  try {
    const raw = await chrome.storage.local.get(["ma_recording", "ma_start_time", "ma_active_tab"]);
    return {
      recording: !!raw.ma_recording,
      startTime: raw.ma_start_time || null,
      activeTabId: raw.ma_active_tab || null,
    };
  } catch {
    return { recording: false, startTime: null, activeTabId: null };
  }
}

async function setRecordingState(recording, startTime, activeTabId) {
  try {
    await chrome.storage.local.set({
      ma_recording: recording,
      ma_start_time: startTime,
      ma_active_tab: activeTabId,
    });
  } catch (e) {
    console.error("Failed to persist recording state:", e);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getStatus") {
    getRecordingState().then((state) => {
      sendResponse({ recording: state.recording, startTime: state.startTime });
    });
    return true;
  }

  if (message.action === "startRecording") {
    handleStartRecording(message.tabId, message.streamId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "stopRecording") {
    handleStopRecording()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "offscreen-stopped") {
    return false;
  }
});

async function handleStartRecording(tabId, streamId) {
  const state = await getRecordingState();
  if (state.recording) throw new Error("Ya se está grabando");

  await setRecordingState(true, Date.now(), tabId);

  await ensureOffscreenDocument();
  await new Promise((r) => setTimeout(r, 300));

  chrome.runtime.sendMessage({
    action: "offscreen-start",
    streamId,
  });

  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });

  chrome.tabs.sendMessage(tabId, { action: "recordingStarted" }).catch(() => {});
}

async function handleStopRecording() {
  if (!await getRecordingState().then(s => s.recording)) {
    throw new Error("No se está grabando");
  }

  const state = await getRecordingState();
  const startTime = state.startTime;
  const activeTabId = state.activeTabId;

  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.action === "offscreen-stopped") {
        chrome.runtime.onMessage.removeListener(listener);

        if (stopTimeout) {
          clearTimeout(stopTimeout);
          stopTimeout = null;
        }

        setRecordingState(false, null, null);
        chrome.action.setBadgeText({ text: "" });

        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, { action: "recordingStopped" }).catch(() => {});
        }

        if (message.serverResult) {
          // Offscreen document already uploaded via FormData
          resolve({
            message: message.serverResult.message || "Transcripcion guardada",
            summary: message.serverResult.summary || "",
            sessionId: message.serverResult.sessionId || null,
          });
        } else if (message.audioBase64) {
          // Fallback: background.js uploads the base64 audio
          const durationMs = startTime ? Date.now() - startTime : null;
          sendToServer(message.audioBase64, durationMs).then(resolve).catch(reject);
        } else {
          reject(new Error(message.error || "No se capturó audio"));
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({ action: "offscreen-stop" });

    stopTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      setRecordingState(false, null, null);
      chrome.action.setBadgeText({ text: "" });
      reject(new Error("Timeout: el audio tardó demasiado en procesarse"));
    }, 120000);
  });
}

async function sendToServer(base64Audio, durationMs) {
  const MAX_ATTEMPTS = 3;
  let lastError;
  const { serverUrl, apiKey } = await getServerConfig();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }

      const response = await fetch(`${serverUrl}/transcribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          audio: base64Audio,
          timestamp: new Date().toISOString(),
          durationMs: durationMs || null,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Error ${response.status}: ${text}`);
        }
        throw new Error(`Server error ${response.status}: ${text}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (err.message.startsWith("Error 4")) throw err;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        console.log(`Attempt ${attempt} failed, retrying in ${backoff}ms...`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastError;
}

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Recording tab audio for meeting transcription",
  });
}

// Restore badge on service worker restart
chrome.runtime.onStartup.addListener(async () => {
  const state = await getRecordingState();
  if (state.recording) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
  }
});
