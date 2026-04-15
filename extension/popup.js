const btn = document.getElementById("recordBtn");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const resultDiv = document.getElementById("result");
const resultText = document.getElementById("resultText");

let isRecording = false;

// Check current state on popup open
chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
  if (response?.recording) {
    setRecordingUI(true);
  }
});

btn.addEventListener("click", async () => {
  if (isRecording) {
    // Stop recording
    btn.disabled = true;
    btn.textContent = "Procesando...";
    statusText.textContent = "Deteniendo y enviando a transcribir...";

    resultDiv.classList.add("show");
    resultText.textContent = "Enviando audio al servidor...";

    chrome.runtime.sendMessage({ action: "stopRecording" }, (response) => {
      btn.disabled = false;
      setRecordingUI(false);

      if (response?.success) {
        resultDiv.querySelector(".label").textContent = "Transcripcion guardada";
        resultText.textContent = response.summary || response.message || "Listo";
      } else {
        resultDiv.querySelector(".label").textContent = "Error";
        resultText.textContent = response?.error || "Error desconocido";
      }
    });
  } else {
    // Get active tab first
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes("meet.google.com")) {
      statusText.textContent = "Abre una reunion de Google Meet primero";
      statusText.classList.add("active");
      setTimeout(() => {
        statusText.textContent = "Listo para grabar";
        statusText.classList.remove("active");
      }, 3000);
      return;
    }

    btn.disabled = true;
    statusText.textContent = "Iniciando captura de audio...";

    try {
      // IMPORTANT: Get streamId HERE in the popup, where the user gesture is valid
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

      // Send streamId to background to manage offscreen recording
      chrome.runtime.sendMessage(
        { action: "startRecording", tabId: tab.id, streamId },
        (response) => {
          btn.disabled = false;
          if (response?.success) {
            setRecordingUI(true);
          } else {
            statusText.textContent = response?.error || "Error al iniciar";
            statusText.classList.add("active");
          }
        }
      );
    } catch (err) {
      btn.disabled = false;
      statusText.textContent = "Error: " + err.message;
      statusText.classList.add("active");
      console.error("tabCapture error:", err);
    }
  }
});

function setRecordingUI(recording) {
  isRecording = recording;
  if (recording) {
    btn.textContent = "Detener grabacion";
    btn.classList.add("recording");
    statusText.textContent = "Grabando audio de la reunion...";
    statusText.classList.add("active");
    statusDot.classList.add("recording");
    resultDiv.classList.remove("show");
  } else {
    btn.textContent = "Iniciar grabacion";
    btn.classList.remove("recording");
    statusText.textContent = "Listo para grabar";
    statusText.classList.remove("active");
    statusDot.classList.remove("recording");
  }
}
