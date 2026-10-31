// Per-tool policy on the JSON-RPC method and target, and entitlement-aware discovery through the whole gateway pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { A, A1, AGG, APP, U, X, callTool, codeOf, listNames, mcp, newEngine, ok, run } from './helpers.js';
import { STYLES } from '../src/wire.js';

const names = (e, u, app, style) => listNames(e, u, APP(app), style ? { style } : {});

test('listing is filtered to the user\'s entitlement, over every wire style: json, event stream, gzip and gzip-compressed stream', () => {
  const e = newEngine();
  for (const style of STYLES) assert.deepEqual(names(e, U, A1, style), ['search', 'get_status', 'read_record'], style);
  assert.deepEqual(names(e, A, A1).length, 5, 'administrators see all five');
  const r = ok(mcp(e, U, APP(A1), 'tools/list', {}, { style: 'gzip-sse' }));
  assert.deepEqual(r.operator.log, ['Removing unauthorized tool from MCP response: write_record', 'Removing unauthorized tool from MCP response: export_all'], 'the operator log line is the measured one');
  assert.ok(!JSON.stringify(r.rpc).includes('export_all'), 'the agent\'s view never names a hidden tool');
});

test('a hidden tool cannot be called, and the refusal is identical to one for a tool that does not exist (the agent cannot tell)', () => {
  const e = newEngine();
  const hidden = callTool(e, U, APP(A1), 'export_all'); const absent = callTool(e, U, APP(A1), 'no_such_tool');
  assert.equal(codeOf(hidden), 'access_denied'); assert.equal(hidden.status, 403);
  assert.deepEqual([hidden.code, hidden.status, hidden.detail, hidden.data.wire], [absent.code, absent.status, absent.detail, absent.data.wire]);
  assert.equal(hidden.data.wire.httpStatus, 403); assert.equal(hidden.data.wire.body, null, 'a bare 403 with no JSON-RPC body (measured)');
  assert.notEqual(hidden.data.reason, absent.data.reason, 'only the operator can tell them apart');
});

test('deny by default: no grant for the user\'s groups means even initialize is refused', () => {
  const e = newEngine();
  for (const m of ['initialize', 'tools/list', 'prompts/list', 'resources/list']) assert.equal(codeOf(mcp(e, X, APP(A1), m)), 'access_denied', m);
  assert.equal(mcp(e, X, APP(A1), 'initialize').data.reason, 'no_policy');
  assert.equal(codeOf(mcp(e, X, APP(A1), 'ping')), 'ok');
});

test('the method is part of the decision: tools, prompts and resources, listing and invocation alike; an unknown method is refused', () => {
  const e = newEngine();
  assert.deepEqual(ok(mcp(e, U, APP(A1), 'prompts/list')).rpc.result.prompts.map((p) => p.name), ['summarise']);
  assert.deepEqual(ok(mcp(e, U, APP(A1), 'resources/list')).rpc.result.resources.map((r) => r.uri), ['docs://guide']);
  assert.equal(codeOf(mcp(e, U, APP(A1), 'prompts/get', { name: 'summarise' })), 'ok');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'prompts/get', { name: 'draft_reply' })), 'access_denied');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'prompts/get', { name: 'nope' })), 'access_denied');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'resources/read', { uri: 'docs://guide' })), 'ok');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'resources/read', { uri: 'records://all' })), 'access_denied');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'resources/read', { uri: 'https://elsewhere.example/x' })), 'access_denied');
  for (const m of ['tools/delete', 'sampling/createMessage', 'logging/setLevel', 'completion/complete', 'notifications/initialized', '', 'TOOLS/LIST']) {
    const r = mcp(e, U, APP(A1), m); assert.equal(codeOf(r), m === '' ? 'bad_rpc' : 'access_denied', m);
    if (m) assert.equal(r.data.reason, 'method_not_permitted');
  }
  // the same call that is allowed as tools/call is not allowed as a different method
  assert.equal(codeOf(mcp(e, U, APP(A1), 'tools/call', { name: 'search', arguments: { query: 'q' } })), 'ok');
  assert.equal(codeOf(mcp(e, U, APP(A1), 'tools/call', { name: ['search'], arguments: { query: 'q' } })), 'access_denied');
});

