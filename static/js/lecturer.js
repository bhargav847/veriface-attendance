// Lecturer Command & 5-Minute OTP Attendance Session JavaScript

let currentLecturer = null;
let activeSession = null;
let timerInterval = null;
let pollingInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  // Check session storage
  const savedLecturer = sessionStorage.getItem("lecturer_auth");
  if (savedLecturer) {
    try {
      currentLecturer = JSON.parse(savedLecturer);
      unlockLecturerPortal();
    } catch (e) {
      sessionStorage.removeItem("lecturer_auth");
    }
  }

  // Login Form
  const loginForm = document.getElementById("lecturerLoginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleLecturerLogin();
    });
  }

  // Create Session Form
  const sessionForm = document.getElementById("createSessionForm");
  if (sessionForm) {
    sessionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleCreateSession();
    });
  }

  // Auto-generate OTP button
  const genOtpBtn = document.getElementById("btnGenerateRandomOtp");
  if (genOtpBtn) {
    genOtpBtn.addEventListener("click", () => {
      const codeInput = document.getElementById("customOtpCode");
      const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
      codeInput.value = randomCode;
    });
  }
});

async function handleLecturerLogin() {
  const idInput = document.getElementById("lecturerIdInput");
  const passInput = document.getElementById("lecturerPassInput");
  const errEl = document.getElementById("loginErrorMsg");

  const lecturerId = idInput.value.trim().toUpperCase();
  const password = passInput.value.trim();

  try {
    const res = await fetch("/api/lecturer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lecturer_id: lecturerId, password: password })
    });

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.detail || "Authentication failed.";
      errEl.classList.remove("hidden");
      return;
    }

    currentLecturer = data.lecturer;
    sessionStorage.setItem("lecturer_auth", JSON.stringify(currentLecturer));
    unlockLecturerPortal();
  } catch (err) {
    errEl.textContent = "Error connecting to server.";
    errEl.classList.remove("hidden");
  }
}

function unlockLecturerPortal() {
  document.getElementById("lecturerLoginModal").classList.add("hidden");
  document.getElementById("lecturerDashboard").classList.remove("hidden");

  // Display Lecturer Info
  document.getElementById("lecturerNameDisplay").textContent = currentLecturer.name;
  document.getElementById("lecturerIdDisplay").textContent = currentLecturer.lecturer_id;
  document.getElementById("lecturerDeptDisplay").textContent = currentLecturer.department || "Faculty";
  
  const subjInput = document.getElementById("sessionSubject");
  if (subjInput && currentLecturer.assigned_subject) {
    subjInput.value = currentLecturer.assigned_subject;
  }

  // Poll for any currently active session
  checkActiveSession();
}

function logoutLecturer() {
  sessionStorage.removeItem("lecturer_auth");
  location.reload();
}

async function handleCreateSession() {
  const subjInput = document.getElementById("sessionSubject");
  const codeInput = document.getElementById("customOtpCode");
  const durationInput = document.getElementById("sessionDuration");
  const errBox = document.getElementById("sessionErrorBox");

  const subject = subjInput.value.trim() || currentLecturer.assigned_subject || "General Lecture";
  let customCode = codeInput.value.trim().toUpperCase();
  const duration = parseInt(durationInput.value) || 5;

  if (!customCode) {
    customCode = Math.floor(100000 + Math.random() * 900000).toString();
    codeInput.value = customCode;
  }

  try {
    const res = await fetch("/api/lecturer/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lecturer_id: currentLecturer.lecturer_id,
        subject: subject,
        custom_code: customCode,
        duration_minutes: duration
      })
    });

    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.detail || "Failed to create session.";
      errBox.classList.remove("hidden");
      return;
    }

    errBox.classList.add("hidden");
    activeSession = data.session;
    startActiveSessionUI(data.session);

  } catch (err) {
    errBox.textContent = "Error launching session: " + err.message;
    errBox.classList.remove("hidden");
  }
}

async function checkActiveSession() {
  if (!currentLecturer) return;
  try {
    const res = await fetch(`/api/lecturer/active-session/${currentLecturer.lecturer_id}`);
    const data = await res.json();
    if (data.success && data.has_active_session) {
      activeSession = data.session;
      startActiveSessionUI(data.session);
    } else {
      stopActiveSessionUI();
    }
  } catch (err) {
    console.warn("Active session poll error:", err);
  }
}

