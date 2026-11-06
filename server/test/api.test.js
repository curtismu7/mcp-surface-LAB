import test from 'node:test';
import assert from 'node:assert/strict';
import { A, A1, AGG, C, U, act, get, json, post, rawHttp, withServer, W } from './helpers.js';
import { installNetguard } from '../src/netguard.js';
import { createWorkspaces } from '../src/workspaces.js';

const guard = installNetguard();

test('health, info and story answer; the story fills every token for every vertical', async () => {
  await withServer(async (url) => {
    const h = await json(await get(url, '/api/health'));
    assert.equal(h.schema, 'demo-health/1'); assert.equal(h.demo.id, 'mcp-surface-lab'); assert.equal(h.runtime, 'offline');
    const info = await json(await get(url, '/api/info'));
    assert.deepEqual([info.simulated, info.unverified, info.release], [true, true, '2026-11-02']);
    for (const v of ['finance', 'health', 'retail']) {
      const s = await json(await get(url, `/api/story?vertical=${v}`));
      assert.ok(!/\{\{/.test(JSON.stringify(s)), v); assert.equal(s.vertical, v); assert.equal(s.scenarios.length, 8);
    }
    // N1: a vertical the lab does not have is a 400 on a GET as it is on a POST (it used to fall back to the default and answer 200)
    for (const bad of ['__proto__', 'junk', 'constructor', 'FINANCE']) { const r = await get(url, `/api/story?vertical=${bad}`); assert.equal(r.status, 400, bad); assert.equal((await r.json()).error, 'bad_vertical'); }
    const twice = await get(url, '/api/story?vertical=finance&vertical=health'); assert.equal(twice.status, 400, 'a repeated query value is not a vertical');
    assert.equal((await get(url, '/api/state?mode=mock&vertical=junk')).status, 400); assert.equal((await get(url, '/api/state?mode=live&vertical=junk')).status, 400);
    assert.equal((await get(url, '/api/diagram?vertical=junk')).status, 400);
    assert.equal((await get(url, '/api/story')).status, 200, 'no vertical = the default'); assert.equal((await json(await get(url, '/api/story'))).vertical, 'finance');
    assert.equal((await get(url, '/api/health', {})).headers.get('cache-control'), 'no-store');
    assert.equal((await post(url, '/api/health', {})).status, 405);
  });
});

test('rule 19: POST /api/mode {source} switches the server-side mode at runtime; /api/info follows; the body must be exactly {source}', async () => {
  await withServer(async (url) => {
    const before = await json(await get(url, '/api/info'));
    assert.equal(before.realAvailable, true);
    const toReal = await post(url, '/api/mode', { source: 'real' });
    assert.equal(toReal.status, 200);
    const afterReal = await json(await get(url, '/api/info'));
    assert.equal(afterReal.source, 'real'); assert.equal(afterReal.mode, 'live'); assert.equal(afterReal.realAvailable, true); assert.equal(afterReal.realReason, null);
    const toMock = await post(url, '/api/mode', { source: 'mock' });
    assert.equal(toMock.status, 200);
    const afterMock = await json(await get(url, '/api/info'));
    assert.equal(afterMock.source, 'mock'); assert.equal(afterMock.mode, 'mock');
    for (const body of [{ source: 'mock', extra: 1 }, { source: 'zzz-secret-value' }, {}, 'x', [1]]) {
      const r = await post(url, '/api/mode', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(!(await r.text()).includes('zzz-secret-value'));
    }
  });
});

test('the state: Mock gives a generated scenario, Live gives the workspace engine, both the same shape', async () => {
  await withServer(async (url) => {
    const m = await json(await get(url, '/api/state?mode=mock&vertical=finance&scenario=catalog'));
    const l = await json(await get(url, '/api/state?mode=live&vertical=finance'));
    assert.equal(m.scenario.id, 'catalog'); assert.equal(m.scenarios.length, 8); assert.equal(m.state.catalog.deployments.length, 2);
    assert.deepEqual(Object.keys(m.state).sort(), Object.keys(l.state).sort(), 'one shape for both');
    assert.equal(l.state.catalog.deployments.length, 0);
    assert.equal((await json(await get(url, '/api/state?mode=mock&scenario=nope'))).scenario.id, 'aggregate-cap', 'an unknown scenario falls back');
    assert.equal((await get(url, '/api/state?mode=prod')).status, 400); assert.equal((await get(url, '/api/state')).status, 400);
    assert.equal((await get(url, '/api/state?mode=live', W('Bad Id'))).status, 400);
  });
});

test('Mock is read-only: every action but the pure OpenAPI preview is refused with 409 and changes nothing; the preview runs the same parser', async () => {
  await withServer(async (url) => {
    for (const op of ['mcp', 'advance', 'setPolicy', 'oaDeploy', 'passThrough', 'catDeploy', 'oauthRegister', 'propose', 'decide', 'sessionOpen', 'setFault']) {
      const r = await post(url, `/api/act/${op}`, { mode: 'mock', vertical: 'finance', params: {} }); assert.equal(r.status, 409, op); assert.equal((await r.json()).error, 'mock_is_read_only');
    }
    const spec = (await json(await get(url, '/api/story?vertical=finance'))).sampleSpec;
    const p = await post(url, '/api/act/oaPreview', { mode: 'mock', vertical: 'finance', params: { spec } }); const b = await p.json();
    assert.equal(p.status, 200); assert.equal(b.result.tools.length, 4); assert.equal(b.state, undefined, 'a Mock answer carries no engine state');
    const bad = await post(url, '/api/act/oaPreview', { mode: 'mock', vertical: 'finance', params: { spec: 'openapi: 3' } }); assert.equal(bad.status, 400);
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.apps.length, 5);
  });
});

test('actions need a mode, an object body, only known top-level keys, a known action name; honest statuses for every refusal', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/act/advance', { vertical: 'finance', params: { minutes: 1 } })).status, 400);
    assert.equal((await post(url, '/api/act/advance', { mode: 'prod', params: { minutes: 1 } })).status, 400);
    assert.equal((await post(url, '/api/act/advance', [1])).status, 400);
    const unk = await post(url, '/api/act/advance', { mode: 'live', params: { minutes: 1 }, token: 'x' }); assert.equal(unk.status, 400); assert.equal((await unk.json()).error, 'unknown_field');
    for (const op of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal((await post(url, `/api/act/${op}`, { mode: 'live', params: {} })).status, 404, op);
    const bad = await act(url, 'advance', { minutes: 0 }); assert.equal(bad.status, 400); assert.equal(bad.body.error, 'bad_clock');
    const miss = await act(url, 'mcp', {}); assert.equal(miss.status, 400);
    assert.equal((await act(url, 'setPolicy', { actor: U, appId: A1, grants: [] })).status, 403);
    assert.equal((await act(url, 'mcp', { user: U, target: { kind: 'app', id: 'nope' }, rpc: { method: 'ping' } })).status, 404);
    assert.equal((await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: { name: `${C.castApp2}__create_item`, arguments: { name: 'x' } } } })).status, 403);
  });
});

