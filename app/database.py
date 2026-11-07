import sqlite3
import json
import os
import math
import secrets
import io
import csv
from datetime import datetime
from typing import Optional, List, Dict, Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "attendance.db")
DATABASE_URL = os.environ.get("DATABASE_URL")

def get_db():
    """
    Returns database connection.
    If DATABASE_URL is configured (Supabase / Neon / Render Postgres), connects to PostgreSQL;
    otherwise seamlessly connects to local SQLite database.
    """
    if DATABASE_URL and (DATABASE_URL.startswith("postgresql://") or DATABASE_URL.startswith("postgres://")):
        try:
            import psycopg2
            from psycopg2.extras import RealDictCursor
            url = DATABASE_URL
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
            conn = psycopg2.connect(url, cursor_factory=RealDictCursor)
            return conn
        except ImportError:
            # psycopg2 not installed in local environment; fallback cleanly to SQLite
            pass
        except Exception as e:
            print(f"PostgreSQL connection error: {e}. Using SQLite fallback.")
            
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Table for registered users / students
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roll_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        department TEXT DEFAULT 'Computer Science',
        face_descriptor TEXT NOT NULL,
        avatar_path TEXT NOT NULL,
        dpdp_consent INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'ACTIVE'
    );
    """)

    # Table for Lecturers / Faculty (Registered exclusively by Host)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS lecturers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lecturer_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        department TEXT DEFAULT 'Computer Science',
        password TEXT NOT NULL,
        assigned_subject TEXT DEFAULT 'Computer Vision',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'ACTIVE'
    );
    """)

    # Table for 5-Minute Class Session OTPs created by Lecturers
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS class_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lecturer_id TEXT NOT NULL,
        lecturer_name TEXT NOT NULL,
        subject TEXT NOT NULL,
        session_code TEXT NOT NULL,
        session_secret TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        duration_minutes INTEGER DEFAULT 5,
        is_active INTEGER DEFAULT 1
    );
    """)

    # Table for attendance entries
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        roll_no TEXT NOT NULL,
        name TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        match_distance REAL NOT NULL,
        match_confidence REAL NOT NULL,
        ip_address TEXT,
        device_id TEXT,
        user_agent TEXT,
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        altitude REAL,
        altitude_accuracy REAL,
        location_address TEXT,
        is_proxy_suspect INTEGER DEFAULT 0,
        proxy_flags TEXT,
        snapshot_path TEXT,
        admin_notes TEXT,
        liveness_verified INTEGER DEFAULT 0,
        blink_count INTEGER DEFAULT 0,
        session_code TEXT,
        session_id INTEGER,
        lecturer_id TEXT,
        specular_score REAL DEFAULT 0.0,
        texture_score REAL DEFAULT 100.0,
        moire_detected INTEGER DEFAULT 0,
        ear_value REAL DEFAULT 0.30,
        FOREIGN KEY (user_id) REFERENCES users (id)
    );
    """)

    # Dynamic schema migration for existing databases
    cursor.execute("PRAGMA table_info(attendance)")
    existing_cols = [r["name"] for r in cursor.fetchall()]
    if "liveness_verified" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN liveness_verified INTEGER DEFAULT 0")
    if "blink_count" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN blink_count INTEGER DEFAULT 0")
    if "altitude" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN altitude REAL")
    if "altitude_accuracy" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN altitude_accuracy REAL")
    if "session_code" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN session_code TEXT")
    if "session_id" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN session_id INTEGER")
    if "lecturer_id" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN lecturer_id TEXT")
    if "specular_score" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN specular_score REAL DEFAULT 0.0")
    if "texture_score" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN texture_score REAL DEFAULT 100.0")
    if "moire_detected" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN moire_detected INTEGER DEFAULT 0")
    if "ear_value" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN ear_value REAL DEFAULT 0.30")
    if "device_id" not in existing_cols:
        cursor.execute("ALTER TABLE attendance ADD COLUMN device_id TEXT DEFAULT ''")

    # Dynamic schema migration for class_sessions
    cursor.execute("PRAGMA table_info(class_sessions)")
    cs_cols = [r["name"] for r in cursor.fetchall()]
    if "session_secret" not in cs_cols:
        cursor.execute("ALTER TABLE class_sessions ADD COLUMN session_secret TEXT DEFAULT ''")

    # Dynamic schema migration for users
    cursor.execute("PRAGMA table_info(users)")
    u_cols = [r["name"] for r in cursor.fetchall()]
    if "dpdp_consent" not in u_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN dpdp_consent INTEGER DEFAULT 1")

    # Table for Everyday Liveness Telemetry (Continuous Model Training)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS liveness_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        roll_no TEXT NOT NULL,
        session_date TEXT NOT NULL,
        baseline_ear REAL NOT NULL,
        blink_count INTEGER NOT NULL,
        specular_score REAL DEFAULT 0.0,
        texture_score REAL DEFAULT 100.0,
        status TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    );
    """)

    # Table for Learned Personalized Liveness Model Profiles
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS liveness_model_profiles (
        user_id INTEGER PRIMARY KEY,
        roll_no TEXT NOT NULL,
        sample_count INTEGER DEFAULT 0,
        mean_ear REAL DEFAULT 0.30,
        std_ear REAL DEFAULT 0.03,
        adaptive_blink_threshold REAL DEFAULT 0.22,
        mean_texture REAL DEFAULT 150.0,
        mean_specular REAL DEFAULT 1.5,
        last_calibrated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
    );
    """)

    # System settings table (for geofence, thresholds, host pin)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """)

    # Default settings
    default_settings = {
        "geofence_enabled": "false",
        "campus_lat": "12.971600",
        "campus_lon": "77.594600",
        "geofence_radius_meters": "500",
        "match_threshold": "0.45",
        "max_users_per_ip_per_day": "2",
        "admin_pin": "admin123",
        "institution_name": "Digital Attendance Management Portal",
        "allow_multiple_checkins_per_day": "false"
    }

    for key, val in default_settings.items():
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, val))

    conn.commit()
    conn.close()

