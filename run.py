import sys
import os
import socket

# Ensure project root is in path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

import uvicorn

def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0

def get_available_port() -> int:
    env_port = os.environ.get("PORT")
    if env_port:
        return int(env_port)
    if not is_port_in_use(8000):
        return 8000
    if not is_port_in_use(8080):
        return 8080
    return 8081

if __name__ == "__main__":
    PORT = get_available_port()
    print("=" * 65)
    print("  VERIFACE: DIGITAL BIOMETRIC ATTENDANCE & ANTI-PROXY SYSTEM")
    print("=" * 65)
    print(f"  * Attendance Check-in:    http://localhost:{PORT}/")
    print(f"  * Face ID Enrollment:     http://localhost:{PORT}/register")
    print(f"  * Faculty/Lecturer Portal: http://localhost:{PORT}/lecturer")
    print(f"  * Host / Admin Console:   http://localhost:{PORT}/host")
    print("    (Default Host PIN: admin123)")
    print("=" * 65)
    
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, log_level="info")
