import os
import json
import csv
import io
from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, Request, Response, HTTPException, Depends, status
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from app.database import (
    init_db, get_setting, set_setting, get_all_settings,
    register_user, get_user_by_roll_no, get_user_by_id, get_all_users, delete_user,
    delete_student_biometrics, get_last_attendance_for_user, get_device_recent_checkin,
    record_manual_override, export_full_database_backup, export_full_database_csv,
    get_today_attendance_for_user, record_attendance, get_attendance_logs,
    update_attendance_status, get_dashboard_stats,
    register_lecturer, get_all_lecturers, get_lecturer_by_id, delete_lecturer, verify_lecturer_login,
    create_class_session, get_active_session_by_code, get_active_session_for_lecturer,
    get_class_session_by_id, get_all_active_sessions,
    close_class_session, get_session_attendees, get_student_attendance_history,
    get_liveness_training_stats, get_all_liveness_profiles, train_and_recalibrate_liveness_model
)
from app.security import (
    calculate_euclidean_distance, compute_match_confidence,
    save_base64_image, extract_client_ip, perform_anti_proxy_evaluation,
    generate_rolling_otp, verify_rolling_otp, check_impossible_travel,
    is_rate_limited, generate_session_token, verify_session_token
)

# Initialize Database Schema
init_db()

app = FastAPI(title="Digital Attendance & Biometric Face Verification System")

async def require_host_auth(request: Request):
    """
    Security Middleware / Dependency:
    Enforces server-side authentication on all administrative /api/host/* routes.
    Accepts:
      - X-Host-Token header (signed token issued on verify-pin)
      - Authorization: Bearer <token>
      - token or admin_pin query parameter (for direct file downloads/exports)
      - X-Admin-PIN header (master pin)
    """
    token = (
        request.headers.get("X-Host-Token")
        or request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        or request.query_params.get("token")
    )
    admin_pin = request.headers.get("X-Admin-PIN") or request.query_params.get("admin_pin")
    correct_pin = get_setting("admin_pin", "admin123")

    if admin_pin and admin_pin == correct_pin:
        return {"subject": "admin", "role": "host"}

    if token:
        verified = verify_session_token(token, expected_role="host")
        if verified:
            return verified
        if token == correct_pin:
            return {"subject": "admin", "role": "host"}

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: Host administration credentials or valid session token required."
    )

async def require_lecturer_auth(request: Request) -> Dict[str, Any]:
    """
    Security Middleware / Dependency:
    Enforces that the caller has an active, cryptographically signed faculty session.
    Extracts session token from:
      1. HTTP-Only Cookie 'veriface_lecturer_token'
      2. Header 'X-Lecturer-Token' or 'Authorization: Bearer <token>'
      3. Query parameter 'token' (for projector display modes)
    Validates token signature and expiration. Never trusts caller-supplied unverified IDs.
    """
    token = (
        request.headers.get("X-Lecturer-Token")
        or request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        or request.cookies.get("veriface_lecturer_token")
        or request.query_params.get("token")
    )
    
    # Allow Host Admin master override for institutional audits
    admin_pin = request.headers.get("X-Admin-PIN")
    host_token = request.headers.get("X-Host-Token")
    correct_pin = get_setting("admin_pin", "admin123")
    if admin_pin and admin_pin == correct_pin:
        return {"lecturer_id": "ADMIN", "role": "host"}
    if host_token:
        v_host = verify_session_token(host_token, expected_role="host")
        if v_host:
            return {"lecturer_id": "ADMIN", "role": "host"}

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Faculty authentication required: No valid session token provided. Please log in."
        )

    verified = verify_session_token(token)
    if not verified or verified.get("role") not in ("lecturer", "host"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Faculty session expired or invalid. Please re-authenticate."
        )

    return {"lecturer_id": verified["subject"], "role": verified["role"]}

# High-Performance Compression & Static Asset Caching Middleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.middleware("http")
async def add_performance_and_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        # Cache static neural weights, JS libraries, and CSS for 7 days in client browser
        response.headers["Cache-Control"] = "public, max-age=604800, immutable"
    return response

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

# Mount Static Files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Templates
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# --- Pydantic Request Models ---
class RegisterRequest(BaseModel):
    roll_no: str
    name: str
    department: Optional[str] = "Computer Science"
    face_descriptor: List[float]
    avatar_data_url: Optional[str] = ""
    dpdp_consent: Optional[bool] = True

