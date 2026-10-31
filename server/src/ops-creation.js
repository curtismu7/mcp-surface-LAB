// Approval-gated creation, session logging, headless agents and deployment notes (slide 36).
//  - Anyone may PROPOSE a new MCP or HTTP application; a tenant administrator reviews, may adjust the configuration, and approves before anything is created.
//    Self-approval is refused, approve-after-deny is refused, a proposal changed after the administrator looked is refused (revision), and an old proposal
//    is refused as stale. The values are RE-VALIDATED when the proposal is approved (not frozen at request time): the name may have been taken meanwhile.
//  - Session logging: tool invocations and their arguments are recorded when it is enabled; when the recording is full a call is refused, never left unrecorded.
//  - Headless agents act as their owning user with a scoped access key or a Federated Identity; a revoked agent is refused.
//  - Deployment: one hostname serves every MCP application, addressed by path; OAuth session state is per gateway process, so client sessions need pinning.
import { refuse } from './errors.js';
import { cleanFree } from './credentials.js';
import { NAME_RE, credentialShaped, safeId, take } from './util.js';
import { AUTH_MODES } from './ops-credentials.js';
import { iso } from './common.js';

const MAX_PROPOSALS = 30; const PROPOSAL_TTL = 7 * 86400; const MAX_SESSIONS = 20;
const KINDS = ['mcp', 'http'];
const BACKEND = /^https:\/\/[a-z0-9-]{1,40}(?:\.[a-z0-9-]{1,40}){0,3}\.(?:example|invalid)(?:\/[A-Za-z0-9._~/-]{0,60})?$/;
const REPLICAS = ['replica-a', 'replica-b'];