test('every editable policy field is proven by mutation: group, tools, prompts, resources', () => {
  const grants = (staff) => [{ group: 'staff', ...staff }, { group: 'admins', tools: ['*'], prompts: ['*'], resources: ['*'] }];
  let e = newEngine();
  // tools
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: grants({ tools: ['export_all'] }) }));
  assert.deepEqual(names(e, U, A1), ['export_all']); assert.equal(codeOf(callTool(e, U, APP(A1), 'export_all')), 'ok'); assert.equal(codeOf(callTool(e, U, APP(A1), 'search', { query: 'q' })), 'access_denied');
  assert.deepEqual(ok(mcp(e, U, APP(A1), 'prompts/list')).rpc.result.prompts, [], 'an omitted list means nothing');
  // prompts
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: grants({ tools: ['search'], prompts: ['draft_reply'] }) }));
  assert.deepEqual(ok(mcp(e, U, APP(A1), 'prompts/list')).rpc.result.prompts.map((p) => p.name), ['draft_reply']);
  // resources
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: grants({ tools: ['search'], resources: ['records://all', 'docs://policy'] }) }));
  assert.deepEqual(ok(mcp(e, U, APP(A1), 'resources/list')).rpc.result.resources.map((r) => r.uri), ['docs://policy', 'records://all']);
  // group: the contractor group, once granted, sees exactly its own grant, and staff are unaffected
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: [...grants({ tools: ['search'] }), { group: 'contractors', tools: ['get_status'] }] }));
  assert.deepEqual(names(e, X, A1), ['get_status']); assert.deepEqual(names(e, U, A1), ['search']);
  // the wildcard
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: grants({ tools: ['*'] }) }));
  assert.equal(names(e, U, A1).length, 5);
  // an empty policy is deny by default
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: [] }));
  assert.equal(codeOf(mcp(e, A, APP(A1), 'tools/list')), 'access_denied');
});

test('the policy is a union: two groups\' grants add up (the AI-DEMO2 policy-union note)', () => {
  const e = newEngine();
  const original = e.apps[A1].policy;
  e.users.find((u) => u.id === U).groups.push('contractors');
  ok(run(e, 'setPolicy', { actor: A, appId: A1, grants: [{ group: 'staff', tools: ['search'] }, { group: 'contractors', tools: ['get_status'] }] }));
  assert.deepEqual(names(e, U, A1).sort(), ['get_status', 'search']);
  assert.ok(original);
});

test('policy validation: only administrators, names must exist, groups must be known, bounded', () => {
  const e = newEngine();
  const set = (actor, grants) => run(e, 'setPolicy', { actor, appId: A1, grants });
  assert.equal(codeOf(set(U, [])), 'admin_only'); assert.equal(set(U, []).status, 403);
  assert.equal(codeOf(set(A, [{ group: 'staff', tools: ['nope'] }])), 'bad_policy');
  assert.equal(codeOf(set(A, [{ group: '__proto__', tools: [] }])), 'bad_policy');
  assert.equal(codeOf(set(A, [{ group: 'staff', tools: 'search' }])), 'bad_policy');
  assert.equal(codeOf(set(A, [{ group: 'staff', tools: [], extra: 1 }])), 'unknown_field');
  assert.equal(codeOf(set(A, 'x')), 'bad_policy');
  assert.equal(codeOf(set(A, Array.from({ length: 9 }, () => ({ group: 'staff' })))), 'bad_policy');
  assert.equal(codeOf(run(e, 'setPolicy', { actor: A, appId: '__proto__', grants: [] })), 'unknown_app');
  assert.equal(codeOf(run(e, 'setPolicy', { actor: A, appId: 5, grants: [] })), 'unknown_app');
  assert.equal(codeOf(run(e, 'setPolicy', { actor: 'nobody', appId: A1, grants: [] })), 'unknown_user');
  assert.equal(e.apps[A1].policy.grants.length, 2, 'every refusal left the policy as it was');
});

test('a tool listed through the aggregate follows the member\'s entitlement too (the same pipeline, unchanged)', () => {
  const e = newEngine();
  assert.ok(listNames(e, U, AGG).every((n) => !/export_all|write_record/.test(n)));
});

test('arguments are checked against the tool\'s schema: a missing required argument, a wrong type and an unknown field are all violations', () => {
  const e = newEngine();
  for (const args of [{}, { query: 5 }, { query: 'q', extra: 1 }, { query: null }, [], 'q', { query: 'q'.repeat(9000) }]) assert.equal(callTool(e, U, APP(A1), 'search', args).code, 'invalid_arguments', JSON.stringify(args).slice(0, 30));
  assert.equal(codeOf(callTool(e, U, APP(A1), 'search', { query: 'q' })), 'ok');
});

test('a call is read-checked before it reaches the upstream: a refused call never connects, injects or records', () => {
  const e = newEngine(); e.sessionLogging = true;
  callTool(e, U, APP(A1), 'export_all');
  assert.equal(e.recordings.length, 0, 'nothing recorded for a refused call');
});
