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

  // Offline queue event listeners (Fix 6: weak campus Wi-Fi)
  window.addEventListener("online", flushOfflineCheckinQueue);
  setInterval(flushOfflineCheckinQueue, 5000);
  updateOfflineBanner();

  // Plain Browser Mode (Zero Cache) check (Fix 7: iOS Safari quirks)
  if (window.location.search.includes("mode=plain") || sessionStorage.getItem("plain_mode") === "true") {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let reg of registrations) reg.unregister();
      });
    }
  }
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
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: isMobile ? 640 : 1280 },
        height: { ideal: isMobile ? 480 : 720 },
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
    // Show iOS Safari guidance banner if on iPhone / iPad
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      const safariBanner = document.getElementById("safariHelpBanner");
      if (safariBanner) safariBanner.classList.remove("hidden");
    }
  }
}

// -------------------------------------------------------------
// 3. EYE ASPECT RATIO (EAR) MATHEMATICAL COMPUTATION
// -------------------------------------------------------------
function calculatePointDistance(p1, p2) {
  if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p2.x !== 'number') return 0;
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
  if (!eyePoints || eyePoints.length < 6) return 0.30;
  const v1 = calculatePointDistance(eyePoints[1], eyePoints[5]);
  const v2 = calculatePointDistance(eyePoints[2], eyePoints[4]);
  const h = calculatePointDistance(eyePoints[0], eyePoints[3]);
  if (h <= 0.001) return 0.30;
  const ear = (v1 + v2) / (2.0 * h);
  return isNaN(ear) ? 0.30 : Math.max(0.05, Math.min(0.50, ear));
}

// Real-Time Illumination & Lighting Evaluation (Fix 4: Low light & camera hints)
let lightSampleCanvas = null;
function evaluateLightingConditions() {
  if (!videoElement || videoElement.videoWidth === 0) return;
  try {
    if (!lightSampleCanvas) {
      lightSampleCanvas = document.createElement("canvas");
      lightSampleCanvas.width = 40;
      lightSampleCanvas.height = 30;
    }
    const lCtx = lightSampleCanvas.getContext("2d");
    lCtx.drawImage(videoElement, 0, 0, 40, 30);
    const imgData = lCtx.getImageData(0, 0, 40, 30).data;
    let totalLuma = 0;
    const pixelCount = imgData.length / 4;
    for (let i = 0; i < imgData.length; i += 4) {
      totalLuma += 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
    }
    const avgLuma = totalLuma / pixelCount;
    updateLightingTipBadge(avgLuma);
  } catch (e) {}
}

function updateLightingTipBadge(avgLuma) {
  const hud = document.getElementById("lightingHUD");
  const text = document.getElementById("lightingText");
  const icon = document.getElementById("lightingIcon");
  if (!hud || !text) return;

  if (avgLuma < 48) {
    hud.className = "pointer-events-auto inline-flex items-center px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-slate-900/90 backdrop-blur-md text-amber-300 border border-amber-500/50 shadow-md";
    if (icon) icon.textContent = "🌙";
    text.textContent = "Too Dim: Turn to light";
  } else if (avgLuma > 225) {
    hud.className = "pointer-events-auto inline-flex items-center px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-slate-900/90 backdrop-blur-md text-amber-300 border border-amber-500/50 shadow-md";
    if (icon) icon.textContent = "☀️";
    text.textContent = "Too Bright: Backlit";
  } else {
    hud.className = "pointer-events-auto inline-flex items-center px-2.5 sm:px-3 py-1 rounded-full text-[11px] sm:text-xs font-semibold bg-slate-900/90 backdrop-blur-md text-emerald-300 border border-emerald-500/40 shadow-md";
    if (icon) icon.textContent = "💡";
    text.textContent = "Lighting: Good";
  }
}

