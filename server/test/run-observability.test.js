// Rule 27 for this lab: one run per record, the honesty of every row, and the one stdout line per decision. Every row is `simulated`: Mock reads the decisions the engine
// took when the table was generated, Live is the engine acting on the visitor's own calls, and nothing is read from a product log (so every record has source `mock`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine.js';
import { RUN_OPS, isRunOp, perform } from '../src/actions.js';
import { MOCK_TABLE } from '../src/mockTable.js';
import { MAX_RUNS, buildRecord, commitRun, decisionLine, hasDecision, lineValue } from '../src/runObs.js';
import { runAction } from '../src/service.js';
import { createWorkspaces } from '../src/workspaces.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { VERTICALS } from '../src/cast.js';
import { SECRETS } from './secrets.js';
import { A, A1, A2, A2N, AGG, C, U, U2, X, act, callTool, get, mcp, newEngine, ok, run, withServer } from './helpers.js';

const LINE = /^\d{4}-\d\d-\d\dT[\d:]+Z mcp-surface-lab decision check=[A-Za-z0-9._:/@-]+ layer=[a-z]+ actor=\S+ agent=\S+ result=(?:passed|stopped|unclear) run=\S+$/;
const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i;
const DIRECT = { kind: 'app', id: A1 };
const route = { method: 'POST', url: '/api/act/(action)' };
const rec = async (events, runId = 'run-test') => { const r = await buildRecord({ runId, events: events.map((e, i) => ({ ...e, seq: i + 1 })) }); assert.deepEqual(assertRunObservability(r), []); return r; };
const rows = (r) => r.rows.filter((x) => x.origin !== 'not-logged');
const of = (r, layer) => rows(r).filter((x) => x.layer === layer);
const tools = (name, args = {}) => ({ name, arguments: args });
// One action through the service (the path the API takes), with the lines it wrote.
function step(ctx, op, params) {
  const r = runAction({ ws: 'w', workspaces: ctx.workspaces, vertical: 'finance', cast: C, op, params, route, log: (l) => ctx.lines.push(l) });
  return r;
}
const ctx = () => ({ workspaces: createWorkspaces(), lines: [] });
const engineOf = (c) => c.workspaces.peek('w', 'finance');

test('the run actions are exactly the ones that decide something, and the web list says the same', () => {
  assert.deepEqual(RUN_OPS, ['mcp', 'passThrough', 'propose', 'decide']);
  for (const op of ['setPolicy', 'setAuth', 'oaDeploy', 'oauthToken', 'advance', 'oaPreview']) assert.equal(isRunOp(op), false, op);
});

test('a permitted aggregate call: every layer the call crossed has rows, in the order the engine decided them, and nothing but a policy point is `allowed`', async () => {
  const e = newEngine();
  ok(callTool(e, U, AGG, `${A1}__read_record`, { id: 'r-1' }));
  const r = await rec(e.lastRun);
  assert.equal(r.source, 'mock');
  assert.ok(rows(r).length > 0 && r.rows.every((x) => x.origin === 'simulated' || x.origin === 'not-logged'), 'no row is tagged logged or response');
  assert.deepEqual(r.coverage, { person: 'simulated', agent: 'simulated', authorize: 'not-logged', privilege: 'simulated', gateway: 'simulated', resource: 'simulated' });
  assert.match(r.reasons.authorize, /does not model PingOne Authorize/);
  assert.match(of(r, 'person')[0].message, /no sign-in/);
  // privilege = the policy checks (allowed), gateway = the pipeline (information unless it is a policy point), agent = the credential step (an injection is information)
  assert.ok(of(r, 'privilege').length >= 4 && of(r, 'privilege').every((x) => x.outcome === 'allowed'));
  assert.ok(of(r, 'gateway').filter((x) => x.outcome === 'allowed').every((x) => /JSON-RPC method/.test(x.message)), 'only the method check is an allow in the gateway lane');
  assert.ok(of(r, 'agent').every((x) => x.outcome === 'info'), 'a credential injection is information, not an allow');
  assert.ok(of(r, 'resource').length === 1 && of(r, 'resource')[0].outcome === 'info', 'the mock MCP server answering is information');
  assert.equal(r.summary.refused, 0);
  // the rows are the engine's events, in order, one for one, each with the engine's own time
  assert.equal(rows(r).length, e.lastRun.length);
  assert.deepEqual(rows(r).map((x) => x.detail.seq), e.lastRun.map((_, i) => i + 1));
  assert.deepEqual(rows(r).map((x) => x.atExact), e.lastRun.map((x) => x.at), 'the row shows the engine\'s own time text');
  assert.deepEqual(rows(r).map((x) => x.layer), e.lastRun.map((x) => x.layer));
  assert.equal(e.lastRun[0].layer, 'person');
  assert.ok(e.lastRun.findIndex((x) => x.layer === 'resource') > e.lastRun.findIndex((x) => x.check === 'aggregate.entitlement'), 'the server answers after the policy allowed the call');
});

