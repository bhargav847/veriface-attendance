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

    const onStreamReady = () => {
      videoElement.play().catch(e => console.warn("Video play error:", e));
      canvasOverlay.width = videoElement.videoWidth || 640;
      canvasOverlay.height = videoElement.videoHeight || 480;
      updateStatus("Sensor Active. Center your face.", "ready");
      startFaceTracking();
    };

    if (videoElement.readyState >= 1) {
      onStreamReady();
    } else {
      videoElement.onloadedmetadata = onStreamReady;
    }
  } catch (err) {
    console.error("Camera access failed:", err);
    updateStatus("Camera permission denied.", "error");
    showAlert("Please allow camera permissions in your browser or iOS settings to enroll Face ID.", "error");
  }
}

function startFaceTracking() {
  if (isDetecting) return;
  isDetecting = true;

  const ovalGuide = document.getElementById("faceOvalGuide");
  const hudReticle = document.getElementById("hudReticle");

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: isMobile ? 160 : 224,
    scoreThreshold: 0.32
  });

  const detectionInterval = setInterval(async () => {
    if (!modelsLoaded || !videoElement || videoElement.paused || videoElement.ended) return;

    const displaySize = { 
      width: videoElement.videoWidth || 640, 
      height: videoElement.videoHeight || 480 
    };

    if (canvasOverlay.width !== displaySize.width || canvasOverlay.height !== displaySize.height) {
      canvasOverlay.width = displaySize.width;
      canvasOverlay.height = displaySize.height;
    }
    faceapi.matchDimensions(canvasOverlay, displaySize);

    try {
      const detection = await faceapi
        .detectSingleFace(videoElement, detectorOptions)
        .withFaceLandmarks(true);

      const ctx = canvasOverlay.getContext("2d");
      ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

      if (detection && detection.detection) {
        const resized = faceapi.resizeResults(detection, displaySize);
        const box = resized.detection.box;

        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const targetX = displaySize.width / 2;
        const targetY = displaySize.height / 2;

        const distFromCenter = Math.hypot(centerX - targetX, centerY - targetY);
        // Generous, natural threshold so green outline activates smoothly
        const isCentered = distFromCenter < (displaySize.width * 0.28);
        const isGoodSize = box.width > (displaySize.width * 0.16) && box.width < (displaySize.width * 0.90);

        const isAligned = isCentered && isGoodSize;

        if (isAligned) {
          if (ovalGuide) ovalGuide.classList.add("aligned", "face-aligned");
          if (hudReticle) hudReticle.classList.add("aligned", "reticle-locked");
          updateStatus("Face Aligned! Ready to Register.", "aligned");
        } else {
          if (ovalGuide) ovalGuide.classList.remove("aligned", "face-aligned");
          if (hudReticle) hudReticle.classList.remove("aligned", "reticle-locked");
          updateStatus("Center your face inside the oval.", "ready");
        }

        // Live Dynamic Green / Cyan Visual Outline on HUD Canvas Overlay
        const outlineColor = isAligned ? "#10b981" : "#38bdf8";
        ctx.save();
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = isAligned ? 3.5 : 2;
        ctx.shadowColor = outlineColor;
        ctx.shadowBlur = isAligned ? 14 : 6;

        // Draw HUD Corner Brackets around face
        const pad = 12;
        const bx = Math.max(2, box.x - pad);
        const by = Math.max(2, box.y - pad);
        const bw = Math.min(displaySize.width - bx - 2, box.width + pad * 2);
        const bh = Math.min(displaySize.height - by - 2, box.height + pad * 2);
        const cr = Math.min(18, bw * 0.2);

        // Top-left
        ctx.beginPath();
        ctx.moveTo(bx, by + cr);
        ctx.arcTo(bx, by, bx + cr, by, cr);
        ctx.lineTo(bx + cr * 1.5, by);
        ctx.stroke();

        // Top-right
        ctx.beginPath();
        ctx.moveTo(bx + bw - cr * 1.5, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + cr, cr);
        ctx.lineTo(bx + bw, by + cr * 1.5);
        ctx.stroke();

        // Bottom-right
        ctx.beginPath();
        ctx.moveTo(bx + bw, by + bh - cr * 1.5);
        ctx.arcTo(bx + bw, by + bh, bx + bw - cr, by + bh, cr);
        ctx.lineTo(bx + bw - cr * 1.5, by + bh);
        ctx.stroke();

        // Bottom-left
        ctx.beginPath();
        ctx.moveTo(bx + cr * 1.5, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - cr, cr);
        ctx.lineTo(bx, by + bh - cr * 1.5);
        ctx.stroke();

        // High-tech Facial Landmarks Glow Points
        if (detection.landmarks && isAligned) {
          ctx.fillStyle = "#34d399";
          ctx.shadowColor = "#34d399";
          ctx.shadowBlur = 4;
          for (const pos of resized.landmarks.positions) {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 1.8, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
        ctx.restore();

      } else {
        if (ovalGuide) ovalGuide.classList.remove("aligned", "face-aligned");
        if (hudReticle) hudReticle.classList.remove("aligned", "reticle-locked");
        updateStatus("Looking for face... Look directly at camera.", "ready");
      }
    } catch (e) {
      // Skip frame safely
    }
  }, 100);
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
    Detecting Face & Computing 128-D Vector...
  `;

  updateStatus("Computing Biometric 128-D Descriptor...", "loading");

  try {
    let detection = null;

    // 1. Primary: High-accuracy SSD MobileNet
    try {
      detection = await faceapi
        .detectSingleFace(videoElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    } catch (e) {
      console.warn("SSD MobileNet pass skipped:", e);
    }

    // 2. High-speed Fallback: TinyFaceDetector (works on all phones and weak lighting)
    if (!detection) {
      try {
        detection = await faceapi
          .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.25 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
      } catch (e) {
        console.warn("TinyFaceDetector pass skipped:", e);
      }
    }

    // 3. Ultra-sensitive Fallback for small webcams
    if (!detection) {
      try {
        detection = await faceapi
          .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.20 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
      } catch (e) {
        console.warn("Ultra-sensitive detector skipped:", e);
      }
    }

    if (!detection) {
      playChime('error');
      showAlert("No clear face detected in the camera frame. Please face the camera directly in good lighting and try again.", "error");
      resetButton();
      return;
    }

    playChime('snap');

    // Create high-res avatar snapshot from video frame
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = videoElement.videoWidth || 640;
    captureCanvas.height = videoElement.videoHeight || 480;
    const cCtx = captureCanvas.getContext("2d");
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
    cCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);

    const avatarDataUrl = captureCanvas.toDataURL("image/jpeg", 0.85);
    const descriptorArray = Array.from(detection.descriptor);

    // Send to Backend
    updateStatus("Registering 128-D Biometrics to Database...", "loading");

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
