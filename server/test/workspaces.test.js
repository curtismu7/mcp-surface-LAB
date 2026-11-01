import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_RE, createWorkspaces, workspaceFrom } from '../src/workspaces.js';
import { VERTICALS } from '../src/cast.js';

const C = VERTICALS.finance;
test('workspaceFrom defaults, accepts a good id and refuses a bad one', () => {
  assert.equal(workspaceFrom({ headers: {} }), 'default');
  assert.equal(workspaceFrom({ headers: { 'x-workspace': 'abc-1' } }), 'abc-1');
  for (const bad of ['', 'A', 'a b', 'a/b', 'x'.repeat(41), ['a'], '__proto__', 'a'.repeat(40) === 'x' ? '' : 'deadbeef'.repeat(5)]) assert.equal(workspaceFrom({ headers: { 'x-workspace': bad } }), null, String(bad).slice(0, 12));
  assert.ok(WORKSPACE_RE.test('a'));
});

test('engines are per workspace and per vertical, created on first use, and reset clears the workspace only', () => {
  const w = createWorkspaces();
  const a = w.engine('a', 'finance', C); const a2 = w.engine('a', 'finance', C); const ah = w.engine('a', 'health', VERTICALS.health); const b = w.engine('b', 'finance', C);
  assert.equal(a, a2); assert.notEqual(a, ah); assert.notEqual(a, b);
  assert.equal(w.peek('a', 'finance'), a); assert.equal(w.peek('zzz', 'finance'), null); assert.equal(w.peek('a', 'retail'), null);
  assert.equal(w.size(), 2, 'a peek never creates a workspace');
  w.reset('a');
  assert.equal(w.peek('a', 'finance'), null); assert.equal(w.peek('b', 'finance'), b);
});

test('the store expires old workspaces; a new workspace past the cap is REFUSED (never made by evicting another); expiry and reset free room', () => {
  let t = 0;
  const w = createWorkspaces({ max: 3, ttlMs: 100, now: () => t });
  for (const id of ['a', 'b', 'c']) w.engine(id, 'finance', C);
  assert.throws(() => w.engine('d', 'finance', C), (e) => e.code === 'workspace_limit' && e.status === 503);
  assert.equal(w.size(), 3); assert.ok(w.peek('a', 'finance'), 'nothing was evicted');
  assert.ok(w.engine('a', 'health', VERTICALS.health), 'an existing workspace can still add a vertical at the cap');
  w.reset('b'); w.engine('d', 'finance', C); assert.equal(w.size(), 3);
  t = 500;
  assert.equal(w.peek('d', 'finance'), null); assert.equal(w.size(), 0, 'everything expired');
  w.engine('e', 'finance', C); assert.equal(w.size(), 1);
});

test('a refused or pure request holds no workspace slot; a request that changes something does; the cap is still checked first (review fix)', async () => {
  const { withServer, act, post, W, C: CC } = await import('./helpers.js');
  await withServer(async (url) => {
    // the cap is 3: three requests that are refused or change nothing, then three that do
    assert.equal((await act(url, 'advance', { minutes: 0 }, 'j1')).status, 400);
    assert.equal((await act(url, 'mcp', { user: 'nobody.at.all', target: { kind: 'app', id: CC.castApp1 }, rpc: { method: 'tools/list' } }, 'j2')).status, 400);
    assert.equal((await act(url, 'oaPreview', { spec: 'x' }, 'j3')).status, 400);
    assert.equal((await act(url, 'oaPreview', { spec: JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/a': { get: { operationId: 'a' } } } }) }, 'j4')).status, 200, 'a pure preview in Live');
    for (const id of ['v1', 'v2', 'v3']) assert.equal((await act(url, 'advance', { minutes: 5 }, id)).status, 200, id);
    const full = await act(url, 'advance', { minutes: 5 }, 'v4'); assert.equal(full.status, 503); assert.equal(full.body.error, 'workspace_limit');
    assert.equal((await act(url, 'advance', { minutes: 0 }, 'v5')).status, 503, 'the cap is checked before the work');
    assert.equal((await act(url, 'advance', { minutes: 5 }, 'v1')).status, 200, 'an existing workspace keeps working');
    // a refusal that DOES leave a visible trace (the denial is audited) keeps its workspace, so the next read agrees with what the answer showed
    assert.equal((await post(url, '/api/reset', {}, W('v3'))).status, 200);
    const denied = await act(url, 'mcp', { user: CC.castUser, target: { kind: 'app', id: CC.castApp1 }, rpc: { method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } } }, 'aud1');
    assert.equal(denied.status >= 400, true);
    const st = await (await fetch(`${url}/api/state?mode=live`, { headers: W('aud1') })).json();
    assert.equal(JSON.stringify(st.state) === JSON.stringify(denied.body.state), true, 'what the refusal showed is what is stored');
  }, { workspaces: createWorkspaces({ max: 3 }) });
});
