// "What Privilege did" (Rule 25) for the lab's simulated gateway. This lab has no path to a real gateway (its Real mode is its own local engine), so every
// trace is source 'mock' and every decision 'checked'. The assertions are the honesty rule (assertTrace), that no typed secret is in the record, and that each
// decision is what engine.js really evaluated, in its order. The pin test for the vendored files is scripts/gateway-trace.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrace } from '../src/gatewayTrace.js';
import { SECRETS } from './secrets.js';
import { A, A1, A2N, AGG, C, U, act, withServer } from './helpers.js';

const DIRECT = { kind: 'app', id: A1 };
const call = (url, params, ws = 'gw') => act(url, 'mcp', params, ws);
const tc = (target, name, args = {}, extra = {}) => ({ user: U, target, rpc: { method: 'tools/call', params: { name, arguments: args } }, ...extra });
const ids = (t) => t.decisions.map((d) => `${d.outcome}:${d.id}`);

test('every kind of call gives a trace that satisfies the honesty contract: mock, checked, a reserved host, nothing typed leaks', async () => {
  await withServer(async (url) => {
    const typed = [SECRETS.github, SECRETS.jwt, SECRETS.assignment];
    const cases = [
      { user: U, target: AGG, rpc: { method: 'tools/list' } },
      { user: U, target: AGG, rpc: { method: 'tools/list' }, style: 'gzip-sse' },
      tc(AGG, `${A2N}__create_item`, { name: 'x' }),                    // refused at the aggregate
      tc(AGG, `${A2N}__refund_item`, { id: 'r-1' }),                    // refused at the member hop
      tc(AGG, `${A1}__read_record`, { id: typed[0] }),                  // allowed, with a typed value in the arguments
      tc(AGG, `nobody__x`, { q: typed[1] }),                            // not a member alias
      tc(AGG, 'plain', { q: typed[2] }),                                // not namespaced
      { user: U, target: DIRECT, rpc: { method: 'tools/list' }, style: 'gzip-sse' },
      tc(DIRECT, 'export_all', { note: typed[2] }),                     // a tool outside this caller's policy
      tc(DIRECT, 'not_a_tool'),
      { user: U, target: DIRECT, rpc: { method: 'ping' } },
      { user: U, target: DIRECT, rpc: { method: 'sampling/createMessage' } }, // a method the gateway does not permit
      { as: `${C.castAgent}-llm`, target: DIRECT, rpc: { method: 'tools/list' } }, // a key with no mcp scope
      { as: C.castAgent, target: DIRECT, rpc: { method: 'tools/list' } },
      { as: 'no-such-agent', target: DIRECT, rpc: { method: 'tools/list' } },
    ];
    let n = 0;
    for (const params of cases) {
      const r = await call(url, params, `all-${n++}`);
      const t = r.body.trace;
      assert.ok(t, `a trace for ${JSON.stringify(params.rpc)}`);
      assert.deepEqual(assertTrace(t), [], JSON.stringify(params.rpc));
      assert.equal(t.source, 'mock');
      assert.ok(t.decisions.length > 0 && t.decisions.every((d) => d.basis === 'checked'));
      assert.equal(new URL(t.request.url).hostname, 'gateway.example.invalid');
      assert.equal(t.response.status, r.body.result ? 200 : t.response.status);
      const text = JSON.stringify(t);
      for (const s of typed) assert.ok(!text.includes(s), 'a typed credential is never in the trace');
      assert.ok(!/Bearer eyJ/.test(text) && !/mock-access|mock-refresh/.test(text), 'no token of any kind');
    }
  });
});

test('the aggregate cap, enforced twice: each decision is the one engine.js evaluated, in its order, and the refusing one is the layer that refused', async () => {
  await withServer(async (url) => {
    const atAggregate = (await call(url, tc(AGG, `${A2N}__create_item`, { name: 'x' }))).body.trace;
    assert.deepEqual(ids(atAggregate), ['pass:aggregate.method', 'pass:aggregate.policy', 'pass:aggregate.namespace', 'pass:aggregate.member', 'fail:aggregate.entitlement']);
    assert.equal(atAggregate.response.status, 200); // the aggregate answers a refusal as a JSON-RPC error with HTTP 200 (the engine's measured wire note)
    assert.equal(atAggregate.response.body.error.message.includes('access denied'), true);

    const atMember = (await call(url, tc(AGG, `${A2N}__refund_item`, { id: 'r-1' }))).body.trace;
    const order = ids(atMember);
    assert.deepEqual(order.slice(0, 6), ['pass:aggregate.method', 'pass:aggregate.policy', 'pass:aggregate.namespace', 'pass:aggregate.member', 'pass:aggregate.entitlement', 'pass:aggregate.resolve']);
    assert.deepEqual(order.slice(6), ['pass:member.method', 'pass:member.policy', 'pass:member.target', 'fail:member.entitlement']);

    const ok = (await call(url, tc(AGG, `${A1}__read_record`, { id: 'r-1' }))).body.trace;
    assert.ok(ok.decisions.every((d) => d.outcome === 'pass'));
    assert.deepEqual(ids(ok).slice(-4), ['pass:member.cap', 'pass:member.connect', 'pass:member.credential', 'pass:member.filter']);
    assert.equal(ok.response.body.result.isError, false);
    assert.match(ok.record, /^Audit entry \d+: mcp\.call/);
  });
});

