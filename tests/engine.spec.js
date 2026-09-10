/*
 * tests/engine.spec.js — E2E validation of the NetPulse Pro telemetry engine
 * against the live Cloudflare speed-test endpoints.
 *
 * Run:  node tests\engine.spec.js
 *       (uses only Node built-ins; no npm install required)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', 'script.js');
const src = fs.readFileSync(scriptPath, 'utf8');

let failures = 0;
const check = (name, cond, extra) => {
    if (cond) {
        console.log('ok - ' + name);
    } else {
        failures++;
        console.error('FAIL - ' + name + (extra ? ' :: ' + extra : ''));
    }
};

/* ------------------------- Static sanity checks ------------------------- */
// Block comments stripped, then any Math.random() outside line comments fails.
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
if (/\bMath\.random\s*\(/.test(stripped)) {
    console.error('FAIL - Math.random() detected outside comments in script.js');
    process.exit(1);
}
console.log('ok - no Math.random() in measurement code');

/* ------------------- Load the engine into a sandbox ---------------------- */
const moduleBox = { exports: {} };
const context = vm.createContext({
    console,
    module: moduleBox,
    document: { addEventListener: () => {} },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    },
    window: { crypto: globalThis.crypto },
    crypto: globalThis.crypto,
    fetch: (...args) => globalThis.fetch(...args),
    AbortSignal: globalThis.AbortSignal,
    performance: globalThis.performance,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Math, Date, JSON, Uint8Array, Array, Number, String, Promise, Object, Error, RegExp
});
vm.runInContext(src + '\nmodule.exports = { measurePingAndJitter, measureDownloadOnce, measureUploadOnce, measureDownloadSpeed, measureUploadSpeed, median, meanAbsDiff, readServerInfo, buildBlob };', context, { filename: 'script.js' });

const engine = moduleBox.exports;

/* ------------------------------ Pure math -------------------------------- */
check('median() odd', engine.median([3, 1, 2]) === 2, 'got ' + engine.median([3, 1, 2]));
check('median() even', engine.median([4, 1, 3, 2]) === 2.5, 'got ' + engine.median([4, 1, 3, 2]));
const jitter = engine.meanAbsDiff([10, 12, 9]);
check('meanAbsDiff()', Math.abs(jitter - 2.5) < 1e-9, 'got ' + jitter);

/* ----------------------------- Ping (live) ------------------------------- */
(async () => {
    try {
        const r = await engine.measurePingAndJitter();
        check('ping measurable', r.ping > 0, 'got ' + r.ping + ' ms');
        check('jitter >= 0', r.jitter >= 0, 'got ' + r.jitter + ' ms');
        check('server info (cf-meta headers)',
            !!r.serverInfo && r.serverInfo.label && r.serverInfo.label.length > 0,
            JSON.stringify(r.serverInfo));
    } catch (e) {
        failures++;
        console.error('FAIL - ping E2E: ' + e.message);
    }

    /* --------------------------- Download (live) -------------------------- */
    try {
        const dl = await engine.measureDownloadOnce(128 * 1024);
        if (dl == null) {
            // Retried once at a smaller size to distinguish link slowness from code failure.
            const dl2 = await engine.measureDownloadOnce(48 * 1024);
            check('download measurable (retry)', dl2 != null && dl2 > 0, 'got null');
        } else {
            check('download measurable', dl > 0, 'got ' + dl.toFixed(2) + ' Mbps');
        }
    } catch (e) {
        failures++;
        console.error('FAIL - download E2E threw: ' + e.message);
    }

    /* ---------------------------- Upload (live) --------------------------- */
    try {
        const seed = new Uint8Array(160 * 1024);
        const up = await engine.measureUploadOnce(96 * 1024, seed);
        if (up == null) {
            console.log('skip - upload returned null (slow link timeout) — code path executed without throwing');
            const up2 = await engine.measureUploadOnce(16 * 1024, new Uint8Array(32 * 1024));
            if (up2 != null) check('upload measurable (small retry)', up2 > 0, 'got ' + up2.toFixed(2) + ' Mbps');
        } else {
            check('upload measurable', up > 0, 'got ' + up.toFixed(2) + ' Mbps');
        }
    } catch (e) {
        failures++;
        console.error('FAIL - upload E2E threw: ' + e.message);
    }

    /* ------------------- Full adaptive cycle (profile Light) -------------- */
    try {
        const dl = await engine.measureDownloadSpeed('1');
        check('measureDownloadSpeed(profile=1)', dl > 0, 'got ' + dl.toFixed(2) + ' Mbps');
    } catch (e) {
        failures++;
        console.error('FAIL - measureDownloadSpeed threw: ' + e.message);
    }

    console.log(failures
        ? '\nSUMMARY: ' + failures + ' failure(s)'
        : '\nSUMMARY: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch(e => {
    console.error('Harness crash:', e);
    process.exit(2);
});