# VeriFace: Enterprise Digital Biometric Attendance & Anti-Proxy Shield Portal

VeriFace is a full-stack, enterprise-grade biometric attendance-taking web application designed with high-accuracy facial recognition, anti-proxy fraud defense mechanisms (IP address inspection + GPS geofencing), and a dedicated Host / Administrator Console.

---

## 🚀 Quick Access URLs

The application server runs locally at port `8080`:

| Page | URL | Purpose |
| :--- | :--- | :--- |
| **Attendance Check-in** | [http://localhost:8080/](http://localhost:8080/) | Live biometric face scan to mark daily attendance. |
| **Face ID Registration** | [http://localhost:8080/register](http://localhost:8080/register) | Student enrollment (Roll Number, Full Name, 128-pt Face ID). |
| **Host / Admin Portal** | [http://localhost:8080/host](http://localhost:8080/host) | Attendance ledger, side-by-side face audit, proxy alerts, settings. |

> **Host Default PIN**: `admin123` (configurable in the settings panel)

---

## 🛠️ System Architecture & Key Features

### 1. Biometric Face ID Enrollment (`/register`)
- **Facial Landmark & Embedding Extraction**: Uses ResNet-34 based deep neural networks (`face-api.js` + SSD MobileNet V1) to calculate a **128-dimensional floating-point biometric descriptor** for every enrolled face.
- **Centering & Alignment Guide**: Visual oval viewport with laser scan animations. The system requires the student to face forward in good lighting before registration can occur.
- **Duplicate Prevention**: Prevents duplicate roll numbers from registering with clear institutional validation.

### 2. Live Face Scan & Verification (`/`)
- **Strict Euclidean Distance Threshold**: Compares the live face scan against the enrolled descriptor using Euclidean distance ($D = \sqrt{\sum (e_1[i] - e_2[i])^2}$).
  - Distance $< 0.45$: High confidence match ($>90\%$). Status: **PRESENT**.
  - Distance $\ge 0.45$: **Mismatch Rejected**. Blocks impersonators from marking proxy attendance.
- **Single Daily Check-in**: Automatically prevents duplicate attendance on the same day.
- **Digital Pass Modal**: Upon verification, presents an official digital attendance slip with timestamp, match confidence score, client IP, and location coordinates.

### 3. Anti-Proxy Security Shield
To ensure students cannot mark attendance for peers:
- **IP Address Tracking & Clumping Guard**: Captures device IP address (`X-Forwarded-For` or client host). If multiple different students mark attendance from the exact same IP address within the day, the system automatically flags them as **`FLAGGED_PROXY`** with a warning: *"Shared IP Address detected"*.
- **GPS Geolocation Verification**: Captures precise browser coordinates (`navigator.geolocation.getCurrentPosition`).
- **Campus Geofencing**: Administrators can set campus center coordinates (latitude & longitude) and an allowed radius (e.g. 500 meters). Any check-in attempt outside the radius is flagged.

### 4. Host / Administrator Command Center (`/host`)
- **Password / PIN Protected**: Secure administrative login (`admin123`).
- **Real-Time KPI Cards**: Total students enrolled, today's turnout, flagged proxy attempts, attendance percentage.
- **Attendance Ledger**: Filter by date, search roll numbers/names, or filter only proxy suspects.
- **Side-by-Side Biometric Audit Modal**:
  - Displays the enrolled reference photo directly next to the live login snapshot taken at the exact second of authentication.
  - Shows Euclidean distance, confidence percentage, IP address, device user-agent, and a direct Google Maps pin.
  - Host override controls: *"Approve & Clear Flag"* or *"Revoke / Mark Rejected"*.
- **Student Directory**: Inspect enrolled profiles and delete or re-enroll profiles.
- **Geofence & Security Configuration**:
  - Toggle geofence enforcement on/off.
  - One-click *"Set to My Current GPS Coordinates"* button.
  - Radius slider, IP multi-login threshold slider, and face match tolerance slider.
- **Instant CSV Export**: Download attendance sheets formatted for university and organizational spreadsheets.

---

## 📦 How to Start the Server

```powershell
python run.py
```

Dependencies installed in the environment:
- `fastapi`
- `uvicorn`
- `jinja2`
- `aiofiles`
- `httpx`
- `pydantic`
- `sqlite3` (built-in)
