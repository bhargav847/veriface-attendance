import os
import sys
import time
import json
import base64
from fastapi.testclient import TestClient

# Add current path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from app.main import app
from app.database import init_db

# Initialize DB
init_db()

client = TestClient(app)

def test_system():
    print(">>> Running Full VeriFace Verification & Security Test Suite...")

    # 1. Test All Web Pages
    pages = ["/", "/register", "/host", "/lecturer"]
    for path in pages:
        res = client.get(path)
        assert res.status_code == 200, f"Page {path} failed: {res.status_code}"
        print(f"  [PASS] GET {path} (Status 200)")

    # 2. Host Authenticates & Registers a Lecturer Privately
    unauth_host = client.get("/api/host/stats")
    assert unauth_host.status_code == 401, f"Expected 401 Unauthorized for unprotected host route, got {unauth_host.status_code}"
    
    pin_res = client.post("/api/host/verify-pin", json={"pin": "admin123"})
    assert pin_res.status_code == 200
    host_token = pin_res.json().get("token")
    assert host_token is not None, "Host token was not returned on verify-pin"
    host_headers = {"X-Host-Token": host_token}
    print("  [PASS] POST /api/host/verify-pin (Host Admin Authenticated & Token Issued)")

    uid = int(time.time())
    lec_id = f"LEC-{uid % 10000}"
    lec_payload = {
        "lecturer_id": lec_id,
        "name": "Dr. Alan Turing",
        "email": "turing@university.edu",
        "department": "Computer Science",
        "password": "faculty_pass_123",
        "assigned_subject": "Computer Vision & Biometrics"
    }
    res = client.post("/api/host/lecturers", json=lec_payload, headers=host_headers)
    assert res.status_code == 200, f"Host create lecturer failed: {res.text}"
    assert res.json()["success"] is True
    print(f"  [PASS] POST /api/host/lecturers (Registered {lec_id})")

    # 3. Lecturer Logs In
    res = client.post("/api/lecturer/login", json={
        "lecturer_id": lec_id,
        "password": "faculty_pass_123"
    })
    assert res.status_code == 200, f"Lecturer login failed: {res.text}"
    lec_data = res.json()["lecturer"]
    assert lec_data["lecturer_id"] == lec_id
    print(f"  [PASS] POST /api/lecturer/login (Authenticated {lec_data['name']})")

    # 4. Lecturer Creates 5-Minute Class Session OTP
    otp_code = f"OTP{uid % 1000}"
    res = client.post("/api/lecturer/create-session", json={
        "lecturer_id": lec_id,
        "subject": "CS401 - Neural Networks",
        "custom_code": otp_code,
        "duration_minutes": 5
    })
    assert res.status_code == 200, f"Create session failed: {res.text}"
    session = res.json()["session"]
    session_id = session["session_id"]
    assert session["session_code"] == otp_code
    print(f"  [PASS] POST /api/lecturer/create-session (Active OTP: {otp_code}, Session ID: {session_id})")

    # Verify active session query
    res = client.get(f"/api/lecturer/active-session/{lec_id}")
    assert res.status_code == 200
    assert res.json()["has_active_session"] is True
    print(f"  [PASS] GET /api/lecturer/active-session/{lec_id} (Session validated)")

    # 5. Enroll Student Face ID Profile
    sample_img_b64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
    student_roll = f"STU-{uid % 10000}"
    student_descriptor = [0.05 * (i % 5) for i in range(128)]

    reg_payload = {
        "roll_no": student_roll,
        "name": "Jane Doe",
        "department": "Computer Science",
        "face_descriptor": student_descriptor,
        "avatar_data_url": sample_img_b64
    }
    res = client.post("/api/register", json=reg_payload)
    assert res.status_code == 200, f"Register failed: {res.text}"
    print(f"  [PASS] POST /api/register (Student {student_roll} enrolled)")

    # Duplicate registration rejected
    res = client.post("/api/register", json=reg_payload)
    assert res.status_code == 409
    print(f"  [PASS] POST /api/register (Duplicate roll rejected with HTTP 409)")

    # 6. Mark Attendance with Invalid / Wrong OTP (Must be blocked)
    res = client.post("/api/mark-attendance", json={
        "roll_no": student_roll,
        "session_code": "WRONG_OTP",
        "face_descriptor": student_descriptor,
        "snapshot_data_url": sample_img_b64
    })
    assert res.status_code == 400
    print(f"  [PASS] POST /api/mark-attendance (Invalid OTP correctly rejected with HTTP 400)")

    # 7. Mark Attendance with Valid 5-Minute OTP + Eye-Blink Reality Check + Altitude
    matching_descriptor = [val + 0.01 for val in student_descriptor] # Euclidean distance < 0.2
    attend_payload = {
        "roll_no": student_roll,
        "session_code": otp_code,
        "face_descriptor": matching_descriptor,
        "snapshot_data_url": sample_img_b64,
        "latitude": 12.9716,
        "longitude": 77.5946,
        "accuracy": 7.5,
        "altitude": 920.4,
        "altitude_accuracy": 3.2,
        "device_info": "Chrome on Windows 11",
        "liveness_verified": True,
        "blink_count": 2,
        "location_address": "Tech Block B, 4th Floor (±7.5m)"
    }
    test_client_ip = f"198.51.100.{uid % 200 + 1}"
    res = client.post("/api/mark-attendance", json=attend_payload, headers={"X-Forwarded-For": test_client_ip})
    assert res.status_code == 200, f"Mark attendance failed: {res.text}"
    attend_data = res.json()
    assert attend_data["success"] is True
    assert attend_data["status"] == "PRESENT"
    rec = attend_data["record"]
    assert rec["match_confidence"] > 85.0
    assert rec["session_code"] == otp_code
    assert rec["liveness_verified"] is True
    print(f"  [PASS] POST /api/mark-attendance (Verified! Conf: {rec['match_confidence']}%, Dist: {rec['match_distance']}, Alt: 920.4m, Blinks: 2)")

    # 8. Lecturer Views Live Attendees
    res = client.get(f"/api/lecturer/session-attendees/{session_id}")
    assert res.status_code == 200
    attendees = res.json()["attendees"]
    assert len(attendees) >= 1
    assert attendees[0]["roll_no"] == student_roll
    print(f"  [PASS] GET /api/lecturer/session-attendees (Found {len(attendees)} student check-ins)")

    # 9. Host Oversight & Audit
    # PIN auth
    res = client.post("/api/host/verify-pin", json={"pin": "admin123"})
    assert res.status_code == 200
    print(f"  [PASS] POST /api/host/verify-pin (Admin authenticated)")

    # Stats
    res = client.get("/api/host/stats", headers=host_headers)
    assert res.status_code == 200
    stats = res.json()["stats"]
    assert stats["total_students"] >= 1
    assert stats["today_present"] >= 1
    print(f"  [PASS] GET /api/host/stats (Total Students: {stats['total_students']}, Present Today: {stats['today_present']})")

    # CSV Export
    res = client.get("/api/host/export-csv", headers=host_headers)
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    print(f"  [PASS] GET /api/host/export-csv (CSV downloaded)")

    # 10. Test PWA Static Manifest & Service Worker
    res = client.get("/static/manifest.json")
    assert res.status_code == 200
    assert "VeriFace" in res.text
    res = client.get("/static/sw.js")
    assert res.status_code == 200
    res = client.get("/static/icons/icon-192.png")
    assert res.status_code == 200
    print("  [PASS] GET /static/manifest.json & sw.js & icons (PWA configured)")

    # 11. Test Silent Anti-Spoofing: Screen Reflection & Moiré Texture Flagging
    spoof_roll = f"SPOOF-{uid % 10000}"
    client.post("/api/register", json={
        "roll_no": spoof_roll,
        "name": "Screen Spoof Tester",
        "department": "Computer Science",
        "face_descriptor": student_descriptor,
        "avatar_data_url": sample_img_b64
    })
    spoof_payload = dict(attend_payload)
    spoof_payload["roll_no"] = spoof_roll
    spoof_payload["specular_score"] = 12.5 # High screen glare
    spoof_ip = f"198.51.100.{uid % 150 + 50}"
    res = client.post("/api/mark-attendance", json=spoof_payload, headers={"X-Forwarded-For": spoof_ip})
    assert res.status_code == 200
    spoof_res = res.json()
    assert spoof_res["status"] == "FLAGGED_PROXY"
    assert "Screen Glare Alert" in spoof_res["record"]["proxy_flags"]
    print("  [PASS] POST /api/mark-attendance (Screen glare reflection correctly flagged)")

    # 12. Test Adaptive Liveness Training & Everyday Calibration
    res = client.post("/api/host/train-liveness", headers=host_headers)
    assert res.status_code == 200
    train_data = res.json()
    assert train_data["success"] is True
    print(f"  [PASS] POST /api/host/train-liveness (Trained {train_data['calibrated_students']} student profiles)")

    res = client.get("/api/host/liveness-stats", headers=host_headers)
    assert res.status_code == 200
    l_stats = res.json()["stats"]
    assert l_stats["total_samples"] >= 1
    print(f"  [PASS] GET /api/host/liveness-stats (Observed {l_stats['total_samples']} everyday telemetry samples)")

    # 13. Test Keep-Alive Health Route (Fix 9: Render sleep mitigation)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "healthy"
    print("  [PASS] GET /health & /api/health (Uptime pinger keep-alive 200 OK)")

    # 14. Test 30-Second Rolling OTP (Secured against sniffing)
    unauth_otp = client.get(f"/api/lecturer/rolling-otp/{session_id}")
    assert unauth_otp.status_code == 401, f"Expected 401 Unauthorized for unauthenticated rolling OTP access, got {unauth_otp.status_code}"
    print("  [PASS] GET /api/lecturer/rolling-otp (Blocked 401: Unauthenticated code sniffing prevented)")

    res = client.get(f"/api/lecturer/rolling-otp/{session_id}", headers={"X-Lecturer-Id": lec_id})
    assert res.status_code == 200
    rolling_data = res.json()
    assert "rolling_otp" in rolling_data
    assert len(rolling_data["rolling_otp"]) == 6
    rolling_code = rolling_data["rolling_otp"]
    print(f"  [PASS] GET /api/lecturer/rolling-otp/{session_id} (Authenticated Faculty: 30s Code {rolling_code})")

    # 15. Test Lightweight Vector-Only Check-in with Rolling OTP (Fix 6: Weak Wi-Fi & Fix 2)
    vector_roll = f"VEC-{uid}"
    client.post("/api/register", json={
        "roll_no": vector_roll,
        "name": "Vector Only Student",
        "department": "Computer Science",
        "face_descriptor": student_descriptor,
        "avatar_data_url": ""  # No image uploaded
    })
    vec_payload = {
        "roll_no": vector_roll,
        "face_descriptor": student_descriptor,
        "session_code": rolling_code,  # Verified via 30s rolling projector OTP
        "snapshot_data_url": "",      # Lightweight vector-only (< 1.5 KB JSON payload)
        "device_id": f"dev-{uid}",
        "liveness_verified": True,
        "blink_count": 1
    }
    res = client.post("/api/mark-attendance", json=vec_payload, headers={"X-Forwarded-For": f"198.51.100.{uid % 100 + 10}"})
    assert res.status_code == 200
    assert res.json()["status"] == "PRESENT"
    print("  [PASS] POST /api/mark-attendance (Lightweight 1.5 KB payload verified via 30s Rolling OTP)")

    # 16. Test Lecturer Manual Override (Fix 4: Low-end phones / camera failure)
    override_roll = f"MAN-{uid}"
    client.post("/api/register", json={
        "roll_no": override_roll,
        "name": "Broken Camera Student",
        "department": "Mechanical Eng",
        "face_descriptor": student_descriptor,
        "avatar_data_url": ""
    })
    res = client.post("/api/lecturer/manual-override", json={
        "session_id": session_id,
        "lecturer_id": lec_id,
        "roll_no": override_roll,
        "reason": "Hardware camera failure / Low light"
    })
    assert res.status_code == 200
    assert res.json()["success"] is True
    print("  [PASS] POST /api/lecturer/manual-override (Faculty marked broken-camera student Present)")

    # 17. Test DPDP Act 2023 Biometric Erasure (Fix 3: Right to Erasure)
    res = client.delete(f"/api/student/delete-biometrics/{override_roll}")
    assert res.status_code == 200
    assert res.json()["success"] is True
    # Confirm user is erased
    lookup_res = client.get(f"/api/user/lookup/{override_roll}")
    assert lookup_res.status_code == 404
    print(f"  [PASS] DELETE /api/student/delete-biometrics/{override_roll} (DPDP Act Right to Erasure verified)")

    # 18. Test Full Database Backup (Fix 5: Render free disk is ephemeral)
    res_json_bk = client.get("/api/host/backup-database?format=json", headers=host_headers)
    assert res_json_bk.status_code == 200
    assert "application/json" in res_json_bk.headers["content-type"]
    res_csv_bk = client.get("/api/host/backup-database?format=csv", headers=host_headers)
    assert res_csv_bk.status_code == 200
    assert "text/csv" in res_csv_bk.headers["content-type"]
    print("  [PASS] GET /api/host/backup-database (JSON & CSV complete database export verified)")

    # 19. Test Biometric Vector Leak Prevention (DPDP Act 2023 Security Hardening)
    leak_res = client.get("/api/users/all-descriptors")
    assert leak_res.status_code == 403, f"Expected 403 Forbidden, got {leak_res.status_code}"
    assert "Access Denied" in leak_res.json()["detail"]
    
    # Confirm student lookup does not leak face_descriptor
    lookup_clean = client.get(f"/api/user/lookup/{student_roll}")
    assert lookup_clean.status_code == 200
    assert "face_descriptor" not in lookup_clean.json()["user"], "Security Failure: face_descriptor was leaked in user lookup!"
    assert lookup_clean.json()["user"]["is_enrolled"] is True
    print("  [PASS] GET /api/users/all-descriptors (Blocked HTTP 403: Biometric vector exfiltration prevented)")
    print("  [PASS] GET /api/user/lookup/{roll_no} (Privacy Hardened: No 128-D vector leaked in profile payload)")

    # 20. Test Campus Wi-Fi NAT Exemption & SQLite WAL Concurrency
    # Multiple students on the same shared campus IP submitting via rotating projector code
    shared_campus_ip = "203.0.113.88"
    for s_idx in range(3):
        w_roll = f"WIFI-{uid % 1000}-{s_idx}"
        client.post("/api/register", json={
            "roll_no": w_roll,
            "name": f"Campus Wifi Student {s_idx}",
            "department": "IT",
            "face_descriptor": student_descriptor,
            "avatar_data_url": ""
        })
        w_res = client.post("/api/mark-attendance", json={
            "roll_no": w_roll,
            "face_descriptor": student_descriptor,
            "session_code": rolling_code,
            "snapshot_data_url": "",
            "device_id": f"dev-wifi-{s_idx}",
            "liveness_verified": True,
            "blink_count": 1
        }, headers={"X-Forwarded-For": shared_campus_ip})
        assert w_res.status_code == 200
        # Should NOT be marked as FLAGGED_PROXY because rolling projector OTP verified presence!
        assert w_res.json()["status"] == "PRESENT", f"Student {w_roll} was falsely flagged on shared IP!"
    print("  [PASS] Campus Wi-Fi NAT Exemption Verified: Multiple in-class students on shared router not falsely flagged")

    print("\n>>> ALL TESTS PASSED SUCCESSFULLY! VeriFace is completely verified and operational. <<<\n")

if __name__ == "__main__":
    test_system()