test('a fault switch is shown as a check that was NOT applied (info), never as a pass, and the call that gets through says so', async () => {
  await withServer(async (url) => {
    await act(url, 'setFault', { actor: A, aggregateSkipsCheck: true, hopIgnoresCap: true }, 'gw-f');
    const t = (await call(url, tc(AGG, `${A2N}__create_item`, { name: 'x' }), 'gw-f')).body.trace;
    const d = Object.fromEntries(t.decisions.map((x) => [x.id, x]));
    assert.equal(d['aggregate.entitlement'].outcome, 'info');
    assert.equal(d['member.cap'].outcome, 'info');
    assert.match(d['member.cap'].evidence, /ignores the cap/);
    assert.equal(t.response.status, 200);
    assert.equal(t.response.body.result.isError, false); // it really went through: the trace does not claim "all passed"
  });
});

test('the response in the trace is the answer the agent got: the filtered listing, or a bare 403 with no body', async () => {
  await withServer(async (url) => {
    const list = await call(url, { user: U, target: DIRECT, rpc: { method: 'tools/list' } }, 'gw-r');
    assert.deepEqual(list.body.trace.response.body, list.body.result.rpc);
    assert.ok(list.body.result.rpc.result.tools.length > 0);
    assert.match(list.body.trace.decisions.find((d) => d.id === 'gateway.filter').evidence, /tools: \d+ in the upstream answer, \d+ let through/);
    const denied = await call(url, tc(DIRECT, 'export_all'), 'gw-r');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.trace.response.status, 403);
    assert.equal(denied.body.trace.response.body, null);
    assert.deepEqual(denied.body.trace.response.headers, {});
    assert.equal(denied.body.trace.decisions.at(-1).outcome, 'fail');
  });
});

test('a down application and a revoked key are decisions the simulated gateway made, and show as such', async () => {
  await withServer(async (url) => {
    await act(url, 'setAppUp', { actor: A, appId: A1, up: false }, 'gw-d');
    const down = (await call(url, tc(DIRECT, 'search', { query: 'q' }), 'gw-d')).body.trace;
    assert.equal(down.response.status, 502);
    assert.deepEqual(down.decisions.filter((d) => d.outcome === 'fail').map((d) => d.id), ['gateway.reach']);
    await act(url, 'setAgent', { actor: A, agentId: C.castAgent, enabled: false }, 'gw-d');
    const revoked = (await call(url, { as: C.castAgent, target: DIRECT, rpc: { method: 'tools/list' } }, 'gw-d')).body.trace;
    assert.equal(revoked.response.status, 401);
    assert.deepEqual(ids(revoked), ['fail:agent.key']);
    assert.match(revoked.request.headers.authorization, /agent key of /);
    assert.ok(!revoked.request.headers.authorization.includes('eyJ'));
  });
});

test('only an mcp action in Live mode carries a trace; a refused request that never became a call carries none', async () => {
  await withServer(async (url) => {
    const other = await act(url, 'setFault', { actor: A, aggregateSkipsCheck: false }, 'gw-o');
    assert.equal(other.body.trace, undefined);
    const bad = await call(url, { user: U, target: AGG, rpc: { method: 5 } }, 'gw-o');
    assert.equal(bad.status, 400); assert.equal(bad.body.trace, undefined);
    const unknownTarget = await call(url, { user: U, target: { kind: 'app', id: 'nothing-here' }, rpc: { method: 'tools/list' } }, 'gw-o');
    assert.equal(unknownTarget.body.trace.request.url, 'https://gateway.example.invalid/(unknown path)');
    assert.deepEqual(assertTrace(unknownTarget.body.trace), []);
  });
});