class MarkAttendanceRequest(BaseModel):
    roll_no: str
    face_descriptor: List[float]
    snapshot_data_url: Optional[str] = ""  # Optional for lightweight vector-only mode (< 1.5 KB payload)
    session_code: str  # 5-Minute Lecturer OTP or 30-Second Rolling Code
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    altitude: Optional[float] = None
    altitude_accuracy: Optional[float] = None
    device_info: Optional[str] = "Web Browser"
    device_id: Optional[str] = ""  # Persistent hardware/client fingerprint
    liveness_verified: Optional[bool] = True
    blink_count: Optional[int] = 0
    location_address: Optional[str] = None
    specular_score: Optional[float] = None
    texture_score: Optional[float] = None
    moire_detected: Optional[bool] = False
    ear_value: Optional[float] = None

class LecturerLoginRequest(BaseModel):
    lecturer_id: str
    password: str

class CreateLecturerRequest(BaseModel):
    lecturer_id: str
    name: str
    email: Optional[str] = ""
    department: Optional[str] = "Computer Science"
    password: str
    assigned_subject: Optional[str] = "Computer Vision"

class CreateSessionRequest(BaseModel):
    lecturer_id: str
    subject: Optional[str] = "Lecture Session"
    custom_code: str
    duration_minutes: Optional[int] = 5

class CloseSessionRequest(BaseModel):
    session_id: int
    lecturer_id: str

class AdminAuthRequest(BaseModel):
    pin: str

class UpdateAttendanceRequest(BaseModel):
    log_id: int
    new_status: str
    admin_notes: Optional[str] = ""

class UpdateSettingsRequest(BaseModel):
    geofence_enabled: Optional[str] = None
    campus_lat: Optional[str] = None
    campus_lon: Optional[str] = None
    geofence_radius_meters: Optional[str] = None
    match_threshold: Optional[str] = None
    max_users_per_ip_per_day: Optional[str] = None
    admin_pin: Optional[str] = None
    institution_name: Optional[str] = None

class ManualOverrideRequest(BaseModel):
    session_id: int
    lecturer_id: str
    roll_no: str
    reason: Optional[str] = "Hardware Camera Malfunction / Poor Lighting"


# --- Keep-Alive Health Routes (Render Free Tier Sleep Fix) ---

@app.get("/health")
@app.get("/api/health")
async def health_check():
    """
    Ultra-fast keep-alive health route.
    Used by uptime pingers (cron-job.org / UptimeRobot) every 10 minutes to prevent Render free tier from sleeping.
    """
    return {
        "status": "healthy",
        "service": "VeriFace Biometric Attendance System",
        "timestamp": datetime.now().isoformat(),
        "database": "connected"
    }


# --- Web Page Views ---

@app.get("/", response_class=HTMLResponse)
async def index_page(request: Request):
    """Attendance Scanning Page"""
    settings = get_all_settings()
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "institution_name": settings.get("institution_name", "Attendance Portal"),
            "geofence_enabled": settings.get("geofence_enabled", "false")
        }
    )

@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request):
    """User Registration & Face ID Enrollment Page (DPDP Act 2023 Compliant)"""
    settings = get_all_settings()
    return templates.TemplateResponse(
        request=request,
        name="register.html",
        context={
            "institution_name": settings.get("institution_name", "Attendance Portal")
        }
    )

@app.get("/host", response_class=HTMLResponse)
async def host_page(request: Request):
    """Host & Admin Oversight Dashboard"""
    settings = get_all_settings()
    return templates.TemplateResponse(
        request=request,
        name="host.html",
        context={
            "institution_name": settings.get("institution_name", "Attendance Portal")
        }
    )

@app.get("/lecturer", response_class=HTMLResponse)
async def lecturer_page(request: Request):
    """Lecturer Command & Class Session Portal"""
    settings = get_all_settings()
    return templates.TemplateResponse(
        request=request,
        name="lecturer.html",
        context={
            "institution_name": settings.get("institution_name", "Attendance Portal")
        }
    )


# --- Core User & Biometrics APIs ---

