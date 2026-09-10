'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

const ids = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
const missing = [];
for (const id of ids) {
    const re = new RegExp('id=["\']' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']');
    if (!re.test(html)) missing.push(id);
}
console.log('referenced ids:', JSON.stringify(ids));
console.log(missing.length ? 'MISSING: ' + JSON.stringify(missing) : 'ALL IDs present');
process.exit(missing.length ? 1 : 0);