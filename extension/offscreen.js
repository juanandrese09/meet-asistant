let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let sourceNode = null;
let capturedStream = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "offscreen-start") {
    startRecording(message.streamId);
  }
  if (message.action === "offscreen-stop") {
    stopRecording();
  }
});

async function startRecording(streamId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });

    capturedStream = stream;
    recordedChunks = [];

    // ⚠️ CRITICAL: when Chrome's tabCapture grabs audio via getUserMedia,
    // it REDIRECTS the audio stream away from the speakers (muting the tab
    // for the user). We must re-pipe it back through AudioContext so the
    // user keeps hearing the meeting while we record it.
    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(stream);
    sourceNode.connect(audioContext.destination);

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 128000,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onerror = (e) => {
      console.error("Offscreen: MediaRecorder error:", e);
    };

    mediaRecorder.start(1000);
    console.log("Offscreen: recording started (audio routed back to speakers)");
  } catch (err) {
    console.error("Offscreen: failed to start recording:", err);
    chrome.runtime.sendMessage({
      action: "offscreen-stopped",
      audioBase64: null,
      error: err.message,
    });
  }
}

function cleanup() {
  try {
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (audioContext && audioContext.state !== "closed") {
      audioContext.close();
    }
    audioContext = null;
    if (capturedStream) {
      capturedStream.getTracks().forEach((t) => t.stop());
      capturedStream = null;
    }
    mediaRecorder = null;
    recordedChunks = [];
  } catch (e) {
    console.error("Offscreen cleanup error:", e);
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    chrome.runtime.sendMessage({
      action: "offscreen-stopped",
      audioBase64: null,
      error: "No active recording",
    });
    cleanup();
    return;
  }

  mediaRecorder.onstop = async () => {
    // Validate we have actual audio content
    if (!recordedChunks.length) {
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: null,
        error: "No se capturó audio — verifica que la pestaña tenga sonido",
      });
      cleanup();
      return;
    }

    const blob = new Blob(recordedChunks, { type: "audio/webm" });

    if (blob.size < 2000) {
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: null,
        error: `Audio muy corto (${blob.size} bytes) — la grabación fue demasiado breve`,
      });
      cleanup();
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(",")[1];
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: base64,
        sizeBytes: blob.size,
      });
      cleanup();
    };
    reader.onerror = () => {
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: null,
        error: "Error leyendo el audio grabado",
      });
      cleanup();
    };
    reader.readAsDataURL(blob);
  };

  mediaRecorder.stop();
  console.log("Offscreen: recording stopped, processing...");
}
