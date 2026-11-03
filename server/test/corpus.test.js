// The shared-masker corpora (test/corpus, copied from shared-masker 1.4.0) run over the lab's adapters, not over the shared module: a leak must not survive, an
// ordinary string must stay as it is. The adapters are mask.js (maskText, maskDeep), credentials.js (cleanFree, the stored form of visitor text) and util.js (scrub, the hop
// pane and audit form).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFree, tidy } from '../src/credentials.js';
import { looksLikeCredential, maskDeep, maskText } from '../src/mask.js';
import { scrub } from '../src/util.js';
import { expand, join, leaks, ordinary } from './corpus-data.js';

const haystack = (v) => { const out = []; const todo = [v]; while (todo.length) { const x = todo.pop(); if (typeof x === 'string') out.push(x); else if (x && typeof x === 'object') for (const k of Object.keys(x)) { out.push(k); todo.push(x[k]); } } return out.join('\n'); };

test('corpus: the copied files have the shared sizes (3,754 leak probes, 1,926 ordinary strings)', () => {
  assert.equal(leaks.length, 3754); assert.equal(ordinary.length, 1926);
  assert.equal(leaks.filter((r) => r.api === 'deep').length, 338);
});

test('corpus leaks (text): the secret survives in no adapter output: maskText, cleanFree (stored form) and scrub (hop form)', () => {
  const failures = [];
  for (const row of leaks) {
    if (row.api === 'deep') continue;
    const input = expand(row); const secret = join(row.secret);
    if (maskText(input).includes(secret)) failures.push(`${row.id} maskText`);
    else if (!looksLikeCredential(input)) failures.push(`${row.id} looksLikeCredential false`);
    if (cleanFree(input, 1_000_000).includes(secret)) failures.push(`${row.id} cleanFree`);
    if (input.length < 20000 && haystack(scrub({ note: input, list: [input], [input]: 1 })).includes(secret)) failures.push(`${row.id} scrub`);
  }
  assert.deepEqual(failures, [], `${failures.length} failed:\n${failures.slice(0, 30).join('\n')}`);
});

test('corpus leaks (structured): maskDeep and scrub lose the secret and do not mutate the input', () => {
  const failures = [];
  for (const row of leaks.filter((r) => r.api === 'deep')) {
    const value = JSON.parse(join(row.input)); const secret = join(row.secret); const snapshot = JSON.stringify(value);
    if (haystack(maskDeep(value)).includes(secret) || JSON.stringify(maskDeep(value)).includes(secret)) failures.push(`${row.id} maskDeep`);
    if (haystack(scrub(value)).includes(secret) || JSON.stringify(scrub(value)).includes(secret)) failures.push(`${row.id} scrub`);
    if (JSON.stringify(value) !== snapshot) failures.push(`${row.id} mutated`);
  }
  assert.deepEqual(failures, [], `${failures.length} failed:\n${failures.slice(0, 30).join('\n')}`);
});

test('corpus ordinary: every string stays unchanged through maskText, cleanFree (modulo the white space and invisible characters it always tidies) and maskDeep', () => {
  const changed = [];
  for (const row of ordinary) {
    const input = join(row.input);
    if (row.api === 'deep') { const value = JSON.parse(input); assert.deepEqual(maskDeep(value), value, `${row.id} ${input}`); continue; }
    if (maskText(input) !== input) changed.push(`${row.id} maskText ${JSON.stringify(input)} -> ${JSON.stringify(maskText(input))}`);
    if (cleanFree(input, 1_000_000) !== tidy(input, 1_000_000)) changed.push(`${row.id} cleanFree ${JSON.stringify(input)}`);
    if (JSON.stringify(maskDeep({ note: input }).note) !== JSON.stringify(input)) changed.push(`${row.id} maskDeep ${JSON.stringify(input)}`);
  }
  assert.deepEqual(changed, [], `${changed.length} changed:\n${changed.slice(0, 30).join('\n')}`);
});
