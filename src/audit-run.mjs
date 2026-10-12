#!/usr/bin/env node
// Audit a captured page end to end and write the deliverable.
//
//   node scripts/audit-run.mjs <capture.md> [--out report.md] [--json]
//
// This is the piece that was missing: five modules each worked, and a person still
// had to run them one at a time and assemble the result by hand. An audit that
// requires the auditor to remember the procedure is not repeatable, and this whole
// project exists because a repeatable procedure beats a careful person on a good
// day. The hand-built audits of Vendor B and Vendor A were both produced by
// hand and the Vendor A one nearly shipped a wrong finding as a result.
//
// What it does, in order:
//   1. Refuses a capture with incomplete provenance, before doing any work.
//   2. Inventories the concrete claims.
//   3. Runs physical-range checks over those claims.
//   4. Runs the page's own unit conversions against each other.
//   5. Writes a report that states what was CHECKED, not only what was found.
//
// It never sends, publishes, or edits the target. It never reports a verdict on a
// company -- every finding is a flag for a human, and the report says so.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInventory} from './claim-inventory.mjs';
import {checkClaim} from './claim-arithmetic.mjs';
import {checkConversions} from './claim-conversions.mjs';
import {detectLayout, extractSpecValue} from './spec-layout.mjs';

// Where reports are written by default. Overridable with --report-dir so nothing
// assumes a particular directory layout on someone else's machine.
const outDirDefault = path.resolve(process.cwd(), 'reports');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const asJson = argv.includes('--json');
const target = argv.find(a => !a.startsWith('--') && a !== flag('--out', null) && a !== flag('--min-length', null));
if (!target) {
  console.error('usage: node scripts/audit-run.mjs <capture.md> [--out report.md] [--json]');
  process.exit(1);
}

const file = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
if (!existsSync(file)) { console.error(`no such capture: ${file}`); process.exit(1); }
const raw = readFileSync(file, 'utf8');

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
    if (value === '') { meta[key] = []; listKey = key; } else { meta[key] = value.replace(/^["']|["']$/g, ''); listKey = null; }
  }
  return {meta, body: m[2]};
}

const {meta, body} = parseCapture(raw);
if (!meta) { console.error('capture has no front-matter; provenance is required'); process.exit(1); }

const gaps = Array.isArray(meta.not_captured_in_text)
  ? (meta.not_captured_in_text.join(' | ') || 'nothing observed')
  : meta.not_captured_in_text;

const inventory = buildInventory({
  pageText: body, sourceUrl: meta.url, capturedAt: meta.fetched,
  // Both keys are accepted. The README documents `captured_by` and the shipped example uses it,
  // while earlier captures used `method`; reading only one silently produced "unknown" for the
  // other. Axiom found this in a cold read of the public repo on 2026-10-12.
  notCaptured: gaps, capturedBy: meta.captured_by || meta.method || 'unknown',
}, {minLength: Number(flag('--min-length', '15'))});

if (!inventory.ok) {
  console.error('REFUSED -- the capture is not auditable as given:');
  for (const p of inventory.problems) console.error(`  - ${p}`);
  console.error('\nDeliberate: auditing an incomplete capture would produce a report that');
  console.error('accuses the page of not saying something it may well say elsewhere.');
  process.exit(2);
}

// 3. Physical-range checks.
const rangeFlags = [];
for (const claim of inventory.claims) {
  for (const f of checkClaim(claim.text)) rangeFlags.push({...f, claimText: claim.text});
}

// 4. The page's own conversions.
const {flags: conversionFlags, checked: conversionsChecked} = checkConversions(body);

// 5. Spec rows, so the report can show what the parser read and from where.
const layout = detectLayout(body);
const specRows = [];
for (const line of body.split(/\r?\n/)) {
  if (!/:\s*\S/.test(line)) continue;
  if (!/\d/.test(line)) continue;
  const ex = extractSpecValue(line);
  if (ex) specRows.push({line: line.trim(), value: ex.value, unit: ex.unit, from: ex.fromColumn ?? 'inline'});
}

const findings = [
  ...rangeFlags.map(f => ({type: 'physical-range', severity: 'high', claim: f.claimText, detail: f.arithmetic, note: f.note})),
  ...conversionFlags.map(f => ({type: 'conversion-mismatch', severity: 'high', claim: f.raw, detail: f.arithmetic, note: f.note})),
];

const report = {
  sourceUrl: inventory.sourceUrl,
  capturedAt: inventory.capturedAt,
  capturedBy: inventory.capturedBy,
  layout,
  coverage: inventory.coverage,
  claimsFound: inventory.claims.length,
  conversionsChecked: conversionsChecked.length,
  specRowsRead: specRows.length,
  findings,
};

// JSON goes out when asked for. A `.md` path is handled further down, where the human-readable
// report actually exists -- the usage text advertises `--out report.md` and it previously did nothing,
// because this block runs before the markdown lines are built. Axiom found this on 2026-10-12.
const outPath = flag('--out', null);
if (asJson || (outPath && outPath.endsWith('.json'))) {
  const payload = JSON.stringify(report, null, 2);
  if (outPath && outPath.endsWith('.json')) {
    writeFileSync(path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath), payload + '\n', 'utf8');
    console.error(`wrote ${outPath}`);
  }
  if (asJson && !outPath) process.stdout.write(payload + '\n');
}

