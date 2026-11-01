// The aggregate: namespacing, the cap enforced twice (each point proven alone), lazy connections, members that are missing, down or hang, and every editable field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { A, A2, A1, A2N, A3, A4, A5, AGG, APP, MISS, U, U2, X, C, callTool, codeOf, listNames, mcp, newEngine, ok, run } from './helpers.js';

const members = (e) => e.snapshot().aggregates[0].members;
const conn = (e, name) => members(e).find((m) => m.effectiveAlias === name).connection;

test('one listing, every member\'s tools under its alias; identical tool names never collide', () => {
  const e = newEngine();
  const names = listNames(e, A, AGG);
  assert.ok(names.includes(`${A1}__search`) && names.includes(`${A2N}__search`) && names.includes(`${A3}__search`));
  assert.equal(new Set(names).size, names.length, 'no collision');
  assert.ok(names.every((n) => n.includes('__')));
  // a tool whose own name holds "__" is split at the FIRST separator, so the alias stays unambiguous
  assert.equal('a__b__c'.indexOf('__'), 1);
});

test('the default alias is the application\'s own name; an explicit alias replaces it; an alias with an underscore is refused', () => {
  const e = newEngine();
  assert.equal(members(e)[0].effectiveAlias, A1);
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: 'books' }));
  assert.equal(members(e)[0].effectiveAlias, 'books'); assert.equal(members(e)[0].alias, 'books');
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: '' }));
  assert.equal(members(e)[0].effectiveAlias, A1, 'an empty alias goes back to the default');
  for (const bad of ['a__b', 'A', '1a', 'has space', 'x'.repeat(33), '', 5, null]) {
    const r = run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: bad });
    if (bad === '') continue; // the empty string is the reset above
    assert.equal(codeOf(r), 'bad_alias', String(bad));
  }
});

test('alias collisions: an explicit alias equal to another member\'s alias or default name is refused, in both directions', () => {
  const e = newEngine();
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: A2N })), 'alias_collision');
  assert.equal(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: A2N }).status, 409);
  // adding a new member whose default name equals an existing explicit alias
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: 'books' }));
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: 'books' })), 'alias_collision', 'a new member whose own name equals an existing alias');
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A2N, alias: A1 })); // the freed default name can be taken by another member
  assert.equal(members(e).filter((m) => m.effectiveAlias === A1).length, 1);
  assert.equal(members(e).length, 6, 'a refused member was not added');
});

test('the cap at the aggregate: a tool the member allows but the aggregate denies is hidden from the listing and refused at the call', () => {
  const e = newEngine();
  assert.ok(!listNames(e, U, AGG).includes(`${A2N}__create_item`));
  const r = callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  assert.equal(codeOf(r), 'access_denied'); assert.equal(r.status, 403);
  assert.equal(r.data.enforcedAt, 'aggregate');
  assert.equal(r.data.rpc.error.code, -32600); assert.equal(r.data.wire.httpStatus, 200, 'measured wire form: a JSON-RPC error with HTTP 200');
  // the member itself WOULD have allowed it for staff, called directly
  assert.equal(codeOf(callTool(e, U, APP(A2N), 'create_item', { name: 'x' })), 'ok');
});

test('the cap at the member hop: a tool the aggregate allows but the member denies is refused at the member hop (and not listed)', () => {
  const e = newEngine();
  assert.ok(!listNames(e, U, AGG).includes(`${A2N}__refund_item`), 'entitlement-aware: the member denies it, so it is not listed');
  const r = callTool(e, U, AGG, `${A2N}__refund_item`, { id: 'r-1' });
  assert.equal(codeOf(r), 'access_denied');
  assert.equal(r.data.enforcedAt, 'member-hop (member policy)');
  assert.equal(r.data.reason, 'not_in_policy');
});

