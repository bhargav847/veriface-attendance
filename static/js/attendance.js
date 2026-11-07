// VeriFace: Biometric Attendance & Multi-Layer Anti-Proxy Engine
// Features: Eye Aspect Ratio (EAR) Blink Liveness Detection, High-Precision Multi-Fix GPS,
// Real-Time Empirical FPS Benchmark, Reverse Geocoding, and ResNet-34 128-D Biometric Matching.

let videoElement = null;
let canvasOverlay = null;
let stream = null;
let isScanning = false;

// Geolocation state
let geoCoordinates = { latitude: null, longitude: null, accuracy: null };
let geoStatus = "pending";
let geoWatchId = null;
let bestGeoAccuracy = Infinity;
let resolvedLocationAddress = "";
let lastGeocodeTimestamp = 0;

// Liveness & Eye Blink Reality Check state
let blinkCount = 0;
let isEyeClosed = false;
let livenessVerified = false;
let lastBlinkTimestamp = 0;
let currentEAR = 0.32;
let waitingForBlinkToScan = false;

// Empirical Benchmark state (Proof of Real-Time Throughput)
let frameCount = 0;
let lastFpsTime = performance.now();
let currentFPS = 0;
let currentLatencyMs = 0;
let activeBackend = "WebGL (Hardware Accelerated)";

// Synthetic Web Audio Synthesizer
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playAudioTone(toneType) {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (toneType === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
      osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.10); // E5
      osc.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.22); // G5
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.45);
    } else if (toneType === 'liveness') {
      // Pleasant double chirp confirming genuine eye blink
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
      osc.frequency.setValueAtTime(1174.66, audioCtx.currentTime + 0.08); // D6
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } else if (toneType === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, audioCtx.currentTime);
      osc.frequency.setValueAtTime(370, audioCtx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.4);
    } else if (toneType === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(280, audioCtx.currentTime);
      osc.frequency.setValueAtTime(220, audioCtx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.22, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.35);
    }
  } catch (e) {
    console.warn("Audio unavailable:", e);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  videoElement = document.getElementById("attVideo");
  canvasOverlay = document.getElementById("attCanvasOverlay");
  const scanBtn = document.getElementById("scanBtn");
  const rollInput = document.getElementById("rollNoInput");

  // Detect active TensorFlow.js backend
  detectTensorFlowBackend();

  // 1. Initialize High-Precision GPS with continuous multi-sampling
  initHighAccuracyGeolocation();

  // 2. Load Biometric & Landmark AI Models
  updateScannerStatus("Loading Neural AI Models...", "loading");
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri('/static/models');
    await faceapi.nets.faceLandmark68Net.loadFromUri('/static/models');
    await faceapi.nets.faceRecognitionNet.loadFromUri('/static/models');
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/static/models');
    updateScannerStatus("Models Loaded. Initializing Camera...", "loading");
    await startCamera();
  } catch (err) {
    console.error("Biometric model loading error:", err);
    updateScannerStatus("Failed to load face models. Please refresh page.", "error");
    return;
  }

  // Handle Enter key on Roll Number input
  rollInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      executeAttendanceVerification();
    }
  });

  scanBtn.addEventListener("click", () => {
    executeAttendanceVerification();
  });
});

// TensorFlow.js Backend Detection
function detectTensorFlowBackend() {
  try {
    if (window.tf && tf.getBackend) {
      const b = tf.getBackend();
      activeBackend = b ? `${b.toUpperCase()} (Hardware Accelerated)` : "WebGL";
    }
  } catch (e) {
    activeBackend = "WebGL / WebAssembly";
  }
}

// -------------------------------------------------------------
// 1. HIGH-PRECISION GEOLOCATION & REVERSE GEOCODING
// -------------------------------------------------------------
function initHighAccuracyGeolocation() {
  const geoBadge = document.getElementById("geoStatusBadge");
  if (!navigator.geolocation) {
    geoStatus = "unsupported";
    if (geoBadge) geoBadge.innerHTML = `<span class="text-amber-500 font-mono text-xs">⚠️ GPS Unsupported</span>`;
    return;
  }

  const geoOptions = {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 0 // Reject stale cached coordinates
  };

  // Immediate fix
  navigator.geolocation.getCurrentPosition(processGeoReading, handleGeoError, geoOptions);

  // Continuous watch to lock onto the highest-precision satellite/Wi-Fi fix
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = navigator.geolocation.watchPosition(processGeoReading, handleGeoError, geoOptions);
}

