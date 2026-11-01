// Approval-gated creation (a real state machine), session logging, headless agents, path routing and replica pinning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { A, A1, A2, APP, C, U, U2, X, callTool, codeOf, listNames, mcp, newEngine, ok, run } from './helpers.js';

const propose = (e, over = {}) => run(e, 'propose', { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'static-token', ...over });
const decide = (e, over = {}) => run(e, 'decide', { actor: A2, proposalId: 'prop-0001', decision: 'approve', revision: 1, ...over });
const prop = (e, id = 'prop-0001') => e.snapshot().creation.proposals.find((p) => p.id === id);

test('nothing is created until an administrator approves; approval creates the application with an administrators-only default policy', () => {
  const e = newEngine();
  const p = ok(propose(e)); assert.deepEqual([p.state, p.revision, p.proposer], ['pending', 1, U]);
  assert.ok(!e.snapshot().apps.some((a) => a.id === 'helpdesk'), 'a pending proposal creates nothing');
  const d = ok(decide(e)); assert.deepEqual([d.state, d.decidedBy, d.createdApp], ['approved', A2, 'helpdesk']);
  const app = e.snapshot().apps.find((a) => a.id === 'helpdesk'); assert.deepEqual([app.source, app.authMode, app.kind], ['approved proposal', 'static-token', 'created']);
  assert.equal(codeOf(mcp(e, U, APP('helpdesk'), 'tools/list')), 'access_denied', 'staff have no grant yet');
  assert.deepEqual(listNames(e, A, APP('helpdesk')), ['describe']);
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'proposal.approved' && x.actor === A2));
});

test('an HTTP application is created without MCP tools and cannot be called as an MCP server', () => {
  const e = newEngine(); ok(propose(e, { kind: 'http', name: 'billing', authMode: 'none' })); ok(decide(e));
  assert.equal(e.snapshot().apps.find((a) => a.id === 'billing').kind, 'http');
  assert.equal(codeOf(mcp(e, A, APP('billing'), 'tools/list')), 'not_an_mcp_application');
});

test('who may approve: only an administrator, never the proposer (administrators included)', () => {
  const e = newEngine(); ok(propose(e));
  const r = decide(e, { actor: U }); assert.equal(codeOf(r), 'admin_only'); assert.equal(r.status, 403);
  ok(propose(e, { actor: A, name: 'billing', kind: 'http', authMode: 'none', backend: `https://billing.${C.castHost}.example` }));
  const self = decide(e, { actor: A, proposalId: 'prop-0002' }); assert.equal(codeOf(self), 'self_approval'); assert.equal(self.status, 403);
  assert.equal(codeOf(decide(e, { actor: A, proposalId: 'prop-0002', decision: 'deny' })), 'self_approval', 'nor deny their own');
  assert.equal(prop(e, 'prop-0002').state, 'pending');
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'refused' && x.code === 'self_approval' && x.actor === A));
});

test('state machine: duplicate decision, approve after deny, deny after approve, and a second approval are all refused', () => {
  let e = newEngine(); ok(propose(e)); ok(decide(e));
  assert.equal(codeOf(decide(e)), 'already_decided'); assert.equal(codeOf(decide(e, { decision: 'deny' })), 'already_decided'); assert.equal(codeOf(decide(e, { actor: A })), 'already_decided');
  e = newEngine(); ok(propose(e)); ok(decide(e, { decision: 'deny', reason: 'no' }));
  const after = decide(e, { actor: A }); assert.equal(codeOf(after), 'approve_after_deny'); assert.equal(after.status, 409);
  assert.equal(codeOf(decide(e, { decision: 'deny' })), 'already_decided'); assert.ok(!e.snapshot().apps.some((a) => a.id === 'helpdesk'));
  assert.equal(prop(e).state, 'denied'); assert.equal(prop(e).reason, 'no');
});