test('each enforcement point alone is enough: switching one off still refuses, switching both off lets the call through', () => {
  const e = newEngine();
  ok(run(e, 'setFault', { actor: A, aggregateSkipsCheck: true }));
  const second = callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  assert.equal(codeOf(second), 'access_denied'); assert.equal(second.data.enforcedAt, 'member-hop (aggregate cap)', 'the member hop carries the aggregate cap');
  ok(run(e, 'setFault', { actor: A, aggregateSkipsCheck: false, hopIgnoresCap: true }));
  const first = callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  assert.equal(first.data.enforcedAt, 'aggregate', 'the aggregate check still refuses when the hop ignores the cap');
  ok(run(e, 'setFault', { actor: A, aggregateSkipsCheck: true, hopIgnoresCap: true }));
  assert.equal(codeOf(callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' })), 'ok', 'with both layers broken the aggregate is wider than its own policy');
  assert.ok(listNames(e, U, AGG).includes(`${A2N}__create_item`), 'and the listing leaks it');
  ok(run(e, 'setFault', { actor: A, aggregateSkipsCheck: false, hopIgnoresCap: false }));
  assert.equal(codeOf(callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' })), 'access_denied');
});

test('the aggregate policy cannot widen a member: allowed by the aggregate, absent from the member\'s policy, a tool is still not usable (the aggregate is a cap, not a grant)', () => {
  const e = newEngine();
  ok(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff', tools: ['*'] }, { group: 'admins', tools: ['*'] }] }));
  const names = listNames(e, U, AGG);
  assert.ok(!names.includes(`${A1}__export_all`) && !names.includes(`${A2N}__refund_item`), 'allow-all at the aggregate shows only what each member allows');
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__export_all`)), 'access_denied');
});

test('every editable aggregate field matters, proven by mutation: grants (group, tools), a member\'s tool filter, a member\'s alias', () => {
  // grants.tools: add a tool, it appears
  let e = newEngine();
  const base = listNames(e, U, AGG);
  ok(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff', tools: [`${A1}__search`] }, { group: 'admins', tools: ['*'] }] }));
  assert.deepEqual(listNames(e, U, AGG), [`${A1}__search`]); assert.ok(base.length > 1);
  // grants.group: a group with no grant sees nothing; a different group is unaffected
  assert.equal(codeOf(mcp(e, X, AGG, 'tools/list')), 'no_policy', 'contractors have no grant on this aggregate now: deny by default');
  ok(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'contractors', tools: [`${A2N}__get_status`] }] }));
  assert.deepEqual(listNames(e, X, AGG), [`${A2N}__get_status`]);
  assert.equal(codeOf(mcp(e, U, AGG, 'tools/list')), 'no_policy', 'staff lost their grant');
  // toolFilter: intersected with the grant; empty means all
  e = newEngine();
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, toolFilter: { Elems: ['search'] } }));
  assert.deepEqual(listNames(e, U, AGG).filter((n) => n.startsWith(`${A1}__`)), [`${A1}__search`]);
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__read_record`, { id: 'r-1' })), 'not_exposed');
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, toolFilter: { Elems: [] } }));
  assert.equal(listNames(e, U, AGG).filter((n) => n.startsWith(`${A1}__`)).length, 3, 'an empty filter means all (measured)');
  // alias: the names follow it
  ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: 'books' }));
  assert.ok(!listNames(e, A, AGG).some((n) => n.startsWith(`${A1}__`)));
});

test('renaming an alias strands the old grant (measured note): the new names are not granted until the policy is edited', () => {
  const e = newEngine();
  const r = ok(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, alias: 'books' }));
  assert.ok(r.staleGrants > 0);
  assert.ok(!listNames(e, U, AGG).some((n) => n.startsWith('books__')), 'staff see none of the renamed member\'s tools');
  assert.equal(codeOf(callTool(e, U, AGG, `${A1}__search`, { query: 'q' })), 'unknown_server', 'the old prefix is no longer a member alias');
});

test('lazy connection: a listing connects nothing; the first call connects once; later calls reuse it', () => {
  const e = newEngine();
  listNames(e, U, AGG);
  assert.ok(members(e).every((m) => m.connection.connects === 0 && m.connection.state === 'idle'), 'nothing connected by a listing');
  ok(callTool(e, U, AGG, `${A1}__search`, { query: 'q' }));
  assert.equal(conn(e, A1).connects, 1); assert.equal(conn(e, A1).state, 'connected');
  ok(callTool(e, U, AGG, `${A1}__get_status`));
  assert.deepEqual([conn(e, A1).connects, conn(e, A1).calls], [1, 2]);
  assert.equal(conn(e, A3).connects, 0, 'a member never called is never connected');
  // a call refused at the aggregate connects nothing
  callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  assert.equal(conn(e, A2N).attempts, 0);
});

