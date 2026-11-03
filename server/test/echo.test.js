// A credential the visitor types must come back in NO response field, hop pane, audit entry, recording, log line or error: tested by typing every credential shape
// into every string and every key of every action, on a fresh workspace each, and searching every answer, the state afterwards and the process output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, act, get, post, withServer, W } from './helpers.js';
import { createWorkspaces } from '../src/workspaces.js';
import { OP_NAMES } from '../src/actions.js';
import { SECRETS } from './secrets.js';

const PROBE = (k, v) => (k === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : k === 'bearer' ? 'tokenvalue' : k === 'assignment' ? 'hunter2hunter2' : ({ plainIs: 'hunter2xyz', pwColon: 'Hunter2Secret', passEq: 'Tr0ub4dor', userinfo: 'hunter2@', tokenWord: ['abcdef12', '34567890zz'].join(''), accountKey: ['abcd', 'EFGH1234'].join(''), sessionId: '00D5g000008dkQz' })[k] || v);
const NEEDLES = Object.entries(SECRETS).map(([k, v]) => ({ k, raw: v, probe: PROBE(k, v) }));
const ZW = [...SECRETS.github].join('​');
NEEDLES.push({ k: 'zeroWidthGithub', raw: ZW, probe: SECRETS.github.slice(4, 16) });
NEEDLES.push({ k: 'filler', raw: `${'x '.repeat(9995)}${SECRETS.github}`, probe: SECRETS.github.slice(4, 16) }); // the secret sits after 19,990 characters
// The same shapes typed percent-encoded and double-encoded (a masker that only sees "%20" would let them through).
for (const k of ['plainIs', 'pwColon', 'userinfo', 'tokenWord', 'github', 'passEq']) {
  const v = SECRETS[k]; const pr = PROBE(k, v);
  NEEDLES.push({ k: `${k}Enc`, raw: encodeURIComponent(v), probe: pr, also: [encodeURIComponent(pr).slice(0, 14)] });
  NEEDLES.push({ k: `${k}Enc2`, raw: encodeURIComponent(encodeURIComponent(v)), probe: pr, also: [encodeURIComponent(encodeURIComponent(pr)).slice(0, 14)] });
}
const SHAPES = ['github', 'jwt', 'pem', 'bearer', 'plainIs', 'userinfo', 'hex', 'zeroWidthGithub', 'filler', 'plainIsEnc', 'plainIsEnc2', 'userinfoEnc', 'githubEnc', 'githubEnc2'];
const strip = (t) => t.replace(/[​-‏⁠﻿­]/g, '');

import { SKEL, variants } from './skeleton.js';

test('every action is covered by a skeleton (a new action must be added to the echo test)', () => assert.deepEqual(Object.keys(SKEL).sort(), [...OP_NAMES].sort()));

test('typing every credential shape into every string and every key of every action never echoes it: answers, hops, state afterwards, process output', { timeout: 3_600_000 }, async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  await withServer(async (url) => {
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      let n = 0;
      for (const nd of NEEDLES) {
        const full = SHAPES.includes(nd.k);
        for (const op of OP_NAMES) {
          const all = [...variants(SKEL[op], nd.raw)];
          for (const body of full ? all : [all[all.length - 1]]) { // the main shapes in every position; the others with every string replaced at once
            const ws = `echo-${n++}`;
            const r = await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params: body }, W(ws));
            const t = strip(`${await r.text()} ${[...r.headers.values()].join(' ')}`);
            assert.ok(!t.includes(nd.probe), `${nd.k} via ${op}: the raw value is in the answer: ${t.slice(0, 120)}`);
            for (const x of nd.also || []) assert.ok(!t.includes(x), `${nd.k} via ${op}: the encoded value is in the answer`);
            if (n % 7 === 0) { const st = strip(await (await get(url, '/api/state?mode=live', W(ws))).text()); assert.ok(!st.includes(nd.probe), `${nd.k} via ${op}: in the state`); }
          }
        }
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  }, { workspaces: createWorkspaces({ max: 100000 }) });
  for (const nd of NEEDLES) assert.ok(!strip(out.join('')).includes(nd.probe), `${nd.k}: nothing was logged`);
});

