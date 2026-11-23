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
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

test('every vendored run-observability file matches its pin, and the core is present', () => {
  assert.deepEqual(checkPin(root), []);
});

test('this lab reads no logs: no readers file, no server file names a reader or a RUN_OBS_ setting (comments included), and the core has no imports, no network and no file access', () => {
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')));
  const core = fs.readFileSync(path.join(root, 'server/src/runObservability.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(core), 'the core has no imports');
  assert.ok(!/ElasticsearchReader|DockerLogReader|readersFromEnv|\bfetch\s*\(|node:http|node:fs/.test(core), 'the core names no reader, no network and no file access, not even in a comment');
  // The pinned core is skipped here: its own comment and its "no reader is configured" message name the readers file and RUN_OBS_ settings (it is never edited), and it is checked above.
  for (const f of walk(path.join(root, 'server/src')).filter((p) => p.endsWith('.js') && !p.endsWith('/runObservability.js'))) {
    assert.ok(!READER.test(fs.readFileSync(f, 'utf8')), `${path.relative(root, f)} names no reader and reads no RUN_OBS_ setting`);
  }
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
