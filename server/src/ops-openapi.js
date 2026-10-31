// OpenAPI to MCP as engine operations: preview a specification (pure), deploy it as an ordinary MCP application fronted by the gateway (so it inherits per-tool
// policy, entitlement-aware discovery and credential injection), and redeploy it (a removed operation disappears; an added one arrives with no grant).
import crypto from 'node:crypto';
import { refuse } from './errors.js';
import { NAME_RE, safeId, take } from './util.js';
import { callBackend, diffTools, generateTools, parseSpec } from './openapi.js';
import { cleanFree } from './credentials.js';

const MAX_SERVERS = 5; const MAX_APPS = 30;
const digest = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 12);
const summary = (g) => ({ api: g.api, tools: g.tools.map((t) => ({ name: t.name, description: t.description, nameRule: t.nameRule, method: t.op.method, path: t.op.path, args: Object.keys(t.inputSchema.properties), required: t.inputSchema.required, readOnly: t.readOnly, inputSchema: t.inputSchema })), auth: g.auth, notExposed: g.notExposed, warnings: g.warnings });

export const openapiOps = {
  initOpenapi() { this.oa = { n: 0, servers: Object.create(null) }; },

  // Read-only: parse and generate, change nothing. Runs the same parser in Mock and Live.
  oaPreview(p) {
    take(p, ['spec'], ['spec']);
    const spec = parseSpec(p.spec);
    return { ...summary(generateTools(spec)), specDigest: digest(p.spec) };
  },

  oaDeploy(p) {
    take(p, ['actor', 'name', 'spec'], ['actor', 'name', 'spec']);
    const a = this.admin(p.actor);
    const name = safeId(p.name, NAME_RE, 32);
    if (!name) throw refuse('bad_name', 'a name is lowercase letters, digits and hyphens, starting with a letter');
    if (this.nameInUse(name)) throw refuse('name_taken', 'an application with this name exists', 409);
    if (Object.keys(this.oa.servers).length >= MAX_SERVERS) throw refuse('too_many_servers', `the lab hosts at most ${MAX_SERVERS} generated servers: reset to start over`, 409);
    if (Object.keys(this.apps).length >= MAX_APPS) throw refuse('too_many_apps', `the lab holds at most ${MAX_APPS} applications`, 409);
    this.assertRoom();
    const g = generateTools(parseSpec(p.spec));
    const hdr = g.auth.find((x) => x.handled === 'header');
    const id = `oa-${++this.oa.n}`;
    const readTools = g.tools.filter((t) => t.readOnly).map((t) => t.name);
    this.apps[name] = {
      id: name, name, kind: 'openapi', source: 'openapi', upstream: null, up: true, transport: 'streamable-http', authMode: hdr ? 'static-token' : 'none', staticHeader: hdr ? hdr.header : 'Authorization', entryPath: `/${name}/mcp`,
      tools: g.tools, prompts: [], resources: [], generation: 1,
      policy: { grants: [{ group: 'staff', tools: readTools, prompts: [], resources: [] }, { group: 'admins', tools: ['*'], prompts: [], resources: [] }] },
    };
    this.oa.servers[id] = { id, appId: name, specDigest: digest(p.spec), generation: 1, api: g.api, auth: g.auth, notExposed: g.notExposed, warnings: g.warnings, deployments: 1, lastDiff: null };
    this.hop('the specification becomes a managed MCP server, fronted by the gateway as an ordinary application', { tools: g.tools.length, name }, { registered: true, defaultGrant: 'read-only operations for staff (lab-invented default); everything else denied until granted' });
    this.record('openapi.deploy', { actor: a.id, app: name, tools: g.tools.length });
    return { id, appId: name, tools: g.tools.map((t) => t.name), ...summary(g) };
  },

  oaRedeploy(p) {
    take(p, ['actor', 'id', 'spec'], ['actor', 'id', 'spec']);
    const a = this.admin(p.actor);
    const srv = typeof p.id === 'string' && Object.hasOwn(this.oa.servers, p.id) ? this.oa.servers[p.id] : null;
    if (!srv) throw refuse('unknown_server', 'unknown generated server', 404);
    this.assertRoom();
    const g = generateTools(parseSpec(p.spec));
    const app = this.apps[srv.appId];
    const diff = diffTools(app.tools, g.tools);
    app.tools = g.tools; app.generation++;
    const names = new Set(g.tools.map((t) => t.name));
    app.policy.grants = app.policy.grants.map((gr) => ({ ...gr, tools: gr.tools.filter((x) => x === '*' || names.has(x)) }));
    const hdr = g.auth.find((x) => x.handled === 'header');
    if (hdr) app.staticHeader = hdr.header;
    Object.assign(srv, { specDigest: digest(p.spec), generation: app.generation, api: g.api, auth: g.auth, notExposed: g.notExposed, warnings: g.warnings, deployments: srv.deployments + 1, lastDiff: diff });
    this.hop('redeploy: the tool surface follows the specification', { removed: diff.removed.length, added: diff.added.length }, { note: 'a removed operation disappears; an added one arrives with no grant' });
    this.record('openapi.redeploy', { actor: a.id, app: srv.appId, added: diff.added.length, removed: diff.removed.length });
    return { id: srv.id, generation: app.generation, diff, ...summary(g) };
  },

  runOpenapiTool(app, tool, args) {
    const received = this.cur?.received || { headers: [] };
    const srv = Object.values(this.oa.servers).find((s) => s.appId === app.id);
    const requiresAuth = !!srv?.auth.some((x) => x.handled === 'header');
    const r = callBackend(tool, args, { headers: received.headers, requiresAuth });
    this.hop('gateway to the in-process mock REST backend (no network)', { request: r.request }, { status: r.status });
    return { content: [{ type: 'text', text: JSON.stringify({ status: r.status, body: r.body }) }], isError: r.status >= 400 };
  },

  openapiView() {
    return {
      servers: Object.values(this.oa.servers).map((s) => ({ id: s.id, appId: s.appId, specDigest: s.specDigest, generation: s.generation, deployments: s.deployments, api: s.api, auth: s.auth, notExposed: s.notExposed, warnings: s.warnings, lastDiff: s.lastDiff, tools: this.apps[s.appId].tools.map((t) => ({ name: t.name, nameRule: t.nameRule, method: t.op.method, path: t.op.path, args: Object.keys(t.inputSchema.properties), readOnly: t.readOnly })) })),
      limits: { servers: MAX_SERVERS },
    };
  },
};
export { cleanFree };