def get_setting(key: str, default: str = "") -> str:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = cursor.fetchone()
    conn.close()
    return row["value"] if row else default

def set_setting(key: str, value: str):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
    conn.commit()
    conn.close()

def get_all_settings() -> Dict[str, str]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings")
    rows = cursor.fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}

def register_user(roll_no: str, name: str, department: str, face_descriptor: list, avatar_path: str, dpdp_consent: int = 1) -> Dict[str, Any]:
    conn = get_db()
    cursor = conn.cursor()
    roll_clean = roll_no.strip().upper()
    name_clean = name.strip()
    dept_clean = department.strip() if department else "General"
    desc_json = json.dumps(face_descriptor)

    cursor.execute("""
    INSERT INTO users (roll_no, name, department, face_descriptor, avatar_path, dpdp_consent)
    VALUES (?, ?, ?, ?, ?, ?)
    """, (roll_clean, name_clean, dept_clean, desc_json, avatar_path, dpdp_consent))
    user_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return {"id": user_id, "roll_no": roll_clean, "name": name_clean, "department": dept_clean, "avatar_path": avatar_path, "dpdp_consent": dpdp_consent}

def get_user_by_roll_no(roll_no: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE roll_no = ? AND status = 'ACTIVE'", (roll_no.strip().upper(),))
    row = cursor.fetchone()
    conn.close()
    if row:
        user = dict(row)
        user["face_descriptor"] = json.loads(user["face_descriptor"])
        return user
    return None

def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        user = dict(row)
        user["face_descriptor"] = json.loads(user["face_descriptor"])
        return user
    return None

def get_all_users() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, roll_no, name, department, avatar_path, dpdp_consent, created_at, status FROM users ORDER BY roll_no ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def delete_user(user_id: int) -> bool:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT avatar_path FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    if row and row["avatar_path"]:
        full_avatar_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), row["avatar_path"].lstrip("/"))
        if os.path.exists(full_avatar_path):
            try:
                os.remove(full_avatar_path)
            except Exception:
                pass

    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    cursor.execute("DELETE FROM liveness_telemetry WHERE user_id = ?", (user_id,))
    cursor.execute("DELETE FROM liveness_model_profiles WHERE user_id = ?", (user_id,))
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()
    return deleted