function startActiveSessionUI(session) {
  // Hide configuration card, show active session live billboard
  document.getElementById("createSessionCard").classList.add("hidden");
  document.getElementById("activeSessionCard").classList.remove("hidden");

  // Display details
  document.getElementById("activeSessionOtpBillboard").textContent = session.session_code;
  document.getElementById("activeSessionSubject").textContent = session.subject;
  document.getElementById("activeSessionExpiresAt").textContent = session.expires_at;

  // Countdown timer
  let remainingSeconds = session.remaining_seconds || (session.duration_minutes * 60);
  updateTimerDisplay(remainingSeconds);

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remainingSeconds--;
    if (remainingSeconds <= 0) {
      clearInterval(timerInterval);
      handleSessionExpired();
    } else {
      updateTimerDisplay(remainingSeconds);
    }
  }, 1000);

  // Poll attendees in real-time every 3 seconds
  pollAttendees(session.id || session.session_id);
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(() => {
    pollAttendees(session.id || session.session_id);
  }, 3000);
}

function updateTimerDisplay(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const timerEl = document.getElementById("sessionCountdownTimer");
  if (!timerEl) return;

  timerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  
  if (totalSeconds <= 60) {
    timerEl.className = "text-5xl font-mono font-black text-rose-500 tracking-wider animate-pulse";
  } else if (totalSeconds <= 120) {
    timerEl.className = "text-5xl font-mono font-black text-amber-500 tracking-wider";
  } else {
    timerEl.className = "text-5xl font-mono font-black text-emerald-500 tracking-wider";
  }
}

async function pollAttendees(sessionId) {
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/lecturer/session-attendees/${sessionId}`);
    const data = await res.json();
    if (data.success) {
      renderAttendeesList(data.attendees || []);
    }
  } catch (e) {
    console.warn("Attendees fetch error:", e);
  }
}

function renderAttendeesList(attendees) {
  const container = document.getElementById("attendeesListContainer");
  const countBadge = document.getElementById("sessionAttendeeCount");
  
  if (countBadge) countBadge.textContent = attendees.length;
  if (!container) return;

  if (attendees.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 text-slate-400">
        <div class="text-3xl mb-2 animate-bounce">⏳</div>
        <p class="text-sm font-medium">Awaiting live student check-ins...</p>
        <p class="text-xs text-slate-500 mt-1">Students enter your OTP above and verify their face.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = "";
  attendees.forEach(att => {
    const timeOnly = att.timestamp ? att.timestamp.split(" ")[1] || att.timestamp : "";
    const card = document.createElement("div");
    card.className = "p-3 rounded-2xl glass-card border border-white/40 flex items-center justify-between transition-all hover:scale-[1.01]";
    
    let altDisplay = "";
    if (att.altitude) {
      altDisplay = `<span class="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded font-mono">Alt: ${Math.round(att.altitude)}m</span>`;
    }

    card.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${att.snapshot_path || '/static/models/placeholder.png'}" class="w-10 h-10 rounded-xl object-cover border border-emerald-400/50 shadow-sm" alt="Student" />
        <div>
          <div class="font-bold text-slate-900 text-sm">${att.name}</div>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="font-mono text-xs font-semibold text-blue-600">${att.roll_no}</span>
            ${altDisplay}
          </div>
        </div>
      </div>
      <div class="text-right">
        <span class="inline-flex items-center text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span> Verified
        </span>
        <div class="text-[10px] font-mono text-slate-400 mt-1">${timeOnly}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

function handleSessionExpired() {
  if (timerInterval) clearInterval(timerInterval);
  if (pollingInterval) clearInterval(pollingInterval);
  const timerEl = document.getElementById("sessionCountdownTimer");
  if (timerEl) {
    timerEl.textContent = "00:00 (EXPIRED)";
    timerEl.className = "text-3xl font-mono font-bold text-slate-400";
  }
  alert("Class Attendance Session has ended. 5-minute OTP expired.");
}

async function closeSessionEarly() {
  if (!activeSession) return;
  if (!confirm("Are you sure you want to lock and close this attendance session immediately?")) return;

  try {
    const sId = activeSession.id || activeSession.session_id;
    await fetch("/api/lecturer/close-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sId, lecturer_id: currentLecturer.lecturer_id })
    });
    stopActiveSessionUI();
  } catch (e) {
    alert("Error closing session: " + e.message);
  }
}

function stopActiveSessionUI() {
  if (timerInterval) clearInterval(timerInterval);
  if (pollingInterval) clearInterval(pollingInterval);
  activeSession = null;
  document.getElementById("activeSessionCard").classList.add("hidden");
  document.getElementById("createSessionCard").classList.remove("hidden");
  // Reset input
  document.getElementById("customOtpCode").value = "";
}