export const creationOps = {
  initCreation() {
    this.proposals = []; this.pn = 0;
    this.deploy = { pinned: false, sessions: [], sn: 0 };
  },
  propNameFree(name) { return typeof name === 'string' && !this.nameInUse(name); },
  checkProposalFields(f, { requireAll }) {
    const out = {};
    if (f.kind !== undefined || requireAll) { if (typeof f.kind !== 'string' || !KINDS.includes(f.kind)) throw refuse('bad_kind', 'kind is mcp or http'); out.kind = f.kind; }
    if (f.name !== undefined || requireAll) { const n = safeId(f.name, NAME_RE, 32); if (!n) throw refuse('bad_name', 'a name is lowercase letters, digits and hyphens, starting with a letter'); out.name = n; }
    if (f.backend !== undefined || requireAll) { if (typeof f.backend !== 'string' || f.backend.length > 150 || !BACKEND.test(f.backend) || credentialShaped(f.backend)) throw refuse('bad_backend', 'the backend is an https URL on a reserved .example or .invalid host'); out.backend = f.backend; }
    if (f.authMode !== undefined || requireAll) { if (typeof f.authMode !== 'string' || !AUTH_MODES.includes(f.authMode)) throw refuse('bad_auth_mode', `authMode is one of ${AUTH_MODES.join(', ')}`); out.authMode = f.authMode; }
    return out;
  },
  // Expiry is applied on READ: a proposal older than the TTL is expired in every view and for every action, not only when someone tries to decide it.
  expireProposals() { for (const q of this.proposals) if (q.state === 'pending' && this.t - q.createdAt > PROPOSAL_TTL) q.state = 'expired'; },
  prop(id) {
    this.expireProposals();
    const x = typeof id === 'string' ? this.proposals.find((q) => q.id === id) : null;
    if (!x) throw refuse('unknown_proposal', 'unknown proposal', 404);
    return x;
  },

  propose(p) {
    take(p, ['actor', 'kind', 'name', 'backend', 'authMode', 'note'], ['actor', 'kind', 'name', 'backend', 'authMode']);
    const who = this.user(p.actor);
    const f = this.checkProposalFields(p, { requireAll: true });
    this.expireProposals();
    if (this.proposals.length >= MAX_PROPOSALS) throw refuse('too_many_proposals', `the lab holds at most ${MAX_PROPOSALS} proposals: reset to start over`, 409);
    if (this.proposals.some((q) => q.state === 'pending' && q.name === f.name)) throw refuse('duplicate_proposal', 'a pending proposal with this name exists', 409);
    this.assertRoom();
    const q = { id: `prop-${String(++this.pn).padStart(4, '0')}`, proposer: who.id, ...f, note: cleanFree(p.note ?? '', 200), state: 'pending', revision: 1, createdAt: this.t, decidedBy: null, decidedAt: null, reason: '', adjustments: [], createdApp: null };
    this.proposals.push(q);
    this.record('proposal.created', { actor: who.id, proposal: q.id });
    return this.propView(q);
  },
  // The proposer changes their own pending proposal: the revision moves, so an approval of the version the administrator looked at is stale.
  amend(p) {
    take(p, ['actor', 'proposalId', 'backend', 'authMode', 'name', 'note'], ['actor', 'proposalId']);
    const who = this.user(p.actor); const q = this.prop(p.proposalId);
    if (q.proposer !== who.id) { this.deny('not_the_proposer', { actor: who.id }); throw refuse('not_the_proposer', 'only the proposer may change a proposal', 403); }
    if (q.state !== 'pending') throw refuse('not_pending', 'the proposal is no longer pending', 409);
    const f = this.checkProposalFields(p, { requireAll: false });
    if (p.note !== undefined) q.note = cleanFree(p.note, 200);
    if (!Object.keys(f).length && p.note === undefined) throw refuse('no_change', 'nothing to change', 400);
    Object.assign(q, f); q.revision++;
    this.record('proposal.amended', { actor: who.id, proposal: q.id, revision: q.revision });
    return this.propView(q);
  },
  decide(p) {
    take(p, ['actor', 'proposalId', 'decision', 'revision', 'adjust', 'reason'], ['actor', 'proposalId', 'decision', 'revision']);
    const a = this.admin(p.actor); const q = this.prop(p.proposalId);
    if (p.decision !== 'approve' && p.decision !== 'deny') throw refuse('bad_decision', 'decision is approve or deny');
    if (q.proposer === a.id) { this.deny('self_approval', { actor: a.id, proposal: q.id }); throw refuse('self_approval', 'nobody decides their own proposal', 403); }
    if (q.state === 'denied') { this.deny('approve_after_deny', { actor: a.id, proposal: q.id }); throw refuse(p.decision === 'approve' ? 'approve_after_deny' : 'already_decided', p.decision === 'approve' ? 'a denied proposal cannot be approved: propose again' : 'the proposal was already decided', 409); }
    if (q.state !== 'pending') throw refuse(q.state === 'expired' ? 'proposal_stale' : 'already_decided', q.state === 'expired' ? 'the proposal expired' : 'the proposal was already decided', 409);
    if (this.t - q.createdAt > PROPOSAL_TTL) { q.state = 'expired'; this.record('proposal.expired', { proposal: q.id }); throw refuse('proposal_stale', 'the proposal is older than 7 days on the lab clock and has expired', 409); }
    if (p.revision !== q.revision) { this.deny('stale_revision', { actor: a.id, proposal: q.id }); throw refuse('stale_revision', 'the proposal changed after you looked at it: review the new revision', 409); }
    this.assertRoom();
    const reason = cleanFree(p.reason ?? '', 200);
    if (p.decision === 'deny') { q.state = 'denied'; q.decidedBy = a.id; q.decidedAt = this.t; q.reason = reason; this.record('proposal.denied', { actor: a.id, proposal: q.id }); return this.propView(q); }
    // Approve: the administrator may adjust the configuration; every value is validated again now.
    const adj = p.adjust === undefined ? {} : this.checkProposalFields(take(p.adjust, ['kind', 'name', 'backend', 'authMode']), { requireAll: false });
    const merged = { kind: q.kind, name: q.name, backend: q.backend, authMode: q.authMode, ...adj };
    if (!this.propNameFree(merged.name)) throw refuse('name_taken', 'an application with this name exists now', 409);
    if (Object.keys(this.apps).length >= 30) throw refuse('too_many_apps', 'the lab holds at most 30 applications', 409);
    q.adjustments = Object.keys(adj).filter((k) => adj[k] !== q[k]).map((k) => ({ field: k, from: q[k], to: adj[k] }));
    Object.assign(q, merged);
    const tools = merged.kind === 'mcp' ? [{ name: 'describe', description: 'Describe this application (a lab-invented placeholder tool)', readOnly: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] } }] : [];
    this.apps[merged.name] = { id: merged.name, name: merged.name, kind: merged.kind === 'http' ? 'http' : 'created', source: 'approved proposal', upstream: null, up: true, transport: 'streamable-http', authMode: merged.authMode, staticHeader: 'Authorization', entryPath: `/${merged.name}/mcp`, backend: merged.backend, tools, prompts: [], resources: [], generation: 1, policy: { grants: [{ group: 'admins', tools: ['*'], prompts: [], resources: [] }] } };
    q.state = 'approved'; q.decidedBy = a.id; q.decidedAt = this.t; q.reason = reason; q.createdApp = merged.name;
    this.record('proposal.approved', { actor: a.id, proposal: q.id, app: merged.name, adjustments: q.adjustments.length });
    this.hop('nothing is created until an administrator approves', { proposal: q.id, adjustments: q.adjustments.length }, { created: merged.name, defaultPolicy: 'administrators only (lab-invented default): grant it before anyone else can use it' });
    return this.propView(q);
  },
  propView(q) { return { id: q.id, proposer: q.proposer, kind: q.kind, name: q.name, backend: q.backend, authMode: q.authMode, note: q.note, state: q.state, revision: q.revision, createdAt: iso(q.createdAt), decidedBy: q.decidedBy, decidedAt: q.decidedAt === null ? null : iso(q.decidedAt), reason: q.reason, adjustments: q.adjustments, createdApp: q.createdApp }; },

  setSessionLogging(p) {
    take(p, ['actor', 'enabled'], ['actor', 'enabled']);
    const a = this.admin(p.actor);
    if (typeof p.enabled !== 'boolean') throw refuse('bad_enabled', 'enabled is true or false');
    this.sessionLogging = p.enabled;
    this.record('session.logging', { actor: a.id, enabled: p.enabled });
    return { sessionLogging: this.sessionLogging };
  },
  setAgent(p) {
    take(p, ['actor', 'agentId', 'enabled'], ['actor', 'agentId', 'enabled']);
    const a = this.admin(p.actor);
    const ag = typeof p.agentId === 'string' ? this.agents.find((x) => x.id === p.agentId) : null;
    if (!ag) throw refuse('unknown_agent', 'unknown agent', 404);
    if (typeof p.enabled !== 'boolean') throw refuse('bad_enabled', 'enabled is true or false');
    ag.enabled = p.enabled;
    this.record('agent.set', { actor: a.id, agent: ag.id, enabled: ag.enabled });
    return { agent: ag.id, enabled: ag.enabled };
  },

  // Deployment notes. A path resolves to one application on the single hostname.
  route(p) {
    take(p, ['path'], ['path']);
    if (typeof p.path !== 'string' || p.path.length > 100 || !/^\/[A-Za-z0-9/_.-]*$/.test(p.path)) throw refuse('bad_path', 'a path starts with "/" and holds letters, digits and / _ . - only');
    const hit = [...Object.values(this.apps), ...Object.values(this.aggregates)].find((x) => x.entryPath === p.path);
    if (!hit) throw refuse('no_such_path', 'no application is served on this path', 404);
    return { host: `${this.cast.castHost}-gateway.example`, path: hit.entryPath, serves: hit.id, kind: this.aggregates[hit.id] === hit ? 'aggregate' : hit.kind };
  },
  setPinning(p) {
    take(p, ['actor', 'enabled'], ['actor', 'enabled']);
    const a = this.admin(p.actor);
    if (typeof p.enabled !== 'boolean') throw refuse('bad_enabled', 'enabled is true or false');
    this.deploy.pinned = p.enabled;
    this.record('replica.pinning', { actor: a.id, enabled: p.enabled });
    return { pinned: this.deploy.pinned };
  },
  // Lab-invented illustration of "OAuth session state is held per gateway process": a session lives on the replica that opened it.
  sessionOpen(p) {
    take(p, ['user', 'replica'], ['user', 'replica']);
    const u = this.user(p.user);
    if (typeof p.replica !== 'string' || !REPLICAS.includes(p.replica)) throw refuse('bad_replica', `replica is ${REPLICAS.join(' or ')}`);
    if (this.deploy.sessions.length >= MAX_SESSIONS) throw refuse('too_many_sessions', `the lab holds at most ${MAX_SESSIONS} sessions: reset to start over`, 409);
    const s = { id: `sess-${String(++this.deploy.sn).padStart(3, '0')}`, user: u.id, replica: p.replica };
    this.deploy.sessions.push(s);
    this.record('session.open', { actor: u.id, replica: p.replica });
    return { ...s };
  },
  sessionUse(p) {
    take(p, ['sessionId', 'replica'], ['sessionId', 'replica']);
    const s = typeof p.sessionId === 'string' ? this.deploy.sessions.find((x) => x.id === p.sessionId) : null;
    if (!s) throw refuse('unknown_session', 'unknown session', 404);
    if (typeof p.replica !== 'string' || !REPLICAS.includes(p.replica)) throw refuse('bad_replica', `replica is ${REPLICAS.join(' or ')}`);
    const hit = this.deploy.pinned ? s.replica : p.replica;
    if (hit !== s.replica) { this.deny('session_not_on_replica', { user: s.user }); throw refuse('session_not_on_replica', 'this replica holds no state for the session: its OAuth state lives on the replica that opened it, so the client must be pinned', 401, { servedBy: hit, heldBy: s.replica }); }
    return { session: s.id, servedBy: hit, pinned: this.deploy.pinned };
  },

  creationView() {
    this.expireProposals();
    return {
      proposals: this.proposals.map((q) => this.propView(q)), kinds: KINDS, authModes: AUTH_MODES, proposalTtlDays: PROPOSAL_TTL / 86400, limits: { proposals: MAX_PROPOSALS, sessions: MAX_SESSIONS },
      deployment: { host: `${this.cast.castHost}-gateway.example`, replicas: REPLICAS, pinned: this.deploy.pinned, sessions: this.deploy.sessions.map((s) => ({ ...s })), paths: [...Object.values(this.apps).map((a) => ({ path: a.entryPath, serves: a.id })), ...Object.values(this.aggregates).map((a) => ({ path: a.entryPath, serves: a.id }))] },
    };
  },
};