function processGeoReading(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const acc = pos.coords.accuracy;
  const alt = pos.coords.altitude;
  const altAcc = pos.coords.altitudeAccuracy;

  // Keep the most accurate fix (lowest error margin)
  if (acc <= bestGeoAccuracy || geoCoordinates.latitude === null) {
    bestGeoAccuracy = acc;
    geoCoordinates.latitude = lat;
    geoCoordinates.longitude = lon;
    geoCoordinates.accuracy = acc;
    geoCoordinates.altitude = alt;
    geoCoordinates.altitudeAccuracy = altAcc;
    geoStatus = "active";

    // Reverse geocode to campus / street building name
    fetchHumanReadableAddress(lat, lon);
  }

  renderGeoBadge(geoCoordinates.latitude, geoCoordinates.longitude, geoCoordinates.accuracy, geoCoordinates.altitude, geoCoordinates.altitudeAccuracy);
}

function handleGeoError(err) {
  console.warn("Geolocation warning:", err.message);
  geoStatus = "denied";
  const geoBadge = document.getElementById("geoStatusBadge");
  if (geoBadge) {
    geoBadge.innerHTML = `
      <span class="inline-flex items-center text-xs font-semibold text-red-400 bg-slate-900/90 backdrop-blur px-2.5 py-1 rounded-full border border-red-500/40">
        <span class="w-2 h-2 rounded-full bg-red-500 mr-1.5"></span>
        Location Perms Denied
      </span>
    `;
  }
}

function renderGeoBadge(lat, lon, accuracy, altitude, altitudeAccuracy) {
  const geoBadge = document.getElementById("geoStatusBadge");
  if (!geoBadge || lat === null) return;

  const accRound = Math.round(accuracy);
  let qualityBadge = "";
  let dotClass = "bg-emerald-400 animate-pulse";

  if (accRound <= 15) {
    qualityBadge = "Satellite Lock";
  } else if (accRound <= 50) {
    qualityBadge = "Wi-Fi Precision";
  } else {
    qualityBadge = "Optimizing GPS";
    dotClass = "bg-amber-400 animate-ping";
  }

  let altText = "";
  if (altitude !== null && altitude !== undefined) {
    const altAcc = altitudeAccuracy ? `±${Math.round(altitudeAccuracy)}m` : "";
    altText = ` • Alt: ${Math.round(altitude)}m ${altAcc}`;
  }

  geoBadge.innerHTML = `
    <span class="inline-flex items-center text-xs font-medium text-slate-200 bg-slate-900/90 backdrop-blur px-2.5 py-1 rounded-full border border-slate-700 shadow-md">
      <span class="w-2 h-2 rounded-full ${dotClass} mr-1.5"></span>
      <span>GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${accRound}m • ${qualityBadge}${altText})</span>
    </span>
  `;

  // Update physical address label if widget exists
  const addrWidget = document.getElementById("geoPhysicalAddress");
  if (addrWidget && resolvedLocationAddress) {
    addrWidget.textContent = `📍 ${resolvedLocationAddress} (Margin: ±${accRound}m${altText})`;
  }
}

async function fetchHumanReadableAddress(lat, lon) {
  if (Date.now() - lastGeocodeTimestamp < 12000) return; // Throttle to 12s
  lastGeocodeTimestamp = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.address) {
        const a = data.address;
        const place = a.building || a.amenity || a.university || a.college || a.road || "";
        const suburb = a.suburb || a.neighbourhood || a.city_district || "";
        const city = a.city || a.town || a.county || "";
        const parts = [place, suburb, city].filter(Boolean);
        resolvedLocationAddress = parts.join(", ") || data.display_name.split(",").slice(0, 3).join(", ");

        const addrWidget = document.getElementById("geoPhysicalAddress");
        if (addrWidget) {
          const accRound = Math.round(geoCoordinates.accuracy || 10);
          addrWidget.textContent = `📍 ${resolvedLocationAddress} (±${accRound}m)`;
        }
      }
    }
  } catch (e) {
    console.warn("Reverse geocode not available:", e);
  }
}

