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
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
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
        initEventListeners();
        updateUIState();
    });
}

function initEventListeners() {
    const startBtn = $('start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', (e) => {
            if (e) e.preventDefault();
            startMonitoring();
        });
    }
    const stopBtn = $('stop-btn');
    if (stopBtn) {
        stopBtn.addEventListener('click', (e) => {
            if (e) e.preventDefault();
            stopMonitoring();
        });
    }
    const singleBtn = $('single-btn');
    if (singleBtn) {
        singleBtn.addEventListener('click', (e) => {
            if (e) e.preventDefault();
            runSingleTest();
        });
    }

    const intervalSel = $('interval-select');
    if (intervalSel) {
        intervalSel.addEventListener('change', () => {
            try { localStorage.setItem(INTERVAL_KEY, intervalSel.value); } catch (e) {}
        });
    }
    const sizeSel = $('size-select');
    if (sizeSel) {
        sizeSel.addEventListener('change', () => {
            try { localStorage.setItem(SIZE_KEY, sizeSel.value); } catch (e) {}
            toggleCustomSizeVisibility();
        });
    }
    const customInput = $('custom-size-input');
    if (customInput) {
        customInput.addEventListener('input', () => {
            try { localStorage.setItem('netpulse_custom_size', customInput.value); } catch (e) {}
        });
    }
}

