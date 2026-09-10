# NetPulse Pro ⚡

Enterprise continuous bandwidth & latency monitoring web application running entirely client-side.

## Features

- **Continuous & On-Demand Diagnostics**: Measure Ping, Jitter, Download throughput, and Upload throughput at configurable intervals (1m, 5m, 15m, 30m, 1h).
- **Client-Side Telemetry Engine**: Uses HEAD cache-busted requests for low-latency ping/jitter measurement, chunked CDN streams for download speed, and crypto blob generation for upload metrics.
- **Real-Time Dynamic Charts**: Interactive dual Chart.js visualizations tracking historical bandwidth and latency trends over time.
- **Persistent Local History**: Stores test runs in browser `localStorage` with instant CSV export and history cleanup.
- **Modern Dark UI**: Designed with Tailwind CSS, Lucide icons, responsive metric cards, and progress bars.

## Quick Start

Open `index.html` directly in any modern web browser or serve locally:

```bash
# Python
python -m http.server 8080

# Or with Node.js
npx serve .
```

## Architecture & Development

See `plans/speed-test-website-plan.md` for the full architectural breakdown, and `COLLABORATION.md` / `.clinerules` for multi-agent development conventions.
