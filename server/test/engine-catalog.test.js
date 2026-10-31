// The catalog and hosted servers: the deploy state machine (every transition and refusal), tenant namespaces, the controls from the first request, configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { A, A2, APP, C, U, U2, callTool, codeOf, listNames, newEngine, ok, run } from './helpers.js';

const ID = `tenant-${C.castHost}/kb`;
const dep = (e, id = ID) => e.snapshot().catalog.deployments.find((d) => d.id === id);
const deploy = (e, over = {}) => run(e, 'catDeploy', { actor: A, entryId: 'kb-search', name: 'kb', ...over });

test('one step: the deployment ends healthy through deploying, with policy, credential injection and audit in place before the first request', () => {
  const e = newEngine();
  const d = ok(deploy(e));
  assert.deepEqual(d.history, ['deploying', 'healthy']); assert.equal(d.state, 'healthy'); assert.equal(d.generation, 1); assert.equal(d.namespace, `tenant-${C.castHost}`);
  assert.deepEqual(listNames(e, U, APP('kb')), ['search_docs', 'get_doc'], 'the read-only tools are granted to staff from the very first request');
  const first = ok(callTool(e, U, APP('kb'), 'search_docs', { query: 'q' }));
  assert.equal(first.operator.enforcedAt, 'gateway (app policy)');
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'mcp.call' && x.actor === U && x.target === 'app:kb'), 'audited, with the acting user');
  assert.ok(e.snapshot().audit.shown.some((x) => x.kind === 'catalog.deploy' && x.actor === A));
  assert.equal(e.snapshot().apps.find((a) => a.id === 'kb').source, 'catalog');
  assert.equal(codeOf(callTool(e, U, APP('kb'), 'nope')), 'access_denied');
});

test('the very first request is also policy-checked: a tool staff were not granted is refused on call number one', () => {
  const e = newEngine();
  ok(deploy(e, { entryId: 'ticket-desk', name: 'tickets' }));
  assert.equal(codeOf(callTool(e, U, APP('tickets'), 'create_ticket', { title: 't' })), 'access_denied', 'the write tool needs a grant');
  assert.equal(codeOf(callTool(e, A, APP('tickets'), 'create_ticket', { title: 't' })), 'ok');
});

test('refusals: an unknown entry (404), an unverified entry (403), a bad name, an unknown tenant, a duplicate, administrators only; each audited', () => {
  const e = newEngine();
  const unk = deploy(e, { entryId: 'nope' }); assert.equal(codeOf(unk), 'unknown_catalog_entry'); assert.equal(unk.status, 404);
  const unv = deploy(e, { entryId: 'community-weather', name: 'w' }); assert.equal(codeOf(unv), 'unverified_catalog_entry'); assert.equal(unv.status, 403);
  assert.equal(codeOf(deploy(e, { entryId: '__proto__' })), 'unknown_catalog_entry'); assert.equal(codeOf(deploy(e, { entryId: 5 })), 'unknown_catalog_entry');
  assert.equal(codeOf(deploy(e, { name: 'Bad Name' })), 'bad_name'); assert.equal(codeOf(deploy(e, { tenant: 'nobody' })), 'unknown_tenant');
  assert.equal(codeOf(deploy(e, { name: C.castApp1 })), 'name_taken');
  assert.equal(codeOf(run(e, 'catDeploy', { actor: U, entryId: 'kb-search', name: 'kb' })), 'admin_only');
  assert.equal(e.snapshot().catalog.deployments.length, 0, 'nothing was deployed by any refusal');
  ok(deploy(e)); assert.equal(codeOf(deploy(e)), 'name_taken'); assert.equal(deploy(e).status, 409);
  const reasons = e.snapshot().audit.shown.filter((x) => x.kind === 'refused').map((x) => x.code);
  assert.ok(reasons.includes('unknown_catalog_entry') && reasons.includes('unverified_catalog_entry'));
});

test('containers are namespaced per tenant: the same name in two tenants is fine, in one tenant it is a clash', () => {
  const e = newEngine();
  ok(deploy(e)); const other = ok(deploy(e, { tenant: C.castTenant2 }));
  assert.equal(other.namespace, `tenant-${C.castTenant2}`); assert.equal(other.appId, null, 'another tenant\'s container has no application on this gateway view');
  assert.equal(codeOf(deploy(e, { tenant: C.castTenant2 })), 'name_taken');
  assert.deepEqual(e.snapshot().catalog.deployments.map((d) => d.namespace).sort(), [`tenant-${C.castHost}`, `tenant-${C.castTenant2}`].sort());
});

test('the lifecycle: healthy, crash (not yet detected), unhealthy on the health check, redeploying, healthy again one generation later', () => {
  const e = newEngine(); ok(deploy(e));
  ok(run(e, 'catCrash', { actor: A, id: ID }));
  assert.equal(dep(e).state, 'healthy', 'a crash is not known until it is detected'); assert.equal(dep(e).container, 'exited');
  const early = callTool(e, U, APP('kb'), 'search_docs', { query: 'q' });
  assert.equal(codeOf(early), 'container_exited'); assert.equal(early.status, 502);
  const h = ok(run(e, 'catHealth', { actor: A, id: ID })); assert.equal(h.state, 'unhealthy'); assert.deepEqual(h.history, ['deploying', 'healthy', 'unhealthy']);
  const down = callTool(e, U, APP('kb'), 'search_docs', { query: 'q' }); assert.equal(codeOf(down), 'deployment_not_healthy'); assert.equal(down.status, 503);
  const r = ok(run(e, 'catRedeploy', { actor: A, id: ID }));
  assert.deepEqual(r.history, ['deploying', 'healthy', 'unhealthy', 'redeploying', 'healthy']); assert.equal(r.generation, 2); assert.equal(r.container, 'running');
  assert.equal(codeOf(callTool(e, U, APP('kb'), 'search_docs', { query: 'q' })), 'ok');
  assert.equal(codeOf(run(e, 'catRedeploy', { actor: A, id: ID })), 'not_needed', 'a healthy deployment is not redeployed for nothing');
  assert.equal(run(e, 'catRedeploy', { actor: A, id: ID }).status, 409);
});

