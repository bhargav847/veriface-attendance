// Face Registration & Face ID Enrollment Script
// Powered by face-api.js & HTML5 Canvas
// Fully Compliant with India's Digital Personal Data Protection (DPDP) Act 2023

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
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const constraints = {
      video: {
        facingMode: "user",
        width: { ideal: isMobile ? 640 : 1280 },
        height: { ideal: isMobile ? 480 : 720 }
      },
      audio: false
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = stream;

    videoElement.onloadedmetadata = () => {
      videoElement.play();
      canvasOverlay.width = videoElement.videoWidth;
      canvasOverlay.height = videoElement.videoHeight;
      updateStatus("Sensor Active. Center your face.", "ready");
      startFaceTracking();
    };
  } catch (err) {
    console.error("Camera access failed:", err);
    updateStatus("Camera permission denied.", "error");
    showAlert("Please allow camera permissions in your browser or iOS settings to enroll Face ID.", "error");
  }
}

function startFaceTracking() {
  if (isDetecting) return;
  isDetecting = true;

  const displaySize = { width: videoElement.videoWidth, height: videoElement.videoHeight };
  faceapi.matchDimensions(canvasOverlay, displaySize);

  const ovalGuide = document.getElementById("faceOvalGuide");
  const submitBtn = document.getElementById("captureBtn");
  const hudReticle = document.getElementById("hudReticle");

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: isMobile ? 160 : 224,
    scoreThreshold: 0.40
  });

  const detectionInterval = setInterval(async () => {
    if (!modelsLoaded || videoElement.paused || videoElement.ended) return;

    try {
      const detection = await faceapi
        .detectSingleFace(videoElement, detectorOptions)
        .withFaceLandmarks(true);

      const ctx = canvasOverlay.getContext("2d");
      ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

      if (detection) {
        const resized = faceapi.resizeResults(detection, displaySize);
        const box = resized.detection.box;

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const targetX = displaySize.width / 2;
        const targetY = displaySize.height / 2;

        const distFromCenter = Math.hypot(centerX - targetX, centerY - targetY);
        const isCentered = distFromCenter < (displaySize.width * 0.18);
        const isGoodSize = box.width > (displaySize.width * 0.22) && box.width < (displaySize.width * 0.85);

        if (isCentered && isGoodSize) {
          ovalGuide.classList.add("face-aligned");
          hudReticle.classList.add("reticle-locked");
          updateStatus("Face Aligned! Ready to Register.", "aligned");
          submitBtn.disabled = false;
          submitBtn.classList.remove("opacity-50", "cursor-not-allowed");
        } else {
          ovalGuide.classList.remove("face-aligned");
          hudReticle.classList.remove("reticle-locked");
          updateStatus("Center your face inside the oval.", "ready");
          submitBtn.disabled = true;
          submitBtn.classList.add("opacity-50", "cursor-not-allowed");
        }
      } else {
        ovalGuide.classList.remove("face-aligned");
        hudReticle.classList.remove("reticle-locked");
        updateStatus("No face detected. Look directly into camera.", "ready");
        submitBtn.disabled = true;
        submitBtn.classList.add("opacity-50", "cursor-not-allowed");
      }
    } catch (e) {
      // Frame skip
    }
  }, 120);
}

