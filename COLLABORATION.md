# 🤝 NetPulse Pro - Dual-Agent Mission Control

This document orchestrates active task assignments between **Cline** and **Roo Code**.

---

## 🎯 Current Project Objective
Enhance **NetPulse Pro** into a production-grade continuous network diagnostic tool with multi-threaded telemetry, premium UI micro-interactions, audio alerts, and multi-endpoint latency checks.

---

## 📋 Task Board & Responsibility Matrix

| Task ID | Task Description | Assigned Agent | Status | Primary File |
| :--- | :--- | :--- | :--- | :--- |
| **TASK-101** | Multi-threaded Web Worker for download/upload speed testing (non-blocking UI) | **Roo Code** | 🟡 Ready for Prompt | `worker.js`, `script.js` |
| **TASK-102** | Add Multi-Server Latency Comparison (Cloudflare, Fastly, jsDelivr, Google) | **Roo Code** | 🟡 Ready for Prompt | `script.js` |
| **TASK-103** | Glassmorphism UI Polish, Toast Notifications & Audio Tone Cues on completion | **Cline** | 🟡 Ready for Prompt | `index.html` |
| **TASK-104** | Live Speedometer Gauge Animation for Download & Upload metrics | **Cline** | 🟡 Ready for Prompt | `index.html` |
| **TASK-105** | Cross-agent code audit (validate CORS, Chart.js memory usage, edge cases) | **Cline & Roo** | ⚪ Queued | All files |

---

## 🚀 Ready-to-Use Agent Prompts

You can copy and paste these exact prompts into each agent to start their synchronized work:

### ⚡ Prompt for Roo Code:
```text
Read .clinerules and COLLABORATION.md. You are the Engine Architect.
Please execute TASK-101 and TASK-102:
1. Refactor download and upload speed testing in script.js to support multi-stream chunked fetching.
2. Add multi-server ping latency comparison across Cloudflare (1.1.1.1/CDN), Fastly, and jsDelivr to calculate jitter and detect node routing.
3. Update localStorage and Chart data models cleanly, preserving the UI contract for Cline.
Update COLLABORATION.md when complete.
```

### 🎨 Prompt for Cline:
```text
Read .clinerules and COLLABORATION.md. You are the UI/UX specialist.
Please execute TASK-103 and TASK-104:
1. Enhance index.html with interactive Toast notifications for test events (test started, test finished, connection lost).
2. Add smooth SVG/CSS speedometer gauge animations to the Download and Upload cards.
3. Add a subtle Web Audio API chime tone when a test cycle finishes successfully.
Preserve all IDs and integration hooks used by script.js. Update COLLABORATION.md when complete.
```

---

## 📝 Recent Change Log
* **Initial Setup**: Initialized Git repository, `.clinerules`, `.roomodes`, and collaborative mission control board.
