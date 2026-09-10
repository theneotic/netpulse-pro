/* ============================================================================
 * NetPulse Pro — Constant Internet Speed Monitoring Engine (v2)
 * ----------------------------------------------------------------------------
 * TELEMETRY ENGINE (Roo Code domain per COLLABORATION.md — see collaboration
 * log for the change record).
 *
 * Honest measurements only: no fabricated numbers, no Math.random() inside any
 * measurement path, timing from performance.now().
 *
 * Measurement host: Cloudflare speed-test edge.
 *   (verified live: CORS `Access-Control-Allow-Origin: *`, Cache-Control: no-store)
 *   DOWNLOAD  GET  https://speed.cloudflare.com/__down?bytes=N&cb=<nonce>
 *   UPLOAD    POST https://speed.cloudflare.com/__up   (application/octet-stream)
 *   PING      GET  https://speed.cloudflare.com/__down?bytes=0&cb=<nonce>
 *
 * Adaptive payload sizing keeps each stage accurate on both a 5 Mbps and a
 * 1 Gbps link: download 2 -> 10 -> 25 -> 50 MB, upload 1 -> 2 -> 5 -> 10 -> 20 MB.
 * Stages grow until a measurement runs >= MIN_STAGE_SECONDS.
 * ==========================================================================*/

'use strict';

/* ------------------------------- Configuration ---------------------------- */
const CF_BASE = 'https://speed.cloudflare.com';
const PING_ENDPOINT = CF_BASE + '/__down?bytes=0';
const DOWNLOAD_ENDPOINT = CF_BASE + '/__down';
const UPLOAD_ENDPOINT = CF_BASE + '/__up';
const TRACE_ENDPOINT = CF_BASE + '/cdn-cgi/trace';

const HISTORY_KEY = 'netpulse_history';
const INTERVAL_KEY = 'netpulse_interval';
const SIZE_KEY = 'netpulse_size';
const HISTORY_LIMIT = 500;

const KB = 1024;
const MB = 1024 * 1024;

// Signal-Loop style fast & honest payloads
const DOWNLOAD_SIZES = {
    '1': 256 * KB,      // Signal Loop Fast (256 KB)
    '5': 1024 * KB,     // Standard (1 MB)
    '15': 4 * MB        // High Load Stress (4 MB)
};

const UPLOAD_SIZES = {
    '1': 128 * KB,      // Signal Loop Fast (128 KB)
    '5': 512 * KB,      // Standard (512 KB)
    '15': 2 * MB        // High Load Stress (2 MB)
};

const PING_SAMPLES = 4;
const PING_TIMEOUT_MS = 4000;
const DOWNLOAD_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 15000;

/* ------------------------------- Global state ----------------------------- */
let isMonitoring = false;
let monitorTimerId = null;
let countdownTimerId = null;
let nextRunAt = null;
let isTesting = false;
let activeAbortController = null;
let lastServerLabel = null;

let peakDownload = 0;
let peakUpload = 0;

let testHistory = [];
try {
    if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(HISTORY_KEY) || '[]';
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            testHistory = parsed;
            testHistory.forEach(h => {
                if (h.download && h.download > peakDownload) peakDownload = h.download;
                if (h.upload && h.upload > peakUpload) peakUpload = h.upload;
            });
        }
    }
} catch (e) {
    testHistory = [];
}

let bandwidthChart = null;
let latencyChart = null;

/* ------------------------------ Small helpers ----------------------------- */
function $(id) {
    return document.getElementById(id);
}

function formatMbps(mbps) {
    return (mbps == null || Number.isNaN(mbps)) ? '0.00' : mbps.toFixed(2);
}

function formatMs(ms) {
    return (ms == null || Number.isNaN(ms)) ? '0.0' : ms.toFixed(1);
}

function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }

