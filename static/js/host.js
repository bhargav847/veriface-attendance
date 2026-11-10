// Host & Admin Oversight Portal JavaScript
// Real-time audit, Biometric comparison, Geofencing, Anti-Proxy controls, and Faculty Management

let isHostAuthenticated = false;
let currentAttendanceLogs = [];
let currentLogInspect = null;

document.addEventListener("DOMContentLoaded", () => {
  // Check session storage or localStorage for persistent host session
  if (sessionStorage.getItem("host_auth") === "true" || localStorage.getItem("host_auth") === "true") {
    unlockHostDashboard();
  }

  // Set default date in date picker
  const todayStr = new Date().toISOString().split("T")[0];
  const dateInput = document.getElementById("logDateFilter");
  if (dateInput) dateInput.value = todayStr;

  // Pin Form
  const pinForm = document.getElementById("hostPinForm");
  if (pinForm) {
    pinForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handlePinLogin();
    });
  }

  // Filter Event Listeners
  if (dateInput) {
    dateInput.addEventListener("change", loadAttendanceLogs);
  }
  const statusFilter = document.getElementById("logStatusFilter");
  if (statusFilter) {
    statusFilter.addEventListener("change", loadAttendanceLogs);
  }
  const searchInput = document.getElementById("logSearchInput");
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadAttendanceLogs, 300);
    });
  }

  // Settings Form
  const settingsForm = document.getElementById("settingsForm");
  if (settingsForm) {
    settingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveSettings();
    });
  }

  // Faculty / Lecturer Registration Form
  const lecturerForm = document.getElementById("createLecturerForm");
  if (lecturerForm) {
    lecturerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleCreateLecturer();
    });
  }
});

async function handlePinLogin() {
  const pinInput = document.getElementById("hostPinInput");
  const errorMsg = document.getElementById("pinErrorMsg");
  const pin = pinInput.value.trim();

  try {
    const res = await fetch("/api/host/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin })
    });

    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.detail || "Invalid PIN. Try again.";
      errorMsg.classList.remove("hidden");
      pinInput.value = "";
      return;
    }

    sessionStorage.setItem("host_auth", "true");
    localStorage.setItem("host_auth", "true");
    unlockHostDashboard();
  } catch (err) {
    errorMsg.textContent = "Error connecting to server.";
    errorMsg.classList.remove("hidden");
  }
}

function unlockHostDashboard() {
  isHostAuthenticated = true;
  document.getElementById("hostAuthModal").classList.add("hidden");
  document.getElementById("hostDashboardContainer").classList.remove("hidden");

  // Load Initial Data
  loadDashboardStats();
  loadAttendanceLogs();
  loadStudentsList();
  loadLecturersList();
  loadSettings();
}

function logoutHost() {
  sessionStorage.removeItem("host_auth");
  localStorage.removeItem("host_auth");
  location.reload();
}

// Switch Dashboard Tabs
function switchTab(tabName) {
  const tabs = ["logsTab", "studentsTab", "lecturersTab", "settingsTab", "livenessTab"];
  const navBtns = ["btnTabLogs", "btnTabStudents", "btnTabLecturers", "btnTabSettings", "btnTabLiveness"];

  tabs.forEach(t => {
    const el = document.getElementById(t);
    if (el) el.classList.add("hidden");
  });

  navBtns.forEach(b => {
    const el = document.getElementById(b);
    if (el) {
      el.className = "px-4 py-3 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border-b-2 border-transparent transition-all flex items-center gap-2 shrink-0";
    }
  });

  if (tabName === 'logs') {
    document.getElementById("logsTab").classList.remove("hidden");
    document.getElementById("btnTabLogs").className = "px-4 py-3 text-sm font-bold text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 transition-all flex items-center gap-2 shrink-0";
    loadAttendanceLogs();
  } else if (tabName === 'students') {
    document.getElementById("studentsTab").classList.remove("hidden");
    document.getElementById("btnTabStudents").className = "px-4 py-3 text-sm font-bold text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 transition-all flex items-center gap-2 shrink-0";
    loadStudentsList();
  } else if (tabName === 'lecturers') {
    document.getElementById("lecturersTab").classList.remove("hidden");
    document.getElementById("btnTabLecturers").className = "px-4 py-3 text-sm font-bold text-purple-600 dark:text-purple-400 border-b-2 border-purple-600 dark:border-purple-400 transition-all flex items-center gap-2 shrink-0";
    loadLecturersList();
  } else if (tabName === 'settings') {
    document.getElementById("settingsTab").classList.remove("hidden");
    document.getElementById("btnTabSettings").className = "px-4 py-3 text-sm font-bold text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 transition-all flex items-center gap-2 shrink-0";
    loadSettings();
  } else if (tabName === 'liveness') {
    document.getElementById("livenessTab").classList.remove("hidden");
    document.getElementById("btnTabLiveness").className = "px-4 py-3 text-sm font-bold text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-600 dark:border-emerald-400 transition-all flex items-center gap-2 shrink-0";
    loadLivenessStats();
    loadLivenessProfiles();
  }
  
  if (window.lucide) lucide.createIcons();
}

