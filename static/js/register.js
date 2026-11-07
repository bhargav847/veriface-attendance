// Face Registration & Face ID Enrollment Script
// Powered by face-api.js & HTML5 Canvas

let videoElement = null;
let canvasOverlay = null;
let stream = null;
let modelsLoaded = false;
let isDetecting = false;
let currentDescriptor = null;
let capturedSnapshotData = null;

// Audio Chime Synthesizer using Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playChime(type = 'success') {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.12); // A5
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.4);
    } else if (type === 'snap') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
    }
  } catch (e) {
    console.warn("Audio playback not supported or user has not interacted.", e);
  }
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", async () => {
  videoElement = document.getElementById("regVideo");
  canvasOverlay = document.getElementById("regCanvasOverlay");
  const captureBtn = document.getElementById("captureBtn");
  const regForm = document.getElementById("registerForm");

  updateStatus("Loading Biometric AI Models...", "loading");

  try {
    // Load local weights
    await faceapi.nets.tinyFaceDetector.loadFromUri('/static/models');
    await faceapi.nets.faceLandmark68Net.loadFromUri('/static/models');
    await faceapi.nets.faceRecognitionNet.loadFromUri('/static/models');
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/static/models');
    modelsLoaded = true;
    updateStatus("AI Models Loaded. Requesting Camera Access...", "loading");
    await startCamera();
  } catch (err) {
    console.error("Model loading error:", err);
    updateStatus("Error loading face models. Refresh the page.", "error");
    return;
  }

  // Register Form Submit
  regForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleRegistration();
  });
});

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user"
      },
      audio: false
    });

    videoElement.srcObject = stream;
    videoElement.onloadedmetadata = () => {
      videoElement.play();
      canvasOverlay.width = videoElement.videoWidth;
      canvasOverlay.height = videoElement.videoHeight;
      isDetecting = true;
      updateStatus("Camera Ready. Align your face inside the guide.", "ready");
      startFaceTrackingLoop();
    };
  } catch (err) {
    console.error("Camera access failed:", err);
    updateStatus("Camera permission denied. Please allow camera access.", "error");
  }
}

// Continuous Face Tracking & Landmark Rendering
async function startFaceTrackingLoop() {
  const reticle = document.getElementById("hudReticle");
  const ovalGuide = document.getElementById("faceOvalGuide");
  const captureBtn = document.getElementById("captureBtn");
  const ctx = canvasOverlay.getContext("2d");

  const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

  async function track() {
    if (!isDetecting || !videoElement || videoElement.paused || videoElement.ended) {
      requestAnimationFrame(track);
      return;
    }

    try {
      const detection = await faceapi.detectSingleFace(videoElement, detectorOptions).withFaceLandmarks();
      ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

      if (detection) {
        const box = detection.detection.box;
        const score = Math.round(detection.detection.score * 100);

        // Check if face is centered and of good size
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const frameCenterX = canvasOverlay.width / 2;
        const frameCenterY = canvasOverlay.height / 2;

        const isCentered = Math.abs(centerX - frameCenterX) < 120 && Math.abs(centerY - frameCenterY) < 100;
        const isGoodSize = box.width > 120 && box.height > 120;

        if (isCentered && isGoodSize) {
          reticle.classList.add("aligned");
          reticle.classList.remove("error");
          ovalGuide.classList.add("aligned");
          captureBtn.disabled = false;
          captureBtn.classList.remove("opacity-50", "cursor-not-allowed");
          updateStatus(`Face Aligned & Detected (${score}% confidence). Ready to Register!`, "aligned");
        } else {
          reticle.classList.remove("aligned", "error");
          ovalGuide.classList.remove("aligned");
          captureBtn.disabled = true;
          captureBtn.classList.add("opacity-50", "cursor-not-allowed");
          updateStatus("Center your face inside the oval frame...", "ready");
        }
      } else {
        reticle.classList.remove("aligned", "error");
        ovalGuide.classList.remove("aligned");
        captureBtn.disabled = true;
        captureBtn.classList.add("opacity-50", "cursor-not-allowed");
        updateStatus("Looking for face... Please look directly at camera.", "ready");
      }
    } catch (e) {
      console.warn("Detection frame error:", e);
    }

    setTimeout(track, 100);
  }

  track();
}