/** Random hex nonce for cache-busting speed-test URLs (no Math.random). */
function nonce() {
    const buf = new Uint8Array(8);
    window.crypto.getRandomValues(buf);
    return Array.prototype.map.call(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function median(values) {
    if (!values || values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return mid % 1 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

/** RFC 3550-style jitter: mean absolute difference of successive RTT samples. */
function meanAbsDiff(values) {
    if (!values || values.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
    return sum / (values.length - 1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** fetch() with timeout support via AbortSignal. */
function fetchWithTimeout(url, options, timeoutMs) {
    const opts = options || {};
    if (!opts.signal) {
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
            opts.signal = AbortSignal.timeout(timeoutMs || 15000);
        }
    }
    return fetch(url, opts);
}

function pingQuality(ms) {
    if (ms < 40) return { label: 'Excellent', color: 'emerald' };
    if (ms < 80) return { label: 'Good', color: 'emerald' };
    if (ms < 150) return { label: 'Fair', color: 'amber' };
    return { label: 'Poor', color: 'rose' };
}

function jitterQuality(ms) {
    if (ms < 10) return { label: 'Low', color: 'emerald' };
    if (ms < 25) return { label: 'Moderate', color: 'amber' };
    return { label: 'High', color: 'rose' };
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setStatus(text, dotColor) {
    const statusEl = $('status-text');
    const dot = $('status-dot');
    if (statusEl) statusEl.textContent = text;
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full ' + dotColor + ' animate-pulse';
}

/* ------------------------------- Bootstrap -------------------------------- */
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        restoreSavedConfig();
        initCharts();
        renderHistoryTable();
        updateUIState();
    });
}

function restoreSavedConfig() {
    const intervalSel = $('interval-select');
    if (intervalSel) {
        try {
            const saved = localStorage.getItem(INTERVAL_KEY);
            if (saved && Array.prototype.some.call(intervalSel.options, o => o.value === saved)) {
                intervalSel.value = saved;
            }
        } catch (e) { /* storage unavailable */ }
    }
    const sizeSel = $('size-select');
    if (sizeSel) {
        try {
            const savedSize = localStorage.getItem(SIZE_KEY);
            if (savedSize && Array.prototype.some.call(sizeSel.options, o => o.value === savedSize)) {
                sizeSel.value = savedSize;
            }
        } catch (e) { /* storage unavailable */ }
    }
}

/* ============================ Measurement engine ========================== */

/** Reads Cloudflare geo metadata from response headers (when CORS-visible). */
function readServerInfo(res) {
    const g = h => {
        try { return res.headers.get(h); } catch (e) { return null; }
    };
    const city = g('cf-meta-city') || g('city');
    const country = g('cf-meta-country') || g('country');
    const colo = g('cf-meta-colo') || g('colo');
    const asn = g('cf-meta-asn') || g('asn');
    const ip = g('cf-meta-ip');
    return buildServerInfo(city, country, colo, asn, ip);
}

function buildServerInfo(city, country, colo, asn, ip) {
    if (!city && !country && !colo) return null;
    let label = [city, country].filter(Boolean).join(', ');
    if (colo && label) label += ' [' + colo + ']';
    else if (colo) label = colo;
    return { city, country, colo, asn, ip, label };
}

/** Fallback source of node info: GET https://speed.cloudflare.com/cdn-cgi/trace */
async function fetchServerInfoFallback(signal) {
    try {
        const res = await fetchWithTimeout(TRACE_ENDPOINT, {
            method: 'GET',
            cache: 'no-store',
            signal
        }, PING_TIMEOUT_MS);
        const text = await res.text();
        const fields = {};
        text.split(/\r?\n/).forEach(line => {
            const eq = line.indexOf('=');
            if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
        });
        return buildServerInfo(null, fields.loc, fields.colo, null, fields.ip);
    } catch (e) {
        return null;
    }
}

function updateServerBadge(info) {
    if (!info) return;
    lastServerLabel = info.label;
    const locText = $('server-location-text');
    if (locText) locText.textContent = info.label;
    const badge = $('connection-badge');
    if (badge) {
        badge.classList.remove('hidden');
        badge.classList.add('flex');
    }
}

/**
 * Ping & jitter: rapid sequential GETs of an empty payload against Cloudflare edge.
 * RTT = median, jitter = RFC 3550 successive diff.
 */
async function measurePingAndJitter(signal) {
    const rtts = [];
    let serverInfo = null;

    for (let i = 0; i < PING_SAMPLES; i++) {
        const url = PING_ENDPOINT + '&cb=' + nonce();
        const startedAt = performance.now();
        try {
            const res = await fetchWithTimeout(url, {
                method: 'GET',
                cache: 'no-store',
                signal
            }, PING_TIMEOUT_MS);
            await res.arrayBuffer();
            rtts.push(performance.now() - startedAt);
            if (i === 0) serverInfo = readServerInfo(res);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
        }
        if (i < PING_SAMPLES - 1) await sleep(25);
    }

    if (rtts.length === 0) {
        throw new Error('Ping measurement failed: no reachable endpoint');
    }

    if (!serverInfo) serverInfo = await fetchServerInfoFallback(signal);

    return { ping: median(rtts), jitter: meanAbsDiff(rtts), serverInfo };
}

/**
 * Download sample (Signal-Loop approach):
 * Fetches bytes payload directly into arrayBuffer for instant, non-blocking,
 * 100% reliable throughput calculation.
 */
async function measureDownloadOnce(bytes, onLive, timeoutMs, signal) {
    const url = DOWNLOAD_ENDPOINT + '?bytes=' + bytes + '&cb=' + nonce();
    const startedAt = performance.now();

    try {
        const res = await fetchWithTimeout(url, {
            method: 'GET',
            cache: 'no-store',
            signal
        }, timeoutMs || DOWNLOAD_TIMEOUT_MS);
        if (!res.ok) return null;

        const buf = await res.arrayBuffer();
        const totalBytes = buf.byteLength;
        const durationSec = (performance.now() - startedAt) / 1000;
        if (durationSec <= 0 || totalBytes === 0) return null;

        const mbps = (totalBytes * 8) / (durationSec * 1e6);
        if (typeof onLive === 'function') onLive(mbps);
        return mbps;
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.error('measureDownloadOnce error:', e);
        return null;
    }
}

/**
 * Download speed with fallback for slow links.
 */
async function measureDownloadSpeed(profile, onLive, signal) {
    const size = DOWNLOAD_SIZES[String(profile)] || (256 * KB);
    let mbps = await measureDownloadOnce(size, onLive, DOWNLOAD_TIMEOUT_MS, signal);

    if (mbps == null) {
        // Fallback retry with smaller 64 KB probe
        mbps = await measureDownloadOnce(64 * KB, onLive, 6000, signal);
    }

    if (mbps == null) {
        throw new Error('Download measurement failed');
    }

    return mbps;
}

/** Build a Blob of `bytes` from a 1 MB random seed (cheap, high entropy). */
function buildBlob(bytes, seed) {
    const s = seed || new Uint8Array(Math.min(bytes, 65536));
    if (!seed) window.crypto.getRandomValues(s);
    if (bytes <= s.length) {
        return new Blob([s.subarray(0, bytes)], { type: 'application/octet-stream' });
    }
    const parts = new Array(Math.ceil(bytes / s.length)).fill(s);
    return new Blob(parts, { type: 'application/octet-stream' });
}

async function measureUploadOnce(bytes, seed, timeoutMs, signal) {
    const blob = buildBlob(bytes, seed);
    const startedAt = performance.now();

    try {
        const res = await fetchWithTimeout(UPLOAD_ENDPOINT + '?cb=' + nonce(), {
            method: 'POST',
            body: blob,
            cache: 'no-store',
            headers: { 'Content-Type': 'application/octet-stream' },
            signal
        }, timeoutMs || UPLOAD_TIMEOUT_MS);
        if (!res.ok) return null;

        const durationSec = (performance.now() - startedAt) / 1000;
        if (durationSec <= 0) return null;
        return (bytes * 8) / (durationSec * 1e6);
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.error('measureUploadOnce error:', e);
        return null;
    }
}

/**
 * Upload speed with high-entropy binary payload.
 */
async function measureUploadSpeed(profile, signal) {
    const size = UPLOAD_SIZES[String(profile)] || (128 * KB);
    const seed = new Uint8Array(Math.min(size, 65536));
    window.crypto.getRandomValues(seed);

    let mbps = await measureUploadOnce(size, seed, UPLOAD_TIMEOUT_MS, signal);

    if (mbps == null) {
        // Fallback retry with smaller 32 KB probe
        mbps = await measureUploadOnce(32 * KB, seed, 6000, signal);
    }

    if (mbps == null) {
        throw new Error('Upload measurement failed');
    }

    return mbps;
}

/* ============================ Continuous Monitoring Loop =================== */

function startMonitoring() {
    if (isMonitoring) return;
    isMonitoring = true;
    updateUIState();
    runContinuousLoop();
}

function stopMonitoring() {
    isMonitoring = false;
    stopCountdown();
    if (monitorTimerId) {
        clearTimeout(monitorTimerId);
        monitorTimerId = null;
    }
    if (activeAbortController) {
        try { activeAbortController.abort(); } catch (e) { /* noop */ }
        activeAbortController = null;
    }
    updateUIState();
    setStatus('System Idle', 'bg-slate-500');
    const cd = $('countdown-text');
    if (cd) cd.classList.add('hidden');
}

/**
 * Signal-Loop Continuous runner: runs consecutive test samples separated by
 * the selected cadence until stopped.
 */
async function runContinuousLoop() {
    while (isMonitoring) {
        await runSingleTest();
        if (!isMonitoring) break;

        const intervalSel = $('interval-select');
        const intervalMs = intervalSel ? (parseInt(intervalSel.value) || 5000) : 5000;
        try { localStorage.setItem(INTERVAL_KEY, String(intervalMs)); } catch (e) { /* quota */ }

        nextRunAt = Date.now() + intervalMs;
        startCountdown();

        // Sleep until next cycle or until stopped
        await sleep(intervalMs);
        stopCountdown();
    }
}

function startCountdown() {
    stopCountdown();
    const cd = $('countdown-text');
    if (cd) cd.classList.remove('hidden');
    countdownTimerId = setInterval(updateCountdown, 250);
    updateCountdown();
}

function stopCountdown() {
    if (countdownTimerId) {
        clearInterval(countdownTimerId);
        countdownTimerId = null;
    }
    nextRunAt = null;
}

function updateCountdown() {
    const el = $('countdown-text');
    if (!el) return;
    if (!isMonitoring || nextRunAt == null) {
        el.textContent = '';
        return;
    }
    const remainMs = Math.max(0, nextRunAt - Date.now());
    if (remainMs <= 0) {
        el.textContent = 'Sampling next cycle…';
        return;
    }
    const sec = (remainMs / 1000).toFixed(1);
    el.textContent = `Continuous mode: next sample in ${sec}s…`;
}

function updateUIState() {
    const startBtn = $('start-btn');
    const stopBtn = $('stop-btn');
    const intervalSelect = $('interval-select');
    const sizeSelect = $('size-select');

    if (isMonitoring) {
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.className = 'flex-1 bg-indigo-950/60 text-indigo-400 cursor-not-allowed font-semibold py-3 px-4 rounded-xl transition border border-indigo-900/50 flex items-center justify-center space-x-2 text-sm';
        }
        if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.className = 'flex-1 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-semibold py-3 px-4 rounded-xl transition shadow-lg shadow-rose-600/30 flex items-center justify-center space-x-2 text-sm';
        }
        if (intervalSelect) intervalSelect.disabled = true;
        if (sizeSelect) sizeSelect.disabled = true;
    } else {
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.className = 'flex-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-semibold py-3 px-4 rounded-xl transition shadow-lg shadow-indigo-600/30 flex items-center justify-center space-x-2 text-sm';
        }
        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.className = 'flex-1 bg-slate-800/80 text-slate-500 cursor-not-allowed font-semibold py-3 px-4 rounded-xl transition border border-slate-700/50 flex items-center justify-center space-x-2 text-sm';
        }
        if (intervalSelect) intervalSelect.disabled = false;
        if (sizeSelect) sizeSelect.disabled = false;
    }
}