@app.post("/api/register")
async def api_register(data: RegisterRequest, request: Request):
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "127.0.0.1")
    
    # Rate Limiting check (max 10 registrations per minute per IP)
    if is_rate_limited(client_ip, "register", max_requests=10, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Too many registration requests. Please wait a moment before trying again."
        )

    # DPDP Act 2023 Explicit Consent Requirement
    if data.dpdp_consent is False:
        raise HTTPException(
            status_code=400,
            detail="DPDP Act 2023 biometric processing consent is required to enroll in the system."
        )

    roll_clean = data.roll_no.strip().upper()
    name_clean = data.name.strip()

    if not roll_clean or not name_clean:
        raise HTTPException(status_code=400, detail="Roll Number and Full Name are required.")

    if len(data.face_descriptor) != 128:
        raise HTTPException(status_code=400, detail="Invalid biometric Face ID descriptor. Expected 128 embedding points.")

    # Check for duplicate
    existing = get_user_by_roll_no(roll_clean)
    if existing:
        raise HTTPException(status_code=409, detail=f"Roll Number '{roll_clean}' is already registered under name '{existing['name']}'.")

    # Save Avatar Image (or use privacy placeholder if empty)
    avatar_path = ""
    if data.avatar_data_url and data.avatar_data_url.strip():
        try:
            avatar_path = save_base64_image(
                base64_str=data.avatar_data_url,
                folder="avatars",
                filename_prefix=f"avatar_{roll_clean}"
            )
        except Exception as e:
            avatar_path = ""

    user = register_user(
        roll_no=roll_clean,
        name=name_clean,
        department=data.department or "General",
        face_descriptor=data.face_descriptor,
        avatar_path=avatar_path,
        dpdp_consent=1 if data.dpdp_consent else 0
    )

    return {
        "success": True,
        "message": f"Student {name_clean} (Roll No: {roll_clean}) successfully registered under DPDP Act 2023 compliance!",
        "user": {
            "id": user["id"],
            "roll_no": user["roll_no"],
            "name": user["name"],
            "department": user["department"],
            "avatar_path": user["avatar_path"]
        }
    }

@app.delete("/api/student/delete-biometrics/{roll_no}")
async def api_student_delete_biometrics(roll_no: str):
    """
    DPDP Act 2023 Right to Erasure / Right to be Forgotten.
    Permanently erases student's face embedding vector and calibration profiles.
    """
    clean_roll = roll_no.strip().upper()
    res = delete_student_biometrics(clean_roll)
    if not res.get("success"):
        raise HTTPException(status_code=404, detail=res.get("message"))
    return res

@app.get("/api/user/lookup/{roll_no}")
async def api_lookup_user(roll_no: str):
    """
    Lookup student profile metadata (Privacy-Hardened).
    Under India's DPDP Act 2023, raw biometric 128-D descriptors are never exposed publicly.
    """
    clean_roll = roll_no.strip().upper()
    user = get_user_by_roll_no(clean_roll)
    if not user:
        raise HTTPException(status_code=404, detail=f"No registered student found with Roll Number '{clean_roll}'.")
    
    return {
        "success": True,
        "user": {
            "id": user["id"],
            "roll_no": user["roll_no"],
            "name": user["name"],
            "department": user["department"],
            "avatar_path": user["avatar_path"],
            "is_enrolled": True
        }
    }

@app.get("/api/student/history/{roll_no}")
async def api_student_history(roll_no: str):
    """Returns calendar and lecture history for a student."""
    clean_roll = roll_no.strip().upper()
    user = get_user_by_roll_no(clean_roll)
    if not user:
        raise HTTPException(status_code=404, detail=f"No student found with Roll Number '{clean_roll}'.")
    
    records = get_student_attendance_history(clean_roll)
    return {
        "success": True,
        "student": {
            "name": user["name"],
            "roll_no": user["roll_no"],
            "department": user["department"],
            "avatar_path": user["avatar_path"]
        },
        "records": records,
        "total_attended": len([r for r in records if r["status"] == "PRESENT"]),
        "total_sessions": len(records)
    }

@app.get("/api/users/all-descriptors")
async def api_all_descriptors():
    """
    SECURITY HARDENED: Biometric Vector Leak Prevention (DPDP Act 2023).
    Bulk extraction of raw biometric descriptors is strictly prohibited.
    Face matching is performed exclusively server-side via 1:1 roll number verification.
    """
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access Denied: Bulk biometric vector exfiltration is disabled under India's DPDP Act 2023 compliance policy."
    )