test('stale: an amendment moves the revision, so an approval of the revision the administrator looked at is refused; the new revision works', () => {
  const e = newEngine(); ok(propose(e));
  const a = ok(run(e, 'amend', { actor: U, proposalId: 'prop-0001', authMode: 'user-token' })); assert.equal(a.revision, 2);
  const stale = decide(e, { revision: 1 }); assert.equal(codeOf(stale), 'stale_revision'); assert.equal(stale.status, 409);
  assert.equal(codeOf(decide(e, { revision: 3 })), 'stale_revision', 'a revision from the future is no better');
  assert.equal(prop(e).state, 'pending');
  assert.equal(ok(decide(e, { revision: 2 })).state, 'approved'); assert.equal(e.snapshot().apps.find((x) => x.id === 'helpdesk').authMode, 'user-token');
  assert.equal(codeOf(run(e, 'amend', { actor: U, proposalId: 'prop-0001', authMode: 'none' })), 'not_pending');
});

test('stale: a proposal older than seven days on the lab clock expires and cannot be approved', () => {
  const e = newEngine(); ok(propose(e));
  for (let i = 0; i < 7; i++) ok(run(e, 'advance', { minutes: 1440 }));
  ok(run(e, 'advance', { minutes: 1 }));
  const r = decide(e); assert.equal(codeOf(r), 'proposal_stale'); assert.equal(prop(e).state, 'expired'); assert.equal(codeOf(decide(e)), 'proposal_stale');
  const e2 = newEngine(); ok(propose(e2)); for (let i = 0; i < 7; i++) ok(run(e2, 'advance', { minutes: 1440 }));
  assert.equal(codeOf(decide(e2)), 'ok', 'exactly seven days is still fine');
});

test('values are RE-VALIDATED at approval (not frozen): a name taken in the meantime refuses the approval and leaves the proposal pending', () => {
  const e = newEngine(); ok(propose(e));
  ok(run(e, 'catDeploy', { actor: A, entryId: 'kb-search', name: 'helpdesk' }));
  const r = decide(e); assert.equal(codeOf(r), 'name_taken'); assert.equal(prop(e).state, 'pending');
  const adj = ok(decide(e, { adjust: { name: 'helpdesk-2' } })); assert.equal(adj.createdApp, 'helpdesk-2');
  assert.deepEqual(adj.adjustments, [{ field: 'name', from: 'helpdesk', to: 'helpdesk-2' }]);
});

test('every adjustable field matters, proven by mutation: kind, name, backend, authMode; adjustments are recorded', () => {
  const e = newEngine(); ok(propose(e));
  const d = ok(decide(e, { adjust: { kind: 'http', name: 'desk', backend: `https://desk.${C.castHost}.example`, authMode: 'oauth' } }));
  assert.deepEqual(d.adjustments.map((x) => x.field).sort(), ['authMode', 'backend', 'kind', 'name']);
  const app = e.snapshot().apps.find((a) => a.id === 'desk'); assert.deepEqual([app.kind, app.authMode], ['http', 'oauth']);
  assert.equal(e.apps.desk.backend, `https://desk.${C.castHost}.example`);
  assert.equal(codeOf(decide(newEngine(), { adjust: { name: 'Bad' } })), 'unknown_proposal');
  const f = newEngine(); ok(propose(f));
  for (const bad of [{ name: 'Bad Name' }, { backend: 'http://x.example' }, { authMode: 'obo' }, { kind: 'other' }, { extra: 1 }, 'x', []]) assert.ok(['bad_name', 'bad_backend', 'bad_auth_mode', 'bad_kind', 'unknown_field', 'bad_request'].includes(codeOf(decide(f, { adjust: bad }))), JSON.stringify(bad));
  assert.equal(prop(f).state, 'pending', 'a refused adjustment decided nothing');
});

