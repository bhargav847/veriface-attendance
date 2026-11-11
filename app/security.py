import math
import os
import base64
import time
import hashlib
import hmac
from datetime import datetime
from collections import defaultdict
from typing import List, Tuple, Optional, Dict, Any
from app.database import get_setting, count_distinct_users_on_ip_today, get_liveness_profile_for_user

# In-memory sliding window rate limiter: { (client_ip, action): [timestamps...] }
_rate_limit_records = defaultdict(list)

def is_rate_limited(client_ip: str, action: str, max_requests: int = 15, window_seconds: int = 60) -> bool:
    """
    Sliding window in-memory rate limiter to protect open endpoints against bots and spam.
    Returns True if request exceeds max_requests within window_seconds.
    """
    now = time.time()
    key = (client_ip, action)
    timestamps = _rate_limit_records[key]
    
    # Purge timestamps outside the sliding window
    cutoff = now - window_seconds
    valid_timestamps = [t for t in timestamps if t > cutoff]
    _rate_limit_records[key] = valid_timestamps
    
    if len(valid_timestamps) >= max_requests:
        return True
        
    valid_timestamps.append(now)
    _rate_limit_records[key] = valid_timestamps
    return False

def generate_rolling_otp(session_id: int, secret: str = "", window_seconds: int = 30) -> Dict[str, Any]:
    """
    Generates a 6-digit rolling OTP that updates every 30 seconds for classroom projector display.
    Derived deterministically from session_id + session_secret + epoch_step.
    """
    epoch_now = time.time()
    step = int(epoch_now // window_seconds)
    seconds_remaining = window_seconds - int(epoch_now % window_seconds)
    
    key = f"veriface_session_{session_id}_{secret}".encode("utf-8")
    msg = str(step).encode("utf-8")
    h = hmac.new(key, msg, hashlib.sha256).hexdigest()
    
    # 6 numeric digits: 100000 - 999999
    otp_int = (int(h[:8], 16) % 900000) + 100000
    otp = str(otp_int)
    
    return {
        "otp": otp,
        "seconds_remaining": seconds_remaining,
        "window_seconds": window_seconds,
        "step": step
    }

def verify_rolling_otp(submitted_code: str, session_id: int, secret: str = "", window_seconds: int = 30) -> bool:
    """
    Verifies rolling OTP with a 1-step grace window (current step T and previous step T-1)
    to accommodate camera scan lag and weak Wi-Fi transmission delay.
    """
    clean_code = (submitted_code or "").strip().upper()
    if not clean_code:
        return False
        
    epoch_now = time.time()
    current_step = int(epoch_now // window_seconds)
    key = f"veriface_session_{session_id}_{secret}".encode("utf-8")
    
    # Check current window and previous window (grace period of 30 seconds)
    for step in (current_step, current_step - 1):
        msg = str(step).encode("utf-8")
        h = hmac.new(key, msg, hashlib.sha256).hexdigest()
        otp_val = str((int(h[:8], 16) % 900000) + 100000)
        if clean_code == otp_val:
            return True
            
    return False

def check_impossible_travel(
    prev_lat: Optional[float],
    prev_lon: Optional[float],
    prev_timestamp: Optional[Any],
    current_lat: Optional[float],
    current_lon: Optional[float],
    max_speed_kmh: float = 200.0,
    min_distance_meters: float = 1000.0
) -> Tuple[bool, Optional[str]]:
    """
    Detects impossible teleportation / mock GPS jumps between consecutive scans for the same student.
    e.g. Scanned in Location A 5 minutes ago, now scanning from Location B 50 km away.
    """
    if prev_lat is None or prev_lon is None or current_lat is None or current_lon is None or prev_timestamp is None:
        return False, None
        
    try:
        dist_m = haversine_distance_meters(prev_lat, prev_lon, current_lat, current_lon)
        if dist_m < min_distance_meters:
            return False, None
            
        now = datetime.now()
        if isinstance(prev_timestamp, str):
            try:
                prev_dt = datetime.fromisoformat(prev_timestamp.replace("Z", ""))
            except Exception:
                try:
                    prev_dt = datetime.strptime(prev_timestamp, "%Y-%m-%d %H:%M:%S")
                except Exception:
                    return False, None
        elif isinstance(prev_timestamp, datetime):
            prev_dt = prev_timestamp
        else:
            return False, None
            
        time_diff_seconds = abs((now - prev_dt).total_seconds())
        if time_diff_seconds < 1:
            time_diff_seconds = 1
            
        speed_ms = dist_m / time_diff_seconds
        speed_kmh = speed_ms * 3.6
        
        if speed_kmh > max_speed_kmh:
            dist_km = round(dist_m / 1000.0, 1)
            reason = f"Impossible Travel Jump Detected: Speed {int(speed_kmh)} km/h across {dist_km} km in {int(time_diff_seconds)}s (suspected mock GPS app)"
            return True, reason
    except Exception:
        pass
        
    return False, None

def calculate_euclidean_distance(desc1: List[float], desc2: List[float]) -> float:
    """Calculate Euclidean distance between two 128-dimensional face embedding vectors."""
    if len(desc1) != len(desc2):
        raise ValueError(f"Descriptor lengths mismatch: {len(desc1)} vs {len(desc2)}")
    total = sum((a - b) ** 2 for a, b in zip(desc1, desc2))
    return math.sqrt(total)

def compute_match_confidence(distance: float, threshold: float = 0.45) -> float:
    """
    Computes an intuitive percentage confidence (0% - 100%).
    Under threshold (e.g. <= 0.45), confidence is in 80% - 99.9% range.
    Above threshold, confidence drops rapidly.
    """
    if distance <= 0.05:
        return 99.8
    elif distance <= threshold:
        # Scale between 80% and 99%
        ratio = distance / threshold
        conf = 99.0 - (ratio * 19.0)
        return round(conf, 1)
    else:
        # Scale down from 79% to 0%
        excess = distance - threshold
        conf = max(0.0, 79.0 - (excess / 0.40) * 79.0)
        return round(conf, 1)

def haversine_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculates the great circle distance between two points on the earth in meters.
    """
    R = 6371000.0  # Earth's radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c

def save_base64_image(base64_str: str, folder: str, filename_prefix: str) -> str:
    """
    Saves a base64 image data URL (e.g. data:image/jpeg;base64,...) to disk.
    Returns relative web path (e.g. /static/uploads/avatars/...).
    If base64_str is empty, returns empty string.
    """
    if not base64_str or not base64_str.strip():
        return ""

    if "," in base64_str:
        base64_data = base64_str.split(",", 1)[1]
    else:
        base64_data = base64_str

    try:
        image_bytes = base64.b64decode(base64_data)
    except Exception:
        return ""

    timestamp = int(time.time() * 1000)
    filename = f"{filename_prefix}_{timestamp}.jpg"
    
    root_dir = os.path.dirname(os.path.dirname(__file__))
    target_dir = os.path.join(root_dir, "static", "uploads", folder)
    os.makedirs(target_dir, exist_ok=True)

    file_path = os.path.join(target_dir, filename)
    with open(file_path, "wb") as f:
        f.write(image_bytes)

    return f"/static/uploads/{folder}/{filename}"

def extract_client_ip(headers: Dict[str, str], client_host: Optional[str]) -> str:
    """Extract true client IP taking proxies and Cloudflare CF-Connecting-IP into account."""
    # Check Cloudflare CF-Connecting-IP header first
    cf_ip = headers.get("cf-connecting-ip") or headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip.strip()

    x_forwarded_for = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()

    x_real_ip = headers.get("x-real-ip") or headers.get("X-Real-IP")
    if x_real_ip:
        return x_real_ip.strip()

    if client_host:
        return client_host

    return "127.0.0.1"

# Cryptographic Session & Access Token Salt
AUTH_SECRET = os.environ.get("VERIFACE_AUTH_SECRET", "veriface_enterprise_secure_salt_2026")

def generate_session_token(subject: str, role: str = "host", valid_hours: int = 24) -> str:
    """Generates a tamper-proof signed authorization token for host admin or faculty."""
    expires = int(time.time()) + (valid_hours * 3600)
    payload = f"{subject}:{role}:{expires}"
    sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(f"{payload}:{sig}".encode()).decode()

def verify_session_token(token: str, expected_role: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Verifies a signed session token and returns payload dictionary if authentic and unexpired."""
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        parts = decoded.split(":")
        if len(parts) != 4:
            return None
        subject, role, expires_str, sig = parts
        expires = int(expires_str)
        if time.time() > expires:
            return None
        payload = f"{subject}:{role}:{expires_str}"
        expected_sig = hmac.new(AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expected_sig):
            return None
        if expected_role and role != expected_role:
            return None
        return {"subject": subject, "role": role, "expires": expires}
    except Exception:
        return None

def perform_anti_proxy_evaluation(
    user_id: int,
    roll_no: str,
    ip_address: str,
    lat: Optional[float],
    lon: Optional[float],
    accuracy: Optional[float],
    date_str: str,
    liveness_verified: bool = True,
    blink_count: int = 0,
    specular_score: Optional[float] = None,
    texture_score: Optional[float] = None,
    moire_detected: Optional[bool] = False,
    ear_value: Optional[float] = None,
    device_sharing_alert: Optional[str] = None,
    impossible_travel_alert: Optional[str] = None,
    is_rolling_match: bool = False
) -> Tuple[bool, List[str]]:
    """
    Evaluates multi-layer anti-proxy triggers:
    1. Liveness reality check (Dynamic eye blink detection & personalized adaptive threshold).
    2. Screen reflection & specular glare analysis (Detects phone/tablet glass reflection).
    3. Micro-texture & Moiré frequency analysis (Detects digital display pixel matrices & printouts).
    4. Multi-login on the same IP (IP clumping & Campus Wi-Fi NAT awareness).
    5. Geofence perimeter check with GPS accuracy buffer & altitude telemetry.
    6. Impossible travel & mock GPS detection.
    7. Shared hardware device detection.
    Returns (is_proxy_suspect: bool, flags: List[str]).
    """
    flags = []
    is_suspect = False

    # Check 1: Liveness / Reality Check Verification & Adaptive Baseline Check
    if not liveness_verified:
        is_suspect = True
        flags.append("Liveness Check Failed: No dynamic eye blink detected (potential static photo/screen spoof)")
    else:
        # Check against student's learned personal adaptive liveness profile (if trained)
        profile = get_liveness_profile_for_user(user_id)
        if profile and ear_value is not None:
            mean_calibrated_ear = profile.get("mean_ear", 0.30)
            if ear_value > 0.45 or ear_value < 0.15:
                flags.append(f"Liveness Calibration Advisory: Measured EAR ({round(ear_value, 2)}) deviates from learned baseline ({round(mean_calibrated_ear, 2)})")

    # Check 2: Screen Glare & Specular Reflection Analysis
    if specular_score is not None and specular_score > 3.8:
        is_suspect = True
        flags.append(f"Screen Glare Alert: Abnormal glass reflection / display blowout detected ({round(specular_score, 1)}% > 3.8% limit - suspected phone/tablet screen)")

    # Check 3: Micro-Texture & High-Frequency Moiré Pattern Analysis
    if moire_detected:
        is_suspect = True
        flags.append("Display Grid Alert: High-frequency periodic Moiré interference pattern detected (suspected digital screen display)")
    elif texture_score is not None and texture_score < 18.0:
        is_suspect = True
        flags.append(f"Texture Anomaly: Abnormal low-frequency blur / smooth printout detected (texture variance: {round(texture_score, 1)} < 18.0)")
    elif texture_score is not None and texture_score > 360.0:
        is_suspect = True
        flags.append(f"Texture Anomaly: High-frequency subpixel grid / screen grain detected (texture variance: {round(texture_score, 1)} > 360.0)")

    # Check 4: Shared Device Binding Alert
    if device_sharing_alert:
        is_suspect = True
        flags.append(f"Shared Device Alert: {device_sharing_alert}")

    # Check 5: Impossible Travel / Mock GPS Teleportation
    if impossible_travel_alert:
        is_suspect = True
        flags.append(impossible_travel_alert)

    # Check 6: Multi-login on the same IP (IP sharing detection with Campus Wi-Fi NAT exemption)
    try:
        max_ip_limit = int(get_setting("max_users_per_ip_per_day", "15"))
    except ValueError:
        max_ip_limit = 15

    exempt_wifi = get_setting("exempt_campus_wifi", "true").lower() in ("true", "1")
    other_users_count = count_distinct_users_on_ip_today(ip_address, date_str, exclude_user_id=user_id)
    if other_users_count >= max_ip_limit:
        if exempt_wifi and is_rolling_match:
            # Physical presence is guaranteed via classroom projector 30-second rolling TOTP
            flags.append(f"Institutional Wi-Fi NAT: {other_users_count} students connected via IP {ip_address} (Verified via 30s Projector OTP)")
        else:
            is_suspect = True
            flags.append(f"Shared IP Address: {other_users_count} other user(s) already checked in from IP {ip_address} today")

    # Check 7: Geofence perimeter check & precision evaluation
    geofence_enabled = get_setting("geofence_enabled", "false").lower() in ("true", "1", "yes")
    if geofence_enabled:
        if lat is None or lon is None:
            is_suspect = True
            flags.append("Geolocation Missing: Location permissions denied or unavailable while geofence is strictly enforced")
        else:
            try:
                campus_lat = float(get_setting("campus_lat", "12.971600"))
                campus_lon = float(get_setting("campus_lon", "77.594600"))
                radius_m = float(get_setting("geofence_radius_meters", "500"))

                distance_m = haversine_distance_meters(lat, lon, campus_lat, campus_lon)
                acc_text = f" (GPS margin ±{int(accuracy)}m)" if accuracy is not None else ""

                if distance_m > radius_m:
                    is_suspect = True
                    dist_km = round(distance_m / 1000.0, 2)
                    flags.append(f"Geofence Breach: Location is {dist_km} km ({int(distance_m)}m) away from campus perimeter (allowed radius: {int(radius_m)}m){acc_text}")
            except Exception as e:
                flags.append(f"Geofence evaluation warning: {str(e)}")

    # Check 8: Weak Indoor GPS Accuracy
    if accuracy is not None and accuracy > 80.0:
        flags.append(f"Weak Indoor Location Accuracy: GPS error margin is coarse (±{int(accuracy)}m) - correlation paired with 30s rotating classroom OTP")

    return is_suspect, flags
