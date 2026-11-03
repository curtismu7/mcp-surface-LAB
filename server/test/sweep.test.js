// The final check (builder brief, lesson 1) on a MODEST SAMPLE of the shared-masker corpus (owner: it is a demo, no load testing): 60 leak probes (45 text, 15 structured),
// evenly spaced through the corpus so every family and encoding is met, are typed into the free-text fields, keys, path segments, queries, headers and error-path inputs of
// the HTTP API. Each secret must be in no answer (body strings and keys, headers), in the follow-up state, and in nothing written to stdout or stderr.
// The first 6 text probes also go into EVERY string leaf of EVERY action at once (SKEL). The whole corpus is run through the adapters by corpus.test.js (in process, no HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, rawHttp, withServer, W } from './helpers.js';
import { createWorkspaces } from '../src/workspaces.js';
import { OP_NAMES } from '../src/actions.js';
import { SKEL, variants } from './skeleton.js';
import { expand, join, leaks } from './corpus-data.js';

const MAX_INPUT = 20000; // the body limit is 64 kB: a row with a long filler is covered by the adapter test
const pick = (arr, n) => arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]);
const all = leaks.filter((r) => expand(r).length <= MAX_INPUT).map((r) => ({ id: r.id, family: r.family, enc: r.enc, deep: r.api === 'deep', input: r.api === 'deep' ? join(r.input) : expand(r), secret: join(r.secret) }));
const N_TEXT = 45; const N_DEEP = 15; const N_ALL_LEAVES = 6;
const textRows = pick(all.filter((r) => !r.deep), N_TEXT);
const deepRows = pick(all.filter((r) => r.deep), N_DEEP);
const rows = [...textRows, ...deepRows];
const representative = pick(textRows, N_ALL_LEAVES);

// Every string and every key of an answer, plus the raw text and the headers.
function seen(text, headers) {
  const parts = [text, ...[...headers].map(([k, v]) => `${k}: ${v}`)];
  try { const todo = [JSON.parse(text)]; while (todo.length) { const x = todo.pop(); if (typeof x === 'string') parts.push(x); else if (x && typeof x === 'object') for (const k of Object.keys(x)) { parts.push(k); todo.push(x[k]); } } } catch { /* not JSON */ }
  return parts.join('\n');
}
const wf = (s) => String(s).toWellFormed(); // a lone surrogate cannot be percent-encoded
const printable = (s) => /^[\x20-\x7e]*$/.test(s);

test('sweep: the sample is 45 text probes and 15 structured ones, from at least 8 families', () => {
  assert.equal(textRows.length, 45); assert.equal(deepRows.length, 15); assert.equal(representative.length, 6);
  assert.ok(new Set(rows.map((r) => r.family)).size >= 8, `${new Set(rows.map((r) => r.family)).size} families`);
});

// A secret that is also an ordinary word of the lab's own answers (the role "admin" is in the state) cannot be told from the lab's text: those probes are skipped, and
// they must stay few.
let baseline = '';
test('sweep: probes whose secret is a word the lab itself shows are set aside (at most 3)', async () => {
  await withServer(async (url) => {
    for (const p of ['/api/state?mode=live', '/api/story', '/api/diagram', '/api/info']) { const r = await get(url, p); baseline += `\n${seen(await r.text(), r.headers)}`; }
  });
  const ambiguous = rows.filter((r) => baseline.includes(r.secret));
  assert.ok(ambiguous.length <= 3, `${ambiguous.length}: ${ambiguous.map((r) => r.id).join(' ')}`);
  for (const r of ambiguous) { r.skip = true; }
});

async function sweep(name, fn) {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  const failures = [];
  await withServer(async (url) => {
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      let n = 0;
      const check = (label, text, headers, row) => { if (!row.skip && seen(text, headers).includes(row.secret)) failures.push(`${row.id} ${row.family}/${row.enc} via ${label}`); };
      const state = async (ws, row, label) => { const r = await get(url, '/api/state?mode=live', W(ws)); check(`${label} then state`, await r.text(), r.headers, row); };
      await fn({ url, next: () => `sw-${name}-${n++}`, check, state });
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  }, { workspaces: createWorkspaces({ max: 1_000_000 }) });
  assert.deepEqual(failures, [], `${failures.length} of the typed probes came back:\n${failures.slice(0, 30).join('\n')}`);
  const logged = out.join(''); // nothing typed was logged
  for (const r of rows) if (!r.skip && r.secret.length >= 8 && logged.includes(r.secret)) assert.fail(`${r.id} ${r.family}/${r.enc}: logged`);
}

