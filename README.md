# VeriFace: Enterprise Digital Biometric Attendance & Anti-Proxy Shield Portal

VeriFace is a full-stack, enterprise-grade biometric attendance-taking web application engineered for high-accuracy facial verification, anti-proxy defense mechanisms (30-second rolling classroom billboard TOTP, eye-blink liveness reality check, screen reflection analysis, and IP NAT awareness), and a dedicated Faculty Command Center with institutional Host Administrator audits.

---

## 🚀 Quick Access URLs

The application server defaults to port `8000` (or the port set by the `PORT` environment variable):

| Page | URL | Purpose |
| :--- | :--- | :--- |
| **Attendance Check-in** | [http://localhost:8000/](http://localhost:8000/) | Live biometric face scan to mark daily attendance with 30s classroom code. |
| **Face ID Registration** | [http://localhost:8000/register](http://localhost:8000/register) | Student enrollment (Roll Number, Full Name, 128-pt Face ID vector). |
| **Faculty Portal** | [http://localhost:8000/lecturer](http://localhost:8000/lecturer) | Faculty session creation, 30s rolling projector billboard, manual override. |
| **Host / Admin Portal** | [http://localhost:8000/host](http://localhost:8000/host) | Administrative console, attendance ledger, biometric audits, and security settings. |

> **Host Default PIN**: `admin123` (configurable in the settings panel)  
> **Default Faculty Accounts**: Created and managed exclusively by Host Admin in `/host`.

---

## 🛠️ System Architecture & Key Features

### 1. Biometric Face ID Enrollment (`/register`)
- **Facial Landmark & Embedding Extraction**: Uses ResNet-34 based deep neural networks (`face-api.js` + SSD MobileNet V1) to calculate a **128-dimensional floating-point biometric descriptor** for every enrolled face.
- **Centering & Alignment Guide**: Visual oval viewport with laser scan animations. The system requires the student to face forward in good lighting before registration can occur.
- **Duplicate Prevention**: Rejects duplicate roll numbers with institutional error handling (HTTP 409 Conflict).
- **DPDP Act 2023 Privacy Compliance**: Biometric descriptors are stored securely in the database. Vector exfiltration endpoints (`/api/users/all-descriptors`) are permanently blocked (HTTP 403 Forbidden). Public student lookup endpoints strip facial vectors, returning only verification status. Students possess a verifiable Right to Erasure (`DELETE /api/student/delete-biometrics/{roll_no}`).

### 2. Live Face Scan & Verification (`/`)
- **Strict Euclidean Distance Threshold**: Compares the live face scan against the enrolled descriptor using Euclidean distance ($D = \sqrt{\sum (e_1[i] - e_2[i])^2}$).
  - Distance $< 0.45$: High confidence match ($>90\%$). Status: **PRESENT**.
  - Distance $\ge 0.45$: **Mismatch Rejected**. Blocks impersonators from marking proxy attendance.
- **Dynamic Face Crop & Bandwidth Optimization**: Automatically scales detected face bounding boxes to standard capture canvas coordinates, transmitting ultra-lightweight verification payloads (< 1.5 KB JSON) for weak campus Wi-Fi networks.
- **Single Check-in Per Session**: Automatically prevents duplicate attendance on the same session code.
- **Digital Pass Modal**: Upon verification, presents an official digital attendance slip with timestamp, match confidence score, client IP, and location coordinates.

### 3. Faculty Command Center & 30-Second Rolling TOTP Billboard (`/lecturer`)
- **Cryptographic Faculty Authentication**:
  - Faculty login (`POST /api/lecturer/login`) verifies credentials and issues an HMAC-SHA256 signed session token stored in an HTTP-only secure cookie (`veriface_lecturer_token`) and supported via `X-Lecturer-Token` header.
  - Rate limiting protects against brute-force attacks (max 8 attempts/min per IP).
- **Strict Session Ownership & RBAC**:
  - Endpoints (`/api/lecturer/create-session`, `/api/lecturer/active-session`, `/api/lecturer/rolling-otp`, `/api/lecturer/manual-override`, `/api/lecturer/close-session`, `/api/lecturer/session-attendees`) strictly derive faculty identity from the cryptographically verified token.
  - Caller-supplied IDs without cryptographic proof are rejected with HTTP 401 Unauthorized.
  - Cross-faculty snooping or tampering (Lecturer A querying or closing Lecturer B's session) is strictly rejected with HTTP 403 Forbidden.
- **Anti-Forwarding 30-Second Rotating Projector Billboard**:
  - The faculty dashboard projects a high-visibility billboard code onto the classroom screen that rotates every 30 seconds.
  - **Cryptographic TOTP Generation**: Derived via HMAC-SHA256 from `session_id`, `session_secret`, and 30-second epoch time-step:
    $$\text{OTP} = (\text{HMAC-SHA256}(K, \lfloor t / 30 \rfloor) \pmod{900000}) + 100000$$
  - **Zero Lookahead Leakage**: The authenticated endpoint (`/api/lecturer/rolling-otp/{session_id}`) returns *only* the current 30-second OTP and seconds remaining. It never exposes future codes (`next_otp` eliminated), preventing students from sharing codes in advance.
  - **Physical Presence Requirement**: A remote or absent student cannot guess or query the billboard code. If a student inside class attempts to photograph and forward the code via WhatsApp or Telegram, transmission and processing delay causes the 30-second window to expire before the absent recipient can authenticate.
  - **Grace Window**: The server permits a 1-step grace window ($T$ and $T-1$) to handle camera scan time and network transit latency without compromising anti-forwarding security.
- **Faculty Manual Override**:
  - For students experiencing hardware camera failures, severe glare, or bandages, authenticated faculty can issue an official manual override (`POST /api/lecturer/manual-override`) with an audit trail note.

### 4. Anti-Proxy Security Shield
To ensure students cannot mark attendance for peers:
- **Liveness Reality Check**: Eye blink detection algorithm measures Eye Aspect Ratio (EAR) over live camera frames to verify physical human presence and block printed photo attacks.
- **Screen Glare & Reflection Analysis**: Analyzes specular reflection intensity to detect phone or tablet glass reflection.
- **Moiré Frequency & Micro-Texture Detection**: Computes Laplacian variance and spatial frequency to flag digital screen pixel matrices and low-resolution printouts.
- **Campus Wi-Fi NAT Exemption**: Recognizes institutional networks where hundreds of students share a single public gateway IP. When a student validates against the 30-second rotating classroom projector OTP, their physical presence is confirmed, exempting them from false multi-login IP proxy flags.
- **Geofence & Geolocation Guard**: Validates coordinates against campus latitude, longitude, and allowed radius. Flags impossible travel jumps or mock GPS location spoofing.

### 5. Host / Administrator Command Center (`/host`)
- **Password / PIN Protected**: Secure administrative login (`admin123`) issuing signed host session tokens.
- **Real-Time KPI Cards**: Total students enrolled, today's turnout, flagged proxy attempts, attendance percentage.
- **Attendance Ledger**: Filter by date, search roll numbers/names, or filter proxy suspects.
- **Side-by-Side Biometric Audit Modal**:
  - Displays the enrolled reference photo directly next to the live login snapshot taken at the exact second of authentication.
  - Displays Euclidean distance, confidence percentage, IP address, device user-agent, and a direct Google Maps pin.
  - Host override controls: *"Approve & Clear Flag"* or *"Revoke / Mark Rejected"*.
- **Faculty Management**: Create, assign subjects, and manage faculty credentials privately.
- **Full Database Backup & Disaster Recovery**:
  - Automated and on-demand JSON and CSV export endpoints (`/api/host/backup-database`) to safeguard against ephemeral container restarts.

---

## 🧪 Automated Security & Verification Test Suite

VeriFace includes a test suite verifying every security boundary, anti-proxy filter, and faculty session requirement:

```powershell
python test_app.py
```

The test suite validates:
1. Web portal page availability (Status 200).
2. Host admin PIN verification and token issuance.
3. Faculty registration and multi-lecturer separation.
4. Cryptographic faculty login, HTTP-only cookie setting, and unauthenticated endpoint rejection (HTTP 401).
5. Cross-faculty RBAC enforcement (HTTP 403 Forbidden for unauthorized session access).
6. 30-second rolling projector TOTP generation with lookahead leak prevention (no `next_otp`).
7. Header spoofing prevention (arbitrary `X-Lecturer-Id` without cryptographic token rejected with HTTP 401).
8. Live facial biometric verification with Euclidean distance $< 0.45$.
9. Silent anti-spoofing screen reflection and moiré detection.
10. Campus Wi-Fi NAT awareness and multi-student check-in.
11. DPDP Act 2023 Right to Erasure and vector exfiltration prevention (HTTP 403).
12. Database full JSON and CSV backups.
13. Session closing and logout cookie clearing.

---

## 📦 How to Start the Server

```powershell
python run.py
```

Server dependencies:
- `fastapi`
- `uvicorn`
- `jinja2`
- `aiofiles`
- `httpx`
- `pydantic`
- `sqlite3` (built-in)