// -------------------------------------------------------------
// 4. REAL-TIME FACE TRACKING & DYNAMIC BLINK LIVENESS LOOP
// -------------------------------------------------------------
let loopFrameCounter = 0;
async function startFaceTrackingLoop() {
  const reticle = document.getElementById("hudReticle");
  const ovalGuide = document.getElementById("faceOvalGuide");
  const ctx = canvasOverlay.getContext("2d");
  
  // Low-end phone optimization (Fix 4): use 160px tensor on mobile for 3x speedup
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({ 
    inputSize: isMobile ? 160 : 224, 
    scoreThreshold: 0.38 
  });

  async function loop() {
    if (!isScanning || !videoElement || videoElement.paused || videoElement.ended) {
      requestAnimationFrame(loop);
      return;
    }

    loopFrameCounter++;
    if (loopFrameCounter % 15 === 0) {
      evaluateLightingConditions();
    }

    const frameStartTime = performance.now();

    try {
      const detection = await faceapi.detectSingleFace(videoElement, detectorOptions).withFaceLandmarks();
      ctx.clearRect(0, 0, canvasOverlay.width, canvasOverlay.height);

      if (detection && detection.detection && detection.landmarks && Array.isArray(detection.landmarks.positions)) {
        const box = detection.detection.box;
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        const frameCenterX = canvasOverlay.width / 2;
        const frameCenterY = canvasOverlay.height / 2;

        const isCentered = Math.abs(centerX - frameCenterX) < 130 && Math.abs(centerY - frameCenterY) < 110;
        const isGoodSize = box.width > 105 && box.height > 105;

        // Extract 68 landmark points
        const positions = detection.landmarks.positions;
        if (positions.length >= 68) {
          const leftEyePoints = [positions[36], positions[37], positions[38], positions[39], positions[40], positions[41]];
          const rightEyePoints = [positions[42], positions[43], positions[44], positions[45], positions[46], positions[47]];

          const leftEAR = calculateEyeAspectRatio(leftEyePoints);
          const rightEAR = calculateEyeAspectRatio(rightEyePoints);
          currentEAR = (leftEAR + rightEAR) / 2.0;

          // Draw Eye Landmark Contours on HUD Overlay
          drawEyeContours(ctx, leftEyePoints, isEyeClosed);
          drawEyeContours(ctx, rightEyePoints, isEyeClosed);

          // --- DYNAMIC BLINK STATE MACHINE ---
          // Threshold: EAR <= 0.22 indicates eyes closed; EAR >= 0.26 indicates eyes open
          if (currentEAR <= 0.22) {
            isEyeClosed = true;
            updateLivenessHUD("BLINKING", blinkCount, currentEAR);
          } else if (currentEAR >= 0.26 && isEyeClosed) {
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
      console.warn("Tracking frame exception (auto-recovering):", e);
    } finally {
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

      // Self-healing continuous loop: ALWAYS schedules next frame even if an error occurred
      setTimeout(loop, 80);
    }
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
  // Ensure the eye blink was recent (within the last 8 seconds) to prevent stale blinks from prior attempts
  const isRecentBlink = livenessVerified && (Date.now() - lastBlinkTimestamp < 8000);

  if (!isRecentBlink) {
    livenessVerified = false;
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
    // Attempt SSD MobileNet V1 first; if low-end phone struggles, fallback to TinyFaceDetector
    let detection = null;
    try {
      detection = await faceapi
        .detectSingleFace(videoElement, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.55 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    } catch (e) {
      console.warn("SSD MobileNet failed; falling back to TinyFaceDetector...", e);
    }

    if (!detection) {
      // Fast fallback for low-end devices
      detection = await faceapi
        .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    }

    if (!detection) {
      playAudioTone('error');
      showScanAlert("High-accuracy face capture failed. Look directly into the camera in good lighting.", "error");
      resetScanBtn();
      return;
    }

    // 2. Capture lightweight thumbnail snapshot (Fix 6: weak campus Wi-Fi)
    // Downscale from 1280x720 (1.5MB) down to 160x120 (~4KB)
    // 60 students submitting simultaneously will consume only 240KB total burst rather than 90MB!
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = 160;
    captureCanvas.height = 120;
    const cCtx = captureCanvas.getContext("2d");
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
    cCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
    const snapshotDataUrl = captureCanvas.toDataURL("image/jpeg", 0.50);

    // --- SILENT ADVANCED ANTI-SPOOFING: TEXTURE & SCREEN REFLECTION ANALYSIS ---
    const { specularScore, textureScore, moireDetected } = analyzeFaceTextureAndScreenReflection(
      cCtx,
      { x: 20, y: 15, width: 120, height: 90 },
      captureCanvas.width,
      captureCanvas.height
    );

    const descriptorArray = Array.from(detection.descriptor);
    const deviceInfo = `${navigator.platform} | ${navigator.userAgent.slice(0, 80)}`;
    const deviceId = getOrCreateDeviceId();

    updateScannerStatus("Verifying Identity, 30s OTP & GPS Boundaries...", "loading");

    const payload = {
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
      device_id: deviceId,
      liveness_verified: livenessVerified,
      blink_count: blinkCount,
      location_address: resolvedLocationAddress || null,
      specular_score: specularScore,
      texture_score: textureScore,
      moire_detected: moireDetected,
      ear_value: parseFloat(currentEAR.toFixed(3))
    };

    // 3. Post to backend
    let response;
    try {
      response = await fetch("/api/mark-attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (networkErr) {
      console.warn("Network post failed; queuing offline:", networkErr);
      queueOfflineCheckin(payload);
      resetScanBtn();
      return;
    }

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

// -------------------------------------------------------------
// HARDWARE DEVICE ID & OFFLINE CHECK-IN QUEUE (Fix 6 & Fix 8)
// -------------------------------------------------------------
function getOrCreateDeviceId() {
  let devId = localStorage.getItem("veriface_device_id");
  if (!devId) {
    devId = "dev_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now().toString(36);
    localStorage.setItem("veriface_device_id", devId);
  }
  return devId;
}

function queueOfflineCheckin(payload) {
  try {
    const queue = JSON.parse(localStorage.getItem("veriface_offline_queue") || "[]");
    queue.push({
      payload: payload,
      queuedAt: new Date().toISOString()
    });
    localStorage.setItem("veriface_offline_queue", JSON.stringify(queue));
    updateOfflineBanner();
    playAudioTone('warning');
    showScanAlert("Campus Wi-Fi is weak or offline. Check-in saved securely on device. Auto-submitting when connection returns...", "warning");
  } catch (e) {
    console.warn("Offline queue error:", e);
  }
}

async function flushOfflineCheckinQueue() {
  if (!navigator.onLine) return;
  const queue = JSON.parse(localStorage.getItem("veriface_offline_queue") || "[]");
  if (queue.length === 0) {
    updateOfflineBanner();
    return;
  }

  const item = queue.shift();
  try {
    const res = await fetch("/api/mark-attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.payload)
    });
    if (res.ok) {
      localStorage.setItem("veriface_offline_queue", JSON.stringify(queue));
      updateOfflineBanner();
      playAudioTone('success');
      showScanAlert(`Offline check-in for ${item.payload.roll_no} successfully synced to server!`, "success");
    } else {
      // Put back if server rejected temporarily
      queue.unshift(item);
      localStorage.setItem("veriface_offline_queue", JSON.stringify(queue));
    }
  } catch (err) {
    queue.unshift(item);
    localStorage.setItem("veriface_offline_queue", JSON.stringify(queue));
  }
}

function updateOfflineBanner() {
  const banner = document.getElementById("offlineSyncBanner");
  const countEl = document.getElementById("offlineCount");
  const queue = JSON.parse(localStorage.getItem("veriface_offline_queue") || "[]");
  if (banner && countEl) {
    if (queue.length > 0) {
      countEl.textContent = queue.length;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
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
// Evaluates specular screen glare, unnatural color dispersion, and high-frequency Moiré patterns
// Runs silently in memory without displaying intrusive UI elements.
// -------------------------------------------------------------
function analyzeFaceTextureAndScreenReflection(ctx, box, canvasWidth, canvasHeight) {
  try {
    // 1. Correct for canvas coordinate orientation (handle flipped canvas)
    // The detection box is relative to raw video stream.
    // In captureCanvas, width is canvasWidth. Since we drew with scale(-1, 1),
    // the horizontal coordinate of the face on the mirrored canvas is:
    // mirroredX = canvasWidth - (box.x + box.width)
    let startX = Math.floor(canvasWidth - (box.x + box.width));
    let startY = Math.floor(box.y);
    let boxW = Math.floor(box.width);
    let boxH = Math.floor(box.height);

    // Guard bounds
    startX = Math.max(0, Math.min(startX, canvasWidth - 10));
    startY = Math.max(0, Math.min(startY, canvasHeight - 10));
    boxW = Math.max(20, Math.min(boxW, canvasWidth - startX));
    boxH = Math.max(20, Math.min(boxH, canvasHeight - startY));

    const imgData = ctx.getImageData(startX, startY, boxW, boxH);
    const pixels = imgData.data;
    const totalPixels = boxW * boxH;

    // 2. Specular Glare, Luminance & Chromatic Discrepancy Analysis
    let specularPixelCount = 0;
    let unnaturalBlueScreenCount = 0;
    const lumaGrid = new Float32Array(totalPixels);

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      // ITU-R BT.601 perceptual luminance
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      lumaGrid[i / 4] = luma;

      // Check A: Glass screen reflection blowout (high luma or saturated highlights)
      if (luma > 238 || (r > 240 && g > 240 && b > 240)) {
        specularPixelCount++;
      }

      // Check B: Phone Screen Backlight / LED Color Imbalance
      // Real human skin in any lighting has R >= G >= B (melanin absorption curve).
      // Emissive screens displaying a photo often have excessive blue backlight subpixel peaks:
      if (b > r + 8 && b > 110) {
        unnaturalBlueScreenCount++;
      }
    }

    const specularRatio = (specularPixelCount / totalPixels) * 100;
    const blueRatio = (unnaturalBlueScreenCount / totalPixels) * 100;
    // Composite specular & screen glare index
    const specularScore = parseFloat((specularRatio + (blueRatio * 0.45)).toFixed(2));

    // 3. Discrete 2D Laplacian Variance (High-Frequency Micro-Texture & Moiré Analysis)
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
        if (x > 2 && Math.abs(lumaGrid[idx] - lumaGrid[idx - 2]) > 26 && Math.abs(lumaGrid[idx] - lumaGrid[idx - 1]) > 26) {
          moireEnergyCount++;
        }
      }
    }

    const meanLap = lapSum / Math.max(1, validCount);
    const lapVariance = (lapSqSum / Math.max(1, validCount)) - (meanLap * meanLap);
    const textureScore = parseFloat(Math.max(0, lapVariance).toFixed(1));
    const moireDetected = (moireEnergyCount / Math.max(1, validCount)) > 0.055;

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

// -------------------------------------------------------------
// INTERACTIVE VISUAL STUDENT ATTENDANCE CALENDAR ENGINE
// Renders full monthly matrix with day-by-day class attendance details
// -------------------------------------------------------------

let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth(); // 0-indexed (0 = Jan, 10 = Nov)
let studentAttendanceMap = {}; // Maps "YYYY-MM-DD" -> Array of lecture records
let selectedCalDate = null;
let currentStudentProfile = null;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function scrollToCalendarSection(event) {
  if (event) event.preventDefault();
  const section = document.getElementById("attendanceCalendarSection");
  if (!section) return;

  section.scrollIntoView({ behavior: "smooth", block: "start" });

  const mainRollInput = document.getElementById("rollNoInput");
  const calRollInput = document.getElementById("mainCalRollInput");
  const rollToUse = (mainRollInput && mainRollInput.value.trim()) || 
                    (calRollInput && calRollInput.value.trim()) || 
                    localStorage.getItem("veriface_student_roll") || 
                    "25021A0520";

  if (calRollInput) {
    calRollInput.value = rollToUse.toUpperCase();
    loadStudentCalendarByRoll(rollToUse);
  }
}

function selectQuickRoll(roll) {
  const input = document.getElementById("mainCalRollInput");
  if (input) input.value = roll.toUpperCase();
  loadStudentCalendarByRoll(roll);
}

function changeCalendarMonth(delta) {
  currentCalMonth += delta;
  if (currentCalMonth < 0) {
    currentCalMonth = 11;
    currentCalYear -= 1;
  } else if (currentCalMonth > 11) {
    currentCalMonth = 0;
    currentCalYear += 1;
  }
  renderCalendarGrid();
}

function jumpToCurrentMonth() {
  const now = new Date();
  currentCalYear = now.getFullYear();
  currentCalMonth = now.getMonth();
  renderCalendarGrid();
}

async function loadStudentCalendarByRoll(rollInput) {
  const roll = (rollInput || "").trim().toUpperCase();
  const container = document.getElementById("calGridDaysContainer");
  const banner = document.getElementById("mainCalStudentBanner");
  const detailsList = document.getElementById("calSelectedDayDetailsList");

  if (!roll) {
    if (container) {
      container.innerHTML = `<div class="col-span-7 py-8 text-center text-amber-500 font-bold text-xs">Please enter a valid Student Roll Number.</div>`;
    }
    return;
  }

  // Save to localStorage for persistence
  try {
    localStorage.setItem("veriface_student_roll", roll);
  } catch (e) {}

  if (container) {
    container.innerHTML = `
      <div class="col-span-7 py-12 text-center text-slate-400 text-xs">
        <svg class="animate-spin h-5 w-5 text-emerald-500 mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        Loading attendance records for <strong class="text-slate-800 dark:text-white">${roll}</strong>...
      </div>
    `;
  }

  try {
    const res = await fetch(`/api/student/history/${encodeURIComponent(roll)}`);
    const data = await res.json();

    if (!res.ok) {
      if (banner) banner.classList.add("hidden");
      if (container) {
        container.innerHTML = `<div class="col-span-7 p-6 text-center text-rose-500 font-bold text-xs">${data.detail || "Student not found."}</div>`;
      }
      if (detailsList) {
        detailsList.innerHTML = `<div class="p-6 text-center text-slate-400 text-xs">No attendance history found for ${roll}.</div>`;
      }
      return;
    }

    currentStudentProfile = data.student;
    studentAttendanceMap = {};

    // Group records by Date (YYYY-MM-DD)
    if (data.records && data.records.length > 0) {
      data.records.forEach(rec => {
        if (!studentAttendanceMap[rec.date]) {
          studentAttendanceMap[rec.date] = [];
        }
        studentAttendanceMap[rec.date].push(rec);
      });
    }

    // Populate Student Banner
    if (banner && currentStudentProfile) {
      banner.classList.remove("hidden");
      document.getElementById("mainCalStudentName").textContent = currentStudentProfile.name;
      document.getElementById("mainCalStudentRoll").textContent = currentStudentProfile.roll_no;
      document.getElementById("mainCalDepartment").textContent = currentStudentProfile.department || "Computer Science";
      document.getElementById("mainCalAttendedCount").textContent = `${data.total_attended} / ${data.total_sessions} Classes`;

      const rate = data.total_sessions > 0 ? Math.round((data.total_attended / data.total_sessions) * 100) : 0;
      document.getElementById("mainCalRate").textContent = `${rate}%`;

      const avatarEl = document.getElementById("mainCalAvatar");
      if (avatarEl) {
        if (currentStudentProfile.avatar_path) {
          avatarEl.innerHTML = `<img src="${currentStudentProfile.avatar_path}" class="w-full h-full object-cover" />`;
        } else {
          avatarEl.textContent = currentStudentProfile.name.charAt(0).toUpperCase();
        }
      }
    }

    // Default calendar view to latest attendance month and date
    if (data.records && data.records.length > 0) {
      const latestDateStr = data.records[0].date;
      const parts = latestDateStr.split("-").map(Number);
      if (parts.length === 3) {
        currentCalYear = parts[0];
        currentCalMonth = parts[1] - 1; // 0-indexed
        selectedCalDate = latestDateStr;
      }
    } else {
      const todayStr = getLocalDateString(new Date());
      selectedCalDate = todayStr;
    }

    renderCalendarGrid();
    renderSelectedDayDetails(selectedCalDate);

  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="col-span-7 p-6 text-center text-rose-500 font-bold text-xs">Error loading calendar: ${err.message}</div>`;
    }
  }
}

function getLocalDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderCalendarGrid() {
  const container = document.getElementById("calGridDaysContainer");
  const titleEl = document.getElementById("calMonthYearTitle");
  if (!container) return;

  if (titleEl) {
    titleEl.textContent = `${MONTH_NAMES[currentCalMonth]} ${currentCalYear}`;
  }

  // Calculate days
  const firstDayIndex = new Date(currentCalYear, currentCalMonth, 1).getDay(); // 0 = Sun, 1 = Mon...
  const daysInMonth = new Date(currentCalYear, currentCalMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(currentCalYear, currentCalMonth, 0).getDate();

  const todayStr = getLocalDateString(new Date());

  let html = "";

  // 1. Padding days from previous month
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const prevDayNum = daysInPrevMonth - i;
    html += `
      <div class="h-16 sm:h-20 p-1.5 rounded-xl border border-transparent bg-slate-100/30 dark:bg-slate-900/20 text-slate-300 dark:text-slate-700 opacity-40 select-none">
        <span class="text-[10px] font-bold block">${prevDayNum}</span>
      </div>
    `;
  }

  // 2. Actual days of the current month
  for (let day = 1; day <= daysInMonth; day++) {
    const monthStr = String(currentCalMonth + 1).padStart(2, "0");
    const dayStr = String(day).padStart(2, "0");
    const dateKey = `${currentCalYear}-${monthStr}-${dayStr}`;

    const recordsOnDay = studentAttendanceMap[dateKey] || [];
    const hasPresent = recordsOnDay.some(r => r.status === "PRESENT");
    const hasFlagged = recordsOnDay.some(r => r.status === "FLAGGED_PROXY");
    const hasRejected = recordsOnDay.some(r => r.status === "REJECTED");

    const isToday = (dateKey === todayStr);
    const isSelected = (dateKey === selectedCalDate);

    let cellBg = "bg-white/80 dark:bg-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-750";
    let borderStyle = isToday 
      ? "border-2 border-blue-500 shadow-sm" 
      : (isSelected ? "border-2 border-emerald-500 ring-2 ring-emerald-500/30" : "border border-slate-200/60 dark:border-white/10");

    let statusPill = "";

    if (hasPresent) {
      cellBg = "bg-emerald-50/90 dark:bg-emerald-950/40 hover:bg-emerald-100/90";
      const count = recordsOnDay.filter(r => r.status === "PRESENT").length;
      statusPill = `
        <div class="mt-1 px-1 py-0.5 rounded-md bg-emerald-600 text-white font-bold text-[9px] sm:text-[10px] flex items-center justify-center gap-0.5 shadow-xs">
          <span>✓</span>
          <span class="hidden sm:inline">${count} class${count > 1 ? 'es' : ''}</span>
        </div>
      `;
    } else if (hasFlagged) {
      cellBg = "bg-amber-50/90 dark:bg-amber-950/40 hover:bg-amber-100/90";
      statusPill = `
        <div class="mt-1 px-1 py-0.5 rounded-md bg-amber-500 text-white font-bold text-[9px] sm:text-[10px] flex items-center justify-center gap-0.5">
          <span>⚠️</span>
          <span class="hidden sm:inline">Proxy</span>
        </div>
      `;
    } else if (hasRejected) {
      cellBg = "bg-rose-50/90 dark:bg-rose-950/40 hover:bg-rose-100/90";
      statusPill = `
        <div class="mt-1 px-1 py-0.5 rounded-md bg-rose-500 text-white font-bold text-[9px] sm:text-[10px] flex items-center justify-center gap-0.5">
          <span>✕</span>
          <span class="hidden sm:inline">Failed</span>
        </div>
      `;
    }

    html += `
      <button 
        type="button" 
        onclick="selectCalendarDate('${dateKey}')" 
        class="h-16 sm:h-20 p-1.5 rounded-xl ${cellBg} ${borderStyle} transition-all flex flex-col justify-between text-left cursor-pointer group hover:scale-[1.02]"
      >
        <div class="flex items-center justify-between w-full">
          <span class="text-xs sm:text-sm font-black text-slate-800 dark:text-slate-100 ${isToday ? 'text-blue-600 dark:text-blue-400' : ''}">${day}</span>
          ${isToday ? '<span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>' : ''}
        </div>
        ${statusPill}
      </button>
    `;
  }

  // 3. Trailing blank cells to complete the 7-column row
  const totalCells = firstDayIndex + daysInMonth;
  const remainingCells = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remainingCells; i++) {
    html += `
      <div class="h-16 sm:h-20 p-1.5 rounded-xl border border-transparent bg-slate-100/30 dark:bg-slate-900/20 text-slate-300 dark:text-slate-700 opacity-40 select-none">
        <span class="text-[10px] font-bold block">${i}</span>
      </div>
    `;
  }

  container.innerHTML = html;
}

function selectCalendarDate(dateKey) {
  selectedCalDate = dateKey;
  renderCalendarGrid();
  renderSelectedDayDetails(dateKey);
}

function renderSelectedDayDetails(dateKey) {
  const titleEl = document.getElementById("calSelectedDateTitle");
  const countBadge = document.getElementById("calSelectedDayClassCount");
  const listEl = document.getElementById("calSelectedDayDetailsList");
  if (!listEl) return;

  if (!dateKey) {
    if (titleEl) titleEl.textContent = "Select a date";
    if (countBadge) countBadge.textContent = "0 Classes";
    listEl.innerHTML = `<div class="text-center py-16 text-slate-400 text-xs">Click any date on the calendar to view attendance records.</div>`;
    return;
  }

  // Safe Date parsing without UTC midnight shift
  const [y, m, d] = dateKey.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayName = !isNaN(dateObj.getTime()) ? DAY_NAMES[dateObj.getDay()] : "";
  const monthName = !isNaN(dateObj.getTime()) ? MONTH_NAMES[dateObj.getMonth()] : "";
  const formattedDate = `${dayName}, ${monthName} ${d}, ${y}`;

  if (titleEl) titleEl.textContent = formattedDate;

  const records = studentAttendanceMap[dateKey] || [];
  if (countBadge) countBadge.textContent = `${records.length} Class${records.length === 1 ? '' : 'es'}`;

  if (records.length === 0) {
    listEl.innerHTML = `
      <div class="text-center py-16 text-slate-400 text-xs">
        <div class="text-2xl mb-2">🏖️</div>
        <div class="font-bold text-slate-700 dark:text-slate-300 text-sm">No Attendance Logged</div>
        <p class="mt-1">No lectures or check-ins were recorded for this day.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = records.map((rec, idx) => {
    const isPresent = rec.status === "PRESENT";
    const isFlagged = rec.status === "FLAGGED_PROXY";

    let badgeClass = "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800";
    let statusText = "✓ Verified Present";

    if (isFlagged) {
      badgeClass = "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800";
      statusText = "⚠️ Flagged Proxy";
    } else if (!isPresent) {
      badgeClass = "bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border-rose-300 dark:border-rose-800";
      statusText = "✕ Rejected Mismatch";
    }

    const timeStr = rec.timestamp ? rec.timestamp.split(" ")[1] || rec.timestamp : "";

    return `
      <div class="p-3.5 rounded-2xl bg-white/80 dark:bg-slate-750/80 border border-slate-200/80 dark:border-white/10 shadow-sm flex flex-col gap-2 text-xs">
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Class Session #${idx + 1}</span>
            <h5 class="text-sm font-black text-slate-900 dark:text-white mt-0.5">${rec.subject || "General Class Lecture"}</h5>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border ${badgeClass} shrink-0">
            ${statusText}
          </span>
        </div>

        <div class="grid grid-cols-2 gap-2 text-[11px] text-slate-600 dark:text-slate-300 pt-1.5 border-t border-slate-200/40 dark:border-white/5">
          <div class="flex items-center gap-1.5">
            <span>👨‍🏫 Faculty:</span>
            <span class="font-bold text-slate-800 dark:text-white">${rec.lecturer_name || "Faculty Member"}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span>🕒 Check-in:</span>
            <span class="font-mono font-bold text-slate-800 dark:text-white">${timeStr}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span>🔑 OTP Code:</span>
            <span class="font-mono text-purple-600 dark:text-purple-400 font-bold">${rec.session_code || "N/A"}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span>🎯 Confidence:</span>
            <span class="font-mono text-blue-600 dark:text-blue-400 font-bold">${rec.match_confidence}%</span>
          </div>
        </div>

        ${rec.location_address ? `
          <div class="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1 truncate pt-1">
            <span>📍</span>
            <span class="truncate">${rec.location_address}</span>
          </div>
        ` : ""}
      </div>
    `;
  }).join("");
}

// Attach listener when document is ready
document.addEventListener("DOMContentLoaded", () => {
  const calRollInput = document.getElementById("mainCalRollInput");
  if (calRollInput) {
    calRollInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadStudentCalendarByRoll(calRollInput.value);
      }
    });

    // Auto-load student calendar if previously used or pre-fill default
    const savedRoll = localStorage.getItem("veriface_student_roll") || "25021A0520";
    calRollInput.value = savedRoll;
    loadStudentCalendarByRoll(savedRoll);
  }
});