// Load KPI Stats
async function loadDashboardStats() {
  const dateInput = document.getElementById("logDateFilter");
  const dateVal = dateInput ? dateInput.value : "";

  try {
    const res = await fetch(`/api/host/stats?date=${dateVal}`);
    const data = await res.json();
    if (data.success) {
      document.getElementById("kpiTotalStudents").textContent = data.stats.total_students;
      document.getElementById("kpiTodayPresent").textContent = data.stats.today_present;
      document.getElementById("kpiProxyAlerts").textContent = data.stats.today_proxy_alerts;
      document.getElementById("kpiAttendanceRate").textContent = `${data.stats.attendance_rate}%`;
    }
  } catch (err) {
    console.error("Failed to load KPI stats:", err);
  }
}

// Load Attendance Ledger
async function loadAttendanceLogs() {
  const dateVal = document.getElementById("logDateFilter").value;
  const statusVal = document.getElementById("logStatusFilter").value;
  const searchVal = document.getElementById("logSearchInput").value.trim();
  const tbody = document.getElementById("attendanceTableBody");

  tbody.innerHTML = `
    <tr>
      <td colspan="7" class="text-center py-8 text-gray-400">
        <div class="inline-block animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mr-2 align-middle"></div>
        Fetching real-time attendance ledger...
      </td>
    </tr>
  `;

  try {
    let url = `/api/host/attendance-logs?date=${dateVal}&limit=150`;
    if (statusVal && statusVal !== "ALL") {
      url += `&status_filter=${statusVal}`;
    }
    if (searchVal) {
      url += `&search=${encodeURIComponent(searchVal)}`;
    }

    const res = await fetch(url);
    const data = await res.json();

    if (!data.success || !data.logs || data.logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-12 text-gray-400">
            No attendance entries found for ${dateVal || "selected query"}.
          </td>
        </tr>
      `;
      currentAttendanceLogs = [];
      return;
    }

    currentAttendanceLogs = data.logs;
    renderAttendanceRows(data.logs);
  } catch (err) {
    console.error("Failed to load attendance logs:", err);
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-8 text-red-500 font-medium">
          Error retrieving attendance records.
        </td>
      </tr>
    `;
  }
}

function renderAttendanceRows(logs) {
  const tbody = document.getElementById("attendanceTableBody");
  tbody.innerHTML = "";

  logs.forEach(log => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-slate-50/80 transition-colors border-b border-gray-100 text-sm";

    // Status pill
    let statusPill = "";
    if (log.is_proxy_suspect) {
      statusPill = `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span> Proxy Flagged
      </span>`;
    } else if (log.status === "PRESENT") {
      statusPill = `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span> Present
      </span>`;
    } else {
      statusPill = `<span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-300">
        <span class="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5"></span> Rejected
      </span>`;
    }

    // Location & Altitude display
    let locDisplay = `<span class="text-gray-400 text-xs">Unavailable</span>`;
    if (log.latitude && log.longitude) {
      const mapsUrl = `https://www.google.com/maps?q=${log.latitude},${log.longitude}`;
      let altBadge = "";
      if (log.altitude !== null && log.altitude !== undefined) {
        altBadge = `<span class="ml-1 text-[10px] text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded font-mono">Alt: ${Math.round(log.altitude)}m</span>`;
      }
      locDisplay = `
        <div class="flex items-center gap-1">
          <a href="${mapsUrl}" target="_blank" class="text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1 text-xs font-mono">
            <span>📍</span> ${log.latitude.toFixed(4)}, ${log.longitude.toFixed(4)}
          </a>
          ${altBadge}
        </div>
      `;
    }

    // Session code pill
    let sessionBadge = "";
    if (log.session_code) {
      sessionBadge = `<span class="font-mono text-[10px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded ml-1">OTP: ${log.session_code}</span>`;
    }

    // Time formatted
    const timeOnly = log.timestamp ? log.timestamp.split(" ")[1] || log.timestamp : "";

    tr.innerHTML = `
      <td class="py-3 px-4 font-mono text-gray-600 text-xs">${timeOnly}</td>
      <td class="py-3 px-4">
        <div class="font-bold text-gray-900 flex items-center gap-1">
          <span>${log.name}</span>
          ${sessionBadge}
        </div>
        <div class="text-xs text-gray-500 font-mono">${log.roll_no}</div>
      </td>
      <td class="py-3 px-4">
        <div class="flex items-center gap-2">
          <div class="w-16 bg-gray-200 rounded-full h-2 overflow-hidden">
            <div class="h-2 rounded-full ${log.match_confidence > 80 ? 'bg-emerald-500' : 'bg-amber-500'}" style="width: ${log.match_confidence}%"></div>
          </div>
          <span class="font-bold text-xs text-gray-700">${log.match_confidence}%</span>
        </div>
        <div class="text-[10px] text-gray-400">Dist: ${log.match_distance}</div>
      </td>
      <td class="py-3 px-4 font-mono text-xs text-gray-700">${log.ip_address || "127.0.0.1"}</td>
      <td class="py-3 px-4">${locDisplay}</td>
      <td class="py-3 px-4">${statusPill}</td>
      <td class="py-3 px-4 text-right">
        <button onclick="openInspectionModal(${log.id})" class="liquid-btn-glass px-3 py-1 rounded-xl text-xs font-bold text-blue-600 dark:text-blue-400">
          Inspect
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Side-by-side Biometric Inspection Modal
function openInspectionModal(logId) {
  const log = currentAttendanceLogs.find(l => l.id === logId);
  if (!log) return;
  currentLogInspect = log;

  document.getElementById("inspStudentName").textContent = log.name;
  document.getElementById("inspRollNo").textContent = log.roll_no;
  document.getElementById("inspTime").textContent = log.timestamp;
  document.getElementById("inspIP").textContent = log.ip_address || "Unknown";

  // Liveness & Location fields
  const livenessEl = document.getElementById("inspLiveness");
  if (livenessEl) {
    if (log.liveness_verified) {
      livenessEl.innerHTML = `<span class="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">✅ Passed (${log.blink_count || 1} blinks)</span>`;
    } else {
      livenessEl.innerHTML = `<span class="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">⚠️ Unverified</span>`;
    }
  }

  const locEl = document.getElementById("inspLocationAddress");
  if (locEl) {
    let locStr = log.location_address || "";
    if (log.latitude && log.longitude) {
      locStr += ` (Lat: ${log.latitude.toFixed(5)}, Lon: ${log.longitude.toFixed(5)})`;
    }
    if (log.accuracy) {
      locStr += ` [Margin: ±${Math.round(log.accuracy)}m]`;
    }
    if (log.altitude !== null && log.altitude !== undefined) {
      locStr += ` [Altitude: ${Math.round(log.altitude)}m]`;
    }
    locEl.textContent = locStr || "Location unavailable";
  }

  // Photos
  document.getElementById("inspAvatarImg").src = log.registered_avatar || "/static/models/placeholder.png";
  document.getElementById("inspSnapshotImg").src = log.snapshot_path || "/static/models/placeholder.png";

  // Distance & confidence
  document.getElementById("inspConfidence").textContent = `${log.match_confidence}%`;
  document.getElementById("inspDistance").textContent = `${log.match_distance} (Threshold: 0.45)`;

  // Proxy Flags banner
  const flagsBox = document.getElementById("inspProxyFlagsBox");
  if (log.is_proxy_suspect && log.proxy_flags) {
    flagsBox.classList.remove("hidden");
    document.getElementById("inspProxyFlagsText").textContent = log.proxy_flags;
  } else {
    flagsBox.classList.add("hidden");
  }

  // Admin notes input
  document.getElementById("inspAdminNotes").value = log.admin_notes || "";

  // Open modal
  const modal = document.getElementById("inspectionModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeInspectionModal() {
  const modal = document.getElementById("inspectionModal");
  modal.classList.remove("flex");
  modal.classList.add("hidden");
  currentLogInspect = null;
}

// Override Attendance Status (Approve / Revoke)
async function updateInspectionStatus(newStatus) {
  if (!currentLogInspect) return;

  const notes = document.getElementById("inspAdminNotes").value.trim();

  try {
    const res = await fetch("/api/host/override-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        log_id: currentLogInspect.id,
        new_status: newStatus,
        admin_notes: notes
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.detail || "Failed to update record.");
      return;
    }

    closeInspectionModal();
    loadAttendanceLogs();
  } catch (err) {
    alert("Error updating record: " + err.message);
  }
}

// Load Students Directory
async function loadStudentsList() {
  const tbody = document.getElementById("studentsTableBody");
  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="text-center py-8 text-gray-400">Loading student directory...</td>
    </tr>
  `;

  try {
    const res = await fetch("/api/host/students");
    const data = await res.json();

    if (!data.success || !data.students || data.students.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-12 text-gray-400">
            No students registered yet. Students can register on the Face ID Enrollment page.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = "";
    data.students.forEach(st => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50/80 transition-colors border-b border-gray-100 text-sm";
      tr.innerHTML = `
        <td class="py-3 px-4">
          <img src="${st.avatar_path}" class="w-10 h-10 rounded-2xl object-cover border border-gray-200 shadow-sm" alt="${st.name}" />
        </td>
        <td class="py-3 px-4 font-mono font-bold text-gray-900">${st.roll_no}</td>
        <td class="py-3 px-4 font-medium text-gray-800">${st.name}</td>
        <td class="py-3 px-4 text-gray-600">${st.department}</td>
        <td class="py-3 px-4 text-xs text-gray-500">${st.created_at}</td>
        <td class="py-3 px-4 text-right">
          <button onclick="deleteStudent(${st.id}, '${st.roll_no}')" class="liquid-btn-rose px-3 py-1 rounded-xl text-xs font-bold">
            Remove
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Students list error:", err);
  }
}

async function deleteStudent(userId, rollNo) {
  if (!confirm(`Are you sure you want to remove student with Roll No ${rollNo}? This will delete their Face ID profile.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/host/students/${userId}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      loadStudentsList();
      loadDashboardStats();
    } else {
      alert(data.detail || "Error deleting student.");
    }
  } catch (err) {
    alert("Network error deleting student.");
  }
}

// -------------------------------------------------------------
// FACULTY & LECTURER MANAGEMENT (HOST-RESTRICTED)
// -------------------------------------------------------------

async function loadLecturersList() {
  const tbody = document.getElementById("lecturersTableBody");
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="text-center py-8 text-slate-400">Loading faculty directory...</td>
    </tr>
  `;

  try {
    const res = await fetch("/api/host/lecturers");
    const data = await res.json();

    if (!data.success || !data.lecturers || data.lecturers.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-12 text-slate-400">
            No faculty members registered yet. Use the form above to add lecturers.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = "";
    data.lecturers.forEach(lec => {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50/80 transition-colors border-b border-slate-100 text-sm";
      tr.innerHTML = `
        <td class="py-3 px-4 font-mono font-bold text-blue-700">${lec.lecturer_id}</td>
        <td class="py-3 px-4 font-bold text-slate-900">${lec.name}</td>
        <td class="py-3 px-4 text-slate-600 text-xs">${lec.department}</td>
        <td class="py-3 px-4 font-semibold text-purple-700 text-xs">${lec.assigned_subject || "General"}</td>
        <td class="py-3 px-4 text-xs font-mono text-slate-500">${lec.created_at || "Active"}</td>
        <td class="py-3 px-4 text-right">
          <button onclick="deleteLecturer('${lec.lecturer_id}', '${lec.name}')" class="liquid-btn-rose px-3 py-1 rounded-xl text-xs font-bold">
            Remove
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Failed to load lecturers:", err);
  }
}

async function handleCreateLecturer() {
  const idInput = document.getElementById("newLecturerId");
  const nameInput = document.getElementById("newLecturerName");
  const emailInput = document.getElementById("newLecturerEmail");
  const deptInput = document.getElementById("newLecturerDept");
  const passInput = document.getElementById("newLecturerPass");
  const subjInput = document.getElementById("newLecturerSubject");
  const alertBox = document.getElementById("lecturerFormAlert");

  const lecturerId = idInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();
  const email = emailInput ? emailInput.value.trim() : "";
  const department = deptInput ? deptInput.value.trim() : "Computer Science";
  const password = passInput.value.trim();
  const assignedSubject = subjInput ? subjInput.value.trim() : "Computer Vision";

  if (!lecturerId || !name || !password) {
    alertBox.textContent = "Lecturer ID, Name, and Password are required.";
    alertBox.className = "p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold";
    alertBox.classList.remove("hidden");
    return;
  }

  try {
    const res = await fetch("/api/host/lecturers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lecturer_id: lecturerId,
        name: name,
        email: email,
        department: department,
        password: password,
        assigned_subject: assignedSubject
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alertBox.textContent = data.detail || "Failed to register lecturer.";
      alertBox.className = "p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold";
      alertBox.classList.remove("hidden");
      return;
    }

    alertBox.textContent = `✅ Faculty member ${name} (${lecturerId}) registered successfully!`;
    alertBox.className = "p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold";
    alertBox.classList.remove("hidden");

    // Reset inputs
    idInput.value = "";
    nameInput.value = "";
    if (emailInput) emailInput.value = "";
    passInput.value = "";
    if (subjInput) subjInput.value = "";

    loadLecturersList();
    setTimeout(() => alertBox.classList.add("hidden"), 4000);

  } catch (err) {
    alertBox.textContent = "Error: " + err.message;
    alertBox.className = "p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold";
    alertBox.classList.remove("hidden");
  }
}

async function deleteLecturer(lecturerId, name) {
  if (!confirm(`Are you sure you want to remove faculty member ${name} (${lecturerId})?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/host/lecturers/${lecturerId}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      loadLecturersList();
    } else {
      alert(data.detail || "Error deleting lecturer.");
    }
  } catch (err) {
    alert("Network error deleting lecturer.");
  }
}

// -------------------------------------------------------------
// SETTINGS MANAGEMENT
// -------------------------------------------------------------

async function loadSettings() {
  try {
    const res = await fetch("/api/host/settings");
    const data = await res.json();
    if (!data.success) return;

    const s = data.settings;
    document.getElementById("setGeofenceToggle").checked = s.geofence_enabled === "true";
    document.getElementById("setCampusLat").value = s.campus_lat || "";
    document.getElementById("setCampusLon").value = s.campus_lon || "";
    document.getElementById("setGeofenceRadius").value = s.geofence_radius_meters || "500";
    document.getElementById("setMatchThreshold").value = s.match_threshold || "0.45";
    document.getElementById("setMaxIpLimit").value = s.max_users_per_ip_per_day || "2";
    document.getElementById("setAdminPin").value = s.admin_pin || "admin123";
    document.getElementById("setInstitutionName").value = s.institution_name || "Apex University";

    const healthDisplay = document.getElementById("healthEndpointDisplay");
    if (healthDisplay) {
      healthDisplay.textContent = window.location.origin + "/health";
    }
  } catch (err) {
    console.error("Settings load error:", err);
  }
}

async function saveSettings() {
  const toast = document.getElementById("settingsToast");
  const payload = {
    geofence_enabled: document.getElementById("setGeofenceToggle").checked ? "true" : "false",
    campus_lat: document.getElementById("setCampusLat").value.trim(),
    campus_lon: document.getElementById("setCampusLon").value.trim(),
    geofence_radius_meters: document.getElementById("setGeofenceRadius").value.trim(),
    match_threshold: document.getElementById("setMatchThreshold").value.trim(),
    max_users_per_ip_per_day: document.getElementById("setMaxIpLimit").value.trim(),
    admin_pin: document.getElementById("setAdminPin").value.trim(),
    institution_name: document.getElementById("setInstitutionName").value.trim()
  };

  try {
    const res = await fetch("/api/host/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      toast.classList.remove("hidden");
      setTimeout(() => toast.classList.add("hidden"), 3000);
    } else {
      alert("Failed to save settings.");
    }
  } catch (err) {
    alert("Error saving settings: " + err.message);
  }
}

// Grab Host's Current GPS Location for Campus Geofence
function detectHostCurrentLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById("setCampusLat").value = pos.coords.latitude.toFixed(6);
      document.getElementById("setCampusLon").value = pos.coords.longitude.toFixed(6);
      alert(`Location detected! Lat: ${pos.coords.latitude.toFixed(6)}, Lon: ${pos.coords.longitude.toFixed(6)}. Remember to click 'Save Settings'.`);
    },
    (err) => {
      alert("Unable to acquire location: " + err.message);
    },
    { enableHighAccuracy: true }
  );
}

// Trigger CSV Export
function exportAttendanceCSV() {
  const dateVal = document.getElementById("logDateFilter").value;
  window.location.href = `/api/host/export-csv?date=${dateVal}`;
}

// -------------------------------------------------------------
// ADAPTIVE LIVENESS AI TRAINING & TELEMETRY CONTROLLER
// -------------------------------------------------------------

async function loadLivenessStats() {
  try {
    const res = await fetch("/api/host/liveness-stats");
    const data = await res.json();
    if (data.success && data.stats) {
      const s = data.stats;
      document.getElementById("livenessTotalSamples").textContent = s.total_samples || 0;
      document.getElementById("livenessTotalProfiles").textContent = s.total_profiles || 0;
      document.getElementById("livenessGlobalThresh").textContent = s.global_avg_thresh || "0.22";
      document.getElementById("livenessLastTrained").textContent = s.last_trained || "Never";
    }
  } catch (err) {
    console.warn("Failed to load liveness training stats:", err);
  }
}

async function loadLivenessProfiles() {
  const tbody = document.getElementById("livenessProfilesTableBody");
  const countBadge = document.getElementById("livenessProfilesCount");
  if (!tbody) return;

  try {
    const res = await fetch("/api/host/liveness-profiles");
    const data = await res.json();

    if (!data.success || !data.profiles || data.profiles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">No student liveness observations logged yet. Mark attendances with eye blinks to generate training telemetry.</td></tr>`;
      if (countBadge) countBadge.textContent = "0 Profiles Calibrated";
      return;
    }

    if (countBadge) countBadge.textContent = `${data.profiles.length} Profiles Calibrated`;

    tbody.innerHTML = data.profiles.map(p => `
      <tr class="hover:bg-slate-50/50 dark:hover:bg-white/5 transition-all">
        <td class="p-3.5">
          <div class="flex items-center gap-2.5">
            <img src="${p.avatar_path || '/static/icons/icon-192.png'}" class="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-white/10" alt="${p.name}">
            <div>
              <div class="font-bold text-slate-900 dark:text-white">${p.name || 'Student'}</div>
              <div class="font-mono text-[10px] text-blue-600 dark:text-blue-400 font-bold">${p.roll_no}</div>
            </div>
          </div>
        </td>
        <td class="p-3.5 font-mono font-bold text-slate-800 dark:text-slate-200">${p.sample_count}</td>
        <td class="p-3.5 font-mono text-emerald-600 dark:text-emerald-400 font-bold">${p.mean_ear.toFixed(3)}</td>
        <td class="p-3.5">
          <span class="px-2 py-0.5 rounded font-mono font-bold text-[11px] bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
            EAR &le; ${p.adaptive_blink_threshold.toFixed(3)}
          </span>
        </td>
        <td class="p-3.5 font-mono text-slate-600 dark:text-slate-400">${p.mean_texture.toFixed(1)}</td>
        <td class="p-3.5 font-mono text-slate-600 dark:text-slate-400">${p.mean_specular.toFixed(2)}%</td>
        <td class="p-3.5 text-slate-400 font-mono text-[11px]">${p.last_calibrated_at || 'Recently'}</td>
      </tr>
    `).join("");

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-rose-500">Error loading profiles: ${err.message}</td></tr>`;
  }
}

async function triggerLivenessTraining() {
  const btn = document.getElementById("btnTrainLiveness");
  const toast = document.getElementById("trainLivenessToast");

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="animate-spin mr-2">⚙️</span> Calibrating Adaptive Neural Models...`;
  }

  try {
    const res = await fetch("/api/host/train-liveness", { method: "POST" });
    const data = await res.json();

    if (toast) {
      toast.classList.remove("hidden");
      toast.textContent = `✅ Successfully recalibrated liveness parameters for ${data.calibrated_students} student(s) at ${data.timestamp}!`;
      setTimeout(() => toast.classList.add("hidden"), 6000);
    }

    await loadLivenessStats();
    await loadLivenessProfiles();

  } catch (err) {
    alert("Training calibration failed: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="sparkles" class="w-4 h-4 mr-2"></i> Recalibrate & Train Model`;
      if (window.lucide) lucide.createIcons();
    }
  }
}