test('the aggregate cap, enforced twice: the refusing layer is `refused`, a fault switch is `info` (never an allow), and nothing after the refusal is invented', async () => {
  const e = newEngine();
  callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  let r = await rec(e.lastRun);
  const atAggregate = rows(r).filter((x) => x.outcome === 'refused');
  assert.deepEqual(atAggregate.map((x) => `${x.layer}:${x.detail.check}`), ['privilege:aggregate.entitlement']);
  assert.deepEqual(of(r, 'resource'), [], 'the member was never asked');
  assert.match(r.reasons.resource, /earlier decision stopped the call/);
  assert.equal(rows(r).at(-1).detail.check, 'aggregate.entitlement', 'the refusal is the last decision');

  callTool(e, U, AGG, `${A2N}__refund_item`, { id: 'r-1' });
  r = await rec(e.lastRun);
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => x.detail.check), ['member.entitlement']);
  assert.ok(rows(r).findIndex((x) => x.detail.check === 'aggregate.entitlement') < rows(r).findIndex((x) => x.detail.check === 'member.entitlement'), 'first enforcement before the second');

  run(e, 'setFault', { actor: A, aggregateSkipsCheck: true, hopIgnoresCap: true });
  ok(callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' }));
  r = await rec(e.lastRun);
  const faults = rows(r).filter((x) => /fault switch/.test(x.message));
  assert.equal(faults.length, 2);
  assert.ok(faults.every((x) => x.outcome === 'info'), 'a check the fault switch skipped is information, never an allow');
  assert.equal(r.summary.refused, 0);
});

test('a call that is not a well-formed request, a revoked key and a member that is down each say who stopped it', async () => {
  const e = newEngine();
  let r = await rec((callTool(e, U, DIRECT, 'not_a_tool'), e.lastRun));
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => `${x.layer}:${x.detail.check}`), ['gateway:gateway.target']);
  r = await rec((mcp(e, U, DIRECT, 'sampling/createMessage'), e.lastRun));
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => x.detail.check), ['gateway.method']);
  r = await rec((callTool(e, X, DIRECT, 'search'), e.lastRun));
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => `${x.layer}:${x.detail.check}`), ['privilege:gateway.policy']);
  // a key with no mcp grant, and a revoked one: the agent lane, a policy point
  perform(e, 'mcp', { as: `${C.castAgent}-llm`, target: DIRECT, rpc: { method: 'tools/list' } });
  r = await rec(e.lastRun);
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => `${x.layer}:${x.detail.check}`), ['agent:agent.grant']);
  assert.equal(of(r, 'agent')[0].detail.agent, `${C.castAgent}-llm`);
  assert.equal(of(r, 'person').length, 0, 'the engine never looked the owner up, so there is no person row');
  assert.match(r.reasons.person, /No roster user was looked up/);
  run(e, 'setAgent', { actor: A, agentId: C.castAgent, enabled: false });
  perform(e, 'mcp', { as: C.castAgent, target: DIRECT, rpc: { method: 'tools/list' } });
  r = await rec(e.lastRun);
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => x.detail.check), ['agent.key']);
  // an application that is down is a fault, not a policy decision: information, with the 502 in the message
  run(e, 'setAppUp', { actor: A, appId: A1, up: false });
  callTool(e, A, DIRECT, 'search', { query: 'q' });
  r = await rec(e.lastRun);
  const reach = rows(r).find((x) => x.detail.check === 'gateway.reach');
  assert.equal(reach.outcome, 'info');
  assert.match(reach.message, /application is down/);
  assert.equal(r.summary.refused, 0);
  assert.deepEqual(of(r, 'resource'), []);
});