test('a credential in a REAL, accepted request is masked in the answer, the hops, the audit trail, the proposal, the recording and the state', async () => {
  await withServer(async (url) => {
    for (const nd of NEEDLES.filter((x) => SHAPES.includes(x.k) || x.k === 'google')) {
      const ws = `real-${nd.k}`.toLowerCase().slice(0, 30);
      await act(url, 'setSessionLogging', { actor: C.castAdmin, enabled: true }, ws);
      const reqs = [
        await act(url, 'propose', { actor: C.castUser, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'none', note: `please ${nd.raw} thanks` }, ws),
        await act(url, 'decide', { actor: C.castAdmin2, proposalId: 'prop-0001', decision: 'deny', revision: 1, reason: `no ${nd.raw}` }, ws),
        await act(url, 'oauthRegister', { clientName: `app ${nd.raw}`, redirectUris: [`https://agent.${C.castHost}.example/callback`] }, ws),
        await act(url, 'mcp', { user: C.castUser, target: { kind: 'app', id: C.castApp1 }, rpc: { method: 'tools/call', params: { name: 'search', arguments: { query: `find ${nd.raw}` } } } }, ws),
        await act(url, 'mcp', { user: C.castUser, target: { kind: 'app', id: C.castApp1 }, rpc: { method: 'tools/call', params: { name: 'write_record', arguments: { id: 'r-1', note: nd.raw } } } }, ws),
      ];
      for (const r of reqs) assert.ok(!strip(JSON.stringify(r.body)).includes(nd.probe), `${nd.k}: not in an answer`);
      if (nd.k !== 'filler') assert.match(JSON.stringify(reqs[0].body.state.creation.proposals[0]), /\[masked:/, `${nd.k}: the stored note shows the mask`);
      const st = strip(JSON.stringify((await (await get(url, '/api/state?mode=live', W(ws))).json())));
      assert.ok(!st.includes(nd.probe), `${nd.k}: not in the state`);
      if (nd.k !== 'filler') assert.ok(reqs[3].status === 200 && reqs[3].body.state.recordings.shown.length === 1, 'the invocation was recorded, with its arguments masked');
      if (nd.k !== 'filler') assert.match(JSON.stringify(reqs[3].body.state.recordings.shown[0].arguments), /\[masked:/);
    }
  }, { workspaces: createWorkspaces({ max: 1000 }) });
});

test('a credential in an OpenAPI document (a name, an operationId, a summary, a parameter, a server URL, an enum, a title) is masked in the tools, the schema and the state', async () => {
  await withServer(async (url) => {
    for (const nd of NEEDLES.filter((x) => SHAPES.includes(x.k) && x.k !== 'filler' && x.k !== 'zeroWidthGithub' && x.k !== 'pem')) {
      const v = nd.raw;
      const s = { openapi: '3.0.3', info: { title: `t ${v}`, version: v, description: v }, servers: [{ url: `https://u:${v}@x.example` }], components: { securitySchemes: { [v]: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }, schemas: { A: { type: 'object', description: v, properties: { [v]: { type: 'string', enum: [v], description: v } } } } },
        paths: { [`/${v}`]: { get: { operationId: v, summary: v, description: v, parameters: [{ name: v, in: 'query', description: v, schema: { type: 'string', enum: [v] } }], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } };
      const ws = `oa-${nd.k}`.toLowerCase().slice(0, 30);
      for (const op of ['oaPreview', 'oaDeploy']) {
        const r = await act(url, op, { actor: C.castAdmin, name: 'invoices', spec: JSON.stringify(s) }, ws);
        assert.ok(!strip(JSON.stringify(r.body)).includes(nd.probe), `${nd.k} ${op}: ${JSON.stringify(r.body).slice(0, 160)}`);
      }
      assert.ok(!strip(await (await get(url, '/api/state?mode=live', W(ws))).text()).includes(nd.probe), `${nd.k}: state`);
    }
  }, { workspaces: createWorkspaces({ max: 1000 }) });
});

// Review finding: the names INSIDE a specification (an apiKey header name, an operationId, a parameter, a property, a required entry, a scheme key) were turned into
// identifiers BEFORE they were checked, so "password: hunter2" became "password__hunter2" and a 32-character header name was stored and shown as typed.
test('a credential typed as a NAME inside an OpenAPI document (header name, operationId, parameter, property, required entry, scheme key) is refused or masked: answers and live state', async () => {
  const positions = {
    headerName: (v) => ({ components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: v } } }, paths: { '/items': { get: { operationId: 'listAll' } } } }),
    schemeKey: (v) => ({ components: { securitySchemes: { [v]: { type: 'http', scheme: 'bearer' } } }, paths: { '/items': { get: { operationId: 'listAll' } } } }),
    operationId: (v) => ({ paths: { '/items': { get: { operationId: v } } } }),
    queryParam: (v) => ({ paths: { '/items': { get: { operationId: 'listAll', parameters: [{ name: v, in: 'query' }] } } } }),
    pathParam: (v) => ({ paths: { [`/items/{${v}}`]: { get: { operationId: 'getOne', parameters: [{ name: v, in: 'path', required: true }] } } } }),
    propertyAndRequired: (v) => ({ paths: { '/items': { post: { operationId: 'make', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { [v]: { type: 'string' } }, required: [v] } } } } } } } }),
  };
  const shapes = NEEDLES.filter((x) => (SHAPES.includes(x.k) || ['pwColon', 'passEq', 'hex', 'tokenWord'].includes(x.k)) && x.k !== 'filler' && x.k !== 'pem' && x.raw.length < 200);
  shapes.push({ k: 'hex40', raw: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', probe: 'a1b2c3d4e5f6' }, { k: 'pwHunter', raw: ['password', ': hunter2'].join(''), probe: 'hunter2' });
  await withServer(async (url) => {
    for (const nd of shapes) for (const [pos, build] of Object.entries(positions)) {
      const doc = JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1' }, ...build(nd.raw) });
      const ws = `nm-${nd.k}-${pos}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
      for (const op of ['oaPreview', 'oaDeploy']) {
        const r = await act(url, op, op === 'oaPreview' ? { spec: doc } : { actor: C.castAdmin, name: 'invoices', spec: doc }, ws);
        assert.ok(!strip(JSON.stringify(r.body)).includes(nd.probe), `${nd.k} ${pos} ${op}: ${JSON.stringify(r.body).slice(0, 200)}`);
      }
      assert.ok(!strip(await (await get(url, '/api/state?mode=live', W(ws))).text()).includes(nd.probe), `${nd.k} ${pos}: state`);
    }
  }, { workspaces: createWorkspaces({ max: 1000 }) });
});

test('field names are not echoed either: an unknown key that is itself a credential never comes back, from any action', async () => {
  await withServer(async (url) => {
    for (const nd of NEEDLES.filter((x) => SHAPES.includes(x.k))) for (const op of ['mcp', 'setPolicy', 'propose', 'oauthToken', 'oaDeploy', 'cimdSet']) {
      const r = await post(url, `/api/act/${op}`, { mode: 'live', params: { ...SKEL[op], [nd.raw]: 1 } }); const t = strip(await r.text());
      assert.equal(r.status, 400, `${op}`); assert.ok(!t.includes(nd.probe), `${nd.k} ${op}`);
      const top = await post(url, `/api/act/${op}`, { mode: 'live', [nd.raw]: 1, params: SKEL[op] }); assert.ok(!strip(await top.text()).includes(nd.probe));
    }
  }, { workspaces: createWorkspaces({ max: 1000 }) });
});

test('plain-language and URL-userinfo credentials in a header (X-Workspace, traceparent) and a query string never come back', async () => {
  await withServer(async (url) => {
    for (const nd of NEEDLES.filter((x) => SHAPES.includes(x.k) && !/[\r\n​]/.test(x.raw) && x.raw.length < 200)) {
      const enc = encodeURIComponent(nd.raw);
      for (const p of [`/api/state?mode=${enc}`, `/api/state?mode=live&vertical=${enc}&scenario=${enc}`, `/api/story?vertical=${enc}`, `/api/diagram?name=${enc}`, `/api/health?x=${enc}`]) { const t = strip(await (await get(url, p)).text()); assert.ok(!t.includes(nd.probe), `${nd.k} ${p.slice(0, 30)}`); }
      const h = nd.raw.replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
      for (const headers of [{ 'x-workspace': h }, { traceparent: h }, { origin: `http://${h.replace(/\s/g, '')}`, 'x-workspace': 'ok' }]) {
        try { const r = await post(url, '/api/act/advance', { mode: 'live', params: { minutes: 1 } }, headers); assert.ok(!strip(await r.text()).includes(nd.probe), `${nd.k} header`); } catch { /* an invalid header value: the client refused before sending */ }
      }
    }
  }, { workspaces: createWorkspaces({ max: 1000 }) });
});