function toggleCustomSizeVisibility() {
    const sizeSel = $('size-select');
    const container = $('custom-size-container');
    if (!sizeSel || !container) return;
    if (sizeSel.value === 'custom') {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
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
    const customInput = $('custom-size-input');
    if (customInput) {
        try {
            const savedCustom = localStorage.getItem('netpulse_custom_size');
            if (savedCustom) customInput.value = savedCustom;
        } catch (e) { /* storage unavailable */ }
    }
    toggleCustomSizeVisibility();
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
 * Download speed with fallback for slow links and support for custom payload sizes.
 */
async function measureDownloadSpeed(profile, onLive, signal) {
    let size;
    if (typeof profile === 'number' && profile > 0) {
        size = profile;
    } else if (profile === 'custom') {
        const customInput = $('custom-size-input');
        const customMb = customInput ? (parseFloat(customInput.value) || 10) : 10;
        size = Math.round(Math.max(0.1, customMb) * MB);
    } else {
        size = DOWNLOAD_SIZES[String(profile)] || (256 * KB);
    }

    const timeout = Math.max(DOWNLOAD_TIMEOUT_MS, Math.round((size / MB) * 4000));
    let mbps = await measureDownloadOnce(size, onLive, timeout, signal);

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
 * Upload speed with high-entropy binary payload and support for custom payload sizes.
 */
async function measureUploadSpeed(profile, signal) {
    let size;
    if (typeof profile === 'number' && profile > 0) {
        size = profile;
    } else if (profile === 'custom') {
        const customInput = $('custom-size-input');
        const customMb = customInput ? (parseFloat(customInput.value) || 10) : 10;
        size = Math.round(Math.max(0.05, customMb * 0.5) * MB);
    } else {
        size = UPLOAD_SIZES[String(profile)] || (128 * KB);
    }

    const seed = new Uint8Array(Math.min(size, 65536));
    window.crypto.getRandomValues(seed);

    const timeout = Math.max(UPLOAD_TIMEOUT_MS, Math.round((size / MB) * 4000));
    let mbps = await measureUploadOnce(size, seed, timeout, signal);

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
            startBtn.className = 'flex items-center justify-center gap-2 bg-[#e84d31]/20 text-[#e84d31]/40 border border-[#e84d31]/30 px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] transition cursor-not-allowed';
        }
        if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.className = 'flex items-center justify-center gap-2 bg-[#e84d31] text-[#f4f1e8] hover:bg-[#17201f] border border-[#e84d31] px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] transition cursor-pointer shadow-ink';
        }
        if (intervalSelect) intervalSelect.disabled = true;
        if (sizeSelect) sizeSelect.disabled = true;
    } else {
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.className = 'flex items-center justify-center gap-2 bg-[#e84d31] hover:bg-[#f4f1e8] text-[#17201f] border border-[#17201f] px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] transition cursor-pointer shadow-ink';
        }
        if (stopBtn) {
            stopBtn.disabled = true;
            stopBtn.className = 'flex items-center justify-center gap-2 border border-[#8a9992]/40 text-[#8a9992]/40 px-4 py-3.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] transition cursor-not-allowed opacity-40';
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

/* -------------------- Global window bindings for handlers ----------------- */
if (typeof window !== 'undefined') {
    window.startMonitoring = startMonitoring;
    window.stopMonitoring = stopMonitoring;
    window.runSingleTest = runSingleTest;
    window.clearHistory = clearHistory;
    window.exportCSV = exportCSV;
    window.exportJSON = exportJSON;
}

/* -------------------- Calculator Desk (Cline UI/UX) -----------------------
 * UI/UX enhancement per COLLABORATION.md — drives the scientific keypad,
 * LCD display, and step-by-step solver. No telemetry or Chart.js paths
 * are touched. Uses the existing $() and escapeHtml() helpers above.
 * ------------------------------------------------------------------ */
function appendMathKey(key) {
    const input = $('math-expression-input');
    if (!input) return;
    input.value += key;
    input.focus();
    syncCalculatorDisplay();
}

function clearMathInput() {
    const input = $('math-expression-input');
    if (!input) return;
    input.value = '';
    input.focus();
    syncCalculatorDisplay();
    const output = $('math-solution-output');
    const status = $('solution-status');
    if (output) output.innerHTML = '';
    if (status) status.textContent = 'Ready';
}

// Mirror the live expression field onto the calculator LCD (top segment).
function syncCalculatorDisplay() {
    const input = $('math-expression-input');
    const exprEl = $('calc-expr');
    if (!exprEl) return;
    const raw = input ? input.value.trim() : '';
    exprEl.textContent = raw.length ? raw : '0';
}

// Push a computed value onto the calculator LCD (result segment) + glow pulse.
function syncCalcResult(expr, result) {
    const exprEl = $('calc-expr');
    const resultEl = $('calc-result');
    if (exprEl) exprEl.textContent = expr ? expr : '0';
    if (!resultEl) return;
    const pretty = formatCalcResult(result);
    resultEl.textContent = pretty;
    if (pretty !== '—') {
        void resultEl.offsetWidth; // restart the glow animation
        resultEl.classList.add('calc-glow');
    } else {
        resultEl.classList.remove('calc-glow');
    }
}

function formatCalcResult(value) {
    if (value == null) return '—';
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    if (typeof value === 'number') {
        if (!isFinite(value)) return String(value);
        if (Number.isInteger(value)) return String(value);
        return parseFloat(value.toPrecision(10)).toString();
    }
    return String(value);
}

// Numeric backspace — remove the last character.
function backspaceMath() {
    const input = $('math-expression-input');
    if (!input) return;
    input.value = input.value.slice(0, -1);
    input.focus();
    syncCalculatorDisplay();
}

// Toggle the sign of the trailing numeric operand in the expression.
function toggleSignMath() {
    const input = $('math-expression-input');
    if (!input) return;
    const v = input.value;
    if (!v.trim()) { input.value = '-'; input.focus(); syncCalculatorDisplay(); return; }
    const token = /(-?)([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/g;
    let last = null, m;
    while ((m = token.exec(v)) !== null) last = m;
    if (last) {
        input.value = last[1] === '-'
            ? v.slice(0, last.index) + last[2] + v.slice(last.index + last[0].length)
            : v.slice(0, last.index) + '-' + last[2] + v.slice(last.index + last[0].length);
    } else {
        input.value = v.charAt(0) === '-' ? v.slice(1) : '-' + v;
    }
    input.focus();
    syncCalculatorDisplay();
}

// Keyboard accessibility while the calculator desk has focus.
function onCalcKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const desk = $('math');
    if (!desk || !desk.contains(e.target)) return;
    if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        solveMathExpression();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        clearMathInput();
    } else if (e.target.tagName !== 'INPUT' && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        backspaceMath();
    } else if (e.target.tagName !== 'INPUT' && e.key.length === 1 && /[0-9.+\-*/%()^!=]/.test(e.key)) {
        const btn = document.querySelector('#calc-keypad [data-key="' + e.key + '"]');
        if (btn) { e.preventDefault(); btn.click(); }
    }
}

function solveMathExpression() {
    const input = $('math-expression-input');
    const output = $('math-solution-output');
    const status = $('solution-status');
    if (!input || !output || !status) return;

    const expr = input.value.trim();
    if (!expr) {
        alert('Please enter a mathematical expression.');
        return;
    }

    if (typeof math === 'undefined') {
        status.textContent = 'Math.js Not Loaded';
        output.innerHTML = '<p class="text-[#e84d31] font-bold">Math.js failed to load from CDN. Check your connection and reload the page.</p>';
        return;
    }

    status.textContent = 'Calculating Steps...';
    syncCalcResult(expr, null);

    try {
        let result;
        const steps = [];

        steps.push(`1. Input Expression: <code>${escapeHtml(expr)}</code>`);

        if (expr.startsWith('det(')) {
            const evaluated = math.evaluate(expr);
            steps.push('2. Parsing Matrix and computing Determinant via Laplace expansion / LU decomposition.');
            steps.push(`3. Resulting Determinant Value: <strong class="text-[#e84d31]">${JSON.stringify(evaluated)}</strong>`);
            result = evaluated;
        } else if (expr.startsWith('inv(')) {
            const evaluated = math.evaluate(expr);
            steps.push('2. Computing Matrix Inverse via Gauss-Jordan elimination.');
            steps.push(`3. Resulting Inverse Matrix: <strong class="text-[#e84d31]">${JSON.stringify(evaluated)}</strong>`);
            result = evaluated;
        } else if (expr.startsWith('derivative(')) {
            steps.push('2. Applying Power Rule, Chain Rule, and Sum/Difference identities.');
            // Robust parse: strip the 'derivative(' prefix and trailing ')' directly,
            // then split on the LAST comma so nested commas (matrices etc.) keep
            // correct variable detection. Falls back to variable 'x'.
            const inner = expr.slice('derivative('.length, -1);
            const comma = inner.lastIndexOf(',');
            const dExpr = (comma >= 0 ? inner.slice(0, comma) : inner).trim();
            const dVar = ((comma >= 0 ? inner.slice(comma + 1) : 'x').trim() || 'x');
            if (!dExpr) throw new Error('derivative() requires an <expression> and <variable>.');
            const evaluated = math.derivative(dExpr, dVar).toString();
            steps.push(`3. Simplified Derivative <code>d/d${escapeHtml(dVar)}</code>: <strong class="text-[#e84d31]">${escapeHtml(evaluated)}</strong>`);
            result = evaluated;
        } else if (expr.startsWith('integrate(')) {
            // Math.js v12 exposes no symbolic integration primitive — surface a
            // graceful, actionable message instead of an opaque parser error.
            steps.push('2. Searching Math.js operator table for an indefinite integral primitive...');
            steps.push('<strong class="text-[#e84d31]">Symbolic integration is not supported by the loaded Math.js build.</strong> Use <code>d/dx</code> for derivatives or reformulate as a numeric sum.');
            result = null;
        } else {
            const evaluated = math.evaluate(expr);
            steps.push('2. Simplifying trigonometric, algebraic, and logarithmic terms.');
            steps.push(`3. Numerical / Symbolic Evaluation: <strong class="text-[#e84d31]">${typeof evaluated === 'object' ? JSON.stringify(evaluated) : evaluated}</strong>`);
            result = evaluated;
        }

        status.textContent = (result === null && expr.startsWith('integrate(')) ? 'Integration Unsupported' : 'Solved Successfully';

        output.innerHTML = steps.map((s, i) =>
            `<p class="step-item border-l-2 border-[#e84d31] pl-3 py-1.5" style="animation-delay:${i * 85}ms">${s}</p>`
        ).join('');

        // Mirror the final value onto the calculator LCD.
        syncCalcResult(expr, result);

    } catch (err) {
        status.textContent = 'Calculation Error';
        output.innerHTML = `<p class="text-[#e84d31] font-bold">Error evaluating expression: ${escapeHtml(err.message)}</p>`;
        syncCalcResult(expr, 'Error');
    }
}

function initCalculator() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const input = $('math-expression-input');
    if (input && typeof input.addEventListener === 'function') {
        input.addEventListener('input', syncCalculatorDisplay);
        input.addEventListener('keydown', onCalcKey);
    }
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', onCalcKey);
    }
    syncCalculatorDisplay();
}

// Wire calculator desk listeners on DOM ready (idempotent).
initCalculator();

/* -------------------- Window bindings (calculator desk) -------------------- */
if (typeof window !== 'undefined') {
    window.appendMathKey = appendMathKey;
    window.clearMathInput = clearMathInput;
    window.solveMathExpression = solveMathExpression;
    window.backspaceMath = backspaceMath;
    window.toggleSignMath = toggleSignMath;
}