// -------------------------------------------------------------
// 2. CAMERA INITIALIZATION
// -------------------------------------------------------------
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
      isScanning = true;
      updateScannerStatus("Camera Active. Center face and blink eyes to verify liveness.", "ready");
      startFaceTrackingLoop();
    };
  } catch (err) {
    console.error("Camera access failed:", err);
    updateScannerStatus("Camera permission denied. Please allow camera permissions.", "error");
  }
}

// -------------------------------------------------------------
// 3. EYE ASPECT RATIO (EAR) MATHEMATICAL COMPUTATION
// -------------------------------------------------------------
function calculatePointDistance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculates the Eye Aspect Ratio (EAR) based on Soukupova and Cech (2016):
 * EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
 * eyePoints: Array of 6 landmark points [p1, p2, p3, p4, p5, p6]
 */
function calculateEyeAspectRatio(eyePoints) {
  const v1 = calculatePointDistance(eyePoints[1], eyePoints[5]);
  const v2 = calculatePointDistance(eyePoints[2], eyePoints[4]);
  const h = calculatePointDistance(eyePoints[0], eyePoints[3]);
  if (h === 0) return 0.30;
  return (v1 + v2) / (2.0 * h);
}

// -------------------------------------------------------------
// 4. REAL-TIME FACE TRACKING & DYNAMIC BLINK LIVENESS LOOP
// -------------------------------------------------------------
async function startFaceTrackingLoop() {
  const reticle = document.getElementById("hudReticle");
  const ovalGuide = document.getElementById("faceOvalGuide");
  const ctx = canvasOverlay.getContext("2d");
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.50 });

  async function loop() {
    if (!isScanning || !videoElement || videoElement.paused || videoElement.ended) {
      requestAnimationFrame(loop);
      return;
    }

    const frameStartTime = performance.now();

    try {
      const detection = await faceapi.detectSingleFace(videoElement, detectorOptions).withFaceLandmarks();
      ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

      if (detection) {
        const box = detection.detection.box;
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const frameCenterX = canvasOverlay.width / 2;
        const frameCenterY = canvasOverlay.height / 2;

        const isCentered = Math.abs(centerX - frameCenterX) < 130 && Math.abs(centerY - frameCenterY) < 110;
        const isGoodSize = box.width > 115 && box.height > 115;

        // Extract 68 landmark points
        const positions = detection.landmarks.positions;
        const leftEyePoints = [positions[36], positions[37], positions[38], positions[39], positions[40], positions[41]];
        const rightEyePoints = [positions[42], positions[43], positions[44], positions[45], positions[46], positions[47]];

        const leftEAR = calculateEyeAspectRatio(leftEyePoints);
        const rightEAR = calculateEyeAspectRatio(rightEyePoints);
        currentEAR = (leftEAR + rightEAR) / 2.0;

        // Draw Eye Landmark Contours on HUD Overlay
        drawEyeContours(ctx, leftEyePoints, isEyeClosed);
        drawEyeContours(ctx, rightEyePoints, isEyeClosed);

        // --- DYNAMIC BLINK STATE MACHINE ---
        // Threshold: EAR <= 0.21 indicates eyes closed; EAR >= 0.25 indicates eyes open
        if (currentEAR <= 0.21) {
          isEyeClosed = true;
          updateLivenessHUD("BLINKING", blinkCount, currentEAR);
        } else if (currentEAR >= 0.25 && isEyeClosed) {
          // Complete Blink Detected: Eyes transitioned from Open -> Closed -> Re-opened
          isEyeClosed = false;
          blinkCount++;
          livenessVerified = true;
          lastBlinkTimestamp = Date.now();
          playAudioTone('liveness');
          updateLivenessHUD("VERIFIED", blinkCount, currentEAR);

          // If user clicked 'Scan' and was waiting for liveness blink, trigger immediately!
          if (waitingForBlinkToScan) {
            waitingForBlinkToScan = false;
            executeAttendanceVerification();
          }
        } else {
          updateLivenessHUD(livenessVerified ? "VERIFIED" : "WAITING", blinkCount, currentEAR);
        }

        if (isCentered && isGoodSize) {
          reticle.classList.add("aligned");
          reticle.classList.remove("error");
          ovalGuide.classList.add("aligned");
          if (livenessVerified) {
            updateScannerStatus("Face Aligned & Liveness Confirmed. Ready to Check-in!", "aligned");
          } else {
            updateScannerStatus("Face Aligned. Please BLINK eyes for reality check.", "aligned");
          }
        } else {
          reticle.classList.remove("aligned", "error");
          ovalGuide.classList.remove("aligned");
          updateScannerStatus("Center your face inside the scanning guide...", "ready");
        }
      } else {
        reticle.classList.remove("aligned", "error");
        ovalGuide.classList.remove("aligned");
        updateScannerStatus("Looking for face... Please look directly at camera.", "ready");
        updateLivenessHUD("NO_FACE", blinkCount, 0);
      }
    } catch (e) {
      console.warn("Tracking frame exception:", e);
    }

    // Benchmark Throughput (FPS & Latency measurement)
    const frameEndTime = performance.now();
    currentLatencyMs = Math.round(frameEndTime - frameStartTime);
    frameCount++;
    if (frameEndTime - lastFpsTime >= 1000) {
      currentFPS = Math.round((frameCount * 1000) / (frameEndTime - lastFpsTime));
      frameCount = 0;
      lastFpsTime = frameEndTime;
      updateBenchmarkHUD(currentFPS, currentLatencyMs);
    }

    setTimeout(loop, 90);
  }

  loop();
}