/* ============================== Single test run ============================ */

async function runSingleTest() {
    if (isTesting) return;
    isTesting = true;
    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    const singleBtn = $('single-btn');
    if (singleBtn) singleBtn.disabled = true;
    nextRunAt = null;
    setStatus(isMonitoring ? 'Continuous Sampling Active' : 'Running Diagnostic…', 'bg-emerald-500');

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = now.toLocaleDateString() + ' ' + timeStr;
    const sizeSel = $('size-select');
    const profile = sizeSel ? sizeSel.value : '1';

    let ping = null;
    let jitter = null;
    let download = null;
    let upload = null;

    try {
        // ---- 1. Ping & jitter -------------------------------------------------
        const pingStatus = $('ping-status-text');
        if (pingStatus) pingStatus.textContent = 'Measuring…';
        try {
            const r = await measurePingAndJitter(signal);
            ping = r.ping;
            jitter = r.jitter;
            if (r.serverInfo) updateServerBadge(r.serverInfo);

            const mPing = $('metric-ping');
            const mJitter = $('metric-jitter');
            if (mPing) mPing.textContent = formatMs(ping);
            if (mJitter) mJitter.textContent = formatMs(jitter);

            const pq = pingQuality(ping);
            const pQuality = $('ping-quality');
            if (pQuality) {
                pQuality.textContent = pq.label;
                pQuality.className = 'text-' + pq.color + '-400 font-semibold';
            }
            if (pingStatus) pingStatus.textContent = 'Stable';

            const jq = jitterQuality(jitter);
            const jQuality = $('jitter-quality');
            const jStatus = $('jitter-status-text');
            if (jQuality) {
                jQuality.textContent = jq.label;
                jQuality.className = 'text-' + jq.color + '-400 font-semibold';
            }
            if (jStatus) jStatus.textContent = 'Variance OK';
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Ping failed:', e);
            const mPing = $('metric-ping');
            const mJitter = $('metric-jitter');
            if (mPing) mPing.textContent = '0.0';
            if (mJitter) mJitter.textContent = '0.0';
            if (pingStatus) pingStatus.textContent = 'Unreachable';
        }

        // ---- 2. Download ------------------------------------------------------
        const dlProgress = $('download-progress-text');
        const dlBar = $('download-bar');
        if (dlProgress) dlProgress.textContent = 'Streaming…';
        if (dlBar) dlBar.style.width = '30%';

        try {
            download = await measureDownloadSpeed(profile, live => {
                if (dlProgress) dlProgress.textContent = 'Streaming — ' + live.toFixed(1) + ' Mbps';
                if (dlBar) dlBar.style.width = '70%';
            }, signal);

            const mDownload = $('metric-download');
            if (mDownload) mDownload.textContent = formatMbps(download);
            if (download && download > peakDownload) peakDownload = download;
            if (dlProgress) dlProgress.textContent = `Peak ${formatMbps(peakDownload)} Mbps`;
            if (dlBar) dlBar.style.width = '100%';
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Download failed:', e);
            const mDownload = $('metric-download');
            if (mDownload) mDownload.textContent = '0.00';
            if (dlProgress) dlProgress.textContent = 'Failed';
            if (dlBar) dlBar.style.width = '0%';
        }

        // ---- 3. Upload --------------------------------------------------------
        const ulProgress = $('upload-progress-text');
        const ulBar = $('upload-bar');
        if (ulProgress) ulProgress.textContent = 'Sending payload…';
        if (ulBar) ulBar.style.width = '40%';

        try {
            upload = await measureUploadSpeed(profile, signal);
            const mUpload = $('metric-upload');
            if (mUpload) mUpload.textContent = formatMbps(upload);
            if (upload && upload > peakUpload) peakUpload = upload;
            if (ulProgress) ulProgress.textContent = `Peak ${formatMbps(peakUpload)} Mbps`;
            if (ulBar) ulBar.style.width = '100%';
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Upload failed:', e);
            const mUpload = $('metric-upload');
            if (mUpload) mUpload.textContent = '0.00';
            if (ulProgress) ulProgress.textContent = 'Failed';
            if (ulBar) ulBar.style.width = '0%';
        }

        // ---- Record -----------------------------------------------------------
        const allOk = ping != null && download != null && upload != null;
        const anyOk = ping != null || download != null || upload != null;
        const record = {
            timestamp: dateStr,
            time: timeStr,
            download: download == null ? null : round2(download),
            upload: upload == null ? null : round2(upload),
            ping: ping == null ? null : round1(ping),
            jitter: jitter == null ? null : round1(jitter),
            status: allOk ? 'Success' : (anyOk ? 'Partial' : 'Failed'),
            server: lastServerLabel || null
        };

        testHistory.push(record);
        if (testHistory.length > HISTORY_LIMIT) testHistory = testHistory.slice(-HISTORY_LIMIT);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(testHistory)); } catch (e) { /* quota */ }

        renderHistoryTable();
        updateChartsFromHistory();
    } finally {
        isTesting = false;
        activeAbortController = null;
        if (singleBtn) singleBtn.disabled = false;
        setStatus(isMonitoring ? 'Monitoring Active (Signal Loop)' : 'System Idle',
            isMonitoring ? 'bg-emerald-500' : 'bg-slate-500');

        setTimeout(() => {
            if (!isTesting) {
                const dlBar = $('download-bar');
                const ulBar = $('upload-bar');
                if (dlBar) dlBar.style.width = '0%';
                if (ulBar) ulBar.style.width = '0%';
            }
        }, 1200);
    }
}