async function handleRegistration() {
  const rollInput = document.getElementById("rollNo");
  const nameInput = document.getElementById("fullName");
  const deptInput = document.getElementById("department");
  const submitBtn = document.getElementById("captureBtn");
  const alertContainer = document.getElementById("alertContainer");

  const rollNo = rollInput.value.trim().toUpperCase();
  const fullName = nameInput.value.trim();
  const department = deptInput.value.trim() || "Computer Science";

  if (!rollNo || !fullName) {
    showAlert("Please enter your Roll Number and Full Name.", "error");
    return;
  }

  // Freeze button & update UI
  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
    </svg>
    Extracting Biometric Face ID...
  `;

  try {
    // High accuracy extraction using SSD MobileNet V1
    const highAccDetection = await faceapi
      .detectSingleFace(videoElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.7 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!highAccDetection) {
      playChime('error');
      showAlert("High-accuracy face capture failed. Keep your face steady, well-lit, and facing forward.", "error");
      resetButton();
      return;
    }

    playChime('snap');

    // Create high-res avatar snapshot from video frame
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = videoElement.videoWidth;
    captureCanvas.height = videoElement.videoHeight;
    const cCtx = captureCanvas.getContext("2d");
    // Flip horizontally so avatar looks natural as viewed in mirror
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
    cCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);

    const avatarDataUrl = captureCanvas.toDataURL("image/jpeg", 0.92);
    const descriptorArray = Array.from(highAccDetection.descriptor);

    // Send to Backend
    updateStatus("Transmitting Biometric Credentials to Database...", "loading");

    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roll_no: rollNo,
        name: fullName,
        department: department,
        face_descriptor: descriptorArray,
        avatar_data_url: avatarDataUrl
      })
    });

    const result = await response.json();

    if (!response.ok) {
      playChime('error');
      showAlert(result.detail || "Registration failed. Please try again.", "error");
      resetButton();
      return;
    }

    // Success! Show confirmation card
    playChime('success');
    showSuccessModal(result.user, avatarDataUrl);

  } catch (err) {
    console.error("Registration error:", err);
    playChime('error');
    showAlert("Network or server error during registration: " + err.message, "error");
    resetButton();
  }
}

function resetButton() {
  const submitBtn = document.getElementById("captureBtn");
  submitBtn.disabled = false;
  submitBtn.innerHTML = `
    <i data-lucide="scan-face" class="w-5 h-5 mr-2 inline"></i>
    Capture & Register Face ID
  `;
  if (window.lucide) lucide.createIcons();
}

function updateStatus(text, state = "ready") {
  const statusBadge = document.getElementById("cameraStatusBadge");
  const statusText = document.getElementById("cameraStatusText");
  const dot = document.getElementById("statusDot");

  if (!statusBadge || !statusText) return;

  statusText.textContent = text;
  dot.className = "w-2.5 h-2.5 rounded-full mr-2 ";

  if (state === "aligned") {
    dot.className += "bg-emerald-500 animate-pulse";
    statusBadge.className = "inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200";
  } else if (state === "loading") {
    dot.className += "bg-amber-500 animate-ping";
    statusBadge.className = "inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200";
  } else if (state === "error") {
    dot.className += "bg-red-500";
    statusBadge.className = "inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200";
  } else {
    dot.className += "bg-blue-500";
    statusBadge.className = "inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200";
  }
}

function showAlert(message, type = "error") {
  const container = document.getElementById("alertContainer");
  if (!container) return;

  const isErr = type === "error";
  container.innerHTML = `
    <div class="flex items-center p-4 rounded-xl border ${isErr ? 'bg-red-50 text-red-800 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'} shadow-sm">
      <span class="mr-3 text-lg">${isErr ? '⚠️' : '✅'}</span>
      <div class="flex-1 text-sm font-medium">${message}</div>
      <button onclick="document.getElementById('alertContainer').innerHTML=''" class="ml-2 text-gray-400 hover:text-gray-600">×</button>
    </div>
  `;
}

function showSuccessModal(user, avatarDataUrl) {
  const modal = document.getElementById("successModal");
  document.getElementById("modalStudentName").textContent = user.name;
  document.getElementById("modalStudentRoll").textContent = user.roll_no;
  document.getElementById("modalStudentDept").textContent = user.department;
  document.getElementById("modalStudentAvatar").src = avatarDataUrl;

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}
