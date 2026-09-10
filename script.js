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
const HISTORY_LIMIT = 500;

const MB = 1024 * 1024;
const DOWNLOAD_STAGES = [2 * MB, 10 * MB, 25 * MB, 50 * MB];
const UPLOAD_STAGES = [1 * MB, 2 * MB, 5 * MB, 10 * MB, 20 * MB];
// Fallbacks attempted only when the smallest regular stage can't complete
// (e.g. very slow links or heavy congestion).
const SLOW_DOWNLOAD_STAGES = [256 * 1024, 512 * 1024, 1024 * 1024];
const SLOW_UPLOAD_STAGES = [64 * 1024, 128 * 1024, 256 * 1024];
// size-select value -> highest stage index to attempt
const DL_STAGE_INDEX = { '1': 0, '5': 2, '15': 3 };
const UP_STAGE_INDEX = { '1': 0, '5': 2, '15': 4 };

const PING_SAMPLES = 8;
const UPLOAD_ATTEMPTS = 2;
const MIN_STAGE_SECONDS = 1.5; // keep sizing up until a stage runs at least this long
const PING_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const UPLOAD_TIMEOUT_MS = 60000;
const SLOW_FLOOR_TIMEOUT_MS = 8000;

/* ------------------------------- Global state ----------------------------- */
let isMonitoring = false;
let monitorTimerId = null;
let pendingTick = false;   // scheduled tick fired while a test was already running
let nextRunAt = null;      // epoch ms of the next scheduled test (for countdown)
let countdownTimerId = null;
let isTesting = false;
let lastServerLabel = null;

let testHistory = [];
try {
    if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(HISTORY_KEY) || '[]';
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) testHistory = parsed;
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
    return (mbps == null || Number.isNaN(mbps)) ? '—' : mbps.toFixed(2);
}

function formatMs(ms) {
    return (ms == null || Number.isNaN(ms)) ? '—' : ms.toFixed(1);
}

function round2(v) { return Math.round(v * 100) / 100; }
function round1(v) { return Math.round(v * 10) / 10; }