@app.post("/api/mark-attendance")
async def api_mark_attendance(data: MarkAttendanceRequest, request: Request):
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "127.0.0.1")

    # Rate Limiting check (max 25 attendance attempts per minute per IP)
    if is_rate_limited(client_ip, "mark_attendance", max_requests=25, window_seconds=60):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Please wait a moment before resubmitting attendance."
        )

    roll_clean = data.roll_no.strip().upper()
    user = get_user_by_roll_no(roll_clean)

    if not user:
        raise HTTPException(status_code=404, detail=f"Student with Roll Number '{roll_clean}' is not registered.")

    # 1. Validate Lecturer Session OTP:
    # First check if submitted code matches active static code OR rolling 30s projector OTP
    clean_session_code = (data.session_code or "").strip().upper()
    if not clean_session_code:
        raise HTTPException(
            status_code=400,
            detail="Class Session OTP is required. Please enter the classroom code or 30-second rotating projector code."
        )

    session_info = get_active_session_by_code(clean_session_code)
    is_rolling_match = False

    if not session_info:
        # Check against 30-second rolling TOTP for active sessions
        active_sessions = get_all_active_sessions()
        for sess in active_sessions:
            secret = sess.get("session_secret", "")
            if verify_rolling_otp(clean_session_code, sess["id"], secret):
                session_info = sess
                is_rolling_match = True
                break

    if not session_info:
        raise HTTPException(
            status_code=400,
            detail=f"Session code '{clean_session_code}' is invalid or expired. Check the classroom projector for the latest 30-second code."
        )

    if len(data.face_descriptor) != 128:
        raise HTTPException(status_code=400, detail="Invalid face scan descriptor.")

    # Calculate Face Euclidean Distance
    registered_desc = user["face_descriptor"]
    distance = calculate_euclidean_distance(data.face_descriptor, registered_desc)

    # Read Threshold
    try:
        threshold = float(get_setting("match_threshold", "0.45"))
    except ValueError:
        threshold = 0.45

    confidence = compute_match_confidence(distance, threshold)
    is_match = distance <= threshold

    user_agent = request.headers.get("user-agent", data.device_info or "Web Browser")
    today_str = datetime.now().strftime("%Y-%m-%d")

    # If Face Fails Biometric Match
    if not is_match:
        snapshot_path = ""
        if data.snapshot_data_url and data.snapshot_data_url.strip():
            try:
                snapshot_path = save_base64_image(
                    base64_str=data.snapshot_data_url,
                    folder="snapshots",
                    filename_prefix=f"mismatch_{roll_clean}"
                )
            except Exception:
                snapshot_path = ""

        # Record Rejected attempt
        record_attendance(
            user_id=user["id"],
            roll_no=roll_clean,
            name=user["name"],
            date=today_str,
            status="REJECTED",
            match_distance=round(distance, 4),
            match_confidence=confidence,
            ip_address=client_ip,
            user_agent=user_agent,
            latitude=data.latitude,
            longitude=data.longitude,
            accuracy=data.accuracy,
            location_address=f"Lat: {data.latitude}, Lon: {data.longitude}" if data.latitude else "Location Unavailable",
            is_proxy_suspect=1,
            proxy_flags=f"Biometric Mismatch (Distance: {round(distance, 3)} > Threshold: {threshold})",
            snapshot_path=snapshot_path,
            liveness_verified=1 if data.liveness_verified else 0,
            blink_count=data.blink_count or 0,
            altitude=data.altitude,
            altitude_accuracy=data.altitude_accuracy,
            session_code=clean_session_code,
            session_id=session_info["id"],
            lecturer_id=session_info["lecturer_id"],
            specular_score=data.specular_score,
            texture_score=data.texture_score,
            moire_detected=1 if data.moire_detected else 0,
            ear_value=data.ear_value,
            device_id=data.device_id or ""
        )

        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "Face verification failed. The scanned face does not match the enrolled Face ID.",
                "match_distance": round(distance, 4),
                "match_confidence": confidence,
                "threshold": threshold,
                "student_name": user["name"]
            }
        )

    # Check if Attendance already marked today
    allow_multiple = get_setting("allow_multiple_checkins_per_day", "false").lower() in ("true", "1")
    existing_attendance = get_today_attendance_for_user(user["id"], today_str)

    if existing_attendance and not allow_multiple and existing_attendance["status"] in ("PRESENT", "FLAGGED_PROXY"):
        return {
            "success": True,
            "already_marked": True,
            "message": f"Attendance already logged today for {user['name']} at {existing_attendance['timestamp']}.",
            "record": {
                "id": existing_attendance["id"],
                "roll_no": user["roll_no"],
                "name": user["name"],
                "status": existing_attendance["status"],
                "timestamp": existing_attendance["timestamp"],
                "match_confidence": existing_attendance["match_confidence"],
                "is_proxy_suspect": bool(existing_attendance["is_proxy_suspect"]),
                "proxy_flags": existing_attendance["proxy_flags"]
            }
        }

    # Check 1: Shared Device Binding Alert (Prevent one phone from scanning multiple friends)
    device_sharing_alert = None
    if data.device_id and data.device_id.strip():
        prev_dev = get_device_recent_checkin(data.device_id, session_info["id"], roll_clean)
        if prev_dev:
            device_sharing_alert = f"Device fingerprint already registered a check-in for student {prev_dev['roll_no']} ({prev_dev['name']}) in this session"

    # Check 2: Impossible Travel / Mock GPS Teleportation Detection
    impossible_travel_alert = None
    if data.latitude is not None and data.longitude is not None:
        last_att = get_last_attendance_for_user(user["id"])
        if last_att and last_att.get("latitude") is not None and last_att.get("longitude") is not None:
            is_jump, jump_reason = check_impossible_travel(
                prev_lat=last_att.get("latitude"),
                prev_lon=last_att.get("longitude"),
                prev_timestamp=last_att.get("timestamp"),
                current_lat=data.latitude,
                current_lon=data.longitude
            )
            if is_jump:
                impossible_travel_alert = jump_reason

    # Evaluate Multi-Layer Anti-Proxy Security
    is_proxy_suspect, proxy_flags_list = perform_anti_proxy_evaluation(
        user_id=user["id"],
        roll_no=roll_clean,
        ip_address=client_ip,
        lat=data.latitude,
        lon=data.longitude,
        accuracy=data.accuracy,
        date_str=today_str,
        liveness_verified=bool(data.liveness_verified),
        blink_count=data.blink_count or 0,
        specular_score=data.specular_score,
        texture_score=data.texture_score,
        moire_detected=bool(data.moire_detected),
        ear_value=data.ear_value,
        device_sharing_alert=device_sharing_alert,
        impossible_travel_alert=impossible_travel_alert,
        is_rolling_match=is_rolling_match
    )

    attendance_status = "FLAGGED_PROXY" if is_proxy_suspect else "PRESENT"
    proxy_flags_str = "; ".join(proxy_flags_list) if proxy_flags_list else ""

    # Save attendance snapshot (optional in lightweight weak Wi-Fi mode)
    snapshot_path = ""
    if data.snapshot_data_url and data.snapshot_data_url.strip():
        try:
            snapshot_path = save_base64_image(
                base64_str=data.snapshot_data_url,
                folder="snapshots",
                filename_prefix=f"attend_{roll_clean}"
            )
        except Exception:
            snapshot_path = ""

    # Human-readable location coordinates & altitude
    loc_text = data.location_address if data.location_address else ""
    if not loc_text:
        loc_text = f"GPS: {round(data.latitude, 6)}, {round(data.longitude, 6)}" if data.latitude is not None and data.longitude is not None else "Location Perms Denied"
        if data.accuracy:
            loc_text += f" (±{round(data.accuracy, 1)}m)"

    if data.altitude is not None:
        loc_text += f" • Alt: {round(data.altitude, 1)}m"
        if data.altitude_accuracy is not None:
            loc_text += f" (±{round(data.altitude_accuracy, 1)}m)"

    log_id = record_attendance(
        user_id=user["id"],
        roll_no=roll_clean,
        name=user["name"],
        date=today_str,
        status=attendance_status,
        match_distance=round(distance, 4),
        match_confidence=confidence,
        ip_address=client_ip,
        user_agent=user_agent,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy=data.accuracy,
        location_address=loc_text,
        is_proxy_suspect=1 if is_proxy_suspect else 0,
        proxy_flags=proxy_flags_str,
        snapshot_path=snapshot_path,
        liveness_verified=1 if data.liveness_verified else 0,
        blink_count=data.blink_count or 0,
        altitude=data.altitude,
        altitude_accuracy=data.altitude_accuracy,
        session_code=clean_session_code,
        session_id=session_info["id"],
        lecturer_id=session_info["lecturer_id"],
        specular_score=data.specular_score,
        texture_score=data.texture_score,
        moire_detected=1 if data.moire_detected else 0,
        ear_value=data.ear_value,
        device_id=data.device_id or ""
    )

    return {
        "success": True,
        "already_marked": False,
        "status": attendance_status,
        "message": f"Attendance verified & logged for {session_info['subject']}!",
        "record": {
            "id": log_id,
            "roll_no": user["roll_no"],
            "name": user["name"],
            "department": user["department"],
            "status": attendance_status,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "match_distance": round(distance, 4),
            "match_confidence": confidence,
            "liveness_verified": bool(data.liveness_verified),
            "blink_count": data.blink_count or 0,
            "session_code": clean_session_code,
            "subject": session_info["subject"],
            "lecturer_name": session_info["lecturer_name"],
            "ip_address": client_ip,
            "location": loc_text,
            "is_proxy_suspect": is_proxy_suspect,
            "proxy_flags": proxy_flags_str,
            "snapshot_url": snapshot_path,
            "avatar_url": user["avatar_path"]
        }
    }