// Human-readable report.
const lines = [];
lines.push(`# Audit: ${report.sourceUrl}`);
lines.push('');
lines.push(`**Captured:** ${report.capturedAt}  `);
lines.push(`**Captured by:** ${report.capturedBy}  `);
lines.push(`**Layout detected:** \`${report.layout}\``);
lines.push('');
lines.push('## Result');
lines.push('');
if (!findings.length) {
  lines.push('**No defect found on this page.**');
  lines.push('');
  lines.push(`${report.claimsFound} claims were inventoried, and ${report.conversionsChecked} two-unit`);
  lines.push('conversions the page states about itself were recomputed and agree.');
} else {
  lines.push(`**${findings.length} finding(s).** Each is a flag for a human, not a verdict.`);
  lines.push('');
  findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.type}`);
    lines.push('');
    lines.push(`*Wording on the page:* ${f.claim}`);
    lines.push('');
    lines.push(f.detail);
    lines.push('');
    if (f.note) lines.push(`> ${f.note}`);
    lines.push('');
  });
}
lines.push('## What was checked');
lines.push('');
lines.push(`- **Claims inventoried:** ${report.claimsFound}`);
lines.push(`- **Two-unit conversions recomputed:** ${report.conversionsChecked}`);
lines.push(`- **Specification rows read:** ${report.specRowsRead}`);
lines.push('');
if (conversionsChecked.length) {
  lines.push('Every conversion the page states about itself was recomputed, and these agree:');
  lines.push('');
  for (const c of conversionsChecked.slice(0, 20)) {
    lines.push(`- ${c.stated} ${c.fromUnit} = ${c.expected} ${c.toUnit}  (page states ${c.statedOther})`);
  }
  lines.push('');
}
lines.push('## Coverage and limits');
lines.push('');
lines.push('**What did not come through in the capture, as reported by the capturer:**');
lines.push('');
lines.push(report.coverage.gapStatement);
lines.push('');
lines.push('A claim inside an image, a PDF, or an unretrieved region would not appear above.');
lines.push('**Absence from this report is not proof the page does not say it.**');
lines.push('');

const reportDir = path.resolve(flag('--report-dir', outDirDefault));
mkdirSync(reportDir, {recursive: true});
const reportPath = path.join(reportDir, `AUDIT-${path.basename(file, '.md')}.md`);
writeFileSync(reportPath, lines.join('\n'), 'utf8');

// The advertised `--out report.md` contract. It previously did nothing, because the only `--out`
// handling sat in the JSON block above -- which runs before these `lines` exist. Axiom found this in a
// cold read of the public repo on 2026-10-12: the usage text promised a Markdown output path and the
// code silently ignored it.
const mdOut = flag('--out', null);
if (mdOut && mdOut.endsWith('.md')) {
  const mdPath = path.isAbsolute(mdOut) ? mdOut : path.join(process.cwd(), mdOut);
  mkdirSync(path.dirname(mdPath), {recursive: true});
  writeFileSync(mdPath, lines.join('\n'), 'utf8');
  console.error(`wrote ${mdOut}`);
}

if (!asJson) {
  console.log(lines.join('\n'));
  console.error(`\nwrote AUDIT-${path.basename(file, '.md')}.md`);
}