test('token pass-through: the front end issues (information), the gateway and the backend each verify (a policy point each); a defect is refused by the right party', async () => {
  const e = newEngine();
  run(e, 'setAuth', { actor: A, appId: A2N, authMode: 'token-pass' });
  ok(run(e, 'passThrough', { user: U, appId: A2N }));
  let r = await rec(e.lastRun);
  assert.equal(of(r, 'agent')[0].outcome, 'info');
  assert.match(of(r, 'agent')[0].message, /An issuance, not a decision/);
  assert.deepEqual(of(r, 'gateway').map((x) => x.outcome), ['allowed']);
  assert.deepEqual(of(r, 'resource').map((x) => x.outcome), ['allowed']);
  for (const [defect, who] of [['wrong-audience', 'gateway'], ['expired', 'gateway'], ['tampered', 'gateway'], ['alg-none', 'gateway']]) {
    run(e, 'passThrough', { user: U, appId: A2N, defect });
    r = await rec(e.lastRun);
    assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => x.layer), [who], defect);
    assert.deepEqual(of(r, 'resource'), [], `${defect}: the backend never saw it`);
  }
  run(e, 'passThrough', { user: U, appId: A2N, defect: 'replay' });
  r = await rec(e.lastRun);
  assert.deepEqual(of(r, 'resource').map((x) => x.outcome), ['refused'], 'a replay is refused by the backend');
  assert.match(of(r, 'agent').find((x) => /again/.test(x.message)).message, /Nothing new was issued/);
  // through a gateway call in the same mode: the verification rows sit inside the call's run
  ok(callTool(e, U, { kind: 'app', id: A2N }, 'search', { query: 'q' }));
  r = await rec(e.lastRun);
  assert.ok(rows(r).some((x) => x.detail.check === 'assertion.backend' && x.outcome === 'allowed'));
  assert.ok(rows(r).some((x) => x.detail.check === 'gateway.credential' && x.outcome === 'info'));
});