async function handleRegistration() {
  const rollNo = document.getElementById("rollNo").value.trim().toUpperCase();
  const fullName = document.getElementById("fullName").value.trim();
  const department = document.getElementById("department").value.trim();
  const consentBox = document.getElementById("dpdpConsentCheckbox");

  if (!consentBox || !consentBox.checked) {
    playChime('error');
    showAlert("Consent under India's DPDP Act 2023 is required before biometric enrollment.", "error");
    return;
  }

  if (!rollNo || !fullName) {
    showAlert("Please enter your Roll Number and Legal Name.", "error");
    return;
  }

  const submitBtn = document.getElementById("captureBtn");
  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <span class="inline-block animate-spin mr-2">🔄</span>
    Computing 128-D Biometric Embedding...
  `;

  updateStatus("Computing High-Accuracy 128-D Biometric Embedding...", "loading");

  try {
    const highAccDetection = await faceapi
      .detectSingleFace(videoElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
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
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
    cCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);

    const avatarDataUrl = captureCanvas.toDataURL("image/jpeg", 0.90);
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
        avatar_data_url: avatarDataUrl,
        dpdp_consent: true
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
    statusBadge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-500/50";
  } else if (state === "loading") {
    dot.className += "bg-amber-500 animate-ping";
    statusBadge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-amber-950/80 text-amber-300 border border-amber-500/50";
  } else if (state === "error") {
    dot.className += "bg-rose-500";
    statusBadge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-rose-950/80 text-rose-300 border border-rose-500/50";
  } else {
    dot.className += "bg-blue-500";
    statusBadge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-slate-900/85 backdrop-blur-md text-white border border-slate-700 shadow-lg";
  }
}

function showAlert(message, type = "error") {
  const container = document.getElementById("alertContainer");
  if (!container) return;

  const isErr = type === "error";
  container.innerHTML = `
    <div class="flex items-center p-3.5 rounded-2xl border ${isErr ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-800' : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800'} shadow-sm text-xs">
      <span class="mr-2.5 text-base">${isErr ? '⚠️' : '✅'}</span>
      <div class="flex-1 font-medium">${message}</div>
      <button onclick="document.getElementById('alertContainer').innerHTML=''" class="ml-2 text-slate-400 hover:text-slate-600">×</button>
    </div>
  `;
}

function showSuccessModal(user, avatarDataUrl) {
  const modal = document.getElementById("successModal");
  document.getElementById("modalStudentName").textContent = user.name;
  document.getElementById("modalStudentRoll").textContent = user.roll_no;
  document.getElementById("modalStudentDept").textContent = user.department;
  document.getElementById("modalStudentAvatar").src = avatarDataUrl || '/static/icons/default-avatar.png';

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  if (window.lucide) lucide.createIcons();
}

// --- DPDP Act 2023 Self-Service Right to Erasure Controls ---

function openErasureModal() {
  const modal = document.getElementById("erasureModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    const input = document.getElementById("erasureRollInput");
    if (input) {
      input.value = "";
      input.focus();
    }
    const alert = document.getElementById("erasureAlert");
    if (alert) alert.classList.add("hidden");
    if (window.lucide) lucide.createIcons();
  }
}

function closeErasureModal() {
  const modal = document.getElementById("erasureModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }
}

async function executeErasure() {
  const input = document.getElementById("erasureRollInput");
  const alertEl = document.getElementById("erasureAlert");
  const roll = input.value.trim().toUpperCase();

  if (!roll) {
    alertEl.textContent = "Please enter your Roll Number.";
    alertEl.className = "p-3 rounded-xl text-xs font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-200 border border-rose-200 block";
    return;
  }

  if (!confirm(`Are you completely sure you want to permanently erase all biometric data and face vectors for ${roll}? This action cannot be undone under DPDP Act 2023.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/student/delete-biometrics/${encodeURIComponent(roll)}`, {
      method: "DELETE"
    });
    const data = await res.json();

    if (!res.ok) {
      alertEl.textContent = data.detail || "Student not found or deletion failed.";
      alertEl.className = "p-3 rounded-xl text-xs font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-200 border border-rose-200 block";
      return;
    }

    alertEl.textContent = data.message;
    alertEl.className = "p-3 rounded-xl text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-200 border border-emerald-200 block";
    playChime('success');
    setTimeout(() => {
      closeErasureModal();
      location.reload();
    }, 2200);
  } catch (err) {
    alertEl.textContent = "Error: " + err.message;
    alertEl.className = "p-3 rounded-xl text-xs font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-200 border border-rose-200 block";
  }
}