test('proposal validation: names, backends on reserved hosts only, kinds and modes from lists, duplicates and the cap refused; nothing is stored on refusal', () => {
  const e = newEngine();
  for (const bad of [{ name: 'Bad Name' }, { name: '' }, { name: 5 }, { kind: 'grpc' }, { authMode: 'basic' }, { backend: 'https://real.com/x' }, { backend: 'http://x.example' }, { backend: `https://u:p@x.example` }, { backend: 'https://x.example/a b' }, { extra: 1 }]) assert.ok(['bad_name', 'bad_kind', 'bad_auth_mode', 'bad_backend', 'unknown_field'].includes(codeOf(propose(e, bad))), JSON.stringify(bad));
  assert.equal(e.snapshot().creation.proposals.length, 0);
  ok(propose(e)); assert.equal(codeOf(propose(e, { actor: U2 })), 'duplicate_proposal');
  assert.equal(codeOf(propose(e, { actor: 'nobody', name: 'zz' })), 'unknown_user');
  for (let i = 0; i < 29; i++) ok(propose(e, { name: `app-${i}`, actor: U2 }));
  assert.equal(codeOf(propose(e, { name: 'one-more' })), 'too_many_proposals'); assert.equal(e.snapshot().creation.proposals.length, 30, 'refused whole, nothing evicted');
});

test('only the proposer may amend; unknown ids and wrong types are refused', () => {
  const e = newEngine(); ok(propose(e));
  assert.equal(codeOf(run(e, 'amend', { actor: U2, proposalId: 'prop-0001', note: 'x' })), 'not_the_proposer');
  assert.equal(codeOf(run(e, 'amend', { actor: U, proposalId: 'prop-0001' })), 'no_change');
  for (const id of ['nope', '__proto__', 5, null]) assert.ok(['unknown_proposal', 'missing_field'].includes(codeOf(run(e, 'amend', { actor: U, proposalId: id, note: 'x' }))));
  assert.equal(codeOf(decide(e, { proposalId: '__proto__' })), 'unknown_proposal'); assert.equal(codeOf(decide(e, { decision: 'maybe' })), 'bad_decision'); assert.equal(codeOf(decide(e, { revision: '1' })), 'stale_revision');
});

test('concurrent decisions: two administrators deciding at once cannot both win (one approval, one refusal)', () => {
  const e = newEngine(); ok(propose(e));
  const results = [decide(e, { actor: A }), decide(e, { actor: A2 }), decide(e, { actor: A2, decision: 'deny' })];
  assert.deepEqual(results.map(codeOf), ['ok', 'already_decided', 'already_decided']);
  assert.equal(e.snapshot().apps.filter((a) => a.id === 'helpdesk').length, 1);
});

test('session logging: off records nothing; on records the invocation and its arguments (masked); a full recording refuses the call rather than leaving it unrecorded', () => {
  const e = newEngine();
  ok(callTool(e, U, APP(A1), 'search', { query: 'quarterly' })); assert.equal(e.snapshot().recordings.total, 0);
  assert.equal(codeOf(run(e, 'setSessionLogging', { actor: U, enabled: true })), 'admin_only'); assert.equal(codeOf(run(e, 'setSessionLogging', { actor: A, enabled: 'yes' })), 'bad_enabled');
  ok(run(e, 'setSessionLogging', { actor: A, enabled: true }));
  ok(callTool(e, U, APP(A1), 'search', { query: 'quarterly figures' }));
  const rec = e.snapshot().recordings.shown[0]; assert.deepEqual([rec.actor, rec.tool, rec.arguments], [U, 'search', { query: 'quarterly figures' }]);
  callTool(e, U, APP(A1), 'export_all'); assert.equal(e.snapshot().recordings.total, 1, 'a refused call is not a recorded invocation');
  ok(run(e, 'setSessionLogging', { actor: A, enabled: false })); ok(callTool(e, U, APP(A1), 'search', { query: 'q' })); assert.equal(e.snapshot().recordings.total, 1);
  ok(run(e, 'setSessionLogging', { actor: A, enabled: true }));
  for (let i = 1; i < 200; i++) ok(callTool(e, U, APP(A1), 'get_status'));
  const full = callTool(e, U, APP(A1), 'get_status'); assert.equal(codeOf(full), 'recording_full'); assert.equal(full.status, 507);
  assert.equal(e.snapshot().recordings.total, 200); assert.equal(codeOf(mcp(e, U, APP(A1), 'tools/list')), 'ok', 'listing is not recorded, so it still works');
});

