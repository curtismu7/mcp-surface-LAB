// Rule 27: the vendored shared/run-observability files match web/src/run-observability/run-observability.sha256 byte for byte.
// They come from curtismu7/AI-DEMO-Standalone shared/run-observability: change them there, re-pin, re-vendor; never edit them here.
// This lab reads no logs (its rows are all simulated: Mock and Live are both its own engine), so it vendors the core only (no server/src/runObservabilityReaders.js);
// checkPin skips that pin line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPin } from './run-observability-checkPin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READER = /ElasticsearchReader|DockerLogReader|readersFromEnv|runObservabilityReaders|RUN_OBS_/;
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])) : []);
// The ONLY files allowed to name a reader or a RUN_OBS_ setting, by exact lab-relative path: the pinned core (its own comment and its "no reader is configured" message) and the
// pinned panel folder (its fixtures and test describe those messages). Any other file under server/src or web/src, a file of the same name in another folder included, is scanned.
const PINNED_CORE = 'server/src/runObservability.js';
const PINNED_PANEL = 'web/src/run-observability/';
function readerHits(dir) {
  return [...walk(path.join(dir, 'server/src')), ...walk(path.join(dir, 'web/src'))]
    .filter((f) => /\.(?:js|jsx|mjs)$/.test(f))
    .map((f) => path.relative(dir, f).split(path.sep).join('/'))
    .filter((rel) => rel !== PINNED_CORE && !rel.startsWith(PINNED_PANEL) && READER.test(fs.readFileSync(path.join(dir, rel), 'utf8')));
}

test('every vendored run-observability file matches its pin, and the core is present', () => {
  assert.deepEqual(checkPin(root), []);
});

test('this lab reads no logs: no readers file, no server or web file names a reader or a RUN_OBS_ setting (comments included), and the core has no imports, no network and no file access', () => {
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
  const core = fs.readFileSync(path.join(root, PINNED_CORE), 'utf8');
  assert.ok(!/^\s*import\s/m.test(core), 'the core has no imports');
  assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|\bfetch\s*\(|node:http|node:fs/.test(core), 'the core names no reader, no network and no file access, not even in a comment');
  assert.deepEqual(readerHits(root), [], 'no other file under server/src or web/src names a reader or a RUN_OBS_ setting');
});

test('the reader-name scan skips the pinned core by its exact path only: a file of the same name elsewhere, or any other file, is caught', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'ro-scan-'));
  const plant = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
  try {
    plant(PINNED_CORE, '// names ElasticsearchReader and RUN_OBS_ES_URL: the pinned core, skipped\n');
    plant('web/src/run-observability/fixtures.js', 'export const note = "RUN_OBS_ES_URL";\n');
    assert.deepEqual(readerHits(tmp), [], 'the pinned core and the pinned panel folder are skipped');
    plant('server/src/shared/runObservability.js', 'import { ElasticsearchReader } from "x";\n');
    plant('web/src/components/Streams.jsx', 'export const RUN_OBS_STREAMS = [];\n');
    plant('server/src/other.js', '// readersFromEnv\n');
    assert.deepEqual(readerHits(tmp).sort(), ['server/src/other.js', 'server/src/shared/runObservability.js', 'web/src/components/Streams.jsx']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the lab ships no run-observability setting and mounts no Docker socket (nothing reads logs here)', () => {
  for (const f of ['docker-compose.yml', '.env.example', 'Dockerfile']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/RUN_OBS_/.test(text), `${f} has no RUN_OBS_ setting`);
    assert.ok(!/docker\.sock/.test(text), `${f} mounts no Docker socket`);
  }
});

test('an edited vendored byte, or a file that is not pinned, is caught', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'ro-pin-'));
  try {
    for (const f of ['web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css', 'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js', 'web/src/run-observability/run-observability.sha256', 'server/src/runObservability.js']) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(tmp, f));
    }
    assert.deepEqual(checkPin(tmp), [], 'a clean copy passes');
    fs.appendFileSync(path.join(tmp, 'server/src/runObservability.js'), '// edited\n');
    assert.ok(checkPin(tmp).length > 0, 'an edited core fails');
    fs.copyFileSync(path.join(root, 'server/src/runObservability.js'), path.join(tmp, 'server/src/runObservability.js'));
    fs.writeFileSync(path.join(tmp, 'web/src/run-observability/extra.js'), 'export {};\n');
    assert.ok(checkPin(tmp).length > 0, 'an unpinned file beside the vendored ones fails');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
