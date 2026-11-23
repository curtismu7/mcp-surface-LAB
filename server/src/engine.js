// The MCP surface engine: the gateway in front of MCP servers, as a deterministic state machine. One Engine per workspace and vertical. No I/O, no
// timer, no clock of its own (the lab clock only moves when a visitor advances it), no randomness except the local RSA keys in jwt.js.
//  - Applications: the tenant's existing MCP applications, each with a per-tool policy and a backend credential mode.
//  - The aggregate: members (alias, tool filter), its own policy that CAPS what any member exposes, enforced on the listing and the call at the aggregate
//    and again at the member hop; members connected lazily; a missing or unreachable member reported, never silently dropped.
//  - The gateway pipeline: the JSON-RPC method and its target are authorized (tools, prompts, resources; listing and invocation), the upstream answer
//    crosses a real wire (JSON, SSE frames, gzip) and listings are filtered in flight, so the agent never learns what it is not entitled to.
// Mixed in from ops-*.js: OpenAPI to MCP, credentials and pass-through, the catalog, OAuth and CIMD, creation, hosting and headless agents.
import { InputError, refuse } from './errors.js';
import { cleanFree } from './credentials.js';
import { NAME_RE, isObj, safeId, scrub, take } from './util.js';
import { encodeAnswer, filterWire, STYLES } from './wire.js';
import { AGENTS, BASE_EPOCH, CATALOG, CIMD_ALLOWLIST_DEFAULT, GROUPS, RECORDS, UPSTREAMS, cimdDocs, roster, seedAggregate, seedApps } from './world.js';
import { AuthServer } from './oauth.js';
import { validateArgs } from './openapi.js';
import { fingerprint, iso } from './common.js';
import { openapiOps } from './ops-openapi.js';
import { credentialOps } from './ops-credentials.js';
import { catalogOps } from './ops-catalog.js';
import { oauthOps } from './ops-oauth.js';
import { creationOps } from './ops-creation.js';
import { aggregateOps } from './ops-aggregate.js';
import { mockTrace } from './gatewayTrace.js';

const AUDIT_HEADROOM = 8;
export const LIMITS = { audit: 500, recordings: 200, apps: 30, members: 12, hops: 40, clockMinutes: 1440, clockTotalDays: 90, grants: 8, listNames: 80 };
export const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'prompts/list', 'prompts/get', 'resources/list', 'resources/read'];
const LIST_METHODS = ['tools/list', 'prompts/list', 'resources/list'];
const DENY_MSG = 'access denied';
// Run observability (rule 27): what each check means in a run record. The key is the last part of the check's id; the value is [layer, kind]. Only a policy point's
// decision is allowed or refused (kind 'policy'). A request the gateway turns away because it is not a well-formed call (kind 'request') is refused when it fails and
// information when it passes. A fault (the application is down, a member is missing or hangs) and a plain step (the in-flight filter ran) are information.
const CHECKS = {
  key: ['agent', 'policy'], scope: ['agent', 'policy'], credential: ['agent', 'request'],
  method: ['gateway', 'policy'], policy: ['privilege', 'policy'], entitlement: ['privilege', 'policy'], cap: ['privilege', 'policy'], toolfilter: ['privilege', 'policy'],
  target: ['gateway', 'request'], kind: ['gateway', 'request'], namespace: ['gateway', 'request'], member: ['gateway', 'request'],
  resolve: ['gateway', 'fault'], reach: ['gateway', 'fault'], connect: ['gateway', 'fault'], filter: ['gateway', 'none'], listing: ['gateway', 'none'],
};
// The id that goes on the stdout line: the word "scope" is one the family's log matchers read, so the key's grant check is written as a grant.
const checkStep = (id) => (id === 'agent.scope' ? 'agent.grant' : id);
// A JSON-RPC method the visitor typed is only ever stored or shown if it is one the gateway knows; anything else is '(unrecognised)'.
const safeMethod = (m) => (METHODS.includes(m) ? m : '(unrecognised)');

// What a recording can hold WITHOUT cutting anything: scrub() keeps at most 12 array items, 24 keys per object, 4 levels and 300 characters per string.
// With session logging on, a call whose arguments exceed that is refused whole (413) rather than recorded in part.
export const RECORDING_LIMITS = { items: 12, keys: 24, depth: 4, chars: 300 };
export function fitsRecording(value) {
  const work = [[value, 0]];
  while (work.length) {
    const [v, d] = work.pop();
    if (typeof v === 'string') { if (v.length > RECORDING_LIMITS.chars) return false; continue; }
    if (v === null || typeof v !== 'object') continue;
    if (d > RECORDING_LIMITS.depth) return false;
    const ks = Array.isArray(v) ? v : Object.keys(v);
    if (ks.length > (Array.isArray(v) ? RECORDING_LIMITS.items : RECORDING_LIMITS.keys)) return false;
    for (const k of Object.keys(v)) { if (!Array.isArray(v) && k.length > 40) return false; work.push([v[k], d + 1]); }
  }
  return true;
}
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });

export class Engine {
  constructor(cast, { faults } = {}) {
    this.cast = cast;
    this.t = 0; // seconds since the lab clock started (2026-11-02T09:00:00Z)
    this.n = { audit: 0, rec: 0, call: 0 };
    this.users = roster(cast);
    this.apps = Object.create(null);
    for (const a of seedApps(cast)) this.putApp(a, UPSTREAMS[a.upstream]);
    this.aggregates = { 'all-in-one': seedAggregate(cast) };
    this.conn = Object.create(null); // `${aggregateId}/${appId}` -> connection counters
    this.faults = { hopIgnoresCap: false, aggregateSkipsCheck: false, ...(faults || {}) };
    this.audit = []; this.auditDropped = 0; this.recordings = []; this.sessionLogging = false;
    this.hops = []; this.hopsTruncated = false; this.trace = null;
    this.gw = null; this.gwTrace = null; // "What Privilege did": the decisions of the call being made, and the finished record (only for a web action, like the hops)
    this.run = null; this.lastRun = null; this.runs = []; // run observability: the events of the action being made, of the last one made, and the runs kept (service.js, runObs.js)
    this.agents = AGENTS(cast).map((a) => ({ ...a }));
    this.tenants = [cast.castHost, cast.castTenant2];
    this.auth = new AuthServer({ host: cast.castHost, docs: cimdDocs(cast), allowlist: CIMD_ALLOWLIST_DEFAULT(cast) });
    this.initCredentials(); this.initOpenapi(); this.initCatalog(); this.initCreation();
  }