# --- Host & Admin APIs ---

@app.post("/api/host/verify-pin")
async def api_verify_host_pin(auth: AdminAuthRequest):
    correct_pin = get_setting("admin_pin", "admin123")
    if auth.pin == correct_pin:
        token = generate_session_token(subject="admin", role="host", valid_hours=24)
        return {
            "success": True,
            "token": token,
            "message": "Access granted."
        }
    raise HTTPException(status_code=401, detail="Invalid Host PIN. Default PIN is 'admin123'.")

@app.get("/api/host/stats")
async def api_host_stats(date: Optional[str] = None, _auth: Dict = Depends(require_host_auth)):
    query_date = date or datetime.now().strftime("%Y-%m-%d")
    stats = get_dashboard_stats(query_date)
    return {"success": True, "stats": stats}

@app.get("/api/host/attendance-logs")
async def api_attendance_logs(
    date: Optional[str] = None,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 150,
    _auth: Dict = Depends(require_host_auth)
):
    logs = get_attendance_logs(
        date_filter=date,
        status_filter=status_filter,
        search=search,
        limit=limit
    )
    return {"success": True, "logs": logs}

@app.get("/api/host/students")
async def api_host_students(_auth: Dict = Depends(require_host_auth)):
    students = get_all_users()
    return {"success": True, "students": students}

