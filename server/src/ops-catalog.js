// MCP Catalog (slide 39) and hosted servers (slide 36): curated, verified entries (lab-written, not Ping's catalog) deploy as a managed container behind the gateway
// in ONE step, with per-tool authorization, credential injection and audit applied from the FIRST request. Deployments are health-checked and redeployed on
// configuration change. Containers are namespaced per tenant. Customer-published entries are on the roadmap: refused. States: deploying, healthy, unhealthy, redeploying.
import { refuse } from './errors.js';
import { NAME_RE, safeId, take } from './util.js';
import { CATALOG, LOG_LEVELS } from './world.js';
import { fingerprint } from './common.js';

const MAX_DEPLOYMENTS = 8;
const CONFIG_KEYS = ['logLevel', 'maxResults'];

export const catalogOps = {
  initCatalog() { this.deployments = Object.create(null); this.cat = { n: 0 }; },
  nsOf(tenant) { return `tenant-${tenant}`; },

  checkConfig(cfg, base = { logLevel: 'info', maxResults: 10 }) {
    if (cfg === undefined) return { ...base };
    take(cfg, CONFIG_KEYS);
    const out = { ...base };
    if (cfg.logLevel !== undefined) { if (typeof cfg.logLevel !== 'string' || !LOG_LEVELS.includes(cfg.logLevel)) throw refuse('bad_config', `logLevel is one of ${LOG_LEVELS.join(', ')}`); out.logLevel = cfg.logLevel; }
    if (cfg.maxResults !== undefined) { if (!Number.isInteger(cfg.maxResults) || cfg.maxResults < 1 || cfg.maxResults > 50) throw refuse('bad_config', 'maxResults is a whole number from 1 to 50'); out.maxResults = cfg.maxResults; }
    return out;
  },
  depOf(id) {
    if (typeof id !== 'string' || !Object.hasOwn(this.deployments, id)) throw refuse('unknown_deployment', 'unknown deployment', 404);
    return this.deployments[id];
  },
  step(d, to, why) { d.history.push(to); d.state = to; d.reason = why; },

  catDeploy(p) {
    take(p, ['actor', 'entryId', 'name', 'tenant', 'config'], ['actor', 'entryId', 'name']);
    const a = this.admin(p.actor);
    const entry = typeof p.entryId === 'string' ? CATALOG.find((e) => e.id === p.entryId) : null;
    if (!entry) { this.deny('unknown_catalog_entry', { actor: a.id }); throw refuse('unknown_catalog_entry', 'no such catalog entry', 404); }
    if (!entry.verified) { this.deny('unverified_catalog_entry', { actor: a.id, entry: entry.id }); throw refuse('unverified_catalog_entry', 'this entry is not verified, so it cannot be deployed', 403); }
    const name = safeId(p.name, NAME_RE, 32);
    if (!name) throw refuse('bad_name', 'a name is lowercase letters, digits and hyphens, starting with a letter');
    const tenant = p.tenant === undefined ? this.tenants[0] : p.tenant;
    if (typeof tenant !== 'string' || !this.tenants.includes(tenant)) throw refuse('unknown_tenant', 'unknown tenant');
    const ns = this.nsOf(tenant); const id = `${ns}/${name}`;
    if (Object.hasOwn(this.deployments, id)) throw refuse('name_taken', 'a deployment with this name already exists in this tenant namespace', 409);
    const own = tenant === this.tenants[0];
    if (own && Object.hasOwn(this.apps, name)) throw refuse('name_taken', 'an application with this name exists', 409);
    if (Object.keys(this.deployments).length >= MAX_DEPLOYMENTS) throw refuse('too_many_deployments', `the lab runs at most ${MAX_DEPLOYMENTS} containers: reset to start over`, 409);
    if (Object.keys(this.apps).length >= 30) throw refuse('too_many_apps', 'the lab holds at most 30 applications', 409);
    this.assertRoom();
    const config = this.checkConfig(p.config);
    const d = { id, name, entry: entry.id, version: entry.version, tenant, namespace: ns, config, generation: 1, state: 'deploying', container: 'running', history: ['deploying'], reason: 'one step: image pulled, container started', probes: 0, calls: 0, appId: own ? name : null };
    // One step: the container starts, the readiness probe runs, and the gateway application (policy, credential injection, audit) is registered BEFORE the first request.
    d.probes++; this.step(d, 'healthy', 'readiness probe passed');
    if (own) {
      this.apps[name] = {
        id: name, name, kind: 'catalog', source: 'catalog', upstream: null, up: true, transport: 'streamable-http', authMode: 'none', staticHeader: 'Authorization', entryPath: `/${name}/mcp`, catalogDeployment: id,
        tools: entry.tools.map((t) => ({ ...t })), prompts: [], resources: [], generation: 1,
        policy: { grants: [{ group: 'staff', tools: entry.tools.filter((t) => t.readOnly).map((t) => t.name), prompts: [], resources: [] }, { group: 'admins', tools: ['*'], prompts: [], resources: [] }] },
      };
    }
    this.deployments[id] = d;
    this.hop('one step: a verified catalog entry becomes a managed container behind the gateway', { entry: entry.id, version: entry.version, namespace: ns }, { state: d.state, controlsFromFirstRequest: ['per-tool authorization', 'credential injection', 'audit'] });
    this.record('catalog.deploy', { actor: a.id, deployment: id, entry: entry.id, version: entry.version, state: d.state });
    return this.depView(d);
  },
  catCrash(p) {
    take(p, ['actor', 'id'], ['actor', 'id']);
    const a = this.admin(p.actor); const d = this.depOf(p.id);
    d.container = 'exited';
    this.record('catalog.crash', { actor: a.id, deployment: d.id });
    return { id: d.id, container: d.container, state: d.state, note: 'the container exited; the gateway learns of it at the next health check (or when a call fails)' };
  },
  catHealth(p) {
    take(p, ['actor', 'id'], ['actor', 'id']);
    const a = this.admin(p.actor); const d = this.depOf(p.id);
    d.probes++;
    if (d.container === 'exited' && d.state === 'healthy') { this.step(d, 'unhealthy', 'health check failed: the container is not running'); }
    this.record('catalog.health', { actor: a.id, deployment: d.id, state: d.state });
    return this.depView(d);
  },
  redeploy(d, why) {
    this.step(d, 'redeploying', why); d.redeployReason = why; d.container = 'running'; d.generation++; d.probes++;
    this.step(d, 'healthy', 'readiness probe passed after redeploy');
    if (d.appId) this.apps[d.appId].generation = d.generation;
  },
  catRedeploy(p) {
    take(p, ['actor', 'id'], ['actor', 'id']);
    const a = this.admin(p.actor); const d = this.depOf(p.id);
    if (d.state === 'healthy' && d.container === 'running') throw refuse('not_needed', 'the deployment is healthy: nothing to redeploy', 409);
    this.assertRoom();
    this.redeploy(d, 'redeployed by an administrator');
    this.record('catalog.redeploy', { actor: a.id, deployment: d.id, generation: d.generation });
    return this.depView(d);
  },
  // A change of configuration redeploys the container (the same lifecycle as any hosted MCP server).
  catConfigure(p) {
    take(p, ['actor', 'id', 'config'], ['actor', 'id', 'config']);
    const a = this.admin(p.actor); const d = this.depOf(p.id);
    const next = this.checkConfig(p.config, d.config);
    if (CONFIG_KEYS.every((k) => next[k] === d.config[k])) throw refuse('no_change', 'the configuration is unchanged, so nothing is redeployed', 409);
    this.assertRoom();
    d.config = next;
    this.redeploy(d, 'redeployed on configuration change');
    this.record('catalog.configure', { actor: a.id, deployment: d.id, generation: d.generation });
    return this.depView(d);
  },
  catPublish(p) {
    take(p, ['actor']);
    const a = this.admin(p.actor);
    this.deny('customer_published_entries_roadmap', { actor: a.id });
    throw refuse('roadmap', 'customer-published catalog entries are on the roadmap (deck claim): nothing is modelled', 501);
  },

  runCatalogTool(app, tool, args, identity, userId) {
    const d = this.deployments[app.catalogDeployment];
    if (d.state !== 'healthy') throw refuse('deployment_not_healthy', 'the deployment is not healthy', 503, { enforcedAt: 'gateway (health)' });
    if (d.container === 'exited') throw refuse('container_exited', 'the container is not running (not yet detected by a health check)', 502, { enforcedAt: 'gateway (connect)' });
    d.calls++;
    const hasVault = !!this.vault[userId]?.[app.id];
    // The hosted container's environment holds the CALLING user's vault credential (deck claim: exposed to the container's environment), shown to the operator only.
    this.cur.containerEnv = { namespace: d.namespace, USER_VAULT_CREDENTIAL: hasVault ? { kind: 'mock', fingerprint: fingerprint(`vault:${userId}:${app.id}`) } : 'absent: this user stored none for this server' };
    return { content: [{ type: 'text', text: JSON.stringify({ server: d.entry, version: d.version, generation: d.generation, tool: tool.name, results: Math.min(d.config.maxResults, 3), logLevel: d.config.logLevel, scopedTo: identity.actor }) }], isError: false };
  },

  depView(d) { return { id: d.id, name: d.name, entry: d.entry, version: d.version, tenant: d.tenant, namespace: d.namespace, config: d.config, generation: d.generation, state: d.state, container: d.container, history: [...d.history], reason: d.reason, redeployReason: d.redeployReason || '', probes: d.probes, calls: d.calls, appId: d.appId }; },
  catalogView() {
    return {
      entries: CATALOG.map((e) => ({ id: e.id, name: e.name, version: e.version, verified: e.verified, publisher: e.publisher, arch: e.arch, tools: e.tools.map((t) => t.name), summary: e.summary })),
      deployments: Object.values(this.deployments).map((d) => this.depView(d)), logLevels: LOG_LEVELS, limits: { deployments: MAX_DEPLOYMENTS },
    };
  },
};
