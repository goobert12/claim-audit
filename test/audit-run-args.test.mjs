import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, '..', 'src', 'audit-run.mjs');
const example = path.join(here, '..', 'examples', 'example-capture.md');

test('the value of --report-dir is never mistaken for the capture, whichever order the arguments come in', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'audit-args-'));
  for (const args of [['--report-dir', out, example, '--json'], [example, '--report-dir', out, '--json']]) {
    const r = spawnSync('node', [run, ...args], {encoding: 'utf8'});
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(JSON.parse(r.stdout).findings.length >= 1, 'the example capture still produces findings');
  }
});
