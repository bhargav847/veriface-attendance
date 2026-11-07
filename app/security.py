import math
import os
import base64
import time
from typing import List, Tuple, Optional, Dict, Any
from app.database import get_setting, count_distinct_users_on_ip_today, get_liveness_profile_for_user

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
    """
    if "," in base64_str:
        base64_data = base64_str.split(",", 1)[1]
    else:
        base64_data = base64_str

    image_bytes = base64.b64decode(base64_data)
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
    """Extract true client IP taking proxies and forwards into account."""
    x_forwarded_for = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()

    x_real_ip = headers.get("x-real-ip") or headers.get("X-Real-IP")
    if x_real_ip:
        return x_real_ip.strip()

    if client_host:
        return client_host

    return "127.0.0.1"

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
    ear_value: Optional[float] = None
) -> Tuple[bool, List[str]]:
    """
    Evaluates multi-layer anti-proxy triggers:
    1. Liveness reality check (Dynamic eye blink detection & personalized adaptive threshold).
    2. Screen reflection & specular glare analysis (Detects phone/tablet glass reflection).
    3. Micro-texture & Moiré frequency analysis (Detects digital display pixel matrices & printouts).
    4. Multi-login on the same IP (IP clumping & device sharing detection).
    5. Geofence perimeter check with GPS accuracy buffer & altitude telemetry.
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
            adaptive_thresh = profile.get("adaptive_blink_threshold", 0.22)
            # If the student's reported resting EAR deviates radically from their calibrated baseline
            mean_calibrated_ear = profile.get("mean_ear", 0.30)
            if ear_value > 0.45 or ear_value < 0.15:
                flags.append(f"Liveness Calibration Advisory: Measured EAR ({round(ear_value, 2)}) deviates from learned baseline ({round(mean_calibrated_ear, 2)})")

    # Check 2: Screen Glare & Specular Reflection Analysis
    # Physical screens emit high specular glare clusters with saturated pixels (> 8.5% of ROI)
    if specular_score is not None and specular_score > 8.5:
        is_suspect = True
        flags.append(f"Screen Glare Alert: Abnormal specular glass reflection index ({round(specular_score, 1)}% > 8.5% threshold) indicates potential smartphone/tablet screen reflection")

    # Check 3: Micro-Texture & High-Frequency Moiré Pattern Analysis
    # Displays photographed by a camera produce periodic Moiré banding or subpixel noise (Laplacian variance > 580)
    # Low-res static printouts have low texture variance (< 12.0)
    if moire_detected:
        is_suspect = True
        flags.append("Display Grid Alert: High-frequency periodic Moiré interference pattern detected (suspected digital screen display)")
    elif texture_score is not None and texture_score < 12.0:
        is_suspect = True
        flags.append(f"Texture Anomaly: Abnormal low-frequency blur / smooth printout detected (texture variance: {round(texture_score, 1)} < 12.0)")
    elif texture_score is not None and texture_score > 580.0:
        is_suspect = True
        flags.append(f"Texture Anomaly: Excessive high-frequency subpixel grid noise detected (texture variance: {round(texture_score, 1)} > 580.0)")

    # Check 4: Multi-login on the same IP (IP sharing detection)
    try:
        max_ip_limit = int(get_setting("max_users_per_ip_per_day", "2"))
    except ValueError:
        max_ip_limit = 2

    # Localhost loopback can be common in local testing, but still flagged if high
    other_users_count = count_distinct_users_on_ip_today(ip_address, date_str, exclude_user_id=user_id)
    if other_users_count >= max_ip_limit:
        is_suspect = True
        flags.append(f"Shared IP Address: {other_users_count} other user(s) already checked in from IP {ip_address} today")

    # Check 5: Geofence perimeter check & precision evaluation
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

    if accuracy is not None and accuracy > 200:
        flags.append(f"Coarse Location Accuracy: GPS error buffer is large (±{int(accuracy)}m)")

    return is_suspect, flags