@app.delete("/api/host/students/{user_id}")
async def api_delete_student(user_id: int, _auth: Dict = Depends(require_host_auth)):
    success = delete_user(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Student not found.")
    return {"success": True, "message": "Student profile and biometric data removed."}

@app.post("/api/host/override-status")
async def api_override_status(req: UpdateAttendanceRequest, _auth: Dict = Depends(require_host_auth)):
    success = update_attendance_status(req.log_id, req.new_status, req.admin_notes or "Host override")
    if not success:
        raise HTTPException(status_code=404, detail="Attendance record not found.")
    return {"success": True, "message": f"Attendance record #{req.log_id} updated to {req.new_status}."}

@app.get("/api/host/settings")
async def api_get_settings(_auth: Dict = Depends(require_host_auth)):
    return {"success": True, "settings": get_all_settings()}

@app.post("/api/host/settings")
async def api_update_settings(req: UpdateSettingsRequest, _auth: Dict = Depends(require_host_auth)):
    data = req.model_dump(exclude_unset=True)
    for key, val in data.items():
        if val is not None:
            set_setting(key, str(val))
    return {"success": True, "message": "Settings updated successfully."}

@app.get("/api/host/backup-database")
async def api_backup_database(format: str = "json", _auth: Dict = Depends(require_host_auth)):
    """Automated and on-demand full database backup (solves Render ephemeral disk wipe)."""
    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    if format.lower() == "csv":
        csv_data = export_full_database_csv()
        filename = f"veriface_database_backup_{now_str}.csv"
        return StreamingResponse(
            io.BytesIO(csv_data.encode("utf-8")),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    else:
        backup_dict = export_full_database_backup()
        json_data = json.dumps(backup_dict, indent=2)
        filename = f"veriface_database_backup_{now_str}.json"
        return StreamingResponse(
            io.BytesIO(json_data.encode("utf-8")),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )


# --- Lecturer & 5-Minute OTP Session APIs ---

@app.post("/api/lecturer/login")
async def api_lecturer_login(req: LecturerLoginRequest, request: Request, response: Response):
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "127.0.0.1")
    
    # Rate limiting on faculty login (brute force mitigation: max 8 attempts/min)
    if is_rate_limited(client_ip, "lecturer_login", max_requests=8, window_seconds=60):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please wait 1 minute.")

    lecturer = verify_lecturer_login(req.lecturer_id, req.password)
    if not lecturer:
        raise HTTPException(status_code=401, detail="Invalid Faculty ID or Password.")
        
    token = generate_session_token(subject=lecturer["lecturer_id"], role="lecturer", valid_hours=12)
    response.set_cookie(
        key="veriface_lecturer_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=43200,
        secure=False
    )
    lecturer["token"] = token
    return {"success": True, "lecturer": lecturer, "token": token}

@app.post("/api/lecturer/logout")
async def api_lecturer_logout(response: Response):
    response.delete_cookie(key="veriface_lecturer_token")
    return {"success": True, "message": "Faculty session logged out and token cleared."}

@app.post("/api/lecturer/create-session")
async def api_create_session(req: CreateSessionRequest, auth: Dict = Depends(require_lecturer_auth)):
    # Cryptographically verified faculty ID - never trust unverified caller-supplied IDs
    effective_lec_id = req.lecturer_id if auth["role"] == "host" and req.lecturer_id else auth["lecturer_id"]
    lecturer = get_lecturer_by_id(effective_lec_id)
    if not lecturer:
        raise HTTPException(status_code=404, detail="Faculty record not found.")
    
    session = create_class_session(
        lecturer_id=lecturer["lecturer_id"],
        lecturer_name=lecturer["name"],
        subject=req.subject or lecturer.get("assigned_subject", "General Lecture"),
        custom_code=req.custom_code,
        duration_minutes=req.duration_minutes or 5
    )
    return {"success": True, "session": session}

@app.get("/api/lecturer/rolling-otp/{session_id}")
async def api_get_rolling_otp(session_id: int, auth: Dict = Depends(require_lecturer_auth)):
    """
    Returns the real-time 30-second rolling TOTP for display on the classroom projector.
    Requires authenticated faculty session for the session owner (or host admin).
    Anti-forwarding protection: Only returns current OTP and seconds remaining.
    Does NOT return future/next OTP to prevent lookahead forwarding.
    """
    session = get_class_session_by_id(session_id)
    if not session or not session.get("is_active"):
        raise HTTPException(status_code=404, detail="Active class session not found.")
    
    # Ownership check: Caller must be the session owner or host admin
    if auth["role"] != "host" and session.get("lecturer_id", "").strip().upper() != auth["lecturer_id"].strip().upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: You do not own this class session."
        )
    
    rolling = generate_rolling_otp(
        session_id=session["id"],
        secret=session.get("session_secret", ""),
        window_seconds=30
    )
    return {
        "success": True,
        "session_id": session["id"],
        "rolling_otp": rolling["otp"],
        "seconds_remaining": rolling["seconds_remaining"],
        "window_seconds": rolling["window_seconds"]
    }