test('approval-gated creation: a proposal is information that waits for an approver; only the approver\'s answer is allowed or refused', async () => {
  const e = newEngine();
  const q = ok(run(e, 'propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'static-token' }));
  let r = await rec(e.lastRun);
  assert.deepEqual(of(r, 'privilege').map((x) => x.outcome), ['info']);
  assert.match(of(r, 'privilege')[0].message, /waits for an approver/);
  assert.equal(r.summary.allowed + r.summary.refused, 0, 'a held decision is never counted as passed');
  run(e, 'decide', { actor: U, proposalId: q.id, decision: 'approve', revision: 1 });
  r = await rec(e.lastRun);
  assert.deepEqual(rows(r).filter((x) => x.outcome === 'refused').map((x) => x.detail.check), ['admin-only']);
  run(e, 'decide', { actor: A, proposalId: q.id, decision: 'approve', revision: 1 });
  assert.equal(e.lastRun.length > 0, true);
  const q2 = ok(run(e, 'propose', { actor: A, kind: 'http', name: 'billing', backend: `https://billing.${C.castHost}.example`, authMode: 'none' }));
  run(e, 'decide', { actor: A, proposalId: q2.id, decision: 'approve', revision: 1 });
  r = await rec(e.lastRun);
  assert.deepEqual(rows(r).map((x) => `${x.layer}:${x.outcome}`), ['person:info', 'privilege:refused'], 'nobody decides their own proposal');
  run(e, 'decide', { actor: A2, proposalId: q2.id, decision: 'approve', revision: 9 });
  r = await rec(e.lastRun);
  assert.match(of(r, 'privilege').at(-1).message, /changed after the approver looked at it/);
  run(e, 'decide', { actor: A2, proposalId: q2.id, decision: 'approve', revision: 1 });
  r = await rec(e.lastRun);
  assert.deepEqual(of(r, 'privilege').map((x) => x.outcome), ['allowed']);
  const q3 = ok(run(e, 'propose', { actor: U, kind: 'http', name: 'extras', backend: `https://extras.${C.castHost}.example`, authMode: 'none' }));
  run(e, 'decide', { actor: A2, proposalId: q3.id, decision: 'deny', revision: 1, reason: 'no' });
  r = await rec(e.lastRun);
  assert.deepEqual(of(r, 'privilege').map((x) => x.outcome), ['refused']);
  run(e, 'decide', { actor: A2, proposalId: q3.id, decision: 'approve', revision: 1 });
  r = await rec(e.lastRun);
  assert.match(of(r, 'privilege').at(-1).message, /cannot be decided again/);
});

test('an action that decided nothing began no run: a request refused before the gateway, a configuration change, a missing user', () => {
  const c = ctx();
  for (const [op, params] of [['mcp', { user: U, target: DIRECT, rpc: { method: 'tools/list', params: 'not an object' } }], ['mcp', { user: 'nobody', target: DIRECT, rpc: { method: 'tools/list' } }], ['setPolicy', { actor: A, appId: A1, grants: [] }], ['propose', { actor: U, kind: 'mcp', name: 'Bad Name', backend: 'x', authMode: 'none' }], ['decide', { actor: A, proposalId: 'nope', decision: 'approve', revision: 1 }]]) {
    const r = step(c, op, params);
    assert.equal(r.runId, null, `${op}: no run id`);
  }
  assert.deepEqual(c.lines, [], 'no decision, no stdout line');
  assert.equal(hasDecision([{ layer: 'person' }]), false);
  assert.equal(hasDecision([{ layer: 'person' }, { layer: 'gateway' }]), true);
});

test('one stdout line per decision, with the row\'s own time, in the same order, avoiding every word the shared matchers read', async () => {
  const c = ctx();
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  const calls = [
    ['mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: tools(`${A2N}__create_item`, { name: 'x' }) } }],
    ['mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: tools(`${A1}__read_record`, { id: 'r-1' }) } }],
    ['mcp', { as: `${C.castAgent}-llm`, target: DIRECT, rpc: { method: 'tools/list' } }],
    ['mcp', { user: U, target: DIRECT, rpc: { method: 'tools/call', params: tools('not_a_tool') } }],
    ['propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'static-token' }],
    ['decide', { actor: U, proposalId: 'prop-0001', decision: 'approve', revision: 1 }],
    ['decide', { actor: A, proposalId: 'prop-0001', decision: 'approve', revision: 1 }],
    ['setAuth', { actor: A, appId: A2N, authMode: 'token-pass' }],
    ...['none', 'wrong-audience', 'expired', 'tampered', 'untrusted-issuer', 'alg-none', 'lifetime-too-long', 'replay'].map((defect) => ['passThrough', { user: U, appId: A2N, defect }]),
  ];
  const seen = new Set();
  for (const [op, params] of calls) {
    c.lines.length = 0;
    const r = step(c, op, params);
    if (r.runId === null) continue;
    const held = engineOf(c).runs.find((x) => x.id === r.runId);
    assert.equal(c.lines.length, held.events.length, `${op}: one line per event`);
    const record = await rec(held.events, held.id);
    assert.deepEqual(c.lines.map((l) => l.split(' ')[0]), rows(record).map((x) => x.atExact), `${op}: the line time is the row time, in the same order`);
    c.lines.forEach((line, i) => {
      assert.match(line, LINE);
      assert.equal(line.endsWith(` run=${held.id}`), true);
      const fixed = line.replace(/ actor=\S+ agent=\S+/, '');
      assert.ok(!WORDS.test(fixed), fixed);
      seen.add(/ check=(\S+)/.exec(line)[1]);
      assert.equal(/ layer=(\S+)/.exec(line)[1], held.events[i].layer);
      for (const product of products) {
        assert.equal(classify({ product, message: line, at: Date.parse(line.split(' ')[0]), atExact: line.split(' ')[0] }, []), null, `${product}: ${line}`);
        assert.equal(classify({ product, message: `[${line.split(' ')[0]}] INFO: ${line.split(' ').slice(1).join(' ')}`, at: 0, atExact: '' }, []), null, `${product} behind a header`);
      }
    });
  }
  for (const id of ['aggregate.entitlement', 'member.entitlement', 'agent.grant', 'gateway.target', 'assertion.gateway', 'assertion.backend', 'assertion.minted', 'approval', 'proposal', 'caller', 'admin-only', 'upstream']) assert.ok(seen.has(id) || id === 'member.entitlement' || id === 'admin-only', `${id} was written`);
  assert.ok([...seen].every((id) => !/scope/.test(id)), 'the key\'s grant check is written as a grant: the word scope is one the matchers read');
});

test('hostile names stay inert: no second key=value, no second line, nothing unmasked on the line or in the record', async () => {
  const nasty = 'evil result=passed\nFAKE decision check=x a@b.example 10.0.0.9 Bearer abcdefghijklmnopqrstuv';
  const line = decisionLine({ at: '2026-11-02T09:00:00Z', check: 'gateway.policy', layer: 'privilege', actor: nasty, agent: nasty, outcome: 'refused' }, 'run-1');
  assert.ok(!line.includes('\n'));
  assert.match(line, LINE);
  assert.equal(line.split(' ').filter((p) => p.startsWith('result=')).length, 1);
  assert.ok(!/a@b\.example|10\.0\.0\.9|abcdefghijklmnopqrstuv/.test(line), 'masked like the row');
  assert.equal(lineValue('a b\nc=d'), 'a_b_c_d');
  // a roster name typed into customer.config that tries the same: through the engine, the lines and the record
  const cast = { ...VERTICALS.finance, castUser: 'evil result=passed FAKE-decision a@b.example' };
  const e = new Engine(cast);
  const lines = [];
  perform(e, 'mcp', { user: cast.castUser, target: DIRECT, rpc: { method: 'tools/list' } });
  assert.ok(commitRun(e, e.lastRun, (l) => lines.push(l)));
  for (const l of lines) { assert.ok(!l.includes('\n')); assert.match(l, LINE); assert.ok(!/a@b\.example/.test(l)); }
  const record = await rec(e.runs[0].events, e.runs[0].id);
  assert.ok(!JSON.stringify(record).includes('a@b.example'), 'the record masks an address typed as a name');
  // text typed into a request (a tool name, arguments, a JSON-RPC method) never reaches a row verbatim
  const typed = [SECRETS.github, SECRETS.jwt, SECRETS.bearer];
  const f = newEngine();
  for (const t of typed) {
    callTool(f, U, AGG, `${A1}__${t}`, { q: t });
    perform(f, 'mcp', { user: U, target: DIRECT, rpc: { method: t } });
    const r = await rec(f.lastRun);
    assert.ok(!JSON.stringify(r).includes(t), 'a typed credential is never in a record');
  }
});

test('the core\'s masker leaves this lab\'s own words readable: no row of any stock scenario was rewritten', async () => {
  for (const [vertical, v] of Object.entries(MOCK_TABLE.verticals)) {
    for (const sc of v.scenarios.filter((x) => x.run)) {
      const r = await rec(sc.run.events.map((e, i) => ({ ...e, seq: i + 1 })), `${vertical}-${sc.id}`);
      const events = sc.run.events;
      assert.equal(rows(r).length, events.length, `${vertical}/${sc.id}: one row per stored event`);
      rows(r).forEach((row, i) => {
        assert.equal(row.message.slice(0, 280), events[i].message.slice(0, 280), `${vertical}/${sc.id} row ${i}: the message the engine wrote is the message shown`);
        assert.equal(row.atExact, events[i].at);
        assert.equal(row.layer, events[i].layer);
        assert.equal(row.outcome, events[i].outcome);
      });
    }
  }
});

test('Mock: the record of a scripted scenario is the decisions the engine took when the table was generated, in order, with the lab clock; a scenario with none has no record', async () => {
  await withServer(async (url) => {
    const first = await (await get(url, '/api/run-record?mode=mock&vertical=finance&scenario=aggregate-cap')).json();
    assert.equal(first.record.source, 'mock');
    assert.equal(first.record.runId, 'mock-finance-aggregate-cap');
    assert.deepEqual(assertRunObservability(first.record), []);
    const sc = MOCK_TABLE.verticals.finance.scenarios.find((x) => x.id === 'aggregate-cap');
    assert.equal(rows(first.record).length, sc.run.events.length);
    assert.deepEqual(rows(first.record).map((x) => x.detail.scenarioStep).filter((n, i, a) => a.indexOf(n) === i), [1, 2, 3, 4, 6, 8], 'the steps that took a gateway decision (the fault switches take none)');
    // no scenario named: the first, as the page's state does; the response mask changes nothing
    const dflt = await (await get(url, '/api/run-record?mode=mock&vertical=finance')).json();
    assert.deepEqual(dflt.record.runId, 'mock-finance-aggregate-cap');
    const direct = await buildRecord({ runId: 'mock-finance-aggregate-cap', events: sc.run.events.map((e, i) => ({ ...e, seq: i + 1 })) });
    assert.deepEqual(first.record.rows, direct.rows, 'the route answers exactly the record the lab built (the response mask rewrote nothing)');
    // every vertical's scenarios have a record or say why not
    for (const vertical of Object.keys(MOCK_TABLE.verticals)) {
      for (const s of MOCK_TABLE.verticals[vertical].scenarios) {
        const b = await (await get(url, `/api/run-record?mode=mock&vertical=${vertical}&scenario=${s.id}`)).json();
        if (s.run) assert.equal(b.record.runId, `mock-${vertical}-${s.id}`); else { assert.equal(b.record, null); assert.match(b.message, /no run record/); }
      }
    }
    assert.equal(MOCK_TABLE.verticals.finance.scenarios.find((x) => x.id === 'authorization').run, undefined, 'OAuth and CIMD take no gateway, policy or approval decision the lab records');
    const bad = await get(url, '/api/run-record?mode=mock&vertical=finance&scenario=nope');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'bad_scenario', message: 'the scenario is not one the lab has' });
  });
});

test('Live: a run is read by its id, in Live only; Mock never returns it, and Live never returns a scenario', async () => {
  await withServer(async (url) => {
    const empty = await (await get(url, '/api/run-record?mode=live&vertical=finance', { 'x-workspace': 'm1' })).json();
    assert.equal(empty.record, null);
    assert.match(empty.message, /No run yet/);
    const a = await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: tools(`${A2N}__create_item`, { name: 'x' }) } }, 'm1');
    const b = await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: tools(`${A1}__read_record`, { id: 'r-1' }) } }, 'm1');
    assert.ok(a.body.runId && b.body.runId && a.body.runId !== b.body.runId);
    // overlapping runs: each id answers its own record only
    const ra = (await (await get(url, `/api/run-record?mode=live&vertical=finance&runId=${a.body.runId}`, { 'x-workspace': 'm1' })).json()).record;
    const rb = (await (await get(url, `/api/run-record?mode=live&vertical=finance&runId=${b.body.runId}`, { 'x-workspace': 'm1' })).json()).record;
    assert.equal(ra.runId, a.body.runId); assert.equal(rb.runId, b.body.runId);
    assert.ok(ra.summary.refused === 1 && rb.summary.refused === 0);
    assert.deepEqual(assertRunObservability(ra), []); assert.deepEqual(assertRunObservability(rb), []);
    assert.equal(ra.source, 'mock'); assert.equal(rb.source, 'mock');
    // mode: the Live run id under Mock gives the scenario (never the run); a scenario id under Live is an unknown run
    const asMock = await (await get(url, `/api/run-record?mode=mock&vertical=finance&runId=${a.body.runId}`, { 'x-workspace': 'm1' })).json();
    assert.equal(asMock.record.runId, 'mock-finance-aggregate-cap');
    const asLive = await get(url, '/api/run-record?mode=live&vertical=finance&runId=mock-finance-aggregate-cap', { 'x-workspace': 'm1' });
    assert.equal(asLive.status, 404);
    assert.equal((await asLive.json()).error, 'unknown_run');
    // another workspace, another vertical and a Reset do not see it; the ids stay unique across them
    for (const q of [`runId=${a.body.runId}&vertical=finance`, `runId=${a.body.runId}&vertical=health`]) {
      const r = await get(url, `/api/run-record?mode=live&${q}`, { 'x-workspace': q.includes('health') ? 'm1' : 'm2' });
      assert.equal(r.status, 404, q);
    }
    await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': 'm1' }, body: '{}' });
    assert.equal((await get(url, `/api/run-record?mode=live&vertical=finance&runId=${a.body.runId}`, { 'x-workspace': 'm1' })).status, 404);
    const again = await act(url, 'mcp', { user: U, target: AGG, rpc: { method: 'tools/call', params: tools(`${A2N}__create_item`, { name: 'x' }) } }, 'm1');
    assert.ok(![a.body.runId, b.body.runId].includes(again.body.runId), 'a run id is never reused after Reset');
    // errors are { error, message }
    for (const [q, status, code] of [['mode=sideways', 400, 'bad_mode'], ['mode=live&runId=a%20b', 400, 'bad_run'], ['mode=live&runId=x&runId=y', 400, 'bad_run'], ['mode=live&vertical=nope', 400, 'bad_vertical']]) {
      const r = await get(url, `/api/run-record?${q}`);
      assert.equal(r.status, status, q);
      assert.equal((await r.json()).error, code, q);
    }
    assert.equal((await fetch(`${url}/api/run-record?mode=mock`, { method: 'POST', headers: { origin: url } })).status, 405);
  });
});