// Draw eye landmark points on canvas
function drawEyeContours(ctx, points, closed) {
  ctx.save();
  ctx.strokeStyle = closed ? "#10b981" : "#38bdf8";
  ctx.fillStyle = closed ? "rgba(16, 185, 129, 0.4)" : "rgba(56, 189, 248, 0.25)";
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fill();

  // Draw points
  ctx.fillStyle = closed ? "#34d399" : "#bae6fd";
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, 2 * Math.PI);
    ctx.fill();
  });
  ctx.restore();
}

// Update the Liveness / Eye Blink HUD element
function updateLivenessHUD(state, count, earVal) {
  const badge = document.getElementById("livenessHUD");
  const icon = document.getElementById("livenessHUDIcon");
  const text = document.getElementById("livenessHUDText");
  const earMeter = document.getElementById("livenessEARValue");

  if (!badge) return;

  if (earMeter && earVal > 0) {
    earMeter.textContent = `EAR: ${earVal.toFixed(2)}`;
  }

  if (state === "VERIFIED") {
    badge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-emerald-950/85 backdrop-blur text-emerald-300 border border-emerald-500/50 shadow-md";
    icon.textContent = "✅";
    text.textContent = `Reality Check Passed (Live Eye Blink Confirmed • ${count}x)`;
  } else if (state === "BLINKING") {
    badge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-amber-950/85 backdrop-blur text-amber-300 border border-amber-500/50 shadow-md animate-pulse";
    icon.textContent = "👀";
    text.textContent = `Eye Blink in Progress... (Hold for transition)`;
  } else if (state === "WAITING") {
    badge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-slate-900/85 backdrop-blur text-amber-200 border border-amber-500/40 shadow-md";
    icon.textContent = "👁️";
    text.textContent = `Reality Check: Please BLINK eyes to verify human liveness`;
  } else {
    badge.className = "inline-flex items-center px-3.5 py-1.5 rounded-full text-xs font-semibold bg-slate-900/85 backdrop-blur text-slate-400 border border-slate-700 shadow-md";
    icon.textContent = "👤";
    text.textContent = `Face required for reality check`;
  }
}

function updateBenchmarkHUD(fps, latency) {
  const fpsEl = document.getElementById("hudBenchmarkFPS");
  const latencyEl = document.getElementById("hudBenchmarkLatency");
  if (fpsEl) fpsEl.textContent = `${fps} FPS`;
  if (latencyEl) latencyEl.textContent = `${latency}ms`;
}