test('members that are missing or unreachable are REPORTED, not silently dropped; a member recorded as sse hangs (measured)', () => {
  const e = newEngine();
  const r = ok(mcp(e, A, AGG, 'tools/list'));
  const rep = Object.fromEntries(r.operator.members.map((m) => [m.alias, m.status]));
  assert.equal(rep[MISS], 'missing'); assert.equal(rep[A4], 'unreachable'); assert.equal(rep[A1], 'not connected yet');
  assert.ok(r.rpc.result.tools.some((t) => t.name === `${A4}__search` && t._meta?.unavailable === 'member_unreachable'), 'a down member\'s tools stay listed, flagged unavailable');
  assert.ok(!r.rpc.result.tools.some((t) => t.name.startsWith(`${MISS}__`)), 'a missing member has no tools to list, but is reported');
  assert.match(r.operator.members.find((m) => m.alias === A5).warning, /sse/);
  const down = callTool(e, A, AGG, `${A4}__search`, { query: 'q' });
  assert.equal(codeOf(down), 'member_unreachable'); assert.equal(down.status, 502); assert.match(down.data.rpc.error.message, new RegExp(`^${A4}:`));
  const gone = callTool(e, A, AGG, `${MISS}__search`, { query: 'q' });
  assert.equal(codeOf(gone), 'member_missing'); assert.equal(gone.status, 404);
  const hung = callTool(e, U, AGG, `${A5}__search`, { query: 'q' });
  assert.equal(codeOf(hung), 'member_timeout'); assert.equal(hung.status, 504); assert.match(hung.data.measured, /AI-DEMO2/);
  assert.equal(conn(e, A5).connects, 0, 'a hung member never connected');
  // the measured fix: record it as streamable-http
  ok(run(e, 'setTransport', { actor: A, appId: A5, transport: 'streamable-http' }));
  assert.equal(codeOf(callTool(e, U, AGG, `${A5}__search`, { query: 'q' })), 'ok');
  // a member that comes back up works
  ok(run(e, 'setAppUp', { actor: A, appId: A4, up: true }));
  assert.equal(codeOf(callTool(e, A, AGG, `${A4}__search`, { query: 'q' })), 'ok');
});

test('refusal shapes: a bare name, an unknown prefix, a tool that does not exist and an ungranted tool', () => {
  const e = newEngine();
  const bare = callTool(e, U, AGG, 'search', { query: 'q' }); assert.equal(codeOf(bare), 'not_namespaced'); assert.equal(bare.status, 400);
  assert.equal(codeOf(callTool(e, U, AGG, 'bogus__search', { query: 'q' })), 'unknown_server');
  const missing = callTool(e, U, AGG, `${A1}__nope`); const ungranted = callTool(e, U, AGG, `${A1}__export_all`);
  assert.equal(codeOf(missing), 'access_denied'); assert.deepEqual(missing.data.rpc, ungranted.data.rpc, 'the same refusal for a tool that does not exist and one that is not granted');
  for (const bad of [undefined, null, 5, {}, [], 'x'.repeat(300), '__x', '__']) assert.ok(['bad_rpc', 'not_namespaced'].includes(callTool(e, U, AGG, bad).code), String(bad));
});

test('the aggregate answers prompts and resources with empty lists (modelled for tools only), and refuses prompts/get and resources/read', () => {
  const e = newEngine();
  assert.deepEqual(ok(mcp(e, U, AGG, 'prompts/list')).rpc.result, { prompts: [] });
  assert.deepEqual(ok(mcp(e, U, AGG, 'resources/list')).rpc.result, { resources: [] });
  assert.equal(codeOf(mcp(e, U, AGG, 'resources/read', { uri: 'docs://guide' })), 'not_modelled');
  assert.equal(codeOf(mcp(e, U, AGG, 'bogus/method')), 'method_not_permitted');
});

test('deny by default at the aggregate: a user with no grant cannot even initialize', () => {
  const e = newEngine();
  ok(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [] }));
  for (const m of ['initialize', 'tools/list', 'tools/call']) assert.equal(codeOf(mcp(e, A, AGG, m, { name: `${A1}__search` })), 'no_policy', m);
  assert.equal(codeOf(mcp(e, A, AGG, 'ping')), 'ok');
});