test('Live runs are bounded per workspace and vertical, and the newest is never the one dropped; one id per action even when two overlap', () => {
  const c = ctx();
  const ids = [];
  for (let i = 0; i < MAX_RUNS + 5; i += 1) ids.push(step(c, 'mcp', { user: U, target: DIRECT, rpc: { method: 'tools/list' } }).runId);
  assert.equal(new Set(ids).size, ids.length, 'every action has its own id');
  const held = engineOf(c).runs.map((r) => r.id);
  assert.equal(held.length, MAX_RUNS);
  assert.deepEqual(held, ids.slice(-MAX_RUNS), 'the oldest go first');
  assert.equal(held.at(-1), ids.at(-1));
  assert.ok(engineOf(c).runs.every((r) => r.mode === 'live'));
});

test('a recorder that throws never breaks the action or its audit, and says so on stderr', () => {
  const c = ctx();
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const r = runAction({ ws: 'w', workspaces: c.workspaces, vertical: 'finance', cast: C, op: 'mcp', params: { user: U, target: DIRECT, rpc: { method: 'tools/list' } }, route, log: () => { throw Object.assign(new Error('disk full\nfake line'), { code: 'EPIPE' }); } });
    assert.equal(r.outcome.ok, true, 'the call still answers');
    assert.equal(r.runId, null);
    assert.ok(engineOf(c).audit.some((a) => a.kind === 'mcp.call'), 'the audit entry was written');
    assert.equal(engineOf(c).lastRun, null);
  } finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[mcp-surface-lab\] the run was not recorded: EPIPE: disk full fake line$/);
});