test('a refused call carries the JSON-RPC error, the enforcement point and the wire form beside the honest HTTP status', async () => {
  await withServer(async (url) => {
    const r = await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: { name: `${C.castApp2}__create_item`, arguments: { name: 'x' } } } });
    assert.equal(r.status, 403); assert.equal(r.body.ok, false); assert.equal(r.body.error, 'access_denied');
    assert.equal(r.body.data.rpc.error.code, -32600); assert.equal(r.body.data.wire.httpStatus, 200); assert.equal(r.body.data.enforcedAt, 'aggregate');
    assert.ok(r.body.hops.length >= 3); assert.ok(r.body.state.audit.shown.some((x) => x.kind === 'mcp.refused'));
  });
});

test('every Live answer carries one trace: a W3C traceparent on every hop and in the response header; the lab always starts its own trace and never echoes a caller-sent id', async () => {
  await withServer(async (url) => {
    const tp = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const r = await post(url, '/api/act/mcp', { mode: 'live', vertical: 'finance', params: { user: U, target: { kind: 'app', id: A1 }, rpc: { method: 'tools/list' } } }, { traceparent: tp });
    const b = await r.json();
    assert.match(b.traceId, /^[0-9a-f]{32}$/); assert.notEqual(b.traceId, 'a'.repeat(32), 'a caller-sent trace id is never continued');
    assert.match(r.headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/); assert.ok(!r.headers.get('traceparent').includes('a'.repeat(32)));
    assert.match(b.hops[0].request.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/); assert.ok(b.hops.length >= 4);
    assert.ok(b.hops.every((h) => !JSON.stringify(h).includes('a'.repeat(32))));
    assert.deepEqual(b.hops.map((h) => h.n), b.hops.map((_, i) => i + 1));
    for (const bad of ['garbage', `00-${'f'.repeat(32)}-${'1'.repeat(16)}-01`]) { const r2 = await post(url, '/api/act/mcp', { mode: 'live', vertical: 'finance', params: { user: U, target: { kind: 'app', id: A1 }, rpc: { method: 'tools/list' } } }, { traceparent: bad }); const b2 = await r2.json(); assert.match(b2.traceId, /^[0-9a-f]{32}$/); assert.ok(!JSON.stringify(b2).includes('f'.repeat(32))); }
  });
});