def delete_student_biometrics(roll_no: str) -> Dict[str, Any]:
    """
    Compliance with Section 12 of India's Digital Personal Data Protection (DPDP) Act 2023.
    (Right to Erasure / Right to be Forgotten)
    Permanently erases student's face embedding vector, liveness profile, and removes avatar files.
    """
    clean_roll = roll_no.strip().upper()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, avatar_path FROM users WHERE roll_no = ?", (clean_roll,))
    user_row = cursor.fetchone()
    if not user_row:
        conn.close()
        return {"success": False, "message": f"No registered student found with Roll Number '{clean_roll}'."}

    user_id = user_row["id"]
    student_name = user_row["name"]
    avatar_path = user_row["avatar_path"]

    # Purge telemetry and AI profiles
    cursor.execute("DELETE FROM liveness_telemetry WHERE user_id = ?", (user_id,))
    cursor.execute("DELETE FROM liveness_model_profiles WHERE user_id = ?", (user_id,))
    # Delete student record
    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    # Anonymize past attendance history
    cursor.execute("UPDATE attendance SET name = 'DELETED_STUDENT (DPDP)', snapshot_path = '' WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()

    # Remove avatar file on disk if exists
    if avatar_path and avatar_path.startswith("/static/uploads/"):
        root_dir = os.path.dirname(os.path.dirname(__file__))
        rel_path = avatar_path.lstrip("/")
        disk_file = os.path.join(root_dir, rel_path.replace("/", os.sep))
        if os.path.exists(disk_file):
            try:
                os.remove(disk_file)
            except Exception:
                pass

    return {
        "success": True,
        "message": f"Biometric vectors, facial embeddings, and profiles for {clean_roll} ({student_name}) have been permanently erased under DPDP Act 2023."
    }

def get_today_attendance_for_user(user_id: int, date_str: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM attendance WHERE user_id = ? AND date = ? ORDER BY id DESC LIMIT 1", (user_id, date_str))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_last_attendance_for_user(user_id: int) -> Optional[Dict[str, Any]]:
    """Fetches the most recent verified attendance entry with GPS coordinates for impossible travel check."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, user_id, roll_no, latitude, longitude, timestamp, date
    FROM attendance
    WHERE user_id = ? AND latitude IS NOT NULL AND status IN ('PRESENT', 'FLAGGED_PROXY')
    ORDER BY id DESC LIMIT 1
    """, (user_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_device_recent_checkin(device_id: str, session_id: Optional[int], exclude_roll_no: str) -> Optional[Dict[str, Any]]:
    """Checks if this hardware device was already used by another student in this class session."""
    if not device_id or not device_id.strip():
        return None
    conn = get_db()
    cursor = conn.cursor()
    if session_id:
        cursor.execute("""
        SELECT id, roll_no, name, timestamp, device_id FROM attendance
        WHERE device_id = ? AND session_id = ? AND roll_no != ? AND status IN ('PRESENT', 'FLAGGED_PROXY')
        ORDER BY id DESC LIMIT 1
        """, (device_id.strip(), session_id, exclude_roll_no.strip().upper()))
    else:
        today_str = datetime.now().strftime("%Y-%m-%d")
        cursor.execute("""
        SELECT id, roll_no, name, timestamp, device_id FROM attendance
        WHERE device_id = ? AND date = ? AND roll_no != ? AND status IN ('PRESENT', 'FLAGGED_PROXY')
        ORDER BY id DESC LIMIT 1
        """, (device_id.strip(), today_str, exclude_roll_no.strip().upper()))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def record_attendance(
    user_id: int,
    roll_no: str,
    name: str,
    date: str,
    status: str,
    match_distance: float,
    match_confidence: float,
    ip_address: str,
    user_agent: str,
    latitude: Optional[float],
    longitude: Optional[float],
    accuracy: Optional[float],
    location_address: str,
    is_proxy_suspect: int,
    proxy_flags: str,
    snapshot_path: str,
    liveness_verified: int = 1,
    blink_count: int = 0,
    altitude: Optional[float] = None,
    altitude_accuracy: Optional[float] = None,
    session_code: Optional[str] = None,
    session_id: Optional[int] = None,
    lecturer_id: Optional[str] = None,
    specular_score: Optional[float] = 0.0,
    texture_score: Optional[float] = 100.0,
    moire_detected: int = 0,
    ear_value: Optional[float] = 0.30,
    device_id: Optional[str] = ""
) -> int:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO attendance (
        user_id, roll_no, name, date, status, match_distance, match_confidence,
        ip_address, user_agent, latitude, longitude, accuracy, location_address,
        is_proxy_suspect, proxy_flags, snapshot_path, liveness_verified, blink_count,
        altitude, altitude_accuracy, session_code, session_id, lecturer_id,
        specular_score, texture_score, moire_detected, ear_value, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        user_id, roll_no, name, date, status, match_distance, match_confidence,
        ip_address, user_agent, latitude, longitude, accuracy, location_address,
        is_proxy_suspect, proxy_flags, snapshot_path, liveness_verified, blink_count,
        altitude, altitude_accuracy, session_code, session_id, lecturer_id,
        specular_score or 0.0, texture_score or 100.0, moire_detected, ear_value or 0.30,
        device_id or ""
    ))
    log_id = cursor.lastrowid

    # Automatically archive into everyday liveness training telemetry
    try:
        cursor.execute("""
        INSERT INTO liveness_telemetry (
            user_id, roll_no, session_date, baseline_ear, blink_count, specular_score, texture_score, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user_id, roll_no, date, ear_value or 0.30, blink_count,
            specular_score or 0.0, texture_score or 100.0, status
        ))
    except Exception as e:
        print("Liveness telemetry log warning:", e)

    conn.commit()
    conn.close()
    return log_id

def record_manual_override(session_id: int, lecturer_id: str, roll_no: str, reason: str) -> Dict[str, Any]:
    """Faculty manual override for students with camera failure, poor lighting, or low-end device."""
    clean_roll = roll_no.strip().upper()
    user = get_user_by_roll_no(clean_roll)
    if not user:
        return {"success": False, "message": f"Student '{clean_roll}' is not registered in the system."}

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,))
    sess = cursor.fetchone()
    if not sess:
        conn.close()
        return {"success": False, "message": "Class session not found."}

    today_str = datetime.now().strftime("%Y-%m-%d")
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Check if already marked
    cursor.execute("""
    SELECT id FROM attendance
    WHERE user_id = ? AND session_id = ? AND status IN ('PRESENT', 'FLAGGED_PROXY')
    """, (user["id"], session_id))
    existing = cursor.fetchone()
    if existing:
        conn.close()
        return {"success": False, "message": f"Student {clean_roll} is already marked for this session."}

    cursor.execute("""
    INSERT INTO attendance (
        user_id, roll_no, name, date, timestamp, status, match_distance, match_confidence,
        ip_address, user_agent, location_address, is_proxy_suspect, proxy_flags,
        admin_notes, liveness_verified, blink_count, session_code, session_id, lecturer_id
    ) VALUES (?, ?, ?, ?, ?, 'PRESENT', 0.0, 100.0, 'FACULTY_OVERRIDE', 'Lecturer Portal',
              'Classroom Manual Override', 0, '', ?, 1, 1, ?, ?, ?)
    """, (
        user["id"], clean_roll, user["name"], today_str, now_str,
        f"Faculty manual override by {lecturer_id}: {reason}", sess["session_code"], session_id, lecturer_id
    ))
    override_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return {
        "success": True,
        "override_id": override_id,
        "roll_no": clean_roll,
        "name": user["name"],
        "status": "PRESENT",
        "message": f"Student {clean_roll} ({user['name']}) marked Present via faculty manual override."
    }

def count_distinct_users_on_ip_today(ip_address: str, date_str: str, exclude_user_id: Optional[int] = None) -> int:
    conn = get_db()
    cursor = conn.cursor()
    if exclude_user_id:
        cursor.execute("""
        SELECT COUNT(DISTINCT user_id) as cnt FROM attendance
        WHERE ip_address = ? AND date = ? AND user_id != ? AND status != 'REJECTED'
        """, (ip_address, date_str, exclude_user_id))
    else:
        cursor.execute("""
        SELECT COUNT(DISTINCT user_id) as cnt FROM attendance
        WHERE ip_address = ? AND date = ? AND status != 'REJECTED'
        """, (ip_address, date_str))
    row = cursor.fetchone()
    conn.close()
    return row["cnt"] if row else 0

def get_attendance_logs(
    date_filter: Optional[str] = None,
    status_filter: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 150
) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()

    query = """
    SELECT a.*, u.avatar_path as registered_avatar
    FROM attendance a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE 1=1
    """
    params = []

    if date_filter:
        query += " AND a.date = ?"
        params.append(date_filter)

    if status_filter and status_filter != "ALL":
        if status_filter == "PROXY":
            query += " AND a.is_proxy_suspect = 1"
        else:
            query += " AND a.status = ?"
            params.append(status_filter)

    if search:
        query += " AND (a.roll_no LIKE ? OR a.name LIKE ? OR a.ip_address LIKE ?)"
        s = f"%{search}%"
        params.extend([s, s, s])

    query += " ORDER BY a.id DESC LIMIT ?"
    params.append(limit)

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_attendance_status(log_id: int, new_status: str, admin_notes: str = "") -> bool:
    conn = get_db()
    cursor = conn.cursor()
    is_suspect = 1 if new_status == "FLAGGED_PROXY" else 0
    cursor.execute("""
    UPDATE attendance
    SET status = ?, is_proxy_suspect = ?, admin_notes = ?
    WHERE id = ?
    """, (new_status, is_suspect, admin_notes, log_id))
    conn.commit()
    updated = cursor.rowcount > 0
    conn.close()
    return updated

def get_dashboard_stats(date_str: str) -> Dict[str, Any]:
    conn = get_db()
    cursor = conn.cursor()

    # Total registered students
    cursor.execute("SELECT COUNT(*) as cnt FROM users WHERE status = 'ACTIVE'")
    total_students = cursor.fetchone()["cnt"]

    # Today's marked present
    cursor.execute("""
    SELECT COUNT(DISTINCT user_id) as cnt FROM attendance
    WHERE date = ? AND status IN ('PRESENT', 'FLAGGED_PROXY')
    """, (date_str,))
    present_today = cursor.fetchone()["cnt"]

    # Today's flagged suspect
    cursor.execute("""
    SELECT COUNT(*) as cnt FROM attendance
    WHERE date = ? AND is_proxy_suspect = 1
    """, (date_str,))
    flagged_today = cursor.fetchone()["cnt"]

    # Today's rejected
    cursor.execute("""
    SELECT COUNT(*) as cnt FROM attendance
    WHERE date = ? AND status = 'REJECTED'
    """, (date_str,))
    rejected_today = cursor.fetchone()["cnt"]

    # Unique IPs today
    cursor.execute("""
    SELECT COUNT(DISTINCT ip_address) as cnt FROM attendance
    WHERE date = ?
    """, (date_str,))
    unique_ips = cursor.fetchone()["cnt"]

    # Attendance rate
    rate = 0.0
    if total_students > 0:
        rate = round((present_today / total_students) * 100, 1)

    conn.close()
    return {
        "total_students": total_students,
        "present_today": present_today,
        "today_present": present_today,
        "flagged_today": flagged_today,
        "rejected_today": rejected_today,
        "unique_ips_today": unique_ips,
        "attendance_rate": rate
    }

# --- Lecturer / Faculty Management Operations ---

def register_lecturer(lecturer_id: str, name: str, password: str, department: str = "Computer Science", email: str = "", assigned_subject: str = "Computer Vision") -> Dict[str, Any]:
    conn = get_db()
    cursor = conn.cursor()
    clean_id = lecturer_id.strip().upper()
    clean_name = name.strip()
    clean_dept = department.strip() if department else "Computer Science"
    clean_sub = assigned_subject.strip() if assigned_subject else "General Studies"

    cursor.execute("""
    INSERT INTO lecturers (lecturer_id, name, email, department, password, assigned_subject)
    VALUES (?, ?, ?, ?, ?, ?)
    """, (clean_id, clean_name, email.strip(), clean_dept, password, clean_sub))
    lec_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return {
        "id": lec_id,
        "lecturer_id": clean_id,
        "name": clean_name,
        "email": email.strip(),
        "department": clean_dept,
        "assigned_subject": clean_sub
    }

def get_all_lecturers() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, lecturer_id, name, email, department, assigned_subject, created_at, status FROM lecturers ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_lecturer_by_id(lecturer_id: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM lecturers WHERE lecturer_id = ? AND status = 'ACTIVE'", (lecturer_id.strip().upper(),))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def delete_lecturer(lecturer_id: str) -> bool:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE lecturers SET status='INACTIVE' WHERE lecturer_id = ?", (lecturer_id.strip().upper(),))
    conn.commit()
    success = cursor.rowcount > 0
    conn.close()
    return success

def verify_lecturer_login(lecturer_id: str, password: str) -> Optional[Dict[str, Any]]:
    lecturer = get_lecturer_by_id(lecturer_id)
    if lecturer and lecturer["password"] == password:
        return {
            "id": lecturer["id"],
            "lecturer_id": lecturer["lecturer_id"],
            "name": lecturer["name"],
            "department": lecturer["department"],
            "assigned_subject": lecturer["assigned_subject"]
        }
    return None

def create_class_session(lecturer_id: str, lecturer_name: str, subject: str, custom_code: str, duration_minutes: int = 5) -> Dict[str, Any]:
    """
    Creates a customized or auto-generated 5-minute session OTP with a secure secret for rolling OTPs.
    Deactivates any previous active session for this lecturer.
    """
    conn = get_db()
    cursor = conn.cursor()
    
    clean_code = custom_code.strip().upper()
    now = datetime.now()
    from datetime import timedelta
    expires_at = now + timedelta(minutes=duration_minutes)
    session_secret = secrets.token_hex(8)

    # Deactivate existing active sessions for this lecturer
    cursor.execute("UPDATE class_sessions SET is_active = 0 WHERE lecturer_id = ?", (lecturer_id,))

    cursor.execute("""
    INSERT INTO class_sessions (lecturer_id, lecturer_name, subject, session_code, session_secret, created_at, expires_at, duration_minutes, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    """, (lecturer_id, lecturer_name, subject, clean_code, session_secret, now.strftime("%Y-%m-%d %H:%M:%S"), expires_at.strftime("%Y-%m-%d %H:%M:%S"), duration_minutes))

    session_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return {
        "session_id": session_id,
        "lecturer_id": lecturer_id,
        "lecturer_name": lecturer_name,
        "subject": subject,
        "session_code": clean_code,
        "session_secret": session_secret,
        "created_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "expires_at": expires_at.strftime("%Y-%m-%d %H:%M:%S"),
        "duration_minutes": duration_minutes,
        "remaining_seconds": duration_minutes * 60
    }

def get_class_session_by_id(session_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM class_sessions WHERE id = ?", (session_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_active_session_by_code(code: str) -> Optional[Dict[str, Any]]:
    """Validates student OTP input against currently active, non-expired class sessions."""
    conn = get_db()
    cursor = conn.cursor()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute("""
    SELECT * FROM class_sessions
    WHERE session_code = ? AND is_active = 1 AND expires_at > ?
    ORDER BY id DESC LIMIT 1
    """, (code.strip().upper(), now_str))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_active_sessions() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
    SELECT * FROM class_sessions
    WHERE is_active = 1 AND expires_at > ?
    ORDER BY id DESC
    """, (now_str,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_active_session_for_lecturer(lecturer_id: str) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    now = datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute("""
    SELECT * FROM class_sessions
    WHERE lecturer_id = ? AND is_active = 1 AND expires_at > ?
    ORDER BY id DESC LIMIT 1
    """, (lecturer_id.strip().upper(), now_str))
    row = cursor.fetchone()
    conn.close()

    if row:
        session = dict(row)
        expires = datetime.strptime(session["expires_at"], "%Y-%m-%d %H:%M:%S")
        remaining = max(0, int((expires - now).total_seconds()))
        session["remaining_seconds"] = remaining
        return session
    return None

def close_class_session(session_id: int, lecturer_id: str) -> bool:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("UPDATE class_sessions SET is_active = 0 WHERE id = ? AND lecturer_id = ?", (session_id, lecturer_id.strip().upper()))
    conn.commit()
    success = cursor.rowcount > 0
    conn.close()
    return success

def get_session_attendees(session_id: int) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, roll_no, name, timestamp, status, match_confidence, ip_address, device_id, location_address, snapshot_path, altitude
    FROM attendance
    WHERE session_id = ?
    ORDER BY id DESC
    """, (session_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_student_attendance_history(roll_no: str) -> List[Dict[str, Any]]:
    """Fetches full attendance history for a student with class and subject details."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT 
        a.id, a.roll_no, a.name, a.date, a.timestamp, a.status,
        a.match_confidence, a.match_distance, a.location_address,
        a.session_code, a.session_id, a.altitude,
        cs.subject, cs.lecturer_name, cs.duration_minutes
    FROM attendance a
    LEFT JOIN class_sessions cs ON a.session_id = cs.id
    WHERE a.roll_no = ?
    ORDER BY a.id DESC
    """, (roll_no.strip().upper(),))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def export_full_database_backup() -> Dict[str, Any]:
    """Generates complete database JSON archive for on-demand or weekly backup on ephemeral cloud disks."""
    conn = get_db()
    cursor = conn.cursor()
    tables = ["users", "attendance", "lecturers", "class_sessions", "settings", "liveness_telemetry", "liveness_model_profiles"]
    data = {}
    for t in tables:
        try:
            cursor.execute(f"SELECT * FROM {t}")
            data[t] = [dict(r) for r in cursor.fetchall()]
        except Exception:
            data[t] = []
    conn.close()
    return {
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "platform": "VeriFace",
        "tables": data
    }

def export_full_database_csv() -> str:
    """Generates complete CSV export of attendance entries."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT 
        a.id, a.roll_no, a.name, a.date, a.timestamp, a.status,
        a.match_confidence, a.match_distance, a.ip_address, a.device_id,
        a.latitude, a.longitude, a.accuracy, a.altitude, a.location_address,
        a.session_code, a.session_id, a.lecturer_id, a.is_proxy_suspect, a.proxy_flags,
        a.liveness_verified, a.blink_count, a.admin_notes
    FROM attendance a
    ORDER BY a.id DESC
    """)
    rows = cursor.fetchall()
    conn.close()
    
    output = io.StringIO()
    writer = csv.writer(output)
    if rows:
        writer.writerow(rows[0].keys())
        for r in rows:
            writer.writerow(list(r))
    else:
        writer.writerow(["id", "roll_no", "name", "date", "status", "match_confidence"])
    return output.getvalue()

# --- Everyday Liveness AI Training & Adaptive Profile Calibration ---

def get_liveness_profile_for_user(user_id: int) -> Optional[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM liveness_model_profiles WHERE user_id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_liveness_profiles() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT p.*, u.name, u.department
    FROM liveness_model_profiles p
    LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.last_calibrated_at DESC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_liveness_training_stats() -> Dict[str, Any]:
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) as total_samples FROM liveness_telemetry")
    total_samples = cursor.fetchone()["total_samples"]

    cursor.execute("SELECT COUNT(DISTINCT user_id) as enrolled_students FROM liveness_telemetry")
    enrolled_students = cursor.fetchone()["enrolled_students"]

    cursor.execute("SELECT COUNT(*) as calibrated_count FROM liveness_model_profiles")
    calibrated_profiles = cursor.fetchone()["calibrated_count"]

    cursor.execute("SELECT AVG(baseline_ear) as avg_ear, AVG(texture_score) as avg_tex, AVG(specular_score) as avg_spec FROM liveness_telemetry WHERE status = 'PRESENT'")
    avg_row = cursor.fetchone()

    conn.close()
    return {
        "total_samples": total_samples,
        "enrolled_students": enrolled_students,
        "calibrated_profiles": calibrated_profiles,
        "global_average_ear": round(avg_row["avg_ear"], 3) if avg_row and avg_row["avg_ear"] else 0.30,
        "global_average_texture": round(avg_row["avg_tex"], 1) if avg_row and avg_row["avg_tex"] else 150.0,
        "global_average_specular": round(avg_row["avg_spec"], 2) if avg_row and avg_row["avg_spec"] else 1.2,
        "last_trained_at": get_setting("liveness_model_last_trained", "Never Trained")
    }

def train_and_recalibrate_liveness_model() -> Dict[str, Any]:
    """
    Continuous Online Learning Engine:
    Processes all everyday session telemetry from genuine student check-ins.
    Recalibrates personalized adaptive blink thresholds for all students.
    """
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT DISTINCT user_id, roll_no FROM liveness_telemetry WHERE status IN ('PRESENT', 'FLAGGED_PROXY')")
    users = cursor.fetchall()

    calibrated_count = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for u in users:
        uid = u["user_id"]
        rno = u["roll_no"]
        cursor.execute("""
        SELECT baseline_ear, specular_score, texture_score
        FROM liveness_telemetry
        WHERE user_id = ? AND status IN ('PRESENT', 'FLAGGED_PROXY')
        ORDER BY id DESC LIMIT 50
        """, (uid,))
        samples = cursor.fetchall()

        if not samples:
            continue

        ears = [s["baseline_ear"] for s in samples if s["baseline_ear"] and s["baseline_ear"] > 0.15]
        specs = [s["specular_score"] for s in samples if s["specular_score"] is not None]
        texts = [s["texture_score"] for s in samples if s["texture_score"] is not None]

        if not ears:
            continue

        mean_ear = sum(ears) / len(ears)
        variance_ear = sum((e - mean_ear) ** 2 for e in ears) / max(1, len(ears) - 1)
        std_ear = math.sqrt(variance_ear) if len(ears) > 1 else 0.03

        adaptive_thresh = max(0.18, min(0.25, mean_ear - (1.8 * std_ear)))

        mean_spec = sum(specs) / len(specs) if specs else 1.5
        mean_text = sum(texts) / len(texts) if texts else 150.0

        cursor.execute("""
        INSERT INTO liveness_model_profiles (
            user_id, roll_no, sample_count, mean_ear, std_ear, adaptive_blink_threshold,
            mean_texture, mean_specular, last_calibrated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            sample_count = excluded.sample_count,
            mean_ear = excluded.mean_ear,
            std_ear = excluded.std_ear,
            adaptive_blink_threshold = excluded.adaptive_blink_threshold,
            mean_texture = excluded.mean_texture,
            mean_specular = excluded.mean_specular,
            last_calibrated_at = excluded.last_calibrated_at
        """, (uid, rno, len(samples), round(mean_ear, 4), round(std_ear, 4), round(adaptive_thresh, 4), round(mean_text, 1), round(mean_spec, 2), now_str))

        calibrated_count += 1

    conn.commit()
    conn.close()

    set_setting("liveness_model_last_trained", now_str)
    return {
        "success": True,
        "calibrated_students": calibrated_count,
        "timestamp": now_str
    }
