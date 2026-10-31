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

export const LIMITS = { audit: 500, recordings: 200, apps: 30, members: 12, hops: 40, clockMinutes: 1440, clockTotalDays: 90, grants: 8, listNames: 80 };
export const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'prompts/list', 'prompts/get', 'resources/list', 'resources/read'];
const LIST_METHODS = ['tools/list', 'prompts/list', 'resources/list'];
const DENY_MSG = 'access denied';
// A JSON-RPC method the visitor typed is only ever stored or shown if it is one the gateway knows; anything else is '(unrecognised)'.
const safeMethod = (m) => (METHODS.includes(m) ? m : '(unrecognised)');

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
    this.audit = []; this.recordings = []; this.sessionLogging = false;
    this.hops = []; this.hopsTruncated = false; this.trace = null;
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
  assertRoom() { if (this.audit.length >= LIMITS.audit) throw refuse('log_full', `the audit log holds ${LIMITS.audit} entries and is full: reset to start over`, 507); }
  record(kind, fields = {}) {
    this.assertRoom();
    this.audit.push({ n: ++this.n.audit, at: iso(this.t), kind, ...fields });
  }
  user(id) {
    const u = typeof id === 'string' ? this.users.find((x) => x.id === id) : null;
    if (!u) throw refuse('unknown_user', 'unknown user');
    return u;
  }
  admin(id) { const u = this.user(id); if (u.role !== 'admin') { this.deny('admin_only', { actor: u.id }); throw refuse('admin_only', 'only a tenant administrator may do this', 403); } return u; }
  // A refusal worth keeping: written to the audit log with the acting user.
  deny(code, fields = {}) { if (this.audit.length < LIMITS.audit) this.audit.push({ n: ++this.n.audit, at: iso(this.t), kind: 'refused', code, ...fields }); }
  putApp(app, up = {}) {
    this.apps[app.id] = { ...app, tools: (up.tools || []).map((x) => ({ ...x })), prompts: (up.prompts || []).map((x) => ({ ...x })), resources: (up.resources || []).map((x) => ({ ...x })), policy: JSON.parse(JSON.stringify(app.policy)), generation: 1 };
    return this.apps[app.id];
  }
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
  authorize(app, user, rpc, cap) {
    const g = this.grantsOf(app.policy, user);
    if (!METHODS.includes(rpc.method)) return { ok: false, reason: 'method_not_permitted' };
    if (rpc.method === 'ping') return { ok: true };
    if (!g.any) return { ok: false, reason: 'no_policy' }; // deny by default, from the very first initialize (measured, AI-DEMO2 note)
    if (rpc.method === 'initialize' || LIST_METHODS.includes(rpc.method)) return { ok: true };
    if (rpc.method === 'tools/call') {
      const name = rpc.params.name;
      if (typeof name !== 'string' || !app.tools.some((t) => t.name === name)) return { ok: false, reason: 'unknown_tool' };
      if (!this.permits(g.tools, name)) return { ok: false, reason: 'not_in_policy' };
      if (cap && !this.faults.hopIgnoresCap && !cap.includes(name)) return { ok: false, reason: 'cap' };
      return { ok: true };
    }
    if (rpc.method === 'prompts/get') { const n = rpc.params.name; return typeof n === 'string' && app.prompts.some((p) => p.name === n) ? (this.permits(g.prompts, n) ? { ok: true } : { ok: false, reason: 'not_in_policy' }) : { ok: false, reason: 'unknown_prompt' }; }
    if (rpc.method === 'resources/read') { const u = rpc.params.uri; return typeof u === 'string' && app.resources.some((r) => r.uri === u) ? (this.permits(g.resources, u) ? { ok: true } : { ok: false, reason: 'not_in_policy' }) : { ok: false, reason: 'unknown_resource' }; }
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
    const dec = this.authorize(app, user, rpc, ctx.cap);
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
      if (!member && !app.up) { this.deny('app_unreachable', { user: user.id, app: app.id }); throw refuse('app_unreachable', 'the application is unreachable', 502, { enforcedAt: 'gateway (connect)' }); }
      conn = this.connect(app, ctx);
      const inj = this.inject(app, user, rpc, ctx);
      identity = inj.identity; credential = inj.received; this.cur.received = inj.received; this.cur.identity = inj.identity;
    }
    const answer = this.upstreamAnswer(app, rpc, identity, user.id);
    const style = ctx.style && STYLES.includes(ctx.style) ? ctx.style : (member ? 'sse' : 'json');
    const wire = encodeAnswer(answer, style);
    const g = this.grantsOf(app.policy, user);
    const keep = (kind, it) => (kind === 'tools' ? this.permits(g.tools, it.name) && (!ctx.cap || this.faults.hopIgnoresCap || ctx.cap.includes(it.name)) : kind === 'prompts' ? this.permits(g.prompts, it.name) : this.permits(g.resources, it.uri));
    const out = filterWire(wire, keep);
    this.hop(`upstream wire (${style}) then the in-flight filter`, { style, upstreamChunks: out.stats.upstreamChunks }, { frames: out.stats.frames.map((f) => ({ kind: f.kind, listing: f.listing, before: f.before, after: f.after })) });
    const message = out.messages.find((m) => m.id !== undefined) || out.messages[out.messages.length - 1];
    return { message, stats: out.stats, credential, identity, conn, where, style };
  }

  // Lazy connection: a member is connected the first time a tool is actually called, never by a listing (the deck: "connected on demand").
  connect(app, ctx) {
    if (!ctx.aggregateId) return null;
    const k = `${ctx.aggregateId}/${app.id}`;
    const c = this.conn[k] || (this.conn[k] = { state: 'idle', connects: 0, attempts: 0, calls: 0, lastError: '' });
    c.attempts++;
    if (!app.up) { c.state = 'failed'; c.lastError = 'member_unreachable'; throw refuse('member_unreachable', `${ctx.alias}: the member is unreachable`, 502, { enforcedAt: 'member-hop (connect)', memberState: 'unreachable' }); }
    if (app.transport === 'sse') { c.state = 'failed'; c.lastError = 'member_timeout'; throw refuse('member_timeout', `${ctx.alias}: the member did not answer within the lab's simulated 30 seconds`, 504, { enforcedAt: 'member-hop (connect)', memberState: 'hung', measured: 'AI-DEMO2 note: the aggregate opened an event stream to a member recorded as sse and waited for an event the server never sent; swapping the member for another app on the same server did not help' }); }
    if (c.state !== 'connected') { c.state = 'connected'; c.connects++; }
    c.calls++;
    return { state: c.state, connects: c.connects, calls: c.calls };
  }

  // ---- the tool call, as the agent makes it --------------------------------------------------------------------------------------------------
  // params: { user | as, target: { kind: 'app' | 'aggregate', id }, rpc: { method, params, id }, style }
  mcp(p) {
    take(p, ['user', 'as', 'target', 'rpc', 'style'], ['target', 'rpc']);
    take(p.target, ['kind', 'id'], ['kind', 'id']);
    if (p.target.kind !== 'app' && p.target.kind !== 'aggregate') throw refuse('bad_target', 'the target kind is app or aggregate');
    const who = this.caller(p);
    const rpc = this.parseRpc(p.rpc);
    if (p.style !== undefined && !STYLES.includes(p.style)) throw refuse('bad_style', 'style is json, sse, gzip or gzip-sse');
    this.assertRoom();
    this.n.call++;
    this.hop('agent to gateway: JSON-RPC over HTTP', { path: p.target.kind === 'aggregate' && typeof p.target.id === 'string' && Object.hasOwn(this.aggregates, p.target.id) ? this.aggregates[p.target.id].entryPath : p.target.kind === 'app' && typeof p.target.id === 'string' && Object.hasOwn(this.apps, p.target.id) ? this.apps[p.target.id].entryPath : '(unknown path)', method: safeMethod(rpc.method), as: who.label }, { note: 'the agent holds no backend credential' });
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
  // The caller: a signed-in user, or a headless agent acting as its owning user (the same policy and audit apply).
  caller(p) {
    if (p.as !== undefined) {
      if (p.user !== undefined) throw refuse('ambiguous_identity', 'give either a user or a headless agent, not both');
      const ag = typeof p.as === 'string' ? this.agents.find((a) => a.id === p.as) : null;
      if (!ag) throw refuse('unknown_agent', 'unknown agent', 404);
      if (!ag.enabled) { this.deny('agent_revoked', { agent: ag.id }); throw refuse('agent_revoked', 'this agent has been revoked', 401); }
      if (!ag.scopes.includes('mcp')) { this.deny('key_not_scoped_for_mcp', { agent: ag.id }); throw refuse('key_not_scoped_for_mcp', 'this key is not scoped for mcp access (measured wording, AI-DEMO2 note)', 403); }
      return { user: this.user(ag.owner), label: `agent:${ag.id} for ${ag.owner}`, agent: ag };
    }
    const u = this.user(p.user);
    return { user: u, label: u.id };
  }
  directCall(app, user, rpc, p) {
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
    if (!METHODS.includes(rpc.method)) { this.deny('method_not_permitted', { user: user.id, aggregate: agg.id }); jerr('method_not_permitted', 403, -32601, 'method not permitted', { enforcedAt: 'aggregate', reason: 'method_not_permitted' }); }
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
    this.hop('aggregate lists: members resolved lazily, no member connected', { members: agg.members.length }, { tools: tools.length, members: members.map((x) => `${x.alias}: ${x.status}`) });
    return { rpc: rpcOk(rpc.id, { tools }), ...base, operator: { enforcedAt: 'aggregate (listing)', members, connectsThisCall: 0, log: members.flatMap((x) => x.hiddenByAggregate.map((n) => `Removing tool the aggregate policy does not permit: ${n}`)) } };
  }

  callThroughAggregate(agg, user, rpc, p, base, jerr) {
    const name = rpc.params.name;
    if (typeof name !== 'string' || name.length > 200) jerr('bad_rpc', 400, -32602, 'a tool name is required', { enforcedAt: 'aggregate' });
    const i = name.indexOf('__');
    if (i <= 0) { this.deny('not_namespaced', { user: user.id, aggregate: agg.id }); jerr('not_namespaced', 400, -32600, 'the tool name is not namespaced; expected <alias>__<tool>', { enforcedAt: 'aggregate', reason: 'not_namespaced' }); }
    const alias = name.slice(0, i); const bare = name.slice(i + 2);
    const m = agg.members.find((x) => this.aliasOf(x) === alias);
    if (!m) { this.deny('unknown_server', { user: user.id, aggregate: agg.id }); jerr('unknown_server', 404, -32600, 'unknown server: the prefix is not a member alias', { enforcedAt: 'aggregate', reason: 'unknown_server' }); }
    const g = this.grantsOf(agg.policy, user);
    // First enforcement, at the aggregate: the prefixed name must be in the aggregate's policy. A tool that does not exist gets the same refusal.
    if (!this.faults.aggregateSkipsCheck) {
      if (!this.permits(g.tools, name)) { this.deny('policy', { user: user.id, aggregate: agg.id, method: rpc.method, reason: 'not_in_aggregate_policy', enforcedAt: 'aggregate' }); jerr('access_denied', 403, -32600, 'access denied', { enforcedAt: 'aggregate', reason: 'not_in_aggregate_policy' }); }
      if (m.toolFilter.Elems.length && !m.toolFilter.Elems.includes(bare)) { this.deny('policy', { user: user.id, aggregate: agg.id, reason: 'filtered', enforcedAt: 'aggregate' }); jerr('not_exposed', 403, -32600, 'not exposed by this aggregate', { enforcedAt: 'aggregate', reason: 'tool_filter' }); }
    }
    this.hop('aggregate: first enforcement passed', { tool: '(namespaced)', alias }, { allowed: true });
    const app = this.resolve(m);
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
      audit: { total: this.audit.length, shown: this.audit.slice(-60) },
      limits: { ...LIMITS },
    };
  }
}
Object.assign(Engine.prototype, aggregateOps, openapiOps, credentialOps, catalogOps, oauthOps, creationOps);
export { fingerprint, iso, safeId, cleanFree, NAME_RE, CATALOG, rpcOk, rpcErr, text };