test('workspaces: one visitor\'s state and Reset never touch another\'s; a bad id is refused; a NEW workspace at the cap is refused (503), never made by evicting another', async () => {
  const workspaces = createWorkspaces({ max: 3 });
  await withServer(async (url) => {
    await act(url, 'advance', { minutes: 5 }, 'w-a'); await act(url, 'advance', { minutes: 7 }, 'w-b');
    const clock = async (w) => (await json(await get(url, '/api/state?mode=live', W(w)))).state.clockSeconds;
    assert.deepEqual([await clock('w-a'), await clock('w-b')], [300, 420]);
    assert.equal((await post(url, '/api/reset', {}, W('w-a'))).status, 200);
    assert.deepEqual([await clock('w-a'), await clock('w-b')], [0, 420]);
    await act(url, 'advance', { minutes: 1 }, 'w-a'); await act(url, 'advance', { minutes: 1 }, 'w-c');
    const full = await act(url, 'advance', { minutes: 1 }, 'w-d'); assert.equal(full.status, 503); assert.equal(full.body.error, 'workspace_limit');
    assert.equal(await clock('w-b'), 420, 'the existing workspaces are untouched');
    assert.equal(workspaces.size(), 3);
    await post(url, '/api/reset', {}, W('w-c')); assert.equal((await act(url, 'advance', { minutes: 1 }, 'w-d')).status, 200);
  }, { workspaces });
});

test('safety: a non-loopback Host and a cross-origin write are refused; the answer never echoes either', async () => {
  await withServer(async (url) => {
    const h = new URL(url).host;
    const bad = await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example.invalid' } }); assert.equal(bad.status, 403);
    const cross = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host: h, origin: 'http://evil.example.invalid', 'content-type': 'application/json' }, body: '{"mode":"live","params":{"minutes":1}}' }); assert.equal(cross.status, 403);
    const site = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host: h, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{"mode":"live","params":{"minutes":1}}' }); assert.equal(site.status, 403);
    assert.ok(!bad.text.includes('evil') && !cross.text.includes('evil'));
  });
});

test('bodies: an oversize body is 413, invalid JSON is a fixed 400, and a deeply nested body does not crash the server', async () => {
  await withServer(async (url) => {
    const big = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host: new URL(url).host, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'live', params: { x: 'a'.repeat(70000) } }) });
    assert.equal(big.status, 413); assert.deepEqual(JSON.parse(big.text), { error: 'payload_too_large' });
    const bad = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host: new URL(url).host, origin: url, 'content-type': 'application/json' }, body: '{nope' }); assert.equal(bad.status, 400); assert.deepEqual(JSON.parse(bad.text), { error: 'bad_request' });
    const deep = `${'{"a":'.repeat(2000)}1${'}'.repeat(2000)}`;
    const r = await rawHttp(`${url}/api/act/advance`, { method: 'POST', headers: { host: new URL(url).host, origin: url, 'content-type': 'application/json' }, body: `{"mode":"live","params":${deep}}` });
    assert.ok([400, 413].includes(r.status), String(r.status));
    assert.equal((await get(url, '/api/health')).status, 200, 'still serving');
  });
});

test('parallel requests are serialised per workspace: ten simultaneous identical proposals give exactly one, ten simultaneous approvals give exactly one', async () => {
  await withServer(async (url) => {
    const mk = () => act(url, 'propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'none' }, 'par');
    const rs = await Promise.all(Array.from({ length: 10 }, mk));
    assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 9);
    const ds = await Promise.all(Array.from({ length: 10 }, (_, i) => act(url, 'decide', { actor: i % 2 ? C.castAdmin : C.castAdmin2, proposalId: 'prop-0001', decision: 'approve', revision: 1 }, 'par')));
    assert.equal(ds.filter((r) => r.status === 200).length, 1);
    const st = (await json(await get(url, '/api/state?mode=live', W('par')))).state;
    assert.equal(st.apps.filter((a) => a.id === 'helpdesk').length, 1); assert.equal(st.audit.shown.filter((x) => x.kind === 'proposal.approved').length, 1);
    // parallel connects: many simultaneous first calls to one member connect it once
    const calls = await Promise.all(Array.from({ length: 10 }, () => act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: { name: `${A1}__search`, arguments: { query: 'q' } } } }, 'par')));
    assert.ok(calls.every((c) => c.status === 200));
    assert.equal((await json(await get(url, '/api/state?mode=live', W('par')))).state.aggregates[0].members[0].connection.connects, 1);
  });
});

