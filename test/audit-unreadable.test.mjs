import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, '..', 'src', 'audit-run.mjs');

function capture(bodyLines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-unreadable-'));
  const file = path.join(dir, 'capture.md');
  writeFileSync(file, [
    '---',
    'url: https://example.com/product',
    'fetched: 2026-10-13, 09:00 UTC',
    'method: static HTML, no JavaScript rendering',
    'not_captured_in_text:',
    '  - "Anything the page builds with JavaScript after load."',
    '---',
    '',
    ...bodyLines,
  ].join('\n'));
  return file;
}

test('a capture with labels but no values is reported as unreadable, never as clean', () => {
  const labels = ['Dimensions', 'Battery capacity', 'Playtime', 'Bluetooth compatibility', 'Driver', 'Weight', 'Charging time'];
  const filler = Array.from({length: 12}, () => 'Shop now and save on every order today.');
  const r = spawnSync('node', [run, capture([...labels, ...filler])], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /COULD NOT BE READ/);
  assert.equal(r.stdout.includes('**No defect found on this page.**'), false);
});

test('a capture with a readable specification row and nothing wrong still reports clean', () => {
  const rows = ['Weight: 2.5 kg (5.5 lb)', 'Capacity: 1024 Wh', 'Width: 10 in (254 mm)'];
  const filler = Array.from({length: 12}, () => 'Shop now and save on every order today.');
  const r = spawnSync('node', [run, capture([...rows, ...filler])], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes('COULD NOT BE READ'), false);
  assert.match(r.stdout, /No defect found on this page/);
});