test('sweep 1: 6 probes typed into every string leaf and key of every action (SKEL, all at once, and one by one for the first 2): answers, hops, state afterwards, process output', { timeout: 600_000 }, async () => {
  await sweep('a', async ({ url, next, check, state }) => {
    for (const [i, row] of representative.entries()) {
      for (const op of OP_NAMES) {
        const forms = [...variants(SKEL[op], row.input)];
        for (const body of i < 2 ? forms : [forms[forms.length - 1]]) {
          const ws = next();
          const r = await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params: body }, W(ws));
          check(`act/${op}`, await r.text(), r.headers, row);
          if (i < 2 || op === 'propose') await state(ws, row, `act/${op}`);
        }
      }
    }
  });
});

test('sweep 2: the 45 text probes typed into the free-text fields (note, reason, client name, tool argument, spec description), a path segment, a query, a header and the error paths', { timeout: 600_000 }, async () => {
  await sweep('b', async ({ url, next, check, state }) => {
    const enc = (s) => encodeURIComponent(wf(s));
    for (const row of textRows) {
      const v = row.input; let ws = next();
      const calls = [
        ['propose note', () => post(url, '/api/act/propose', { mode: 'live', vertical: 'finance', params: { ...SKEL.propose, note: v } }, W(ws))],
        ['decide reason', () => post(url, '/api/act/decide', { mode: 'live', vertical: 'finance', params: { ...SKEL.decide, reason: v } }, W(ws))],
        ['oauthRegister clientName', () => post(url, '/api/act/oauthRegister', { mode: 'live', vertical: 'finance', params: { ...SKEL.oauthRegister, clientName: v } }, W(ws))],
        ['mcp tool argument', () => post(url, '/api/act/mcp', { mode: 'live', vertical: 'finance', params: { ...SKEL.mcp, rpc: { method: 'tools/call', params: { name: 'search', arguments: { query: v } } } } }, W(ws))],
        ['oaPreview description', () => post(url, '/api/act/oaPreview', { mode: 'mock', vertical: 'finance', params: { spec: JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1', description: v }, paths: { '/a': { get: { operationId: 'a', summary: v, description: v } } } }) } })],
        ['unknown params key', () => post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1, [v]: 1 } }, W(ws))],
        ['unknown top-level key', () => post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', [v]: 1, params: { minutes: 1 } }, W(ws))],
        ['unknown vertical and mode', () => post(url, '/api/act/advance', { mode: v, vertical: v, params: { minutes: 1 } }, W(ws))],
        ['query', async () => get(url, `/api/state?mode=${enc(v)}&vertical=${enc(v)}&scenario=${enc(v)}`, W(ws))],
        ['query story diagram', async () => get(url, `/api/diagram?name=${enc(v)}&vertical=${enc(v)}`)],
        ['path segment', async () => get(url, `/api/act/${enc(v)}`)],
        ['path 404', async () => get(url, `/${enc(v)}`)],
      ];
      for (const [label, run] of calls) { const r = await run(); check(label, await r.text(), r.headers, row); }
      await state(ws, row, 'free text');
      if (printable(v) && v.length < 200) { // a header value must be printable ASCII to be sent at all
        for (const headers of [{ 'x-workspace': v }, { traceparent: v }, { 'x-workspace': next(), 'x-probe': v }]) {
          try { const r = await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1 } }, headers); check('header', await r.text(), r.headers, row); } catch { /* an invalid header value: the client refused it before sending */ }
        }
      }
    }
  });
});

test('sweep 3: the 15 structured probes typed as the parameters, as a body key and as a value inside params: the answer, its hops and the state hold no secret', { timeout: 600_000 }, async () => {
  await sweep('c', async ({ url, next, check, state }) => {
    for (const row of deepRows) {
      const value = JSON.parse(row.input); const ws = next();
      for (const [label, body] of [['params', { mode: 'live', vertical: 'finance', params: value }], ['params.note', { mode: 'live', vertical: 'finance', params: { ...SKEL.propose, note: value } }], ['top-level', { mode: 'live', vertical: 'finance', ...(value && typeof value === 'object' ? value : {}), params: { minutes: 1 } }]]) {
        const r = await post(url, '/api/act/propose', body, W(ws)); check(`propose ${label}`, await r.text(), r.headers, row);
        const q = await post(url, '/api/act/oaPreview', { mode: 'mock', vertical: 'finance', params: { spec: JSON.stringify(value) } }); check(`oaPreview ${label}`, await q.text(), q.headers, row);
      }
      await state(ws, row, 'structured');
    }
  });
});
