import os
import json
import csv
import io
from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, Request, HTTPException, Depends, status
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from app.database import (
    init_db, get_setting, set_setting, get_all_settings,
    register_user, get_user_by_roll_no, get_user_by_id, get_all_users, delete_user,
    get_today_attendance_for_user, record_attendance, get_attendance_logs,
    update_attendance_status, get_dashboard_stats,
    register_lecturer, get_all_lecturers, get_lecturer_by_id, delete_lecturer, verify_lecturer_login,
    create_class_session, get_active_session_by_code, get_active_session_for_lecturer,
    close_class_session, get_session_attendees,
    get_liveness_training_stats, get_all_liveness_profiles, train_and_recalibrate_liveness_model
)
from app.security import (
    calculate_euclidean_distance, compute_match_confidence,
    save_base64_image, extract_client_ip, perform_anti_proxy_evaluation
)

# Initialize Database Schema
init_db()

app = FastAPI(title="Digital Attendance & Biometric Face Verification System")

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
    avatar_data_url: str

class MarkAttendanceRequest(BaseModel):
    roll_no: str
    face_descriptor: List[float]
    snapshot_data_url: str
    session_code: str # The 5-Minute Lecturer OTP Code
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy: Optional[float] = None
    altitude: Optional[float] = None
    altitude_accuracy: Optional[float] = None
    device_info: Optional[str] = "Web Browser"
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
    """User Registration & Face ID Enrollment Page"""
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

    # Save Avatar Image
    try:
        avatar_path = save_base64_image(
            base64_str=data.avatar_data_url,
            folder="avatars",
            filename_prefix=f"avatar_{roll_clean}"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save biometric avatar: {str(e)}")

    user = register_user(
        roll_no=roll_clean,
        name=name_clean,
        department=data.department or "General",
        face_descriptor=data.face_descriptor,
        avatar_path=avatar_path
    )

    return {
        "success": True,
        "message": f"Student {name_clean} (Roll No: {roll_clean}) successfully registered!",
        "user": {
            "id": user["id"],
            "roll_no": user["roll_no"],
            "name": user["name"],
            "department": user["department"],
            "avatar_path": user["avatar_path"]
        }
    }

@app.get("/api/user/lookup/{roll_no}")
async def api_lookup_user(roll_no: str):
    """Quick lookup of registered user profile and enrolled face descriptor."""
    user = get_user_by_roll_no(roll_no)
    if not user:
        raise HTTPException(status_code=404, detail=f"No registered student found with Roll Number '{roll_no.upper()}'.")
    
    return {
        "success": True,
        "user": {
            "id": user["id"],
            "roll_no": user["roll_no"],
            "name": user["name"],
            "department": user["department"],
            "avatar_path": user["avatar_path"],
            "face_descriptor": user["face_descriptor"]
        }
    }

@app.get("/api/users/all-descriptors")
async def api_all_descriptors():
    """Returns enrolled users with descriptors for auto-identification scan mode."""
    users = get_all_users()
    descriptors_list = []
    for u in users:
        full_user = get_user_by_id(u["id"])
        if full_user:
            descriptors_list.append({
                "id": full_user["id"],
                "roll_no": full_user["roll_no"],
                "name": full_user["name"],
                "avatar_path": full_user["avatar_path"],
                "descriptor": full_user["face_descriptor"]
            })
    return {"success": True, "users": descriptors_list}


@app.post("/api/mark-attendance")
async def api_mark_attendance(data: MarkAttendanceRequest, request: Request):
    roll_clean = data.roll_no.strip().upper()
    user = get_user_by_roll_no(roll_clean)

    if not user:
        raise HTTPException(status_code=404, detail=f"Student with Roll Number '{roll_clean}' is not registered.")

    # 1. Validate Lecturer 5-Minute Class Session OTP
    clean_session_code = (data.session_code or "").strip().upper()
    if not clean_session_code:
        raise HTTPException(
            status_code=400,
            detail="Class Session OTP is required. Please enter the 5-minute one-time code provided by your lecturer."
        )

    session_info = get_active_session_by_code(clean_session_code)
    if not session_info:
        raise HTTPException(
            status_code=400,
            detail=f"Session OTP '{clean_session_code}' has expired or is invalid. Please request the current 5-minute code from your lecturer."
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

    # Extract Client Network & Location Information
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "127.0.0.1")
    user_agent = request.headers.get("user-agent", data.device_info or "Unknown Device")
    today_str = datetime.now().strftime("%Y-%m-%d")

    # If Face Fails Biometric Match
    if not is_match:
        # Save snapshot for audit of failed/spoofed attempt
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
            ear_value=data.ear_value
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

    # Evaluate Multi-Layer Anti-Proxy Security (Liveness + Screen Reflection + Moiré Texture + IP Clumping + Geofencing)
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
        ear_value=data.ear_value
    )

    attendance_status = "FLAGGED_PROXY" if is_proxy_suspect else "PRESENT"
    proxy_flags_str = "; ".join(proxy_flags_list) if proxy_flags_list else ""

    # Save attendance snapshot
    try:
        snapshot_path = save_base64_image(
            base64_str=data.snapshot_data_url,
            folder="snapshots",
            filename_prefix=f"attend_{roll_clean}"
        )
    except Exception as e:
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
        ear_value=data.ear_value
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
        return {"success": True, "message": "Access granted."}
    raise HTTPException(status_code=401, detail="Invalid Host PIN. Default PIN is 'admin123'.")