test('limits and validation: members capped, filters checked against the member\'s tools, only administrators configure, unknown fields refused', () => {
  const e = newEngine();
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: U, aggregateId: 'all-in-one', refId: A1, alias: 'x' })), 'admin_only');
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'nope', refId: A1 })), 'unknown_aggregate');
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, toolFilter: { Elems: ['nope'] } })), 'bad_filter');
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: MISS, toolFilter: { Elems: ['search'] } })), 'member_missing');
  assert.equal(codeOf(run(e, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: A1, extra: 1 })), 'unknown_field');
  assert.equal(codeOf(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff', tools: ['nope__x'] }] })), 'bad_policy');
  assert.equal(codeOf(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff', prompts: ['x'] }] })), 'aggregate_tools_only');
  assert.equal(codeOf(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'nobody', tools: [] }] })), 'bad_policy');
  assert.equal(codeOf(run(e, 'aggSetPolicy', { actor: A, aggregateId: 'all-in-one', grants: [{ group: 'staff' }, { group: 'staff' }] })), 'bad_policy', 'a group once');
  // member cap: add apps until the cap
  const e2 = newEngine();
  for (let i = 0; i < 12 - 6; i++) ok(run(e2, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: `extra-${i}` }));
  assert.equal(codeOf(run(e2, 'aggSetMember', { actor: A, aggregateId: 'all-in-one', refId: 'extra-z' })), 'too_many_members');
  assert.equal(members(e2).length, 12, 'nothing was dropped to make room');
  ok(run(e2, 'aggRemoveMember', { actor: A, aggregateId: 'all-in-one', refId: 'extra-0' }));
  assert.equal(codeOf(run(e2, 'aggRemoveMember', { actor: A, aggregateId: 'all-in-one', refId: 'extra-0' })), 'unknown_member');
});

test('per-user upstream OAuth through an aggregate member, and the member\'s own auth mode applies', () => {
  const e = newEngine();
  const first = callTool(e, U, AGG, `${A3}__list_cases`);
  assert.equal(codeOf(first), 'upstream_authorization_required'); assert.equal(first.status, 401); assert.ok(first.data.authorizationUrl.endsWith('.example/authorize'));
  assert.match(first.data.rpc.error.message, new RegExp(`^${A3}:`));
  ok(run(e, 'upstreamAuthorize', { user: U, appId: A3 }));
  assert.equal(codeOf(callTool(e, U, AGG, `${A3}__list_cases`)), 'ok');
  assert.equal(codeOf(callTool(e, U2, AGG, `${A3}__list_cases`)), 'upstream_authorization_required', 'another user has not authorized: per calling user');
  // the vault member: a user without an entry is refused at the member
  assert.equal(codeOf(callTool(e, U2, AGG, `${A2N}__search`, { query: 'q' })), 'no_vault_credential');
  assert.equal(codeOf(callTool(e, U, AGG, `${A2N}__search`, { query: 'q' })), 'ok');
});

test('the same gateway controls: an aggregate call is audited with the acting user, the enforcement point and the backend identity', () => {
  const e = newEngine();
  callTool(e, U, AGG, `${A1}__read_record`, { id: 'r-1' });
  callTool(e, U, AGG, `${A2N}__create_item`, { name: 'x' });
  const s = e.snapshot().audit.shown;
  const okEntry = s.find((x) => x.kind === 'mcp.call');
  assert.equal(okEntry.actor, U); assert.match(okEntry.target, /aggregate:all-in-one/); assert.equal(okEntry.tool, 'read_record'); assert.equal(okEntry.backend, `service-account:${A1}`); assert.equal(okEntry.credentialMode, 'static-token');
  const refused = s.find((x) => x.kind === 'mcp.refused'); assert.equal(refused.actor, U); assert.equal(refused.enforcedAt, 'aggregate');
});

test('the vertical packs all behave the same (names differ, structure does not)', async () => {
  const { VERTICALS } = await import('../src/cast.js');
  for (const [v, cast] of Object.entries(VERTICALS)) {
    const e = newEngine(cast); const agg = AGG;
    const names = listNames(e, cast.castUser, agg);
    assert.ok(names.includes(`${cast.castApp1}__search`), v);
    assert.equal(codeOf(callTool(e, cast.castUser, agg, `${cast.castApp2}__create_item`, { name: 'x' })), 'access_denied', v);
    assert.equal(codeOf(callTool(e, cast.castUser, agg, `${cast.castApp2}__refund_item`, { id: 'r-1' })), 'access_denied', v);
  }
  assert.ok(C.castApp1);
});

test('the lab clock stops 90 days after it started: 90 full days are allowed, the next minute is a 409 clock_limit that changes nothing (review: no test proved the cap)', () => {
  const e = newEngine();
  for (let i = 0; i < 90; i++) ok(run(e, 'advance', { minutes: 1440 }));
  const before = JSON.stringify([e.snapshot().now, e.snapshot().audit.total ?? e.snapshot().audit.shown.length]);
  const r = run(e, 'advance', { minutes: 1 });
  assert.equal(r.ok, false); assert.equal(r.code, 'clock_limit'); assert.equal(r.status, 409);
  assert.equal(JSON.stringify([e.snapshot().now, e.snapshot().audit.total ?? e.snapshot().audit.shown.length]), before, 'the refusal moved neither the clock nor the audit log');
  assert.equal(run(e, 'advance', { minutes: 1440 }).code, 'clock_limit');
});