@app.post("/api/lecturer/manual-override")
async def api_manual_override(req: ManualOverrideRequest, auth: Dict = Depends(require_lecturer_auth)):
    """
    Lecturer manual override for low-end phone camera failure, poor lighting, or student bandages.
    Requires authenticated faculty session and verifies session ownership.
    Immediately marks the student Present with an official faculty audit note.
    """
    session = get_class_session_by_id(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Class session not found.")
        
    if auth["role"] != "host" and session.get("lecturer_id", "").strip().upper() != auth["lecturer_id"].strip().upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: You can only perform manual override for your own sessions."
        )
        
    res = record_manual_override(
        session_id=req.session_id,
        lecturer_id=session["lecturer_id"],
        roll_no=req.roll_no,
        reason=req.reason or "Faculty manual verification"
    )
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("message"))
    return res

@app.get("/api/lecturer/active-session/{lecturer_id}")
async def api_get_active_session(lecturer_id: str, auth: Dict = Depends(require_lecturer_auth)):
    # Ensure caller is querying their own session or is host admin
    if auth["role"] != "host" and lecturer_id.strip().upper() != auth["lecturer_id"].strip().upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: You can only view your own active session."
        )

    session = get_active_session_for_lecturer(lecturer_id)
    if not session:
        return {"success": True, "has_active_session": False, "session": None}
    attendees = get_session_attendees(session["id"])
    return {
        "success": True,
        "has_active_session": True,
        "session": session,
        "attendee_count": len(attendees),
        "attendees": attendees
    }