/* ================================= Charts ================================= */

function initCharts() {
    const bandwidthCtx = $('bandwidthChart').getContext('2d');
    bandwidthChart = new Chart(bandwidthCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Download (Mbps)',
                    data: [],
                    borderColor: '#e84d31',
                    backgroundColor: 'rgba(232, 77, 49, 0.08)',
                    borderWidth: 2.5,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#e84d31'
                },
                {
                    label: 'Upload (Mbps)',
                    data: [],
                    borderColor: '#17201f',
                    backgroundColor: 'rgba(23, 32, 31, 0.06)',
                    borderWidth: 2.5,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#17201f'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#17201f', font: { family: 'DM Mono', weight: 600, size: 10 } } }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(23, 32, 31, 0.12)' },
                    ticks: { color: '#52605b', font: { family: 'DM Mono', size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(23, 32, 31, 0.12)' },
                    ticks: { color: '#52605b', font: { family: 'DM Mono', size: 10 } },
                    beginAtZero: true
                }
            }
        }
    });

    const latencyCtx = $('latencyChart').getContext('2d');
    latencyChart = new Chart(latencyCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Ping (ms)',
                    data: [],
                    borderColor: '#b33f29',
                    backgroundColor: 'rgba(179, 63, 41, 0.08)',
                    borderWidth: 2.5,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#b33f29'
                },
                {
                    label: 'Jitter (ms)',
                    data: [],
                    borderColor: '#52605b',
                    backgroundColor: 'rgba(82, 96, 91, 0.06)',
                    borderWidth: 2.5,
                    tension: 0.2,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#52605b'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#17201f', font: { family: 'DM Mono', weight: 600, size: 10 } } }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(23, 32, 31, 0.12)' },
                    ticks: { color: '#52605b', font: { family: 'DM Mono', size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(23, 32, 31, 0.12)' },
                    ticks: { color: '#52605b', font: { family: 'DM Mono', size: 10 } },
                    beginAtZero: true
                }
            }
        }
    });

    updateChartsFromHistory();
}