@app.get("/api/host/stats")
async def api_host_stats(date: Optional[str] = None):
    query_date = date or datetime.now().strftime("%Y-%m-%d")
    stats = get_dashboard_stats(query_date)
    return {"success": True, "stats": stats}

@app.get("/api/host/attendance-logs")
async def api_attendance_logs(
    date: Optional[str] = None,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 150
):
    logs = get_attendance_logs(
        date_filter=date,
        status_filter=status_filter,
        search=search,
        limit=limit
    )
    return {"success": True, "logs": logs}

@app.get("/api/host/students")
async def api_host_students():
    students = get_all_users()
    return {"success": True, "students": students}

@app.delete("/api/host/students/{user_id}")
async def api_delete_student(user_id: int):
    success = delete_user(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Student not found.")
    return {"success": True, "message": "Student profile and biometric data removed."}

@app.post("/api/host/override-status")
async def api_override_status(req: UpdateAttendanceRequest):
    success = update_attendance_status(req.log_id, req.new_status, req.admin_notes or "Host override")
    if not success:
        raise HTTPException(status_code=404, detail="Attendance record not found.")
    return {"success": True, "message": f"Attendance record #{req.log_id} updated to {req.new_status}."}

@app.get("/api/host/settings")
async def api_get_settings():
    return {"success": True, "settings": get_all_settings()}

@app.post("/api/host/settings")
async def api_update_settings(req: UpdateSettingsRequest):
    data = req.model_dump(exclude_unset=True)
    for key, val in data.items():
        if val is not None:
            set_setting(key, str(val))
    return {"success": True, "message": "Settings updated successfully."}

# --- Lecturer & 5-Minute OTP Session APIs ---

@app.post("/api/lecturer/login")
async def api_lecturer_login(req: LecturerLoginRequest):
    lecturer = verify_lecturer_login(req.lecturer_id, req.password)
    if not lecturer:
        raise HTTPException(status_code=401, detail="Invalid Faculty ID or Password.")
    return {"success": True, "lecturer": lecturer}

@app.post("/api/lecturer/create-session")
async def api_create_session(req: CreateSessionRequest):
    lecturer = get_lecturer_by_id(req.lecturer_id)
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

@app.get("/api/lecturer/active-session/{lecturer_id}")
async def api_get_active_session(lecturer_id: str):
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
async def api_close_session(req: CloseSessionRequest):
    success = close_class_session(req.session_id, req.lecturer_id)
    return {"success": success, "message": "Class attendance session closed."}

@app.get("/api/lecturer/session-attendees/{session_id}")
async def api_session_attendees(session_id: int):
    attendees = get_session_attendees(session_id)
    return {"success": True, "attendees": attendees, "count": len(attendees)}

# --- Host-Exclusive Lecturer Management (Private to Host) ---

@app.get("/api/host/lecturers")
async def api_host_get_lecturers():
    lecturers = get_all_lecturers()
    return {"success": True, "lecturers": lecturers}

@app.post("/api/host/lecturers")
async def api_host_create_lecturer(req: CreateLecturerRequest):
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
async def api_host_delete_lecturer(lecturer_id: str):
    deleted = delete_lecturer(lecturer_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Faculty member not found.")
    return {"success": True, "message": "Faculty profile removed."}

@app.get("/api/host/export-csv")
async def api_export_csv(date: Optional[str] = None):
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
async def api_host_liveness_stats():
    """Returns everyday liveness training telemetry statistics and current model state."""
    stats = get_liveness_training_stats()
    return {"success": True, "stats": stats}

@app.get("/api/host/liveness-profiles")
async def api_host_liveness_profiles():
    """Returns personalized learned liveness parameters for all students."""
    profiles = get_all_liveness_profiles()
    return {"success": True, "profiles": profiles}

@app.post("/api/host/train-liveness")
async def api_host_train_liveness():
    """
    Triggers online training and recalibration of the liveness model
    based on historical verified everyday attendance observations.
    """
    result = train_and_recalibrate_liveness_model()
    return result