test('a health check on a healthy deployment changes nothing but the probe count', () => {
  const e = newEngine(); ok(deploy(e));
  const before = dep(e); const h = ok(run(e, 'catHealth', { actor: A, id: ID }));
  assert.equal(h.state, 'healthy'); assert.equal(h.probes, before.probes + 1); assert.deepEqual(h.history, before.history);
});

test('every configuration field redeploys, proven by mutation: logLevel and maxResults; an unchanged configuration does not', () => {
  const e = newEngine(); ok(deploy(e));
  const cfg = (config) => run(e, 'catConfigure', { actor: A, id: ID, config });
  let d = ok(cfg({ logLevel: 'debug' })); assert.deepEqual([d.generation, d.config.logLevel, d.state], [2, 'debug', 'healthy']);
  assert.match(d.redeployReason, /configuration change/);
  assert.match(ok(callTool(e, U, APP('kb'), 'search_docs', { query: 'q' })).rpc.result.content[0].text, /"logLevel":"debug"/);
  d = ok(cfg({ maxResults: 2 })); assert.deepEqual([d.generation, d.config.maxResults, d.config.logLevel], [3, 2, 'debug']);
  assert.match(ok(callTool(e, U, APP('kb'), 'search_docs', { query: 'q' })).rpc.result.content[0].text, /"results":2/);
  assert.equal(codeOf(cfg({ maxResults: 2, logLevel: 'debug' })), 'no_change'); assert.equal(dep(e).generation, 3);
  for (const bad of [{ logLevel: 'trace' }, { logLevel: 5 }, { maxResults: 0 }, { maxResults: 51 }, { maxResults: 1.5 }, { maxResults: '3' }, { extra: 1 }, 'x', null]) assert.ok(['bad_config', 'bad_request', 'unknown_field', 'missing_field'].includes(codeOf(cfg(bad))), JSON.stringify(bad));
  assert.equal(dep(e).generation, 3, 'a refused configuration redeployed nothing');
  assert.equal(codeOf(run(e, 'catDeploy', { actor: A, entryId: 'kb-search', name: 'k2', config: { logLevel: 'nope' } })), 'bad_config');
});

test('the hosted container\'s environment holds the CALLING user\'s vault credential (operator view only); no entry means absent', () => {
  const e = newEngine(); ok(deploy(e, { entryId: 'kb-search', name: 'kb' }));
  ok(run(e, 'vaultSet', { actor: U, user: U, appId: 'kb', present: true }));
  const withCred = ok(callTool(e, U, APP('kb'), 'search_docs', { query: 'q' })); const without = ok(callTool(e, U2, APP('kb'), 'search_docs', { query: 'q' }));
  assert.match(withCred.operator.containerEnv.USER_VAULT_CREDENTIAL.fingerprint, /^[0-9a-f]{8}$/); assert.equal(withCred.operator.containerEnv.USER_VAULT_CREDENTIAL.kind, 'mock');
  assert.match(without.operator.containerEnv.USER_VAULT_CREDENTIAL, /^absent/);
  assert.equal(withCred.operator.containerEnv.namespace, `tenant-${C.castHost}`);
  assert.ok(!JSON.stringify(withCred.rpc).includes('USER_VAULT'), 'the agent never sees it');
});

test('customer-published entries are on the roadmap: refused with 501, nothing modelled; the catalog lists the unverified entry but flags it', () => {
  const e = newEngine();
  const r = run(e, 'catPublish', { actor: A }); assert.equal(codeOf(r), 'roadmap'); assert.equal(r.status, 501);
  assert.equal(codeOf(run(e, 'catPublish', { actor: U })), 'admin_only');
  const entries = e.snapshot().catalog.entries; assert.equal(entries.length, 4);
  assert.deepEqual(entries.filter((x) => !x.verified).map((x) => x.id), ['community-weather']);
  assert.ok(entries.filter((x) => x.verified).every((x) => x.arch.length === 2), 'verified entries are multi-architecture (deck claim)');
});

test('caps: the lab runs at most 8 containers and refuses the ninth instead of removing one', () => {
  const e = newEngine();
  for (let i = 0; i < 8; i++) ok(deploy(e, { name: `kb${i}` }));
  assert.equal(codeOf(deploy(e, { name: 'kb9' })), 'too_many_deployments'); assert.equal(e.snapshot().catalog.deployments.length, 8);
});

test('unknown deployment ids and wrong types are refused without echo', () => {
  const e = newEngine(); ok(deploy(e));
  for (const id of ['nope', '__proto__', 5, null, undefined, 'tenant-x/y']) for (const op of ['catCrash', 'catHealth', 'catRedeploy']) assert.ok(['unknown_deployment', 'missing_field'].includes(codeOf(run(e, op, { actor: A, id }))), `${op} ${id}`);
  assert.equal(codeOf(run(e, 'catCrash', { actor: A2, id: ID })), 'ok');
});