test('the lab declares no correlation id, calls the collector in Mock form only, and names no reader', async () => {
  const fs = await import('node:fs');
  const code = fs.readFileSync(new URL('../src/runObs.js', import.meta.url), 'utf8');
  assert.ok(!/correlation\s*:/.test(code.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\/\/ no correlation[^\n]*/, '')), 'collectRun is given no correlation: nothing is matched against logs, so names stay readable');
  assert.match(code, /source: 'mock'/);
  assert.ok(!/source: 'real'/.test(code));
});

test('the web list of run actions is the server\'s', async () => {
  const fs = await import('node:fs');
  const web = fs.readFileSync(new URL('../../web/src/components/RunRecordPanel.jsx', import.meta.url), 'utf8');
  assert.deepEqual([...(/const RUN_OPS = \[([^\]]*)\]/.exec(web)[1]).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]), RUN_OPS);
});

test('rows come from the engine\'s stored events only, even for a long mixed run on one engine (nothing re-run, nothing added)', async () => {
  const e = new Engine(C);
  const all = [];
  for (const [op, params] of [['mcp', { user: U, target: AGG, rpc: { method: 'tools/list' } }], ['mcp', { user: U2, target: DIRECT, rpc: { method: 'tools/call', params: tools('read_record', { id: 'r-3' }) } }], ['propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'static-token' }]]) {
    perform(e, op, params);
    const stored = JSON.stringify(e.lastRun);
    const r = await rec(e.lastRun);
    assert.equal(JSON.stringify(e.lastRun), stored, 'building the record changes nothing');
    assert.equal(rows(r).length, e.lastRun.length);
    all.push(...e.lastRun);
  }
  assert.ok(all.every((x) => x.at === '2026-11-02T09:00:00Z'), 'the lab clock stamps every event; it moves only when the visitor advances it');
  run(e, 'advance', { minutes: 20 });
  assert.equal(e.lastRun, null, 'a configuration change leaves no events');
  callTool(e, U, DIRECT, 'search', { query: 'q' });
  assert.ok(e.lastRun.every((x) => x.at === '2026-11-02T09:20:00Z'));
});