  // ---- shared helpers -----------------------------------------------------------------------------------------------------------------------
  now() { return BASE_EPOCH + this.t; }
  recordList() { return RECORDS(this.cast); }
  hop(label, request, response) {
    if (!this.trace) return;
    if (this.hops.length >= LIMITS.hops) { this.hopsTruncated = true; return; }
    this.hops.push({ label, request: scrub(request), response: scrub(response) });
  }
  // "What Privilege did": one decision the simulated gateway really evaluated, in the order it evaluated it. Only called where the code takes the branch, so a check that
  // was never reached is never listed. `evidence` is fixed lab text (never the caller's input). Kept only while a web action is being traced, like hop().
  check(id, label, ok, evidence, outcome) {
    const o = outcome || (ok ? 'pass' : 'fail');
    this.observeCheck(id, label, o, evidence);
    if (!this.gw || this.gw.decisions.length >= 40) return;
    this.gw.decisions.push({ id, label, outcome: o, evidence });
  }
  // ---- run observability (rule 27) ----------------------------------------------------------------------------------------------------------
  // A run is what one visitor action (or one scripted step) decided, in the order the engine decided it, each decision stamped ONCE with the lab clock. An event exists
  // only where the code takes the branch, so nothing is invented and a check that was never reached has no event. The service layer gives the run an id, keeps it and
  // writes its stdout lines (runObs.js); the engine itself does no I/O. Only the actions in actions.js RUN_OPS begin a run.
  beginRun() { this.run = { events: [], actor: null, agent: null, failed: false, seen: new Set() }; this.lastRun = null; }
  endRun() { this.lastRun = this.run ? this.run.events : null; this.run = null; }
  observe(layer, check, outcome, message, detail = {}) {
    if (!this.run) return;
    if (outcome === 'refused') this.run.failed = true;
    this.run.events.push({ at: iso(this.t), layer, check, outcome, message, detail, actor: this.run.actor, agent: this.run.agent });
  }
  observeCheck(id, label, o, evidence) {
    if (!this.run) return;
    const [layer, kind] = CHECKS[id.slice(id.lastIndexOf('.') + 1)] || ['gateway', 'none'];
    if (o === 'fail') this.run.failed = true;
    const outcome = o === 'info' ? 'info' : kind === 'policy' ? (o === 'pass' ? 'allowed' : 'refused') : kind === 'request' && o === 'fail' ? 'refused' : 'info';
    this.observe(layer, checkStep(id), outcome, `${label}: ${evidence}`, layer === 'agent' && this.run.agent ? { agent: this.run.agent } : {});
  }
  // Called BEFORE an action changes anything (perform() does it for every non-pure action), with headroom for the few entries one action can write, so a full
  // log refuses the whole request instead of mutating state and then answering 507.
  assertRoom() { if (this.audit.length + AUDIT_HEADROOM > LIMITS.audit) throw refuse('log_full', `the audit log holds ${LIMITS.audit} entries and is full: reset to start over`, 507); }
  record(kind, fields = {}) {
    if (this.audit.length >= LIMITS.audit) throw refuse('log_full', `the audit log holds ${LIMITS.audit} entries and is full: reset to start over`, 507);
    this.audit.push({ n: ++this.n.audit, at: iso(this.t), kind, ...fields });
  }
  user(id) {
    const u = typeof id === 'string' ? this.users.find((x) => x.id === id) : null;
    if (!u) throw refuse('unknown_user', 'unknown user');
    if (this.run && !this.run.seen.has(u.id)) {
      this.run.seen.add(u.id); this.run.actor ??= u.id;
      this.observe('person', 'caller', 'info', `${u.id} (${u.groups.join(', ')}) is the user this action is for. The lab has no sign-in: the name is a pick from its roster.`, { user: u.id, role: u.role, groups: [...u.groups] });
    }
    return u;
  }
  admin(id) {
    const u = this.user(id);
    if (u.role !== 'admin') { this.observe('privilege', 'admin-only', 'refused', `${u.id} is not a tenant administrator, and only an administrator may do this.`); this.deny('admin_only', { actor: u.id }); throw refuse('admin_only', 'only a tenant administrator may do this', 403); }
    return u;
  }
  // A refusal worth keeping: written to the audit log with the acting user.
  deny(code, fields = {}) { if (this.audit.length < LIMITS.audit) this.audit.push({ n: ++this.n.audit, at: iso(this.t), kind: 'refused', code, ...fields }); else this.auditDropped++; }
  putApp(app, up = {}) {
    this.apps[app.id] = { ...app, tools: (up.tools || []).map((x) => ({ ...x })), prompts: (up.prompts || []).map((x) => ({ ...x })), resources: (up.resources || []).map((x) => ({ ...x })), policy: JSON.parse(JSON.stringify(app.policy)), generation: 1 };
    return this.apps[app.id];
  }
  // One path must resolve to one application: a new name may not equal an application, an aggregate, or an aggregate's path.
  nameInUse(name) { return Object.hasOwn(this.apps, name) || Object.values(this.aggregates).some((a) => a.id === name || a.name === name || a.entryPath === `/${name}/mcp`); }
  appOf(id) {
    if (typeof id !== 'string' || !Object.hasOwn(this.apps, id)) throw refuse('unknown_app', 'unknown application', 404);
    return this.apps[id];
  }
  aggOf(id) {
    if (typeof id !== 'string' || !Object.hasOwn(this.aggregates, id)) throw refuse('unknown_aggregate', 'unknown aggregate', 404);
    return this.aggregates[id];
  }

  // ---- policy -------------------------------------------------------------------------------------------------------------------------------
  // The union of every grant that names one of the user's groups (default deny: no grant, no access).
  grantsOf(policy, user) {
    const out = { tools: new Set(), prompts: new Set(), resources: new Set(), any: false };
    for (const g of policy.grants) if (user.groups.includes(g.group)) { out.any = true; for (const k of ['tools', 'prompts', 'resources']) for (const x of g[k]) out[k].add(x); }
    return out;
  }
  permits(set, name) { return set.has('*') || set.has(name); }

  // Validates and stores a list of grants for an application (bare names) or an aggregate (prefixed tool names, tools only).
  checkGrants(grants, { known, aggregate }) {
    if (!Array.isArray(grants) || grants.length > LIMITS.grants) throw refuse('bad_policy', `a policy has at most ${LIMITS.grants} grants`);
    const seen = new Set(); const out = [];
    for (const g of grants) {
      take(g, ['group', 'tools', 'prompts', 'resources'], ['group']);
      if (typeof g.group !== 'string' || !GROUPS.includes(g.group) || seen.has(g.group)) throw refuse('bad_policy', 'each grant names one known group, once');
      seen.add(g.group);
      const row = { group: g.group, tools: [], prompts: [], resources: [] };
      for (const k of ['tools', 'prompts', 'resources']) {
        const list = g[k] === undefined ? [] : g[k];
        if (!Array.isArray(list) || list.length > LIMITS.listNames) throw refuse('bad_policy', 'a grant list is an array of at most 80 names');
        if (aggregate && k !== 'tools' && list.length) throw refuse('aggregate_tools_only', 'the lab models the aggregate for tools only (resources and prompts through an aggregate were not tested in the AI-DEMO2 notes)');
        for (const x of list) if (x !== '*' && !(typeof x === 'string' && known[k].has(x))) throw refuse('bad_policy', 'a grant names something that does not exist (or is not a name the lab accepts)');
        row[k] = [...new Set(list)];
      }
      out.push(row);
    }
    return out;
  }
  knownOf(app) { return { tools: new Set(app.tools.map((t) => t.name)), prompts: new Set(app.prompts.map((p) => p.name)), resources: new Set(app.resources.map((r) => r.uri)) }; }