// -------------------------------------------------------------
// 5. ATTENDANCE VERIFICATION ACTION (SSD MobileNet + ResNet-34)
// -------------------------------------------------------------
async function executeAttendanceVerification() {
  const rollInput = document.getElementById("rollNoInput");
  const sessionInput = document.getElementById("sessionCodeInput");
  const scanBtn = document.getElementById("scanBtn");
  const rollNo = rollInput.value.trim().toUpperCase();
  const sessionCode = sessionInput ? sessionInput.value.trim().toUpperCase() : "";

  if (!rollNo) {
    showScanAlert("Please enter your registered Roll Number.", "error");
    rollInput.focus();
    return;
  }

  if (!sessionCode) {
    showScanAlert("Class Session OTP is required! Please enter the 5-minute code provided by your lecturer.", "error");
    if (sessionInput) sessionInput.focus();
    return;
  }

  // --- ANTI-SPOOFING LIVENESS GATE ---
  // If user has not blinked yet within this active session:
  if (!livenessVerified) {
    playAudioTone('warning');
    waitingForBlinkToScan = true;
    scanBtn.disabled = true;
    scanBtn.className = "w-full py-3.5 px-6 rounded-2xl liquid-btn-amber text-white font-bold text-sm tracking-wide flex items-center justify-center transition-all animate-pulse";
    scanBtn.innerHTML = `
      <span class="mr-2 text-base">👁️</span>
      Please BLINK your eyes now to complete reality check...
    `;
    updateScannerStatus("Awaiting live eye blink for anti-spoofing reality check...", "loading");
    return;
  }

  waitingForBlinkToScan = false;

  // Visual scan state
  scanBtn.disabled = true;
  scanBtn.className = "w-full py-3.5 px-6 rounded-2xl liquid-btn-primary font-bold text-sm tracking-wide flex items-center justify-center transition-all opacity-85 cursor-wait";
  scanBtn.innerHTML = `
    <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
    </svg>
    Extracting 128-D Biometric Embedding...
  `;
  updateScannerStatus("Running SSD MobileNet V1 & ResNet-34 Biometric Extraction...", "loading");

  try {
    // 1. High precision face bounding box + 128-d descriptor extraction
    // SSD MobileNet V1 detects face bounding box; ResNet-34 extracts 128-point descriptor
    const detection = await faceapi
      .detectSingleFace(videoElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.65 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      playAudioTone('error');
      showScanAlert("High-accuracy face capture failed. Look directly into the camera in good lighting.", "error");
      resetScanBtn();
      return;
    }

    // 2. Capture high-res snapshot
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = videoElement.videoWidth;
    captureCanvas.height = videoElement.videoHeight;
    const cCtx = captureCanvas.getContext("2d");
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
    cCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
    const snapshotDataUrl = captureCanvas.toDataURL("image/jpeg", 0.90);

    // --- SILENT ADVANCED ANTI-SPOOFING: TEXTURE & SCREEN REFLECTION ANALYSIS ---
    // (Operates completely silently without cluttering the UI HUD)
    const { specularScore, textureScore, moireDetected } = analyzeFaceTextureAndScreenReflection(
      cCtx,
      detection.detection.box,
      captureCanvas.width,
      captureCanvas.height
    );

    const descriptorArray = Array.from(detection.descriptor);
    const deviceInfo = `${navigator.platform} | ${navigator.userAgent.slice(0, 80)}`;

    updateScannerStatus("Verifying Identity, 5-Min OTP & GPS Boundaries...", "loading");

    // 3. Post to backend
    const response = await fetch("/api/mark-attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roll_no: rollNo,
        session_code: sessionCode,
        face_descriptor: descriptorArray,
        snapshot_data_url: snapshotDataUrl,
        latitude: geoCoordinates.latitude,
        longitude: geoCoordinates.longitude,
        accuracy: geoCoordinates.accuracy,
        altitude: geoCoordinates.altitude,
        altitude_accuracy: geoCoordinates.altitudeAccuracy,
        device_info: deviceInfo,
        liveness_verified: livenessVerified,
        blink_count: blinkCount,
        location_address: resolvedLocationAddress || null,
        specular_score: specularScore,
        texture_score: textureScore,
        moire_detected: moireDetected,
        ear_value: parseFloat(currentEAR.toFixed(3))
      })
    });

    const data = await response.json();

    if (!response.ok) {
      playAudioTone('error');
      const errReticle = document.getElementById("hudReticle");
      if (errReticle) {
        errReticle.classList.add("error");
        setTimeout(() => errReticle.classList.remove("error"), 2500);
      }

      const msg = data.error || data.detail || "Authentication failed.";
      showScanAlert(msg, "error");
      resetScanBtn();
      return;
    }

    // 4. Handle Result
    if (data.already_marked) {
      playAudioTone('warning');
      showAlreadyMarkedModal(data.record);
    } else if (data.status === "FLAGGED_PROXY") {
      playAudioTone('warning');
      showVerificationResultModal(data.record, true);
    } else {
      playAudioTone('success');
      showVerificationResultModal(data.record, false);
    }

    resetScanBtn();

  } catch (err) {
    console.error("Attendance scan exception:", err);
    playAudioTone('error');
    showScanAlert("Verification error: " + err.message, "error");
    resetScanBtn();
  }
}

