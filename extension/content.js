// Content script: shows recording status on Google Meet pages
// Recording is controlled via the popup (required by tabCapture API)

let floatingBtn = null;
let isRecording = false;

function createFloatingButton() {
  if (floatingBtn) return;

  floatingBtn = document.createElement("div");
  floatingBtn.id = "meet-assistant-btn";
  floatingBtn.innerHTML = `
    <div class="ma-btn" id="ma-record-btn">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="8" cy="8" r="6"/>
      </svg>
      <span>Click extension para grabar</span>
    </div>
  `;
  document.body.appendChild(floatingBtn);

  // Clicking the floating button reminds to use popup
  document.getElementById("ma-record-btn").addEventListener("click", () => {
    if (isRecording) {
      // If recording, stop via background
      const btn = document.getElementById("ma-record-btn");
      btn.querySelector("span").textContent = "Procesando...";
      btn.classList.add("ma-processing");

      chrome.runtime.sendMessage({ action: "stopRecording" }, (response) => {
        isRecording = false;
        btn.classList.remove("ma-recording", "ma-processing");
        btn.querySelector("span").textContent = "Click extension para grabar";

        if (response?.success) {
          showNotification("Transcripcion guardada");
        } else {
          showNotification("Error: " + (response?.error || "desconocido"));
        }
      });
    } else {
      showNotification("Usa el icono de Meet Assistant en la barra de extensiones");
    }
  });
}

function showNotification(text) {
  const notif = document.createElement("div");
  notif.className = "ma-notification";
  notif.textContent = text;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 4000);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "recordingStarted") {
    isRecording = true;
    const btn = document.getElementById("ma-record-btn");
    if (btn) {
      btn.classList.add("ma-recording");
      btn.querySelector("span").textContent = "Grabando... (click para detener)";
    }
  }
  if (message.action === "recordingStopped") {
    isRecording = false;
    const btn = document.getElementById("ma-record-btn");
    if (btn) {
      btn.classList.remove("ma-recording");
      btn.querySelector("span").textContent = "Click extension para grabar";
    }
  }
});

// Check if already recording when page loads
chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
  if (response?.recording) {
    isRecording = true;
    const btn = document.getElementById("ma-record-btn");
    if (btn) {
      btn.classList.add("ma-recording");
      btn.querySelector("span").textContent = "Grabando... (click para detener)";
    }
  }
});

// Wait for Meet UI to load, then inject button
const observer = new MutationObserver(() => {
  if (document.querySelector('[data-call-active]') || document.querySelector('[data-meeting-id]') || document.querySelector('div[jscontroller]')) {
    createFloatingButton();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
setTimeout(createFloatingButton, 2000);
