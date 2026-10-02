#!/usr/bin/env node
// Build a claim inventory from a captured page.
//
//   node scripts/claim-inventory-run.mjs <capture.md> [--out inventory.json] [--json]
//
// A capture is a markdown file with YAML front-matter carrying the provenance:
//
//   ---
//   url: https://example.com/page
//   fetched: 2026-10-01
//   not_captured_in_text:
//     - "what did not come through"
//   ---
//   <the page text>
//
// The provenance is REQUIRED and the tool refuses without it -- see
// server/claim-inventory.mjs for why. A report that hides a retrieval gap would
// accuse a page of not saying something it may well say inside an image.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInventory} from './claim-inventory.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const asJson = argv.includes('--json');
const target = argv.find(a => !a.startsWith('--') && a !== flag('--out', null));
if (!target) {
  console.error('usage: node scripts/claim-inventory-run.mjs <capture.md> [--out file.json] [--json]');
  process.exit(1);
}

const file = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
if (!existsSync(file)) { console.error(`no such capture: ${file}`); process.exit(1); }
const raw = readFileSync(file, 'utf8');

// Split YAML front-matter from the body. A tiny parser, because the shape is
// fixed and pulling in a YAML dependency for five scalar fields is not worth it.
function parseCapture(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return {meta: null, body: text};
  const meta = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { meta[listKey].push(item[1].replace(/^["']|["']$/g, '')); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { meta[key] = []; listKey = key; }
    else { meta[key] = value.replace(/^["']|["']$/g, ''); listKey = null; }
  }
  return {meta, body: m[2]};
}

const {meta, body} = parseCapture(raw);
if (!meta) {
  console.error('capture has no front-matter. Provenance is required, not optional.');
  process.exit(1);
}

const notCapturedList = Array.isArray(meta.not_captured_in_text) ? meta.not_captured_in_text : null;
const inventory = buildInventory({
  pageText: body,
  sourceUrl: meta.url,
  capturedAt: meta.fetched,
  // Join the list into a statement. Absent entirely is different from empty, and
  // buildInventory refuses the former.
  notCaptured: notCapturedList ? (notCapturedList.join(' | ') || 'nothing observed') : meta.not_captured_in_text,
  capturedBy: meta.method || 'unknown',
}, {minLength: Number(flag('--min-length', '15'))});

if (!inventory.ok) {
  console.error('REFUSED -- the capture is not auditable as given:');
  for (const p of inventory.problems) console.error(`  - ${p}`);
  console.error('\nThis is deliberate. Auditing an incomplete capture would produce a report');
  console.error('that accuses the page of not saying something it may well say elsewhere.');
  process.exit(2);
}

const outPath = flag('--out', null);
if (asJson || outPath) {
  const payload = JSON.stringify(inventory, null, 2);
  if (outPath) {
    const dest = path.isAbsolute(outPath) ? outPath : path.resolve(outPath);
    writeFileSync(dest, payload + '\n', 'utf8');
    console.error(`wrote inventory -> ${dest}`);
  } else {
    process.stdout.write(payload + '\n');
  }
}

if (!asJson && !outPath) {
  console.log(`source   : ${inventory.sourceUrl}`);
  console.log(`captured : ${inventory.capturedAt}  by ${inventory.capturedBy}`);
  console.log(`read     : ${inventory.coverage.charactersRead} characters`);
  console.log(`claims   : ${inventory.claims.length}`);
  console.log(`gaps     : ${inventory.coverage.gapStatement.slice(0, 160)}`);
  console.log('');
  inventory.claims.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${c.signals.join(',')}]`);
    console.log(`    ${c.text}`);
  });
  console.log('');
  console.log('Every claim above carries its literal wording and offset into the capture.');
  console.log('Claims inside images or widgets are NOT included -- see the gap statement.');
}
