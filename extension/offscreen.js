let mediaRecorder = null;
let recordedChunks = [];

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

    recordedChunks = [];

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start(1000);
    console.log("Offscreen: recording started");
  } catch (err) {
    console.error("Offscreen: failed to start recording:", err);
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    chrome.runtime.sendMessage({
      action: "offscreen-stopped",
      audioBase64: null,
    });
    return;
  }

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });

    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(",")[1];
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: base64,
      });
    };
    reader.onerror = () => {
      chrome.runtime.sendMessage({
        action: "offscreen-stopped",
        audioBase64: null,
      });
    };
    reader.readAsDataURL(blob);

    // Stop all tracks
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    mediaRecorder = null;
    recordedChunks = [];
  };

  mediaRecorder.stop();
  console.log("Offscreen: recording stopped");
}