@app.post("/api/lecturer/close-session")
async def api_close_session(req: CloseSessionRequest, auth: Dict = Depends(require_lecturer_auth)):
    session = get_class_session_by_id(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Class session not found.")
        
    if auth["role"] != "host" and session.get("lecturer_id", "").strip().upper() != auth["lecturer_id"].strip().upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: You can only close your own class session."
        )
        
    success = close_class_session(req.session_id, session["lecturer_id"])
    return {"success": success, "message": "Class attendance session closed."}

@app.get("/api/lecturer/session-attendees/{session_id}")
async def api_session_attendees(session_id: int, auth: Dict = Depends(require_lecturer_auth)):
    session = get_class_session_by_id(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Class session not found.")
        
    if auth["role"] != "host" and session.get("lecturer_id", "").strip().upper() != auth["lecturer_id"].strip().upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: You can only view attendee rosters for your own sessions."
        )
        
    attendees = get_session_attendees(session_id)
    return {"success": True, "attendees": attendees, "count": len(attendees)}


# --- Host-Exclusive Lecturer Management (Private to Host) ---

@app.get("/api/host/lecturers")
async def api_host_get_lecturers(_auth: Dict = Depends(require_host_auth)):
    lecturers = get_all_lecturers()
    return {"success": True, "lecturers": lecturers}

@app.post("/api/host/lecturers")
async def api_host_create_lecturer(req: CreateLecturerRequest, _auth: Dict = Depends(require_host_auth)):
    created = register_lecturer(
        lecturer_id=req.lecturer_id,
        name=req.name,
        email=req.email or "",
        department=req.department or "Computer Science",
        password=req.password,
        assigned_subject=req.assigned_subject or "General"
    )
    return {"success": True, "message": f"Faculty member {req.name} registered!", "lecturer": created}

@app.delete("/api/host/lecturers/{lecturer_id}")
async def api_host_delete_lecturer(lecturer_id: str, _auth: Dict = Depends(require_host_auth)):
    deleted = delete_lecturer(lecturer_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Faculty member not found.")
    return {"success": True, "message": "Faculty profile removed."}

@app.get("/api/host/export-csv")
async def api_export_csv(date: Optional[str] = None, _auth: Dict = Depends(require_host_auth)):
    """Exports attendance logs as a downloadable CSV spreadsheet."""
    query_date = date or datetime.now().strftime("%Y-%m-%d")
    logs = get_attendance_logs(date_filter=query_date, limit=1000)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Record ID", "Roll Number", "Student Name", "Date", "Timestamp",
        "Status", "Biometric Confidence (%)", "Match Distance",
        "Liveness Verified", "Blink Count",
        "IP Address", "Device / User-Agent", "Latitude", "Longitude", "Location Address",
        "Proxy Suspect Flag", "Proxy Reasons / Flags", "Admin Notes"
    ])

    for row in logs:
        writer.writerow([
            row["id"],
            row["roll_no"],
            row["name"],
            row["date"],
            row["timestamp"],
            row["status"],
            f"{row['match_confidence']}%",
            row["match_distance"],
            "PASS (Blinked)" if row.get("liveness_verified") else "FAIL",
            row.get("blink_count", 0),
            row["ip_address"] or "",
            row["user_agent"] or "",
            row["latitude"] if row["latitude"] is not None else "",
            row["longitude"] if row["longitude"] is not None else "",
            row.get("location_address") or "",
            "YES" if row["is_proxy_suspect"] else "NO",
            row["proxy_flags"] or "",
            row["admin_notes"] or ""
        ])

    output.seek(0)
    filename = f"Attendance_Export_{query_date}.csv"
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# --- Adaptive Liveness AI Training & Telemetry Routes ---

@app.get("/api/host/liveness-stats")
async def api_host_liveness_stats(_auth: Dict = Depends(require_host_auth)):
    """Returns everyday liveness training telemetry statistics and current model state."""
    stats = get_liveness_training_stats()
    return {"success": True, "stats": stats}

@app.get("/api/host/liveness-profiles")
async def api_host_liveness_profiles(_auth: Dict = Depends(require_host_auth)):
    """Returns personalized learned liveness parameters for all students."""
    profiles = get_all_liveness_profiles()
    return {"success": True, "profiles": profiles}

@app.post("/api/host/train-liveness")
async def api_host_train_liveness(_auth: Dict = Depends(require_host_auth)):
    """
    Triggers online training and recalibration of the liveness model
    based on historical verified everyday attendance observations.
    """
    result = train_and_recalibrate_liveness_model()
    return result