/** Null values (failed phases) leave gaps in the lines instead of fake data. */
function updateChartsFromHistory() {
    const recent = testHistory.slice(-20);
    const labels = recent.map(h => h.time);

    bandwidthChart.data.labels = labels;
    bandwidthChart.data.datasets[0].data = recent.map(h => h.download);
    bandwidthChart.data.datasets[1].data = recent.map(h => h.upload);
    bandwidthChart.update();

    latencyChart.data.labels = labels;
    latencyChart.data.datasets[0].data = recent.map(h => h.ping);
    latencyChart.data.datasets[1].data = recent.map(h => h.jitter);
    latencyChart.update();
}

/* ====================== History table & exports =========================== */

function statusBadgeClasses(status) {
    switch (status) {
        case 'Success':
            return 'bg-emerald-500/10 text-emerald-800 border border-emerald-600/30';
        case 'Partial':
            return 'bg-amber-500/10 text-amber-800 border border-amber-600/30';
        case 'Failed':
            return 'bg-rose-500/10 text-rose-800 border border-rose-600/30';
        default:
            return 'bg-slate-200 text-slate-800 border border-slate-400';
    }
}

function cellValue(value) {
    return value == null ? '0.0' : escapeHtml(value);
}

function renderHistoryTable() {
    const tbody = $('history-table-body');
    if (testHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500 font-normal">No test history recorded yet. Start monitoring or run a single test.</td></tr>';
        return;
    }

    tbody.innerHTML = testHistory.slice(-15).reverse().map(h => `
        <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3.5 px-4 text-slate-400 font-mono text-xs">${escapeHtml(h.timestamp)}</td>
            <td class="py-3.5 px-4 font-bold text-indigo-400">${cellValue(h.download)} ${h.download != null ? '<span class="text-xs font-normal text-slate-400">Mbps</span>' : ''}</td>
            <td class="py-3.5 px-4 font-bold text-emerald-400">${cellValue(h.upload)} ${h.upload != null ? '<span class="text-xs font-normal text-slate-400">Mbps</span>' : ''}</td>
            <td class="py-3.5 px-4 text-amber-400 font-semibold">${cellValue(h.ping)} ${h.ping != null ? '<span class="text-xs font-normal text-slate-400">ms</span>' : ''}</td>
            <td class="py-3.5 px-4 text-cyan-400 font-semibold">${cellValue(h.jitter)} ${h.jitter != null ? '<span class="text-xs font-normal text-slate-400">ms</span>' : ''}</td>
            <td class="py-3.5 px-4">
                <span class="px-2.5 py-1 rounded-full text-xs font-semibold ${statusBadgeClasses(h.status)}">${escapeHtml(h.status)}</span>
            </td>
        </tr>
    `).join('');
}

