let recording = false;
let activeTabId = null;
let stopTimeout = null;
let recordingStartTime = null;

const SERVER_URL = "https://meet-asistant.vercel.app";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getStatus") {
    sendResponse({ recording, startTime: recordingStartTime });
    return true;
  }

  if (message.action === "startRecording") {
    handleStartRecording(message.tabId, message.streamId)
      .then(() => sendResponse({ success: true, startTime: recordingStartTime }))
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
    // Handled by the one-time listener in handleStopRecording
    return false;
  }
});

async function handleStartRecording(tabId, streamId) {
  if (recording) throw new Error("Ya se está grabando");

  activeTabId = tabId;

  await ensureOffscreenDocument();
  await new Promise((r) => setTimeout(r, 300));

  chrome.runtime.sendMessage({
    action: "offscreen-start",
    streamId,
  });

  recording = true;
  recordingStartTime = Date.now();

  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });

  chrome.tabs.sendMessage(tabId, { action: "recordingStarted" }).catch(() => {});
}

async function handleStopRecording() {
  if (!recording) throw new Error("No se está grabando");

  const startTime = recordingStartTime;

  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.action === "offscreen-stopped") {
        chrome.runtime.onMessage.removeListener(listener);

        if (stopTimeout) {
          clearTimeout(stopTimeout);
          stopTimeout = null;
        }

        recording = false;
        recordingStartTime = null;
        chrome.action.setBadgeText({ text: "" });

        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, { action: "recordingStopped" }).catch(() => {});
        }

        if (message.audioBase64) {
          const durationMs = startTime ? Date.now() - startTime : null;
          sendToServer(message.audioBase64, durationMs).then(resolve).catch(reject);
        } else {
          reject(new Error(message.error || "No se capturó audio"));
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({ action: "offscreen-stop" });

    // Longer timeout to handle big recordings + server transcription
    stopTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      recording = false;
      recordingStartTime = null;
      chrome.action.setBadgeText({ text: "" });
      reject(new Error("Timeout: el audio tardó demasiado en procesarse"));
    }, 120000); // 2 min
  });
}

// Retry with exponential backoff for network/server errors
async function sendToServer(base64Audio, durationMs) {
  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${SERVER_URL}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64Audio,
          timestamp: new Date().toISOString(),
          durationMs: durationMs || null,
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // Don't retry on 4xx — it's a client-side problem
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Error ${response.status}: ${text}`);
        }
        throw new Error(`Server error ${response.status}: ${text}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      // Don't retry on 4xx
      if (err.message.startsWith("Error 4")) throw err;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
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