test('the netguard recorded zero outbound attempts across the whole API in both modes', async () => {
  const before = guard.attempts.length;
  await withServer(async (url) => {
    for (const mode of ['mock', 'live']) { await get(url, `/api/state?mode=${mode}`); await get(url, '/api/story'); await get(url, '/api/diagram?name=aggregate-cap'); }
    const spec = (await json(await get(url, '/api/story'))).sampleSpec;
    for (const [op, p] of [['oaPreview', { spec }], ['oaDeploy', { actor: A, name: 'invoices', spec }], ['passThrough', { user: U, appId: C.castApp2 }], ['cimdResolve', { clientId: `https://agent.${C.castHost}.example/client.json` }], ['catDeploy', { actor: A, entryId: 'kb-search', name: 'kb' }]]) await act(url, op, p);
    await act(url, 'setAuth', { actor: A, appId: C.castApp2, authMode: 'token-pass' }); await act(url, 'passThrough', { user: U, appId: C.castApp2, defect: 'untrusted-issuer' });
    await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/list' } });
  });
  assert.equal(guard.attempts.length, before, `outbound attempts: ${guard.attempts.slice(before).join(', ')}`);
});

test('the diagram endpoint serves the three diagram-studio/1 diagrams by name, refuses an unknown name (400), and fills the cast', async () => {
  await withServer(async (url) => {
    for (const n of ['aggregate-cap', 'discovery-filter', 'passthrough-assertion']) { const d = await json(await get(url, `/api/diagram?name=${n}&vertical=health`)); assert.equal(d.name, n); assert.ok(!/\{\{/.test(JSON.stringify(d))); assert.ok(d.steps.length >= 7); }
    for (const bad of ['__proto__', 'junk', '']) { const r = await get(url, `/api/diagram?name=${bad}`); assert.equal(r.status, 400, `name=${bad}`); assert.equal((await r.json()).error, 'bad_diagram'); }
    assert.equal((await json(await get(url, '/api/diagram'))).name, 'aggregate-cap', 'no name = the first diagram');
  });
});

test('request-shape statuses: a known route with the wrong method is 405, a non-JSON body is 415, an unknown vertical is 400; none echoes the input (review fix)', async () => {
  await withServer(async (url) => {
    const secretLike = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    for (const [method, p, allow] of [['GET', '/api/act/mcp', 'POST'], ['GET', '/api/act/advance', 'POST'], ['PUT', '/api/state', 'GET, HEAD'], ['POST', '/api/state', 'GET, HEAD'], ['GET', '/api/reset', 'POST'], ['DELETE', '/api/story', 'GET, HEAD']]) {
      const r = await fetch(`${url}${p}`, { method, headers: { origin: url } });
      assert.equal(r.status, 405, `${method} ${p}`); assert.equal(r.headers.get('allow'), allow); assert.deepEqual(await r.json(), { error: 'method_not_allowed' });
    }
    assert.equal((await get(url, '/api/nothing-here')).status, 404, 'an unknown route stays a 404');
    assert.equal((await fetch(`${url}/api/act/${secretLike}`, { method: 'GET' })).status, 404, 'an unknown action is a 404 and the path is not echoed');
    const text = await fetch(`${url}/api/act/advance`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: url }, body: JSON.stringify({ mode: 'live', params: { minutes: 1 } }) });
    assert.equal(text.status, 415); assert.equal((await text.json()).error, 'unsupported_media_type');
    for (const vertical of ['nope', secretLike, 5, null, {}]) {
      const r = await post(url, '/api/act/advance', { mode: 'live', vertical, params: { minutes: 1 } }, W('vert-check'));
      const t = await r.text();
      assert.equal(r.status, 400, String(vertical)); assert.equal(JSON.parse(t).error, 'bad_vertical'); assert.ok(!t.includes(secretLike));
    }
    for (const vertical of ['finance', 'health', 'retail', undefined]) assert.equal((await post(url, '/api/act/advance', { mode: 'live', vertical, params: { minutes: 1 } }, W('vert-ok'))).status, 200, String(vertical));
  });
});

test('GET /api/shelf answers the shelf URL (null when unconfigured)', async () => {
  await withServer(async (url) => {
    const res = await fetch(`${url}/api/shelf`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['shelfUrl']);
    assert.equal(body.shelfUrl, null);
  }, { env: {} });
});
