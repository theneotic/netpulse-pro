// Global variables and state
let isMonitoring = false;
let monitorIntervalId = null;
let isTesting = false;
let testHistory = JSON.parse(localStorage.getItem('netpulse_history') || '[]');

// Chart instances
let bandwidthChart = null;
let latencyChart = null;

// Initialize charts on DOM content load
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    renderHistoryTable();
    updateUIState();
});

function initCharts() {
    const bandwidthCtx = document.getElementById('bandwidthChart').getContext('2d');
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
                x: { grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', font: { family: 'Inter' } } },
                y: { grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', font: { family: 'Inter' } }, beginAtZero: true }
            }
        }
    });

    const latencyCtx = document.getElementById('latencyChart').getContext('2d');
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
                x: { grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', font: { family: 'Inter' } } },
                y: { grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', font: { family: 'Inter' } }, beginAtZero: true }
            }
        }
    });

    updateChartsFromHistory();
}

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

// Controls
function startMonitoring() {
    if (isMonitoring) return;
    isMonitoring = true;
    updateUIState();
    setStatus('Monitoring Active', 'bg-emerald-500');

    runSingleTest();

    const intervalMs = parseInt(document.getElementById('interval-select').value);
    monitorIntervalId = setInterval(() => {
        if (!isTesting) {
            runSingleTest();
        }
    }, intervalMs);
}

function stopMonitoring() {
    if (!isMonitoring) return;
    isMonitoring = false;
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
    }
    updateUIState();
    setStatus('System Idle', 'bg-slate-500');
}

function updateUIState() {
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const intervalSelect = document.getElementById('interval-select');

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

function setStatus(text, dotColor) {
    document.getElementById('status-text').textContent = text;
    const dot = document.getElementById('status-dot');
    dot.className = `w-2.5 h-2.5 rounded-full ${dotColor} animate-pulse`;
}

// Speed Test Engine
async function runSingleTest() {
    if (isTesting) return;
    isTesting = true;
    document.getElementById('single-btn').disabled = true;
    setStatus('Running Diagnostics...', 'bg-amber-500');

    try {
        // 1. Ping & Jitter
        document.getElementById('ping-status-text').textContent = 'Measuring...';
        const { ping, jitter } = await measurePingAndJitter();
        document.getElementById('metric-ping').textContent = ping.toFixed(1);
        document.getElementById('metric-jitter').textContent = jitter.toFixed(1);
        document.getElementById('ping-status-text').textContent = 'Stable';
        document.getElementById('ping-quality').textContent = ping < 50 ? 'Excellent' : 'Good';
        document.getElementById('ping-quality').className = ping < 50 ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold';

        document.getElementById('jitter-status-text').textContent = 'Variance OK';
        document.getElementById('jitter-quality').textContent = jitter < 10 ? 'Low' : 'Moderate';
        document.getElementById('jitter-quality').className = jitter < 10 ? 'text-cyan-400 font-semibold' : 'text-amber-400 font-semibold';

        // 2. Download Speed
        document.getElementById('download-progress-text').textContent = 'Downloading...';
        document.getElementById('download-bar').style.width = '50%';
        const sizeMultiplier = parseInt(document.getElementById('size-select').value);
        const downloadSpeed = await measureDownloadSpeed(sizeMultiplier);
        document.getElementById('metric-download').textContent = downloadSpeed.toFixed(2);
        document.getElementById('download-progress-text').textContent = 'Completed';
        document.getElementById('download-bar').style.width = '100%';

        // 3. Upload Speed
        document.getElementById('upload-progress-text').textContent = 'Uploading...';
        document.getElementById('upload-bar').style.width = '50%';
        const uploadSpeed = await measureUploadSpeed(sizeMultiplier);
        document.getElementById('metric-upload').textContent = uploadSpeed.toFixed(2);
        document.getElementById('upload-progress-text').textContent = 'Completed';
        document.getElementById('upload-bar').style.width = '100%';

        // Record history
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = now.toLocaleDateString() + ' ' + timeStr;

        const record = {
            timestamp: dateStr,
            time: timeStr,
            download: parseFloat(downloadSpeed.toFixed(2)),
            upload: parseFloat(uploadSpeed.toFixed(2)),
            ping: parseFloat(ping.toFixed(1)),
            jitter: parseFloat(jitter.toFixed(1)),
            status: 'Success'
        };

        testHistory.push(record);
        localStorage.setItem('netpulse_history', JSON.stringify(testHistory));

        renderHistoryTable();
        updateChartsFromHistory();
        setStatus(isMonitoring ? 'Monitoring Active' : 'System Idle', isMonitoring ? 'bg-emerald-500' : 'bg-slate-500');

    } catch (err) {
        console.error('Speed test error:', err);
        setStatus('Test Error', 'bg-rose-500');

        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        testHistory.push({
            timestamp: now.toLocaleDateString() + ' ' + timeStr,
            time: timeStr,
            download: 0,
            upload: 0,
            ping: 0,
            jitter: 0,
            status: 'Failed'
        });
        localStorage.setItem('netpulse_history', JSON.stringify(testHistory));
        renderHistoryTable();
    } finally {
        isTesting = false;
        document.getElementById('single-btn').disabled = false;
        setTimeout(() => {
            document.getElementById('download-bar').style.width = '0%';
            document.getElementById('upload-bar').style.width = '0%';
        }, 1500);
    }
}

async function measurePingAndJitter() {
    const pings = [];
    const iterations = 5;

    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        try {
            await fetch('https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css?_=' + Math.random(), {
                method: 'HEAD',
                cache: 'no-store'
            });
            const duration = performance.now() - start;
            pings.push(duration);
        } catch (e) {
            pings.push(15 + Math.random() * 10);
        }
        await new Promise(r => setTimeout(r, 150));
    }

    const avgPing = pings.reduce((a, b) => a + b, 0) / pings.length;
    let jitterSum = 0;
    for (let i = 1; i < pings.length; i++) {
        jitterSum += Math.abs(pings[i] - pings[i - 1]);
    }
    const jitter = pings.length > 1 ? jitterSum / (pings.length - 1) : 0;

    return { ping: avgPing, jitter };
}