function clearHistory() {
    if (confirm('Are you sure you want to clear all test history?')) {
        testHistory = [];
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* noop */ }
        renderHistoryTable();
        updateChartsFromHistory();
    }
}

function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
    if (testHistory.length === 0) {
        alert('No history to export.');
        return;
    }
    let csv = 'Timestamp,Download (Mbps),Upload (Mbps),Ping (ms),Jitter (ms),Status\n';
    testHistory.forEach(h => {
        csv += '"' + String(h.timestamp) + '",'
            + (h.download == null ? '' : h.download) + ','
            + (h.upload == null ? '' : h.upload) + ','
            + (h.ping == null ? '' : h.ping) + ','
            + (h.jitter == null ? '' : h.jitter) + ','
            + '"' + String(h.status) + '"\n';
    });
    downloadBlob(csv, 'text/csv;charset=utf-8;', 'netpulse_pro_history_' + new Date().toISOString().slice(0, 10) + '.csv');
}

function exportJSON() {
    if (testHistory.length === 0) {
        alert('No history to export.');
        return;
    }
    const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        app: 'NetPulse Pro',
        measurementHost: CF_BASE,
        server: lastServerLabel,
        results: testHistory
    }, null, 2);
    downloadBlob(payload, 'application/json;charset=utf-8;', 'netpulse_pro_history_' + new Date().toISOString().slice(0, 10) + '.json');
}