let recording = false;
let activeTabId = null;
let stopTimeout = null;

// Server URL Configuration
// Production (Vercel): https://meet-asistant.vercel.app
// Local development: http://localhost:3456
const SERVER_URL = "https://meet-asistant.vercel.app";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getStatus") {
    sendResponse({ recording });
    return true;
  }

  if (message.action === "startRecording") {
    // streamId already obtained by popup (user gesture context)
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

  // Offscreen document sends back audio data
  if (message.action === "offscreen-stopped") {
    // Handled by the one-time listener in handleStopRecording
    return false;
  }
});

async function handleStartRecording(tabId, streamId) {
  if (recording) throw new Error("Ya se está grabando");

  activeTabId = tabId;

  // Create offscreen document
  await ensureOffscreenDocument();

  // Small delay to ensure offscreen document is ready
  await new Promise((r) => setTimeout(r, 300));

  // Tell offscreen to start recording with the stream ID
  chrome.runtime.sendMessage({
    action: "offscreen-start",
    streamId,
  });

  recording = true;

  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });

  // Notify content script
  chrome.tabs.sendMessage(tabId, { action: "recordingStarted" }).catch(() => {});
}

async function handleStopRecording() {
  if (!recording) throw new Error("No se está grabando");

  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.action === "offscreen-stopped") {
        chrome.runtime.onMessage.removeListener(listener);

        // Clear timeout if set
        if (stopTimeout) {
          clearTimeout(stopTimeout);
          stopTimeout = null;
        }

        recording = false;
        chrome.action.setBadgeText({ text: "" });

        if (activeTabId) {
          chrome.tabs.sendMessage(activeTabId, { action: "recordingStopped" }).catch(() => {});
        }

        if (message.audioBase64) {
          sendToServer(message.audioBase64).then(resolve).catch(reject);
        } else {
          resolve({ message: "Grabación detenida (sin audio)" });
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Tell offscreen to stop
    chrome.runtime.sendMessage({ action: "offscreen-stop" });

    // Timeout (will be cleared when the offscreen response arrives)
    const stopTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      recording = false;
      chrome.action.setBadgeText({ text: "" });
      reject(new Error("Timeout esperando audio"));
    }, 30000);
  });
}

async function sendToServer(base64Audio) {
  const response = await fetch(`${SERVER_URL}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: base64Audio,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server error ${response.status}: ${text}`);
  }
  return await response.json();
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