test('headless agents act as their owning user: the owner\'s policy and audit apply; a key without the mcp scope is refused; a revoked agent is refused', () => {
  const e = newEngine();
  const asAgent = (as, name = 'get_status', args = {}) => run(e, 'mcp', { as, target: APP(A1), rpc: { method: 'tools/call', params: { name, arguments: args } } });
  ok(asAgent(C.castAgent));
  const last = e.snapshot().audit.shown.filter((x) => x.kind === 'mcp.call').at(-1); assert.equal(last.actor, `agent:${C.castAgent} for ${U}`);
  assert.equal(codeOf(asAgent(C.castAgent, 'export_all')), 'access_denied', 'the owner\'s policy applies to the agent too');
  assert.equal(codeOf(asAgent(`${C.castAgent}-fi`)), 'ok', 'a Federated Identity agent acts as its owner as well');
  const llm = asAgent(`${C.castAgent}-llm`); assert.equal(codeOf(llm), 'key_not_scoped_for_mcp'); assert.equal(llm.status, 403);
  assert.equal(codeOf(run(e, 'mcp', { as: C.castAgent, user: U, target: APP(A1), rpc: { method: 'ping' } })), 'ambiguous_identity');
  assert.equal(codeOf(asAgent('nobody')), 'unknown_agent'); assert.equal(codeOf(asAgent('__proto__')), 'unknown_agent');
  ok(run(e, 'setAgent', { actor: A, agentId: C.castAgent, enabled: false }));
  const gone = asAgent(C.castAgent); assert.equal(codeOf(gone), 'agent_revoked'); assert.equal(gone.status, 401);
  assert.equal(codeOf(asAgent(`${C.castAgent}-fi`)), 'ok', 'revoking one agent leaves the other');
  ok(run(e, 'setAgent', { actor: A, agentId: C.castAgent, enabled: true })); assert.equal(codeOf(asAgent(C.castAgent)), 'ok');
  assert.equal(codeOf(run(e, 'setAgent', { actor: U, agentId: C.castAgent, enabled: false })), 'admin_only');
});

test('one hostname, applications addressed by path: a path resolves to one application or aggregate; anything else is a 404', () => {
  const e = newEngine();
  const r = ok(run(e, 'route', { path: `/${A1}/mcp` })); assert.deepEqual([r.serves, r.kind, r.host], [A1, 'mcp', `${C.castHost}-gateway.example`]);
  assert.equal(ok(run(e, 'route', { path: '/all-in-one/mcp' })).kind, 'aggregate');
  const miss = run(e, 'route', { path: '/nothing/mcp' }); assert.equal(codeOf(miss), 'no_such_path'); assert.equal(miss.status, 404);
  for (const bad of ['x', '/a b', '/a?b', '/' + 'a'.repeat(120), 5, null, '/%00']) assert.ok(['bad_path', 'missing_field'].includes(codeOf(run(e, 'route', { path: bad }))), String(bad));
  const hosts = new Set(e.snapshot().creation.deployment.paths.map((p) => p.path)); assert.ok(hosts.has(`/${A1}/mcp`) && hosts.has('/all-in-one/mcp'));
});

test('OAuth session state is per gateway process: a session used on the replica that did not open it is refused until client sessions are pinned', () => {
  const e = newEngine();
  const s = ok(run(e, 'sessionOpen', { user: U, replica: 'replica-a' })); assert.equal(s.replica, 'replica-a');
  assert.equal(ok(run(e, 'sessionUse', { sessionId: s.id, replica: 'replica-a' })).servedBy, 'replica-a');
  const lost = run(e, 'sessionUse', { sessionId: s.id, replica: 'replica-b' }); assert.equal(codeOf(lost), 'session_not_on_replica'); assert.equal(lost.status, 401); assert.deepEqual([lost.data.servedBy, lost.data.heldBy], ['replica-b', 'replica-a']);
  ok(run(e, 'setPinning', { actor: A, enabled: true }));
  assert.deepEqual([ok(run(e, 'sessionUse', { sessionId: s.id, replica: 'replica-b' })).servedBy, e.snapshot().creation.deployment.pinned], ['replica-a', true]);
  ok(run(e, 'setPinning', { actor: A, enabled: false })); assert.equal(codeOf(run(e, 'sessionUse', { sessionId: s.id, replica: 'replica-b' })), 'session_not_on_replica');
  for (const bad of [{ user: U, replica: 'replica-c' }, { user: 'nobody', replica: 'replica-a' }, { user: U, replica: 5 }]) assert.ok(['bad_replica', 'unknown_user'].includes(codeOf(run(e, 'sessionOpen', bad))));
  assert.equal(codeOf(run(e, 'sessionUse', { sessionId: 'sess-999', replica: 'replica-a' })), 'unknown_session'); assert.equal(codeOf(run(e, 'setPinning', { actor: U, enabled: true })), 'admin_only');
  for (let i = 0; i < 19; i++) ok(run(e, 'sessionOpen', { user: U, replica: 'replica-a' }));
  assert.equal(codeOf(run(e, 'sessionOpen', { user: U, replica: 'replica-a' })), 'too_many_sessions');
});