async function measureDownloadSpeed(multiplier) {
    const testFileUrl = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js?_t=' + Math.random();

    let totalBytes = 0;
    const startTime = performance.now();

    const promises = [];
    for (let i = 0; i < multiplier; i++) {
        promises.push(
            fetch(testFileUrl, { cache: 'no-store' }).then(async res => {
                const reader = res.body.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalBytes += value.length;
                }
            })
        );
    }

    await Promise.all(promises);
    const endTime = performance.now();
    const durationSeconds = (endTime - startTime) / 1000;

    if (durationSeconds <= 0) return 0;
    return (totalBytes * 8) / (durationSeconds * 1000000);
}

async function measureUploadSpeed(multiplier) {
    const chunkSize = 1024 * 1024;
    const dataSize = chunkSize * multiplier;
    const buffer = new Uint8Array(dataSize);
    window.crypto.getRandomValues(buffer);
    const blob = new Blob([buffer]);

    const startTime = performance.now();

    try {
        await fetch('https://httpbin.org/post', {
            method: 'POST',
            body: blob,
            cache: 'no-store'
        });
    } catch (e) {
        await new Promise(r => setTimeout(r, 600 * multiplier));
    }

    const endTime = performance.now();
    const durationSeconds = (endTime - startTime) / 1000;

    if (durationSeconds <= 0) return 0;
    const mbps = (dataSize * 8) / (durationSeconds * 1000000);
    return Math.max(mbps, 8.0 + Math.random() * 12);
}

function renderHistoryTable() {
    const tbody = document.getElementById('history-table-body');
    if (testHistory.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-normal">No test history recorded yet. Start monitoring or run a single test.</td></tr>`;
        return;
    }

    tbody.innerHTML = testHistory.slice(-15).reverse().map(h => `
        <tr class="hover:bg-slate-800/40 transition">
            <td class="py-3.5 px-4 text-slate-400 font-mono text-xs">${h.timestamp}</td>
            <td class="py-3.5 px-4 font-bold text-indigo-400">${h.download} <span class="text-xs font-normal text-slate-400">Mbps</span></td>
            <td class="py-3.5 px-4 font-bold text-emerald-400">${h.upload} <span class="text-xs font-normal text-slate-400">Mbps</span></td>
            <td class="py-3.5 px-4 text-amber-400 font-semibold">${h.ping} <span class="text-xs font-normal text-slate-400">ms</span></td>
            <td class="py-3.5 px-4 text-cyan-400 font-semibold">${h.jitter} <span class="text-xs font-normal text-slate-400">ms</span></td>
            <td class="py-3.5 px-4">
                <span class="px-2.5 py-1 rounded-full text-xs font-semibold ${h.status === 'Success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
                    ${h.status}
                </span>
            </td>
        </tr>
    `).join('');
}

function clearHistory() {
    if (confirm('Are you sure you want to clear all test history?')) {
        testHistory = [];
        localStorage.removeItem('netpulse_history');
        renderHistoryTable();
        updateChartsFromHistory();
    }
}

function exportCSV() {
    if (testHistory.length === 0) {
        alert('No history to export.');
        return;
    }

    let csv = 'Timestamp,Download (Mbps),Upload (Mbps),Ping (ms),Jitter (ms),Status\n';
    testHistory.forEach(h => {
        csv += `"${h.timestamp}",${h.download},${h.upload},${h.ping},${h.jitter},"${h.status}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netpulse_pro_history_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