  setPolicy(p) {
    take(p, ['actor', 'appId', 'grants'], ['actor', 'appId', 'grants']);
    const a = this.admin(p.actor); const app = this.appOf(p.appId);
    app.policy = { grants: this.checkGrants(p.grants, { known: this.knownOf(app) }) };
    this.record('policy.set', { actor: a.id, app: app.id, grants: app.policy.grants.length });
    return { app: app.id, grants: app.policy.grants.length };
  }
  setTransport(p) {
    take(p, ['actor', 'appId', 'transport'], ['actor', 'appId', 'transport']);
    const a = this.admin(p.actor); const app = this.appOf(p.appId);
    if (p.transport !== 'sse' && p.transport !== 'streamable-http') throw refuse('bad_transport', 'transport is sse or streamable-http');
    app.transport = p.transport;
    this.record('app.transport', { actor: a.id, app: app.id, transport: app.transport });
    return { app: app.id, transport: app.transport };
  }
  setFault(p) {
    take(p, ['actor', 'hopIgnoresCap', 'aggregateSkipsCheck'], ['actor']);
    const a = this.admin(p.actor);
    for (const k of ['hopIgnoresCap', 'aggregateSkipsCheck']) { if (p[k] === undefined) continue; if (typeof p[k] !== 'boolean') throw refuse('bad_fault', 'a fault switch is true or false'); this.faults[k] = p[k]; }
    this.record('fault.set', { actor: a.id, ...this.faults });
    return { ...this.faults };
  }
  setAppUp(p) {
    take(p, ['actor', 'appId', 'up'], ['actor', 'appId', 'up']);
    const a = this.admin(p.actor); const app = this.appOf(p.appId);
    if (typeof p.up !== 'boolean') throw refuse('bad_up', 'up is true or false');
    app.up = p.up;
    this.record('app.up', { actor: a.id, app: app.id, up: app.up });
    return { app: app.id, up: app.up };
  }
  advance(p) {
    take(p, ['minutes'], ['minutes']);
    if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > LIMITS.clockMinutes) throw refuse('bad_clock', `advance by 1 to ${LIMITS.clockMinutes} minutes at a time`);
    if (this.t + p.minutes * 60 > LIMITS.clockTotalDays * 86400) throw refuse('clock_limit', `the lab clock stops ${LIMITS.clockTotalDays} days after it started: reset to start over`, 409);
    this.t += p.minutes * 60;
    this.auth.sweep(this.now());
    this.record('clock.advance', { minutes: p.minutes });
    return { now: iso(this.t) };
  }

  // ---- the gateway pipeline -----------------------------------------------------------------------------------------------------------------
  parseRpc(rpc) {
    take(rpc, ['method', 'params', 'id'], ['method']);
    if (typeof rpc.method !== 'string' || rpc.method.length < 1 || rpc.method.length > 40) throw refuse('bad_rpc', 'the JSON-RPC method is a short string');
    const id = rpc.id === undefined ? 1 : rpc.id;
    if (!Number.isInteger(id) || id < 0 || id > 2 ** 31) throw refuse('bad_rpc', 'the JSON-RPC id is a whole number');
    if (rpc.params !== undefined && !isObj(rpc.params)) throw refuse('bad_rpc', 'params must be an object');
    return { method: rpc.method, params: rpc.params || {}, id };
  }

  // What the caller may see or do on one application, for one JSON-RPC method and its target. Returns { ok, reason } and never throws.
  authorize(app, user, rpc, cap, scope = 'gateway') {
    const g = this.grantsOf(app.policy, user);
    const at = scope === 'member' ? 'Member hop: ' : '';
    const ck = (id, label, ok, evidence, outcome) => this.check(`${scope}.${id}`, at + label, ok, evidence, outcome);
    if (!METHODS.includes(rpc.method)) { ck('method', 'JSON-RPC method', false, 'not one of the methods the gateway permits'); return { ok: false, reason: 'method_not_permitted' }; }
    ck('method', 'JSON-RPC method', true, `${rpc.method} is a method the gateway permits`);
    if (rpc.method === 'ping') return { ok: true };
    if (!g.any) { ck('policy', 'Policy for this caller', false, 'no grant on this application matches the caller\'s groups: denied by default, from the very first initialize'); return { ok: false, reason: 'no_policy' }; } // deny by default, from the very first initialize (measured, AI-DEMO2 note)
    ck('policy', 'Policy for this caller', true, 'a grant on this application matches the caller\'s groups');
    if (rpc.method === 'initialize' || LIST_METHODS.includes(rpc.method)) return { ok: true };
    if (rpc.method === 'tools/call') {
      const name = rpc.params.name;
      if (typeof name !== 'string' || !app.tools.some((t) => t.name === name)) { ck('target', 'Tool exists', false, 'the application has no tool by that name (the caller gets the same bare refusal as for a tool outside its policy)'); return { ok: false, reason: 'unknown_tool' }; }
      ck('target', 'Tool exists', true, `the application has a tool named ${name}`);
      if (!this.permits(g.tools, name)) { ck('entitlement', 'Tool in the caller\'s policy', false, `${name} is not in the policy grants that match the caller`); return { ok: false, reason: 'not_in_policy' }; }
      ck('entitlement', 'Tool in the caller\'s policy', true, `${name} is in a policy grant that matches the caller`);
      if (cap && this.faults.hopIgnoresCap) ck('cap', 'Aggregate cap', true, 'the fault switch "member hop ignores the cap" is on, so the cap carried from the aggregate was not applied', 'info');
      else if (cap) {
        if (!cap.includes(name)) { ck('cap', 'Aggregate cap', false, `${name} is not in the cap the aggregate carried to this hop`); return { ok: false, reason: 'cap' }; }
        ck('cap', 'Aggregate cap', true, `${name} is in the cap the aggregate carried to this hop`);
      }
      return { ok: true };
    }
    if (rpc.method === 'prompts/get') {
      const n = rpc.params.name;
      if (!(typeof n === 'string' && app.prompts.some((x) => x.name === n))) { ck('target', 'Prompt exists', false, 'the application has no prompt by that name'); return { ok: false, reason: 'unknown_prompt' }; }
      ck('target', 'Prompt exists', true, `the application has a prompt named ${n}`);
      if (!this.permits(g.prompts, n)) { ck('entitlement', 'Prompt in the caller\'s policy', false, `${n} is not in the policy grants that match the caller`); return { ok: false, reason: 'not_in_policy' }; }
      ck('entitlement', 'Prompt in the caller\'s policy', true, `${n} is in a policy grant that matches the caller`);
      return { ok: true };
    }
    if (rpc.method === 'resources/read') {
      const u = rpc.params.uri;
      if (!(typeof u === 'string' && app.resources.some((x) => x.uri === u))) { ck('target', 'Resource exists', false, 'the application has no resource at that address'); return { ok: false, reason: 'unknown_resource' }; }
      ck('target', 'Resource exists', true, 'the application has a resource at that address');
      if (!this.permits(g.resources, u)) { ck('entitlement', 'Resource in the caller\'s policy', false, 'the resource is not in the policy grants that match the caller'); return { ok: false, reason: 'not_in_policy' }; }
      ck('entitlement', 'Resource in the caller\'s policy', true, 'the resource is in a policy grant that matches the caller');
      return { ok: true };
    }
    ck('method', 'JSON-RPC method', false, 'the gateway has no handler for this method');
    return { ok: false, reason: 'method_not_permitted' };
  }

  // The upstream MCP server's own answer to one request: it knows nothing of entitlements and lists everything it has.
  upstreamAnswer(app, rpc, identity, userId) {
    const { method, params, id } = rpc;
    if (method === 'initialize') return rpcOk(id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: app.name, version: String(app.generation) } });
    if (method === 'ping') return rpcOk(id, {});
    if (method === 'tools/list') return rpcOk(id, { tools: app.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    if (method === 'prompts/list') return rpcOk(id, { prompts: app.prompts.map((p) => ({ ...p })) });
    if (method === 'resources/list') return rpcOk(id, { resources: app.resources.map((r) => ({ ...r })) });
    if (method === 'prompts/get') return rpcOk(id, { messages: [{ role: 'user', content: { type: 'text', text: `prompt ${params.name}` } }] });
    if (method === 'resources/read') return rpcOk(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: `contents of ${params.uri}` }] });
    const tool = app.tools.find((t) => t.name === params.name);
    return rpcOk(id, this.runTool(app, tool, params.arguments === undefined ? {} : params.arguments, identity, userId));
  }

  validateToolArgs(tool, args) {
    if (!isObj(args)) throw refuse('invalid_arguments', 'arguments must be an object', 400);
    if (JSON.stringify(args).length > 8000) throw refuse('invalid_arguments', 'arguments are too large', 413);
    const bad = validateArgs(tool.inputSchema, args);
    if (bad) throw refuse('invalid_arguments', `the arguments do not match the tool's input schema (${bad})`);
  }

  seedTool(app, tool, args, identity) {
    const sees = identity.kind === 'user' || identity.kind === 'assertion';
    switch (tool.name) {
      case 'search': return text({ hits: 3, scopedTo: identity.actor });
      case 'get_status': return text({ status: 'ok', app: app.name });
      case 'read_record': {
        const r = RECORDS(this.cast).find((x) => x.id === args.id);
        if (!r) return text({ found: false });
        if (sees && r.owner !== identity.actor) return text({ found: false, note: 'the backend scopes records to the caller it can identify' });
        return text({ found: true, record: r.text, owner: r.owner, identifiedCaller: identity.actor });
      }
      case 'write_record': return text({ written: true });
      case 'export_all': return text({ exported: RECORDS(this.cast).filter((r) => !sees || r.owner === identity.actor).length, identifiedCaller: identity.actor });
      case 'create_item': return text({ created: true });
      case 'refund_item': return text({ refunded: true });
      case 'list_cases': return text({ cases: 2, scopedTo: identity.actor });
      case 'close_case': return text({ closed: true });
      case 'bulk_export': return text({ exported: 4 });
      default: return text({ ok: true });
    }
  }
  runTool(app, tool, args, identity, userId) {
    this.validateToolArgs(tool, args);
    if (app.kind === 'openapi') return this.runOpenapiTool(app, tool, args, identity);
    if (app.kind === 'catalog') return this.runCatalogTool(app, tool, args, identity, userId);
    if (app.kind === 'created') return text({ ok: true, note: 'a lab-invented placeholder tool on a newly created application' });
    return this.seedTool(app, tool, args, identity);
  }

  // One request into one application: authorize, connect, inject the credential, cross the wire, filter in flight. `ctx.via` is 'direct' or 'aggregate';
  // `ctx.cap` is the aggregate's cap for this user and member (the permitted bare tool names), carried to the member hop.
  callApp(app, user, rpc, ctx = {}) {
    const member = ctx.via === 'aggregate';
    const where = member ? 'member hop' : 'gateway';
    const dec = this.authorize(app, user, rpc, ctx.cap, member ? 'member' : 'gateway');
    this.hop(member ? `gateway to member hop: ${ctx.alias}` : 'gateway authorizes the JSON-RPC method and target', { method: safeMethod(rpc.method), target: rpc.params.name ?? rpc.params.uri ?? null, user: user.id, capHeader: ctx.cap ? { tools: ctx.cap } : undefined }, { allowed: dec.ok, reason: dec.ok ? undefined : dec.reason });
    if (!dec.ok) {
      const enforcedAt = member ? (dec.reason === 'cap' ? 'member-hop (aggregate cap)' : 'member-hop (member policy)') : 'gateway (app policy)';
      this.deny('policy', { user: user.id, app: app.id, method: safeMethod(rpc.method), reason: dec.reason, enforcedAt });
      throw refuse(DENY_MSG.replace(' ', '_'), `${DENY_MSG}: the request is not permitted by policy`, 403, { reason: dec.reason, enforcedAt, wire: { httpStatus: 403, body: null, note: 'a bare 403 with no JSON-RPC body: the same for no policy, a tool outside the policy, a tool that does not exist (measured, AI-DEMO2 note)' } });
    }
    if (rpc.method === 'ping') return { message: rpcOk(rpc.id, {}), stats: null, credential: null, identity: null, where };
    let identity = { kind: 'anonymous', actor: '(no credential)' }; let credential = null; let conn = null;
    const upstreamCall = ['initialize', 'tools/call', 'prompts/get', 'resources/read'].includes(rpc.method);
    this.cur = { received: null, identity: null, containerEnv: null };
    if (upstreamCall) {
      if (!member) this.check('gateway.reach', 'Application reachable', app.up, app.up ? 'the gateway reached the application' : 'the application is down, so the gateway could not connect');
      if (!member && !app.up) { this.deny('app_unreachable', { user: user.id, app: app.id }); throw refuse('app_unreachable', 'the application is unreachable', 502, { enforcedAt: 'gateway (connect)' }); }
      conn = this.connect(app, ctx);
      let inj;
      try { inj = this.inject(app, user, rpc, ctx); } catch (e) { if (e instanceof InputError) this.check(`${where === 'gateway' ? 'gateway' : 'member'}.credential`, 'Backend credential', false, e.message); throw e; }
      this.check(`${where === 'gateway' ? 'gateway' : 'member'}.credential`, 'Backend credential', true, `credential mode ${inj.received.mode}: the backend sees ${inj.identity.kind === 'anonymous' ? 'no credential' : `${inj.identity.kind} ${inj.identity.actor}`}`);
      identity = inj.identity; credential = inj.received; this.cur.received = inj.received; this.cur.identity = inj.identity;
    }
    let answer;
    try { answer = this.upstreamAnswer(app, rpc, identity, user.id); } catch (e) {
      if (e instanceof InputError) this.observe('resource', 'upstream', e.code === 'invalid_arguments' ? 'refused' : 'info', e.code === 'invalid_arguments' ? `The mock MCP server for ${app.name} checked the arguments against the tool's input schema and answered with an error.` : `The mock MCP server for ${app.name} could not answer (${e.code}).`, { app: app.id, code: e.code });
      throw e;
    }
    this.observe('resource', 'upstream', 'info', `The mock MCP server for ${app.name} answered ${safeMethod(rpc.method)}${rpc.method === 'tools/call' ? ` for ${rpc.params.name}` : ''} with everything it has: it knows nothing of entitlements, and the gateway's filter comes next.`, { app: app.id, method: safeMethod(rpc.method) });
    const style = ctx.style && STYLES.includes(ctx.style) ? ctx.style : (member ? 'sse' : 'json');
    const wire = encodeAnswer(answer, style);
    const g = this.grantsOf(app.policy, user);
    const keep = (kind, it) => (kind === 'tools' ? this.permits(g.tools, it.name) : kind === 'prompts' ? this.permits(g.prompts, it.name) : this.permits(g.resources, it.uri));
    const out = filterWire(wire, keep);
    const filtered = out.stats.frames.filter((f) => f.listing);
    this.check(`${where === 'gateway' ? 'gateway' : 'member'}.filter`, 'In-flight filter', true, filtered.length
      ? `${filtered.map((f) => `${f.listing}: ${f.before} in the upstream answer, ${f.after} let through`).join('; ')}`
      : 'no listing in the upstream answer; every frame was checked for hidden names and none was found', 'pass');
    if (!member && this.gw) this.gw.wire = out.headers;
    this.hop(`upstream wire (${style}) then the in-flight filter`, { style, upstreamChunks: out.stats.upstreamChunks }, { frames: out.stats.frames.map((f) => ({ kind: f.kind, listing: f.listing, before: f.before, after: f.after })) });
    const message = out.messages.find((m) => m.id !== undefined) || out.messages[out.messages.length - 1];
    if (!message) throw refuse('unparseable_frame', 'the upstream response carried no message the lab could read, so it was refused', 502);
    return { message, stats: out.stats, credential, identity, conn, where, style };
  }

  // Lazy connection: a member is connected the first time a tool is actually called, never by a listing (the deck: "connected on demand").
  connect(app, ctx) {
    if (!ctx.aggregateId) return null;
    const k = `${ctx.aggregateId}/${app.id}`;
    const c = this.conn[k] || (this.conn[k] = { state: 'idle', connects: 0, attempts: 0, calls: 0, lastError: '' });
    c.attempts++;
    const cid = 'member.connect'; const clabel = 'Member connection';
    if (!app.up) { this.check(cid, clabel, false, 'the member is unreachable'); c.state = 'failed'; c.lastError = 'member_unreachable'; throw refuse('member_unreachable', `${ctx.alias}: the member is unreachable`, 502, { enforcedAt: 'member-hop (connect)', memberState: 'unreachable' }); }
    if (app.transport === 'sse') { this.check(cid, clabel, false, 'the member is recorded as an event-stream (sse) transport and the lab simulates its 30 second timeout'); c.state = 'failed'; c.lastError = 'member_timeout'; throw refuse('member_timeout', `${ctx.alias}: the member did not answer within the lab's simulated 30 seconds`, 504, { enforcedAt: 'member-hop (connect)', memberState: 'hung', measured: 'AI-DEMO2 note: the aggregate opened an event stream to a member recorded as sse and waited for an event the server never sent; swapping the member for another app on the same server did not help' }); }
    this.check(cid, clabel, true, c.state === 'connected' ? 'the member was already connected' : 'the member was connected now, on demand');
    if (c.state !== 'connected') { c.state = 'connected'; c.connects++; }
    c.calls++;
    return { state: c.state, connects: c.connects, calls: c.calls };
  }

  // ---- the tool call, as the agent makes it --------------------------------------------------------------------------------------------------
  // params: { user | as, target: { kind: 'app' | 'aggregate', id }, rpc: { method, params, id }, style }
  mcp(p) {
    const seen = { target: null, rpc: null }; const startN = this.n.audit;
    this.gw = this.trace ? { decisions: [], who: null, wire: null } : null; this.gwTrace = null;
    try {
      const res = this.mcpCall(p, seen);
      if (this.gw && seen.rpc) this.gwTrace = this.buildGwTrace(seen, res, null, startN);
      return res;
    } catch (e) {
      // A refusal that no check recorded (the call was too large to record, say) is still the gateway's answer: one event, so a refused run never reads as an unexplained one.
      if (e instanceof InputError && seen.rpc && this.run && !this.run.failed) this.observe('gateway', 'verdict', 'refused', `The gateway refused the call: ${e.message}`, { code: e.code });
      if (this.gw && e instanceof InputError) {
        if (!seen.rpc) { try { seen.rpc = this.parseRpc(p.rpc); } catch { /* the request itself was refused before it was a gateway call */ } }
        if (!seen.target && seen.rpc && isObj(p.target) && (p.target.kind === 'app' || p.target.kind === 'aggregate')) seen.target = p.target;
        if (seen.rpc && seen.target) this.gwTrace = this.buildGwTrace(seen, null, e, startN);
      }
      throw e;
    } finally { this.gw = null; }
  }

  // One call as the agent makes it. `seen` is filled as the request becomes known, so a refusal can still be shown as a gateway call.
  mcpCall(p, seen) {
    take(p, ['user', 'as', 'target', 'rpc', 'style'], ['target', 'rpc']);
    take(p.target, ['kind', 'id'], ['kind', 'id']);
    if (p.target.kind !== 'app' && p.target.kind !== 'aggregate') throw refuse('bad_target', 'the target kind is app or aggregate');
    seen.target = p.target;
    const who = this.caller(p);
    const rpc = this.parseRpc(p.rpc);
    seen.rpc = rpc;
    if (p.style !== undefined && !STYLES.includes(p.style)) throw refuse('bad_style', 'style is json, sse, gzip or gzip-sse');
    this.assertRoom();
    this.n.call++;
    this.hop('agent to gateway: JSON-RPC over HTTP', { path: p.target.kind === 'aggregate' && typeof p.target.id === 'string' && Object.hasOwn(this.aggregates, p.target.id) ? this.aggregates[p.target.id].entryPath : p.target.kind === 'app' && typeof p.target.id === 'string' && Object.hasOwn(this.apps, p.target.id) ? this.apps[p.target.id].entryPath : '(unknown path)', method: safeMethod(rpc.method), as: who.label }, { note: 'the agent holds no backend credential' });
    if (rpc.method === 'tools/call' && this.sessionLogging && !fitsRecording(rpc.params.arguments)) throw refuse('arguments_too_large_to_record', `session logging is on and these arguments exceed what a recording holds without cutting anything (${RECORDING_LIMITS.items} list items, ${RECORDING_LIMITS.keys} keys, ${RECORDING_LIMITS.depth} levels, ${RECORDING_LIMITS.chars} characters per text): the call is refused whole`, 413);
    if (rpc.method === 'tools/call' && this.sessionLogging && this.recordings.length >= LIMITS.recordings) throw refuse('recording_full', `session logging is on and the recording holds ${LIMITS.recordings} calls: the call is refused rather than left unrecorded. Reset to start over`, 507);
    const run = () => (p.target.kind === 'aggregate' ? this.callAggregate(this.aggOf(p.target.id), who.user, rpc, p) : this.directCall(this.appOf(p.target.id), who.user, rpc, p));
    let res;
    try { res = run(); } catch (e) {
      if (e instanceof InputError) this.audit.length < LIMITS.audit && this.audit.push({ n: ++this.n.audit, at: iso(this.t), kind: 'mcp.refused', actor: who.label, target: this.targetLabel(p.target), method: safeMethod(rpc.method), code: e.code, enforcedAt: e.data?.enforcedAt || '' });
      throw e;
    }
    this.afterCall(who, p, rpc, res);
    return res;
  }
  targetLabel(t) { return typeof t?.id === 'string' && (Object.hasOwn(this.apps, t.id) || Object.hasOwn(this.aggregates, t.id)) ? `${t.kind}:${t.id}` : `${t.kind === 'aggregate' ? 'aggregate' : 'app'}:(unknown)`; }
  // The trace of one call: the request as the agent sent it, the answer it got, and the decisions the simulated gateway evaluated between them (all `checked`, because
  // this gateway computed them). The agent holds no key the lab models, so the Authorization line names who the caller is. Nothing the visitor typed goes in unmasked
  // (scrub), and a refusal the engine gave no wire body for shows no body.
  buildGwTrace(seen, res, err, startN) {
    const { target, rpc } = seen;
    const known = typeof target.id === 'string' && (target.kind === 'aggregate' ? Object.hasOwn(this.aggregates, target.id) : Object.hasOwn(this.apps, target.id));
    const path = known ? (target.kind === 'aggregate' ? this.aggregates[target.id] : this.apps[target.id]).entryPath : '/(unknown path)';
    const decisions = this.gw.decisions.map((d) => ({ ...d }));
    const d = err?.data || {};
    if (err && !decisions.some((x) => x.outcome === 'fail')) decisions.push({ id: 'refused', label: 'Refused', outcome: 'fail', evidence: err.message });
    if (!fitsRecording(rpc.params)) decisions.push({ id: 'display', label: 'Request shown shortened', outcome: 'info', evidence: 'the lab keeps at most 12 list items, 24 keys, 4 levels and 300 characters per text when it shows what a visitor typed; the engine saw the whole request' });
    const status = err ? (d.wire?.httpStatus ?? err.status) : (res.wire?.httpStatus ?? 200);
    const body = err ? (d.rpc ?? d.wire?.body ?? null) : res.rpc;
    const headers = err ? (body === null ? {} : { 'content-type': 'application/json' }) : (this.gw.wire || { 'content-type': 'application/json' });
    const last = this.audit.filter((a) => a.n > startN).pop();
    return mockTrace({
      url: `https://gateway.example.invalid${path}`,
      authorization: `Bearer <${this.gw.who || 'caller not identified'}: the lab does not model the credential value>`,
      rpc: { jsonrpc: '2.0', id: rpc.id, method: safeMethod(rpc.method), params: scrub(rpc.params) },
      status, headers, body, decisions,
      record: last ? `Audit entry ${last.n}: ${last.kind}${last.code ? ` (${last.code})` : ''}${last.decision ? `, ${last.decision}` : ''}.` : null,
    });
  }
  // The caller: a signed-in user, or a headless agent acting as its owning user (the same policy and audit apply).
  caller(p) {
    if (p.as !== undefined) {
      if (p.user !== undefined) throw refuse('ambiguous_identity', 'give either a user or a headless agent, not both');
      const ag = typeof p.as === 'string' ? this.agents.find((a) => a.id === p.as) : null;
      if (!ag) throw refuse('unknown_agent', 'unknown agent', 404);
      if (this.gw) this.gw.who = `agent key of ${ag.id}`;
      if (this.run) { this.run.agent = ag.id; this.run.actor = ag.owner; }
      this.check('agent.key', 'Agent key', ag.enabled, ag.enabled ? 'the key is enabled' : 'the key has been revoked');
      if (!ag.enabled) { this.deny('agent_revoked', { agent: ag.id }); throw refuse('agent_revoked', 'this agent has been revoked', 401); }
      this.check('agent.scope', 'Key scope', ag.scopes.includes('mcp'), ag.scopes.includes('mcp') ? 'the key is scoped for mcp access' : 'the key is not scoped for mcp access');
      if (!ag.scopes.includes('mcp')) { this.deny('key_not_scoped_for_mcp', { agent: ag.id }); throw refuse('key_not_scoped_for_mcp', 'this key is not scoped for mcp access (measured wording, AI-DEMO2 note)', 403); }
      return { user: this.user(ag.owner), label: `agent:${ag.id} for ${ag.owner}`, agent: ag };
    }
    const u = this.user(p.user);
    if (this.gw) this.gw.who = `signed-in user ${u.id}`;
    return { user: u, label: u.id };
  }
  directCall(app, user, rpc, p) {
    this.check('gateway.kind', 'MCP application', app.kind !== 'http', app.kind === 'http' ? 'this application is an HTTP application, not an MCP server' : 'the application is an MCP server');
    if (app.kind === 'http') throw refuse('not_an_mcp_application', 'this application is an HTTP application, not an MCP server', 400);
    const r = this.callApp(app, user, rpc, { via: 'direct', style: p.style });
    this.hop('gateway to agent', { status: 200 }, { message: r.message.result ? Object.keys(r.message.result) : r.message.error });
    return {
      rpc: r.message,
      wire: { httpStatus: 200, style: r.style, note: 'a member app answers in whatever form the server uses; the lab streams or compresses it on request' },
      operator: { enforcedAt: 'gateway (app policy)', toolName: rpc.method === 'tools/call' ? rpc.params.name : undefined, credential: r.credential, backendIdentity: r.identity, containerEnv: this.cur?.containerEnv || undefined, frames: r.stats?.frames || [], log: this.removalLog(r.stats) },
    };
  }
  removalLog(stats) { return (stats?.frames || []).flatMap((f) => (f.hidden || []).map((n) => `Removing unauthorized ${f.listing === 'tools' ? 'tool' : f.listing === 'prompts' ? 'prompt' : 'resource'} from MCP response: ${n}`)); }

  afterCall(who, p, rpc, res) {
    const isCall = rpc.method === 'tools/call';
    const name = isCall && typeof rpc.params.name === 'string' ? rpc.params.name : null;
    this.record('mcp.call', { actor: who.label, target: this.targetLabel(p.target), method: rpc.method, tool: res.operator?.toolName ?? null, decision: 'allow', enforcedAt: res.operator?.enforcedAt || '', backend: res.operator?.backendIdentity?.actor ?? null, credentialMode: res.operator?.credential?.mode ?? null });
    if (isCall && this.sessionLogging) {
      this.recordings.push({ n: ++this.n.rec, at: iso(this.t), actor: who.label, target: this.targetLabel(p.target), tool: res.operator?.toolName ?? null, arguments: scrub(rpc.params.arguments ?? {}) });
    }
  }

  // ---- the aggregate ------------------------------------------------------------------------------------------------------------------------
  aliasOf(m) { return m.alias || m.appRef.RefID; }
  resolve(m) { return Object.hasOwn(this.apps, m.appRef.RefID) ? this.apps[m.appRef.RefID] : null; }
  // The cap for one member and one user: the bare tool names the aggregate's policy and the member's tool filter allow.
  capFor(agg, m, user, app) {
    const g = this.grantsOf(agg.policy, user); const al = this.aliasOf(m);
    const filter = m.toolFilter.Elems;
    return app.tools.map((t) => t.name).filter((n) => this.permits(g.tools, `${al}__${n}`) && (!filter.length || filter.includes(n)));
  }
  memberStatus(agg, m) {
    const app = this.resolve(m);
    if (!app) return { status: 'missing', note: 'the application this member refers to does not exist: reported, not silently dropped' };
    const c = this.conn[`${agg.id}/${app.id}`];
    if (!app.up || (c?.state === 'failed' && c.lastError === 'member_unreachable')) return { status: 'unreachable', note: 'the member is down: its tools stay listed as unavailable, and a call fails with the reason' };
    const warn = app.transport === 'sse' ? 'recorded transport is sse: a call may hang (measured, AI-DEMO2 note: the aggregate waits on an event stream the server never sends)' : '';
    return { status: c?.state === 'connected' ? 'connected' : 'not connected yet', note: warn || 'connected on demand, when a tool is first called', warning: warn };
  }

  callAggregate(agg, user, rpc, p) {
    const g = this.grantsOf(agg.policy, user);
    this.hop('aggregate endpoint: the aggregate\'s own policy', { method: safeMethod(rpc.method), user: user.id }, { granted: g.any });
    const jerr = (code, status, rpcCode, msg, extra = {}) => { throw refuse(code, msg, status, { rpc: rpcErr(rpc.id, rpcCode, msg), wire: { httpStatus: 200, note: 'the aggregate returns its refusals as JSON-RPC errors with HTTP 200 (measured, AI-DEMO2 note)' }, ...extra }); };
    this.check('aggregate.method', 'Aggregate: JSON-RPC method', METHODS.includes(rpc.method), METHODS.includes(rpc.method) ? `${rpc.method} is a method the gateway permits` : 'not one of the methods the gateway permits');
    if (!METHODS.includes(rpc.method)) { this.deny('method_not_permitted', { user: user.id, aggregate: agg.id }); jerr('method_not_permitted', 403, -32601, 'method not permitted', { enforcedAt: 'aggregate', reason: 'method_not_permitted' }); }
    if (rpc.method !== 'ping') this.check('aggregate.policy', 'Aggregate: policy for this caller', g.any, g.any ? 'a grant on the aggregate matches the caller\'s groups' : 'no grant on the aggregate matches the caller\'s groups: denied by default');
    if (rpc.method !== 'ping' && !g.any) { this.deny('no_policy', { user: user.id, aggregate: agg.id }); jerr('no_policy', 403, -32600, 'request refused by policy', { enforcedAt: 'aggregate', reason: 'no_policy' }); }
    const base = { wire: { httpStatus: 200, style: 'json', note: 'the aggregate answers in plain JSON (measured, AI-DEMO2 note)' } };
    if (rpc.method === 'ping') return { rpc: rpcOk(rpc.id, {}), ...base, operator: {} };
    if (rpc.method === 'initialize') return { rpc: rpcOk(rpc.id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: `${agg.id}-aggregate`, version: '1' } }), ...base, operator: {} };
    if (rpc.method === 'prompts/list') return { rpc: rpcOk(rpc.id, { prompts: [] }), ...base, operator: { note: 'the lab models the aggregate for tools only' } };
    if (rpc.method === 'resources/list') return { rpc: rpcOk(rpc.id, { resources: [] }), ...base, operator: { note: 'the lab models the aggregate for tools only' } };
    if (rpc.method === 'prompts/get' || rpc.method === 'resources/read') jerr('not_modelled', 400, -32601, 'the lab models the aggregate for tools only', { enforcedAt: 'aggregate' });
    if (rpc.method === 'tools/list') return this.listAggregate(agg, user, rpc, base);
    return this.callThroughAggregate(agg, user, rpc, p, base, jerr);
  }

  // tools/list through the aggregate: the members' recorded catalogs, cut by the aggregate's policy (the cap) and the member's own entitlement. A listing never
  // connects a member (lab reading: the catalog and the health are recorded). Missing and unreachable members are reported.
  listAggregate(agg, user, rpc, base) {
    const g = this.grantsOf(agg.policy, user); const tools = []; const members = [];
    for (const m of agg.members) {
      const al = this.aliasOf(m); const app = this.resolve(m); const st = this.memberStatus(agg, m);
      const row = { alias: al, appId: m.appRef.RefID, ...st, listed: [], hiddenByAggregate: [], hiddenByMember: [] };
      if (app && app.kind !== 'http') {
        const mg = this.grantsOf(app.policy, user);
        const filter = m.toolFilter.Elems;
        for (const t of app.tools) {
          const aggOk = this.faults.aggregateSkipsCheck || (this.permits(g.tools, `${al}__${t.name}`) && (!filter.length || filter.includes(t.name)));
          const memOk = mg.any && this.permits(mg.tools, t.name);
          if (!aggOk) { if (memOk) row.hiddenByAggregate.push(`${al}__${t.name}`); continue; } // not the agent's business: counted for the operator only when the member would have allowed it
          if (!memOk) { row.hiddenByMember.push(`${al}__${t.name}`); continue; }
          tools.push({ name: `${al}__${t.name}`, description: t.description, inputSchema: t.inputSchema, ...(st.status === 'unreachable' ? { _meta: { unavailable: 'member_unreachable' } } : {}) });
          row.listed.push(`${al}__${t.name}`);
        }
      }
      members.push(row);
    }
    const sum = (k) => members.reduce((n, x) => n + x[k].length, 0);
    this.check('aggregate.listing', 'Aggregate: listing cut by the aggregate policy', true, `${tools.length} tool${tools.length === 1 ? '' : 's'} listed across ${members.length} member${members.length === 1 ? '' : 's'}; ${sum('hiddenByAggregate')} left out by the aggregate policy or a member tool filter (only counted where the member itself would have allowed them), ${sum('hiddenByMember')} left out by the member's own policy; no member was connected`);
    this.hop('aggregate lists: members resolved lazily, no member connected', { members: agg.members.length }, { tools: tools.length, members: members.map((x) => `${x.alias}: ${x.status}`) });
    return { rpc: rpcOk(rpc.id, { tools }), ...base, operator: { enforcedAt: 'aggregate (listing)', members, connectsThisCall: 0, log: members.flatMap((x) => x.hiddenByAggregate.map((n) => `Removing tool the aggregate policy does not permit: ${n}`)) } };
  }

  callThroughAggregate(agg, user, rpc, p, base, jerr) {
    const name = rpc.params.name;
    if (typeof name !== 'string' || name.length > 200) jerr('bad_rpc', 400, -32602, 'a tool name is required', { enforcedAt: 'aggregate' });
    const i = name.indexOf('__');
    this.check('aggregate.namespace', 'Aggregate: tool name is <alias>__<tool>', i > 0, i > 0 ? 'the tool name carries a member alias prefix' : 'the tool name has no member alias prefix');
    if (i <= 0) { this.deny('not_namespaced', { user: user.id, aggregate: agg.id }); jerr('not_namespaced', 400, -32600, 'the tool name is not namespaced; expected <alias>__<tool>', { enforcedAt: 'aggregate', reason: 'not_namespaced' }); }
    const alias = name.slice(0, i); const bare = name.slice(i + 2);
    const m = agg.members.find((x) => this.aliasOf(x) === alias);
    this.check('aggregate.member', 'Aggregate: member alias', !!m, m ? 'the prefix is the alias of a member of this aggregate' : 'the prefix is not the alias of any member');
    if (!m) { this.deny('unknown_server', { user: user.id, aggregate: agg.id }); jerr('unknown_server', 404, -32600, 'unknown server: the prefix is not a member alias', { enforcedAt: 'aggregate', reason: 'unknown_server' }); }
    const g = this.grantsOf(agg.policy, user);
    // First enforcement, at the aggregate: the prefixed name must be in the aggregate's policy. A tool that does not exist gets the same refusal.
    if (!this.faults.aggregateSkipsCheck) {
      this.check('aggregate.entitlement', 'Aggregate: tool in the aggregate policy (first enforcement)', this.permits(g.tools, name), this.permits(g.tools, name) ? 'the prefixed tool name is in an aggregate policy grant that matches the caller' : 'the prefixed tool name is not in the aggregate policy (a tool that does not exist gets the same refusal)');
      if (!this.permits(g.tools, name)) { this.deny('policy', { user: user.id, aggregate: agg.id, method: rpc.method, reason: 'not_in_aggregate_policy', enforcedAt: 'aggregate' }); jerr('access_denied', 403, -32600, 'access denied', { enforcedAt: 'aggregate', reason: 'not_in_aggregate_policy' }); }
      if (m.toolFilter.Elems.length) this.check('aggregate.toolfilter', 'Aggregate: member tool filter', m.toolFilter.Elems.includes(bare), m.toolFilter.Elems.includes(bare) ? 'the tool is in the member\'s tool filter' : 'the tool is not in the member\'s tool filter');
      if (m.toolFilter.Elems.length && !m.toolFilter.Elems.includes(bare)) { this.deny('policy', { user: user.id, aggregate: agg.id, reason: 'filtered', enforcedAt: 'aggregate' }); jerr('not_exposed', 403, -32600, 'not exposed by this aggregate', { enforcedAt: 'aggregate', reason: 'tool_filter' }); }
    } else this.check('aggregate.entitlement', 'Aggregate: first enforcement', true, 'the fault switch "aggregate skips its own check" is on, so the aggregate did not check the tool against its policy or a tool filter', 'info');
    this.hop('aggregate: first enforcement passed', { tool: '(namespaced)', alias }, { allowed: true });
    const app = this.resolve(m);
    this.check('aggregate.resolve', 'Aggregate: member application exists', !!app, app ? 'the application the member refers to exists' : 'the application the member refers to does not exist');
    if (!app) { this.deny('member_missing', { user: user.id, aggregate: agg.id }); jerr('member_missing', 404, -32603, `${alias}: the member application does not exist`, { enforcedAt: 'aggregate (resolve)', memberState: 'missing' }); }
    if (app.kind === 'http') jerr('not_an_mcp_application', 400, -32603, `${alias}: not an MCP server`, { enforcedAt: 'aggregate' });
    // Second enforcement, at the member hop: the member's policy and the aggregate's cap (carried as the cap header) are applied again.
    const cap = this.capFor(agg, m, user, app);
    let r;
    try {
      r = this.callApp(app, user, { method: 'tools/call', id: rpc.id, params: { ...rpc.params, name: bare } }, { via: 'aggregate', alias, cap, aggregateId: agg.id, style: p.style });
    } catch (e) {
      if (e instanceof InputError) {
        const status = e.status; const rpcCode = status === 403 ? -32600 : -32603;
        throw refuse(e.code, e.message, status, { ...(e.data || {}), rpc: rpcErr(rpc.id, rpcCode, `${alias}: ${e.message}`), wire: { httpStatus: 200, note: 'the aggregate returns a member\'s failure as a JSON-RPC error named after the member, with HTTP 200 (measured, AI-DEMO2 note)' } });
      }
      throw e;
    }
    return { rpc: { ...r.message, id: rpc.id }, ...base, operator: { enforcedAt: 'aggregate then member hop', alias, bare: true, toolName: bare, cap, connection: r.conn, credential: r.credential, backendIdentity: r.identity, frames: r.stats?.frames || [], log: [] } };
  }

  // ---- views --------------------------------------------------------------------------------------------------------------------------------
  snapshot() {
    const apps = Object.values(this.apps).map((a) => ({ id: a.id, name: a.name, kind: a.kind, source: a.source, up: a.up, transport: a.transport, authMode: a.authMode, staticHeader: a.staticHeader, entryPath: a.entryPath, generation: a.generation, tools: a.tools.map((t) => ({ name: t.name, description: t.description, readOnly: !!t.readOnly })), prompts: a.prompts.map((x) => x.name), resources: a.resources.map((x) => x.uri), policy: a.policy }));
    return {
      now: iso(this.t), clockSeconds: this.t, users: this.users.map((u) => ({ id: u.id, role: u.role, groups: u.groups })), groups: GROUPS, roster: this.users.map((u) => ({ id: u.id, role: u.role })),
      apps,
      aggregates: Object.values(this.aggregates).map((a) => ({ id: a.id, entryPath: a.entryPath, policy: a.policy, members: a.members.map((m) => ({ appRef: m.appRef, alias: m.alias, effectiveAlias: this.aliasOf(m), toolFilter: m.toolFilter, ...this.memberStatus(a, m), connection: this.conn[`${a.id}/${m.appRef.RefID}`] || { state: 'idle', connects: 0, attempts: 0, calls: 0, lastError: '' } })) })),
      faults: { ...this.faults },
      credentials: this.credentialsView(), openapi: this.openapiView(), catalog: this.catalogView(), oauth: { ...this.auth.snapshot(this.now()), metadata: this.oauthMetadata() }, creation: this.creationView(),
      sessionLogging: this.sessionLogging, recordings: { total: this.recordings.length, shown: this.recordings.slice(-30) },
      agents: this.agents.map((a) => ({ ...a })), tenants: [...this.tenants],
      audit: { total: this.audit.length, shown: this.audit.slice(-60), dropped: this.auditDropped },
      limits: { ...LIMITS },
    };
  }
}
Object.assign(Engine.prototype, aggregateOps, openapiOps, credentialOps, catalogOps, oauthOps, creationOps);
export { fingerprint, iso, safeId, cleanFree, NAME_RE, CATALOG, rpcOk, rpcErr, text };