test('the audit log is bounded: when full, new writes are refused (507) and nothing is dropped', () => {
  const e = newEngine();
  for (let i = 0; i < 480; i++) e.record('test', { i });
  let refused = 0; for (let i = 0; i < 40; i++) { const r = run(e, 'advance', { minutes: 1 }); if (!r.ok) { refused++; assert.equal(r.code, 'log_full'); assert.equal(r.status, 507); } }
  assert.ok(refused > 0); assert.ok(e.audit.length <= 500);
  assert.equal(e.audit[0].kind, 'test', 'the oldest entry is still there');
});

test('X (a contractor) cannot use anything the policy does not name, and an unknown user is refused everywhere', () => {
  const e = newEngine();
  assert.equal(codeOf(callTool(e, X, APP(A1), 'search', { query: 'q' })), 'access_denied');
  for (const u of ['nobody', '__proto__', 5, null, undefined]) assert.ok(['unknown_user', 'missing_field'].includes(codeOf(callTool(e, u, APP(A1), 'search', { query: 'q' }))) || codeOf(callTool(e, u, APP(A1), 'search', { query: 'q' })) === 'unknown_user');
});

test('amend applies the same pending-name rule as propose: a name another pending proposal holds is refused (409) and nothing changes; your own name, or a closed proposal\'s name, is fine (review fix)', () => {
  const e = newEngine();
  ok(propose(e, { name: 'alpha' })); ok(propose(e, { actor: U2, name: 'beta' }));
  const before = JSON.stringify(prop(e, 'prop-0002'));
  const r = run(e, 'amend', { actor: U2, proposalId: 'prop-0002', name: 'alpha', note: 'changed my mind' });
  assert.equal(codeOf(r), 'duplicate_proposal'); assert.equal(r.status, 409);
  assert.equal(JSON.stringify(prop(e, 'prop-0002')), before, 'a refused amend changes nothing: not the name, the note nor the revision');
  assert.deepEqual(e.snapshot().creation.proposals.filter((p) => p.state === 'pending').map((p) => p.name).sort(), ['alpha', 'beta']);
  assert.equal(ok(run(e, 'amend', { actor: U2, proposalId: 'prop-0002', name: 'beta', note: 'same name again' })).revision, 2, 'keeping your own name is not a clash');
  ok(run(e, 'decide', { actor: A2, proposalId: 'prop-0001', decision: 'deny', revision: 1 }));
  assert.equal(ok(run(e, 'amend', { actor: U2, proposalId: 'prop-0002', name: 'alpha' })).name, 'alpha', 'a denied proposal no longer holds its name');
});

test('a denial with an adjust field is refused (400) and the proposal stays pending; an approval may still adjust (review fix)', () => {
  const e = newEngine(); ok(propose(e));
  const r = decide(e, { decision: 'deny', adjust: { name: 'BAD NAME!!', kind: 5 } });
  assert.equal(codeOf(r), 'adjust_on_deny'); assert.equal(r.status, 400);
  assert.equal(prop(e).state, 'pending');
  assert.equal(ok(decide(e, { decision: 'deny' })).state, 'denied', 'a plain denial works');
  ok(propose(e, { name: 'other' }));
  assert.equal(ok(decide(e, { proposalId: 'prop-0002', adjust: { name: 'adjusted' } })).createdApp, 'adjusted');
});