/** Random hex nonce for cache-busting speed-test URLs. */
function nonce() {
    const buf = new Uint8Array(8);
    window.crypto.getRandomValues(buf);
    return Array.prototype.map.call(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return mid % 1 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

/** RFC 3550-style jitter: mean absolute difference of successive RTT samples. */
function meanAbsDiff(values) {
    let sum = 0;
    for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
    return values.length > 1 ? sum / (values.length - 1) : 0;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Per-stage timeout sized so even 0.3 Mbps links have time to complete a
 * first-stage payload, clamped between floorMs and capMs.
 */
function stageTimeoutMs(bytes, floorMs, capMs) {
    const minRate = 300000; // bits per second tolerated on small payloads
    return Math.min(capMs, Math.max(floorMs, Math.ceil((bytes * 8) / minRate)));
}

/** fetch() that hard-aborts after timeoutMs (AbortSignal.timeout, Chrome 108+). */
function fetchWithTimeout(url, options, timeoutMs) {
    const opts = options || {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        opts.signal = AbortSignal.timeout(timeoutMs);
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
    $('status-text').textContent = text;
    const dot = $('status-dot');
    dot.className = 'w-2.5 h-2.5 rounded-full ' + dotColor + ' animate-pulse';
}

/* ------------------------------- Bootstrap -------------------------------- */
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        restoreSavedInterval();
        initCharts();
        renderHistoryTable();
        updateUIState();
    });
}

function restoreSavedInterval() {
    const sel = $('interval-select');
    if (!sel) return;
    try {
        const saved = localStorage.getItem(INTERVAL_KEY);
        if (saved && Array.prototype.some.call(sel.options, o => o.value === saved)) {
            sel.value = saved;
        }
    } catch (e) { /* storage unavailable — keep defaults */ }
}

/* ============================ Measurement engine ========================== */

/** Reads Cloudflare geo metadata from response headers (when CORS-visible). */
function readServerInfo(res) {
    const g = h => {
        try { return res.headers.get(h); } catch (e) { return null; }
    };
    // Try the cf-meta aliases first, then the plain names. In CORS-filtered
    // browsers only cf-meta-* may be readable; the trace fallback covers that.
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

/**
 * Fallback source of node info: GET https://speed.cloudflare.com/cdn-cgi/trace
 * (CORS `*`, plain text). Body lines look like: ip=… loc=IN colo=BOM …
 */
async function fetchServerInfoFallback() {
    try {
        const res = await fetchWithTimeout(TRACE_ENDPOINT, {
            method: 'GET',
            cache: 'no-store'
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
    $('server-location-text').textContent = info.label;
    const badge = $('connection-badge');
    badge.classList.remove('hidden');
    badge.classList.add('flex');
}

/**
 * Ping & jitter: PING_SAMPLES sequential GETs of an empty payload against the
 * Cloudflare edge. RTT = median, jitter = mean abs successive diff (RFC 3550).
 * No fallback values — throws if every probe fails. Also captures the first
 * response's geo metadata for the location badge.
 */
async function measurePingAndJitter() {
    const rtts = [];
    let serverInfo = null;

    for (let i = 0; i < PING_SAMPLES; i++) {
        const url = PING_ENDPOINT + '&cb=' + nonce();
        const startedAt = performance.now();
        try {
            const res = await fetchWithTimeout(url, {
                method: 'GET',
                cache: 'no-store'
                // Note: no custom headers — Cache-Control request header triggers a CORS
                // preflight that Cloudflare's /__down endpoint rejects. Cache busting is
                // already handled by the &cb=nonce query param.
            }, PING_TIMEOUT_MS);
            await res.arrayBuffer(); // drain (empty) payload so RTT covers the full round trip
            rtts.push(performance.now() - startedAt);
            if (i === 0) serverInfo = readServerInfo(res);
        } catch (e) {
            // sample failed — skipped, never fabricated
        }
        if (i < PING_SAMPLES - 1) await sleep(120);
    }

    if (rtts.length === 0) {
        throw new Error('Ping measurement failed: no reachable endpoint');
    }

    // In CORS-filtered browsers the cf-meta headers do not carry city/colo —
    // fall back to the always-readable cdn-cgi/trace body.
    if (!serverInfo) serverInfo = await fetchServerInfoFallback();

    return { ping: median(rtts), jitter: meanAbsDiff(rtts), serverInfo };
}

function downloadStagesFor(profile) {
    const idx = DL_STAGE_INDEX[String(profile)];
    return DOWNLOAD_STAGES.slice(0, (idx == null ? DL_STAGE_INDEX['5'] : idx) + 1);
}

/** Stream a single ?bytes=N payload, counting decoded bytes vs elapsed time. */
async function measureDownloadOnce(bytes, onLive, timeoutMs) {
    const url = DOWNLOAD_ENDPOINT + '?bytes=' + bytes + '&cb=' + nonce();
    const startedAt = performance.now();
    let totalBytes = 0;

    try {
        const res = await fetchWithTimeout(url, {
            method: 'GET',
            cache: 'no-store'
        }, timeoutMs || DOWNLOAD_TIMEOUT_MS);
        if (!res.ok) {
            console.warn('Download HTTP response not OK:', res.status, res.statusText);
            return null;
        }

        if (res.body && typeof res.body.getReader === 'function') {
            try {
                const reader = res.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value.length;
                    if (typeof onLive === 'function') {
                        const sec = (performance.now() - startedAt) / 1000;
                        if (sec > 0) onLive((totalBytes * 8) / (sec * 1e6));
                    }
                }
            } catch (streamErr) {
                console.warn('Stream reader interrupted, draining via blob:', streamErr);
            }
        }
        
        // Fallback if reader didn't collect bytes (or wasn't supported)
        if (totalBytes === 0) {
            const blob = await res.blob();
            totalBytes = blob.size;
        }
    } catch (e) {
        console.error('measureDownloadOnce network/CORS error on ' + url + ':', e);
        return null;
    }

    const durationSec = (performance.now() - startedAt) / 1000;
    if (durationSec <= 0 || totalBytes === 0) return null;
    return (totalBytes * 8) / (durationSec * 1e6);
}

/**
 * Download: grow payloads until a stage runs >= MIN_STAGE_SECONDS. Accurate on
 * anything from ~0.3 Mbps (falls back to tiny probes) up to gigabit lines.
 */
async function measureDownloadSpeed(profile, onLive) {
    const stages = downloadStagesFor(profile);
    let lastBest = 0;

    for (let i = 0; i < stages.length; i++) {
        const size = stages[i];
        const mbps = await measureDownloadOnce(size, onLive, stageTimeoutMs(size, SLOW_FLOOR_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS));
        if (mbps != null) {
            lastBest = mbps;
            const elapsedSec = (size * 8) / 1e6 / mbps;
            if (elapsedSec >= MIN_STAGE_SECONDS || i === stages.length - 1) break;
        } else if (i === 0) {
            // Regular stage aborted — try the slow-link fallbacks.
            for (let s = 0; s < SLOW_DOWNLOAD_STAGES.length; s++) {
                const slow = await measureDownloadOnce(SLOW_DOWNLOAD_STAGES[s], onLive, stageTimeoutMs(SLOW_DOWNLOAD_STAGES[s], SLOW_FLOOR_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS));
                if (slow != null) return slow;
            }
            throw new Error('Download measurement failed');
        }
    }

    return lastBest;
}

function uploadStagesFor(profile) {
    const idx = UP_STAGE_INDEX[String(profile)];
    return UPLOAD_STAGES.slice(0, (idx == null ? UP_STAGE_INDEX['5'] : idx) + 1);
}

/** Build a Blob of `bytes` from a 1 MB random seed (cheap, high entropy). */
function buildBlob(bytes, seed) {
    if (bytes <= seed.length) {
        return new Blob([seed.subarray(0, bytes)], { type: 'application/octet-stream' });
    }
    const parts = new Array(Math.ceil(bytes / seed.length)).fill(seed);
    return new Blob(parts, { type: 'application/octet-stream' });
}

async function measureUploadOnce(bytes, seed, timeoutMs) {
    const blob = buildBlob(bytes, seed);
    const startedAt = performance.now();

    try {
        const res = await fetchWithTimeout(UPLOAD_ENDPOINT, {
            method: 'POST',
            body: blob,
            headers: { 'Content-Type': 'application/octet-stream' }
        }, timeoutMs || UPLOAD_TIMEOUT_MS);
        if (!res.ok) return null;
    } catch (e) {
        return null;
    }

    const durationSec = (performance.now() - startedAt) / 1000;
    if (durationSec <= 0) return null;
    return (bytes * 8) / (durationSec * 1e6);
}

/**
 * Upload: two attempts per stage (keep the best) with adaptive sizing, plus a
 * slow-link fallback when even the smallest regular payload can't complete.
 * Note: fetch() exposes no upload progress events, so no live ticker here.
 */
async function measureUploadSpeed(profile) {
    const stages = uploadStagesFor(profile);
    // One high-entropy seed per cycle; replicated across stages.
    // Fill in 64 KB chunks — crypto.getRandomValues() is limited to 65536 bytes per call.
    const seed = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < seed.length; offset += 65536) {
        window.crypto.getRandomValues(seed.subarray(offset, offset + 65536));
    }

    let lastBest = 0;

    for (let i = 0; i < stages.length; i++) {
        const size = stages[i];
        let stageBest = 0;
        for (let a = 0; a < UPLOAD_ATTEMPTS; a++) {
            const mbps = await measureUploadOnce(size, seed, stageTimeoutMs(size, SLOW_FLOOR_TIMEOUT_MS, UPLOAD_TIMEOUT_MS));
            if (mbps != null) {
                stageBest = Math.max(stageBest, mbps);
            }
        }
        if (stageBest > 0) {
            lastBest = stageBest;
            const elapsedSec = (size * 8) / 1e6 / stageBest;
            if (elapsedSec >= MIN_STAGE_SECONDS || i === stages.length - 1) break;
        } else if (i === 0) {
            break; // smallest regular stage failed — fall through to slow probes
        }
    }

    if (lastBest <= 0) {
        // No regular stage succeeded — slow-link fallback: 2 attempts on each tiny payload.
        for (let s = 0; s < SLOW_UPLOAD_STAGES.length; s++) {
            let best = 0;
            for (let a = 0; a < UPLOAD_ATTEMPTS; a++) {
                const mbps = await measureUploadOnce(SLOW_UPLOAD_STAGES[s], seed, stageTimeoutMs(SLOW_UPLOAD_STAGES[s], SLOW_FLOOR_TIMEOUT_MS, UPLOAD_TIMEOUT_MS));
                if (mbps != null) best = Math.max(best, mbps);
            }
            if (best > 0) return best;
        }
        throw new Error('Upload measurement failed');
    }

    return lastBest;
}

/* ====================== Continuous monitoring lifecycle ==================== */

function startMonitoring() {
    if (isMonitoring) return;
    isMonitoring = true;
    pendingTick = false;
    updateUIState();
    setStatus('Monitoring Active', 'bg-emerald-500');
    const cd = $('countdown-text');
    if (cd) cd.classList.remove('hidden');
    runSingleTest(); // first cycle immediately; runSingleTest chains the next tick
}

function stopMonitoring() {
    if (!isMonitoring) return;
    isMonitoring = false;
    pendingTick = false;
    stopCountdown();
    if (monitorTimerId) {
        clearTimeout(monitorTimerId);
        monitorTimerId = null;
    }
    updateUIState();
    setStatus('System Idle', 'bg-slate-500');
    const cd = $('countdown-text');
    if (cd) cd.classList.add('hidden');
}

/** Drift-free chain: the next tick is scheduled only after the current test ends. */
function scheduleNextTest() {
    if (!isMonitoring) return;
    const intervalMs = parseInt($('interval-select').value);
    try { localStorage.setItem(INTERVAL_KEY, String(intervalMs)); } catch (e) { /* quota */ }
    nextRunAt = Date.now() + intervalMs;
    monitorTimerId = setTimeout(onScheduledTick, intervalMs);
    startCountdown();
}

function onScheduledTick() {
    if (!isMonitoring) return;
    if (isTesting) {
        // A test is still running — queue it; runSingleTest drains the queue.
        pendingTick = true;
        return;
    }
    runSingleTest();
}

function startCountdown() {
    stopCountdown();
    countdownTimerId = setInterval(updateCountdown, 500);
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
        el.textContent = 'Starting next test…';
        return;
    }
    const totalSec = Math.ceil(remainMs / 1000);
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    el.textContent = 'Next test in ' + mm + ':' + ss;
}

function updateUIState() {
    const startBtn = $('start-btn');
    const stopBtn = $('stop-btn');
    const intervalSelect = $('interval-select');

    if (isMonitoring) {
        startBtn.disabled = true;
        startBtn.className = 'flex-1 bg-indigo-950/60 text-indigo-400 cursor-not-allowed font-semibold py-3 px-4 rounded-xl transition border border-indigo-900/50 flex items-center justify-center space-x-2 text-sm';
        stopBtn.disabled = false;
        stopBtn.className = 'flex-1 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-semibold py-3 px-4 rounded-xl transition shadow-lg shadow-rose-600/30 flex items-center justify-center space-x-2 text-sm';
        intervalSelect.disabled = true;
    } else {
        startBtn.disabled = false;
        startBtn.className = 'flex-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-semibold py-3 px-4 rounded-xl transition shadow-lg shadow-indigo-600/30 flex items-center justify-center space-x-2 text-sm';
        stopBtn.disabled = true;
        stopBtn.className = 'flex-1 bg-slate-800/80 text-slate-500 cursor-not-allowed font-semibold py-3 px-4 rounded-xl transition border border-slate-700/50 flex items-center justify-center space-x-2 text-sm';
        intervalSelect.disabled = false;
    }
}

/* ============================== Single test run ============================ */

async function runSingleTest() {
    if (isTesting) return;
    isTesting = true;
    $('single-btn').disabled = true;
    nextRunAt = null;
    setStatus('Running Diagnostics…', 'bg-amber-500');

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = now.toLocaleDateString() + ' ' + timeStr;
    const profile = $('size-select').value;

    let ping = null;
    let jitter = null;
    let download = null;
    let upload = null;

    // ---- 1. Ping & jitter -------------------------------------------------
    $('ping-status-text').textContent = 'Measuring…';
    try {
        const r = await measurePingAndJitter();
        ping = r.ping;
        jitter = r.jitter;
        if (r.serverInfo) updateServerBadge(r.serverInfo);

        $('metric-ping').textContent = formatMs(ping);
        $('metric-jitter').textContent = formatMs(jitter);

        const pq = pingQuality(ping);
        $('ping-quality').textContent = pq.label;
        $('ping-quality').className = 'text-' + pq.color + '-400 font-semibold';
        $('ping-status-text').textContent = 'Stable';

        const jq = jitterQuality(jitter);
        $('jitter-quality').textContent = jq.label;
        $('jitter-quality').className = 'text-' + jq.color + '-400 font-semibold';
        $('jitter-status-text').textContent = 'Variance OK';
    } catch (e) {
        console.error('Ping failed:', e);
        $('metric-ping').textContent = '—';
        $('metric-jitter').textContent = '—';
        $('ping-status-text').textContent = 'Unreachable';
        $('ping-quality').textContent = 'Failed';
        $('ping-quality').className = 'text-rose-400 font-semibold';
        $('jitter-status-text').textContent = 'Unavailable';
        $('jitter-quality').textContent = 'Failed';
        $('jitter-quality').className = 'text-rose-400 font-semibold';
    }

    // ---- 2. Download ------------------------------------------------------
    $('download-progress-text').textContent = 'Connecting…';
    $('download-bar').style.width = '0%';
    try {
        download = await measureDownloadSpeed(profile, live => {
            $('download-progress-text').textContent = 'Streaming — ' + live.toFixed(1) + ' Mbps';
        });
        $('metric-download').textContent = formatMbps(download);
        $('download-progress-text').textContent = 'Completed';
        $('download-bar').style.width = '100%';
    } catch (e) {
        console.error('Download failed:', e);
        $('metric-download').textContent = '—';
        $('download-progress-text').textContent = 'Failed';
        $('download-bar').style.width = '0%';
    }

    // ---- 3. Upload --------------------------------------------------------
    $('upload-progress-text').textContent = 'Uploading payload…';
    $('upload-bar').style.width = '0%';
    try {
        upload = await measureUploadSpeed(profile);
        $('metric-upload').textContent = formatMbps(upload);
        $('upload-progress-text').textContent = 'Completed';
        $('upload-bar').style.width = '100%';
    } catch (e) {
        console.error('Upload failed:', e);
        $('metric-upload').textContent = '—';
        $('upload-progress-text').textContent = 'Failed';
        $('upload-bar').style.width = '0%';
    }

    // ---- Record (honest: nulls for failed phases) --------------------------
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

    isTesting = false;
    $('single-btn').disabled = false;
    setStatus(isMonitoring ? 'Monitoring Active' : 'System Idle',
        isMonitoring ? 'bg-emerald-500' : 'bg-slate-500');

    // Reset progress bars shortly after displaying the final state.
    setTimeout(() => {
        if (!isTesting) {
            $('download-bar').style.width = '0%';
            $('upload-bar').style.width = '0%';
        }
    }, 2000);

    // Chain the next scheduled test if monitoring (drains a queued tick too).
    if (isMonitoring) {
        if (pendingTick) {
            pendingTick = false;
            runSingleTest();
        } else {
            scheduleNextTest();
        }
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
                    borderColor: '#818cf8',
                    backgroundColor: 'rgba(129, 140, 248, 0.1)',
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#818cf8'
                },
                {
                    label: 'Upload (Mbps)',
                    data: [],
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52, 211, 153, 0.1)',
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#34d399'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#94a3b8', font: { family: 'Inter', weight: 600 } } }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(51, 65, 85, 0.4)' },
                    ticks: { color: '#94a3b8', font: { family: 'Inter' } }
                },
                y: {
                    grid: { color: 'rgba(51, 65, 85, 0.4)' },
                    ticks: { color: '#94a3b8', font: { family: 'Inter' } },
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
                    borderColor: '#fbbf24',
                    backgroundColor: 'rgba(251, 191, 36, 0.1)',
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#fbbf24'
                },
                {
                    label: 'Jitter (ms)',
                    data: [],
                    borderColor: '#22d3ee',
                    backgroundColor: 'rgba(34, 211, 238, 0.1)',
                    borderWidth: 3,
                    tension: 0.4,
                    fill: true,
                    pointRadius: 3,
                    pointBackgroundColor: '#22d3ee'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#94a3b8', font: { family: 'Inter', weight: 600 } } }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(51, 65, 85, 0.4)' },
                    ticks: { color: '#94a3b8', font: { family: 'Inter' } }
                },
                y: {
                    grid: { color: 'rgba(51, 65, 85, 0.4)' },
                    ticks: { color: '#94a3b8', font: { family: 'Inter' } },
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
            return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
        case 'Partial':
            return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
        case 'Failed':
            return 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
        default:
            return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
    }
}

function cellValue(value) {
    return value == null ? '—' : escapeHtml(value);
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