// The known sweep leaks of the independent sweep, each with its own test (values are built from fragments at run time). The two request-edge leaks (credential-shaped
// X-Workspace ids, and POST/PUT/DELETE/PATCH on / answering 405) are tests H6 and H2 in hygiene.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { get, post, withServer, W } from './helpers.js';
import { createWorkspaces } from '../src/workspaces.js';
import { cleanFree } from '../src/credentials.js';
import { maskText } from '../src/mask.js';
import { SKEL, variants } from './skeleton.js';
import { OP_NAMES } from '../src/actions.js';

const H = ['hun', 'ter2', 'xyz'].join('');
const enc4 = (s) => { let x = s; for (let i = 0; i < 4; i++) x = encodeURIComponent(x); return x; };
const strings = (text) => { const parts = [text]; try { const todo = [JSON.parse(text)]; while (todo.length) { const x = todo.pop(); if (typeof x === 'string') parts.push(x); else if (x && typeof x === 'object') for (const k of Object.keys(x)) { parts.push(k); todo.push(x[k]); } } } catch { /* not JSON */ } return parts.join('\n'); };

// Types `value` into every string leaf of every action (all at once and one by one), and asserts the secret is in no answer and in no state afterwards.
async function everywhere(value, secret, tag) {
  await withServer(async (url) => {
    let n = 0;
    for (const op of OP_NAMES) {
      for (const body of variants(SKEL[op], value)) {
        const ws = `nl-${tag}-${n++}`;
        const r = await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params: body }, W(ws));
        assert.ok(!strings(await r.text()).includes(secret), `${tag} via ${op}`);
      }
      const ws = `nl-${tag}-s${n++}`;
      await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params: [...variants(SKEL[op], value)].at(-1) }, W(ws));
      assert.ok(!strings(await (await get(url, '/api/state?mode=live', W(ws))).text()).includes(secret), `${tag} via ${op}: state`);
    }
  }, { workspaces: createWorkspaces({ max: 1_000_000 }) });
}

test('leak 1: "login: bob / <secret>" and "password - <secret>" typed into params.spec and every params field come back nowhere', { timeout: 600_000 }, async () => {
  await everywhere(`login: bob / ${H}`, H, 'login');
  await everywhere(`password - ${H}`, H, 'dash');
  await withServer(async (url) => {
    for (const text of [`login: bob / ${H}`, `password - ${H}`]) {
      const asDoc = JSON.stringify({ openapi: '3.0.3', info: { title: 'T', version: '1', description: text }, paths: { '/a': { get: { operationId: 'a', summary: text } } } });
      for (const spec of [text, asDoc, `openapi: 3.0.3\n# ${text}\n`]) {
        for (const op of ['oaPreview', 'oaDeploy']) {
          const r = await post(url, `/api/act/${op}`, { mode: op === 'oaPreview' ? 'mock' : 'live', vertical: 'finance', params: op === 'oaPreview' ? { spec } : { actor: SKEL.oaDeploy.actor, name: 'invoices', spec } }, W('nl-spec'));
          assert.ok(!strings(await r.text()).includes(H), `${op}: ${text.slice(0, 8)}`);
        }
      }
    }
  });
  assert.equal(maskText(`login: bob / ${H}`), '[masked:pair]'); assert.equal(maskText(`password - ${H}`), '[masked:shape]');
});

test('leak 2: access_token=<secret> and DB_PASSWORD=<secret> in the OpenAPI specification text are masked in the tools, the hops and the state', async () => {
  const doc = (text) => JSON.stringify({ openapi: '3.0.3', info: { title: text, version: '1', description: text }, servers: [{ url: 'https://api.fabrikam.example/v1', description: text }], paths: { '/a': { get: { operationId: 'a', summary: text, description: text, parameters: [{ name: 'q', in: 'query', description: text, schema: { type: 'string', description: text, enum: [text] } }] } } } });
  await withServer(async (url) => {
    for (const text of [`access_token=${H}`, `DB_PASSWORD=${H}`, `see access_token=${H} and DB_PASSWORD=${H} here`]) {
      for (const spec of [doc(text), `# ${text}\n${doc('x')}`, text]) {
        const p = await post(url, '/api/act/oaPreview', { mode: 'mock', vertical: 'finance', params: { spec } }); assert.ok(!strings(await p.text()).includes(H), `preview ${text}`);
        const d = await post(url, '/api/act/oaDeploy', { mode: 'live', vertical: 'finance', params: { actor: SKEL.oaDeploy.actor, name: 'invoices', spec } }, W('nl-oa')); assert.ok(!strings(await d.text()).includes(H), `deploy ${text}`);
      }
    }
    assert.ok(!strings(await (await get(url, '/api/state?mode=live', W('nl-oa'))).text()).includes(H), 'state');
  });
  assert.equal(maskText(`access_token=${H}`), '[masked:assignment]'); assert.equal(maskText(`DB_PASSWORD=${H}`), '[masked:assignment]');
});

test('leak 3: a secret percent-encoded four times is masked in every field (the shared masker decodes up to its round limit)', { timeout: 600_000 }, async () => {
  for (const text of [`password=${H}`, `login: bob / ${H}`, `my password is ${H}`]) {
    assert.match(enc4(text), /%25252/, 'really encoded four times');
    assert.ok(!cleanFree(enc4(text)).includes(H), text);
  }
  await everywhere(enc4(`password=${H}`), H, 'enc4a');
  await everywhere(enc4(`login: bob / ${H}`), H, 'enc4b');
});

test('leak 4: hops[].request.body and the object keys inside params are masked (a secret as a value under a credential key, as a key, as a nested key)', async () => {
  await withServer(async (url) => {
    const bodies = [
      { password: H }, { nested: { token: H, list: [{ secret: H }] } }, { [`password=${H}`]: 1 }, { [`login: bob / ${H}`]: { [`token=${H}`]: 2 } }, { name: `pw ${H}` }, { 'access_token': H, user: 'bob', DB_PASSWORD: H },
    ];
    for (const [i, params] of bodies.entries()) {
      const r = await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1, ...params } }, W(`nl-hops-${i}`));
      const body = await r.json();
      assert.ok(Array.isArray(body.hops) && body.hops.length >= 1, 'hops are returned even for a refused request');
      assert.ok(!strings(JSON.stringify(body.hops)).includes(H) && !JSON.stringify(body.hops).includes(H), `body ${i}: hops`);
      assert.ok(!JSON.stringify(body).includes(H), `body ${i}: answer`);
    }
    const r = await (await post(url, '/api/act/advance', { mode: 'live', vertical: 'finance', params: { minutes: 1, password: H } }, W('nl-hops-x'))).json();
    assert.equal(r.hops[0].request.body.password, '[masked:assignment]', 'the first hop shows the key with a masked value');
  });
});

test('leak 5: "The secret is out" is ordinary prose (a false positive of the old masker): unchanged in the adapters and in a stored note', async () => {
  for (const t of ['The secret is out', 'The secret is out.', 'the secret is out, call the team']) { assert.equal(maskText(t), t); assert.equal(cleanFree(t), t); }
  await withServer(async (url) => {
    const r = await post(url, '/api/act/propose', { mode: 'live', vertical: 'finance', params: { ...SKEL.propose, note: 'The secret is out' } }, W('nl-fp'));
    const b = await r.json(); assert.equal(b.result.note, 'The secret is out'); assert.equal(b.hops[0].request.body.note, 'The secret is out');
  });
});
