<div align="center">
  <h1>🌐 OMNI_BRIDGE</h1>
  <strong>The Standalone Web Control Terminal for Antigravity AI</strong>
  <br><br>
</div>

---

## 📖 Overview

**OmniBridge** is a high-performance, standalone web-based dashboard designed to interact with and control instances of the **Antigravity AI** core. Built with an elite Sci-Fi UI, it eliminates the need for third-party messengers (like Telegram) and offers a direct, secure, and blazing-fast communication tunnel directly into your AI environment.

### ✨ Key Features
- **🚀 Instant Execution:** Zero latency communication with your Antigravity agent.
- **🛡️ Secure Access:** Protected by built-in Basic HTTP Authentication.
- **🌍 Auto-Tunneling:** Automatically establishes public internet URLs (`localtunnel`) on boot so you can access your AI remotely from any device.
- **🧠 Intelligent Watchers:** Automatically detects when Antigravity crashes or stalls, automatically pressing "Retry" to keep your agent alive.
- **🎨 Elite UI/UX:** Built with TailwindCSS featuring dynamic Glassmorphism, real-time message streaming, and Sci-Fi audio notifications.

---

## ⚙️ Installation & Setup

### 1. Prerequisites
- **Node.js** (v18 or higher)
- An active instance of **Antigravity AI**.

### 2. Configure Antigravity (CRUCIAL STEP)
OmniBridge connects to Antigravity by tapping into its Chrome DevTools Protocol (CDP). For this to work, you **must** start your Antigravity browser with remote debugging enabled on a specific port.

Ensure your Antigravity instance is launched with the following flag:
```bash
--remote-debugging-port=9222
```
*(Note: If you change this port in Antigravity, you must also update the `CDP_PORT` in OmniBridge).*

### 3. Setup OmniBridge
Open the terminal in the OmniBridge folder and install the dependencies:
```bash
npm install
```

Create a `.env` file in the root directory and configure your credentials. This ensures no unauthorized person can access your AI via the public tunnel:

```env
# Port where the OmniBridge Web Interface will be hosted locally
WEB_PORT=8080

# The debugging port configured in Antigravity (from Step 2)
CDP_PORT=9222

# Security Credentials for the Web Interface
WEB_USERNAME=admin
WEB_PASSWORD=your_secure_password
```

### 4. Launch
Simply run the included batch script (Windows) or start via Node:
```bash
start.bat
# or
npm start
```
Upon startup, OmniBridge will output a **Local URL** (e.g., `http://localhost:8080`) and a **Public Tunnel URL** that you can securely access from your phone or any external network.

---

<div align="center">
  <sub>Built for the future. Empowering AI autonomy.</sub>
</div>
