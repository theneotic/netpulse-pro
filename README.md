# NetPulse Pro ⚡
> **Enterprise Continuous Bandwidth & Latency Diagnostics**  
> Autonomous, client-side internet speed, jitter, and latency telemetry monitor with real-time time-series analytics and local persistence.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftheneotic%2Fnetpulse-pro)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Frontend](https://img.shields.io/badge/stack-Vanilla%20JS%20%7C%20Tailwind%20CSS-indigo.svg)
![Charts](https://img.shields.io/badge/visuals-Chart.js-amber.svg)

---

## 🌟 Highlights

- ⏱️ **Continuous & Scheduled Testing**: Automated background runs with customizable intervals (`1m`, `5m`, `15m`, `30m`, `1h`) and manual *Run Test Now* triggers. Drift-free chained timer that never stacks skipped cycles.
- 📊 **Real-Time Dynamic Visualizations**: Dual interactive Chart.js line charts tracking both Bandwidth Throughput (Download/Upload in Mbps) and Latency Performance (Ping/Jitter in ms) over the last 20 tests. Failed phases render as gaps, never fake zeros.
- 🎯 **Honest, High-Precision Engine** (Cloudflare speed-test edge, CORS-enabled):
  - **Ping & Jitter**: 8 sequential RTT probes (`GET /__down?bytes=0`) — median RTT + RFC 3550 jitter. No randomized fallbacks.
  - **Download Speed**: streaming byte-counted download (`GET /__down?bytes=N`) with adaptive sizing 2→10→25→50 MB.
  - **Upload Speed**: crypto-random Blob via `POST /__up`, adaptive 1→2→5→10→20 MB.
  - Live server-node badge reads Cloudflare CDN metadata ("Mumbai, IN [BOM]").
- 💾 **Local Data Persistence**: Saves complete telemetry logs in browser `localStorage` (capped at 500 runs) without tracking or server-side logging.
- 📤 **Instant Data Export**: One-click CSV **and JSON** export for network auditing, ISP dispute documentation, and historical reports.
- 🎨 **Modern Cyber-Dark UI**: Glassmorphism aesthetic built with Tailwind CSS, glowing indicators, responsive progress bars, and Lucide icons.

---

## 🚀 One-Click Vercel Deployment

NetPulse Pro is fully configured for zero-configuration deployment on **Vercel** with optimized security headers (`vercel.json`).

### Deploy via Web UI:
1. Click the **Deploy with Vercel** button above or go to [Vercel Dashboard](https://vercel.com/new).
2. Import your repository: `theneotic/netpulse-pro`.
3. Keep default settings (Framework Preset: **Other**, Build Command: *empty*, Output Directory: *empty*).
4. Click **Deploy**. Your site will be live on a global edge CDN in seconds!

### Deploy via Vercel CLI:
```bash
# Install Vercel CLI if needed
npm install -g vercel

# Deploy directly from repository root
vercel
```

---

## 💻 Local Development

NetPulse Pro runs entirely in the browser without any build dependencies.

### Option 1: Direct Browser
Double-click `index.html` to open it in Chrome, Edge, Safari, or Firefox.

### Option 2: Local HTTP Server
```bash
# Using Node.js (via package.json script)
npm start

# Or using Python 3
python -m http.server 8080
```
Navigate to `http://localhost:8080`.

Alternatively use the bundled VS Code launch config (`.vscode/launch.json`) which
opens `http://localhost:8080` in Chrome.

---

## 🧪 Tests

No dependencies — everything runs on Node's built-ins and hits the live
Cloudflare speed-test endpoints (like the browser does).

```bash
# Syntax check
node --check script.js

# E2E engine test (real ping/jitter/download/upload + server-info + no-Math.random audit)
node tests/engine.spec.js

# DOM contract test (every id referenced by script.js exists in index.html)
node tests/idcheck.js
```

---

## 📐 Architecture & Workflow

```mermaid
graph TD
    A[User Opens NetPulse Pro] --> B[Configure Interval & Payload]
    B --> C{Start Monitoring?}
    C -->|Continuous| D[Interval Scheduler Activated]
    C -->|Manual| E[Run Single Test]
    D --> F[Execute Diagnostic Cycle]
    E --> F
    F --> G[1. Measure Ping & Jitter via empty-payload probes]
    G --> H[2. Measure Download Throughput]
    H --> I[3. Measure Upload Throughput]
    I --> J[Record Run to LocalStorage]
    J --> K[Update Chart.js Graphs & Metric Cards]
    K --> L[Append to History Table]
```

---

## ⚙️ Configuration Options

| Setting | Options | Description |
| :--- | :--- | :--- |
| **Test Interval** | 1m, 5m (default), 15m, 30m, 1h | Frequency of automated diagnostic cycles |
| **Payload Size** | Light (~2MB), Standard (~10MB), Heavy (~30MB) | Volume of data transferred during throughput evaluation |

---

## 🤝 Multi-Agent Development

This repository was architected using a coordinated dual-agent workflow between **Cline** and **Roo Code**:
* **`.clinerules`**: Defines role boundaries, code standards, and UI/Engine separation.
* **`.roomodes`**: Custom architectural and auditing modes for Roo Code.
* **`COLLABORATION.md`**: Live task board for coordinating UI polish and engine extensions.

---

## 🔒 Privacy & Network Model

* **No Tracking**: NetPulse Pro does not collect personal information, user accounts, or cookies.
* **Client-Side Only**: All calculations and metrics are computed locally in the browser runtime.
* **Data Transparency**: Historical records never leave your device unless you export them to CSV.

---

## 📄 License

Distributed under the MIT License.