function resetScanBtn() {
  const scanBtn = document.getElementById("scanBtn");
  if (!scanBtn) return;
  scanBtn.disabled = false;
  scanBtn.className = "w-full py-3.5 px-6 rounded-2xl liquid-btn-primary font-bold text-sm tracking-wide flex items-center justify-center transition-all";
  scanBtn.innerHTML = `
    <i data-lucide="scan" class="w-5 h-5 mr-2 inline"></i>
    Scan Face & Mark Attendance
  `;
  if (window.lucide) lucide.createIcons();
}

function updateScannerStatus(text, state = "ready") {
  const statusBadge = document.getElementById("scannerStatusBadge");
  const statusText = document.getElementById("scannerStatusText");
  const dot = document.getElementById("scannerDot");

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

function showScanAlert(message, type = "error") {
  const box = document.getElementById("scanAlert");
  if (!box) return;

  const isErr = type === "error";
  box.innerHTML = `
    <div class="flex items-center p-4 rounded-xl border ${isErr ? 'bg-red-50 text-red-800 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'} shadow-sm">
      <span class="mr-3 text-lg">${isErr ? '❌' : '✅'}</span>
      <div class="flex-1 text-sm font-medium">${message}</div>
      <button onclick="document.getElementById('scanAlert').innerHTML=''" class="ml-2 text-gray-400 hover:text-gray-600 font-bold">✕</button>
    </div>
  `;
}

// -------------------------------------------------------------
// 6. RESULT MODAL PRESENTATION
// -------------------------------------------------------------
function showVerificationResultModal(record, isProxySuspect) {
  const modal = document.getElementById("resultModal");

  document.getElementById("resStudentName").textContent = record.name;
  document.getElementById("resRollNo").textContent = record.roll_no;
  document.getElementById("resDept").textContent = record.department || "General";
  document.getElementById("resTimestamp").textContent = record.timestamp;
  document.getElementById("resConfidence").textContent = `${record.match_confidence}%`;
  document.getElementById("resDistance").textContent = `${record.match_distance} (Threshold: 0.45)`;
  document.getElementById("resIP").textContent = record.ip_address || "127.0.0.1";
  document.getElementById("resLocation").textContent = record.location || "Coordinates captured";

  // Liveness reality check status
  const livenessEl = document.getElementById("resLivenessStatus");
  if (livenessEl) {
    if (record.liveness_verified) {
      livenessEl.innerHTML = `<span class="text-emerald-600 font-bold">✅ Verified (Eye Blink Confirmed • ${record.blink_count}x)</span>`;
    } else {
      livenessEl.innerHTML = `<span class="text-amber-600 font-bold">⚠️ Unverified (Static Scan)</span>`;
    }
  }

  // Session & Lecturer details
  const sessionEl = document.getElementById("resSessionDetails");
  if (sessionEl) {
    sessionEl.textContent = `${record.subject || 'Class Lecture'} • Faculty: ${record.lecturer_name || 'In-Charge'} (OTP: ${record.session_code || ''})`;
  }

  // Comparison Photos
  if (record.avatar_url) {
    const av = document.getElementById("resAvatarImg");
    if (av) av.src = record.avatar_url;
    const sm = document.getElementById("resAvatarImgSmall");
    if (sm) sm.src = record.avatar_url;
  }
  if (record.snapshot_url) {
    const snap = document.getElementById("resSnapshotImg");
    if (snap) snap.src = record.snapshot_url;
  }

  // Status Badge & Banner
  const statusBadge = document.getElementById("resStatusBadge");
  const proxyNotice = document.getElementById("resProxyNotice");

  if (isProxySuspect) {
    statusBadge.className = "inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300";
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500 mr-1.5"></span> FLAG: PROXY SUSPECT`;
    proxyNotice.classList.remove("hidden");
    document.getElementById("resProxyReason").textContent = record.proxy_flags || "Security flag triggered.";
  } else {
    statusBadge.className = "inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300";
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 mr-1.5"></span> VERIFIED PRESENT`;
    proxyNotice.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function showAlreadyMarkedModal(record) {
  const modal = document.getElementById("alreadyMarkedModal");
  document.getElementById("alreadyName").textContent = record.name;
  document.getElementById("alreadyRoll").textContent = record.roll_no;
  document.getElementById("alreadyTime").textContent = record.timestamp;
  document.getElementById("alreadyStatus").textContent = record.status;

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeResultModal() {
  const modal = document.getElementById("resultModal");
  modal.classList.remove("flex");
  modal.classList.add("hidden");
  document.getElementById("rollNoInput").value = "";
  document.getElementById("scanAlert").innerHTML = "";
  // Reset liveness for next person
  livenessVerified = false;
  blinkCount = 0;
  updateLivenessHUD("WAITING", 0, 0.3);
}

function closeAlreadyMarkedModal() {
  const modal = document.getElementById("alreadyMarkedModal");
  modal.classList.remove("flex");
  modal.classList.add("hidden");
  document.getElementById("rollNoInput").value = "";
  document.getElementById("scanAlert").innerHTML = "";
}

// -------------------------------------------------------------
// SILENT ADVANCED ANTI-SPOOFING: TEXTURE & SCREEN REFLECTION ANALYSIS
// Evaluates specular screen glare and high-frequency Moiré patterns
// Runs silently in memory without displaying intrusive UI elements.
// -------------------------------------------------------------
function analyzeFaceTextureAndScreenReflection(ctx, box, canvasWidth, canvasHeight) {
  try {
    // 1. Crop Region of Interest (Face Box)
    const startX = Math.max(0, Math.floor(box.x));
    const startY = Math.max(0, Math.floor(box.y));
    const boxW = Math.min(canvasWidth - startX, Math.floor(box.width));
    const boxH = Math.min(canvasHeight - startY, Math.floor(box.height));

    if (boxW < 20 || boxH < 20) {
      return { specularScore: 1.2, textureScore: 120.0, moireDetected: false };
    }

    const imgData = ctx.getImageData(startX, startY, boxW, boxH);
    const pixels = imgData.data;
    const totalPixels = boxW * boxH;

    // 2. Specular Glare & Luminance Analysis
    let specularPixelCount = 0;
    const lumaGrid = new Float32Array(totalPixels);

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      // ITU-R BT.601 perceptual luminance
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      lumaGrid[i / 4] = luma;

      // Pure specular blowout saturation (typical of glass screen reflection)
      if (r > 248 && g > 248 && b > 248) {
        specularPixelCount++;
      }
    }

    const specularScore = parseFloat(((specularPixelCount / totalPixels) * 100).toFixed(2));

    // 3. Discrete 2D Laplacian Variance (High-Frequency Micro-Texture)
    let lapSum = 0;
    let lapSqSum = 0;
    let validCount = 0;
    let moireEnergyCount = 0;

    for (let y = 1; y < boxH - 1; y++) {
      for (let x = 1; x < boxW - 1; x++) {
        const idx = y * boxW + x;
        const center = lumaGrid[idx];
        const lap = (4 * center) - lumaGrid[idx - 1] - lumaGrid[idx + 1] - lumaGrid[idx - boxW] - lumaGrid[idx + boxW];

        lapSum += lap;
        lapSqSum += lap * lap;
        validCount++;

        // Periodic Moiré interference detection (alternating subpixel contrast across consecutive columns)
        if (x > 2 && Math.abs(lumaGrid[idx] - lumaGrid[idx - 2]) > 32 && Math.abs(lumaGrid[idx] - lumaGrid[idx - 1]) > 32) {
          moireEnergyCount++;
        }
      }
    }

    const meanLap = lapSum / Math.max(1, validCount);
    const lapVariance = (lapSqSum / Math.max(1, validCount)) - (meanLap * meanLap);
    const textureScore = parseFloat(Math.max(0, lapVariance).toFixed(1));
    const moireDetected = (moireEnergyCount / Math.max(1, validCount)) > 0.09;

    return {
      specularScore,
      textureScore,
      moireDetected
    };
  } catch (err) {
    console.warn("Silent texture analysis fallback:", err);
    return { specularScore: 1.0, textureScore: 140.0, moireDetected: false };
  }
}

