// One Express app. /api = health, info, story, diagram, state and the actions (POST /api/act/:op), reset. Server state per workspace id (X-Workspace) is one engine
// per vertical, so one visitor's Reset never touches another's. Mock reads generated tables and refuses every write (the pure OpenAPI preview excepted); Live
// drives the engine. Both are loopback-only with zero outbound calls. Refusals keep their honest HTTP status.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { VERTICALS, loadCast, verticalFrom } from './cast.js';
import { defaultMode, modeOf } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { InputError } from './errors.js';
import { MOCK_TABLE } from './mockTable.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';
import { Engine } from './engine.js';
import { isOp, isPure } from './actions.js';
import { liveState, mockState, runAction } from './service.js';
import { maskDeep, maskStory } from './mask.js';
import { buildMethodTable, charsetProblem, isPageAddress, methodNotAllowed } from './shared/hygiene.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A page address (the shared rule): the HTML shell is served for these only, never for /assets, a dot-file, a dot segment or a path with an extension.
export { isPageAddress };

// One route table: the 405 answers (with Allow) are built from it, and nothing else. ":op" matches one segment; HEAD is added wherever GET is.
const ROUTES = { '/api/health': ['GET'], '/api/state': ['GET'], '/api/story': ['GET'], '/api/diagram': ['GET'], '/api/info': ['GET'], '/api/act/:op': ['POST'], '/api/reset': ['POST'] };
const METHODS = buildMethodTable(ROUTES);
// A fixed-code answer. Nothing the visitor sent is ever put into the code or the body.
const fail = (res, status, code, headers = {}) => res.set(headers).status(status).json({ error: code });
const actName = (p) => { try { return decodeURIComponent(p.split('/')[2] ?? ''); } catch { return ''; } }; // /act/<name> -> name

export function createApp({ health = createHealth(), configFile = CONFIG, workspaces = createWorkspaces(), table = MOCK_TABLE, webDist = WEB_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff'); res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  // Only UTF-8 bodies: a body declared utf-7 or another charset would be decoded into replacement characters that split a secret. charsetProblem returns a
  // fixed code and never the value, so the 415 answers (and logs) nothing the visitor typed. Before every route, not only /api.
  app.use((req, res, next) => (charsetProblem(req.headers['content-type']) ? fail(res, 415, 'unsupported_charset') : next()));

  const api = express.Router();
  // A known route with the wrong method is a 405 with Allow (fixed JSON, nothing echoed). An unknown action name under /act is not a known route: it falls through to the 404.
  api.use((req, res, next) => {
    const miss = methodNotAllowed(METHODS, req.method, `/api${req.path}`);
    if (!miss || (/^\/act\//i.test(req.path) && !isOp(actName(req.path)))) return next();
    return fail(res, 405, 'method_not_allowed', { Allow: miss.allow.join(', ') });
  });
  api.use(express.json({ limit: '64kb' }));
  // Defence in depth: every JSON answer is masked for credential-shaped values, whatever path produced it.
  api.use((req, res, next) => { const send = res.json.bind(res); const mask = req.path === '/story' ? maskStory : maskDeep; res.json = (b) => send(mask(b)); next(); });
  api.use('/health', health.router);
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  // The workspace id is refused BEFORE any work and before a slot exists: a malformed id or a credential-shaped one (isCredentialId: a long hex or mixed run, an
  // sk-/pw-/token-/password-/secret-/bearer-/ghp- prefix) is a 400, and the id is never echoed. Only the routes that use a workspace carry this middleware.
  const workspace = (req, res, next) => { const id = workspaceFrom(req); if (!id) return fail(res, 400, 'bad_workspace'); req.workspaceId = id; return next(); };

  // A query value the lab does not know is a 400 (as it is in a POST body), never a silent fall-back to the default. Absent = the default.
  const queryVertical = (req, res) => { const v = req.query.vertical; if (v !== undefined && !(typeof v === 'string' && Object.hasOwn(VERTICALS, v))) { res.status(400).json({ error: 'bad_vertical', detail: 'the vertical is not one the lab has' }); return false; } return true; };
  api.get('/story', (req, res) => { noStore(res); if (!queryVertical(req, res)) return; res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => {
    noStore(res); if (!queryVertical(req, res)) return;
    const name = req.query.name;
    if (name !== undefined && !(typeof name === 'string' && DIAGRAM_NAMES.includes(name))) return res.status(400).json({ error: 'bad_diagram', detail: 'the diagram is not one the lab has' });
    return res.json(buildDiagram(castFor(req), name ?? DIAGRAM_NAMES[0]));
  });
  api.get('/info', (_req, res) => { noStore(res); res.json({ mode: defaultMode(), modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });

  api.get('/state', workspace, (req, res, next) => {
    try {
      const id = req.workspaceId;
      noStore(res);
      const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
      if (!queryVertical(req, res)) return;
      const vertical = verticalOf(req);
      if (mode === 'mock') return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario) });
      return res.json({ mode, vertical, workspace: id, state: liveState(id, workspaces, vertical, castFor(req)) });
    } catch (e) { return next(e); }
  });

  // Every action: Live only (a pure one also in Mock), strict top-level keys, one trace, hops, and the whole fresh state back.
  api.post('/act/:op', workspace, (req, res, next) => {
    const id = req.workspaceId;
    noStore(res);
    try {
      if (req.headers['content-type'] && !req.is('application/json')) return res.status(415).json({ error: 'unsupported_media_type', detail: 'send application/json' });
      const op = req.params.op;
      if (!isOp(op)) return res.status(404).json({ error: 'unknown_action' });
      if (!isObj(req.body)) return res.status(400).json({ error: 'bad_request' });
      const mode = modeOf(req.body.mode);
      if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
      if (!Object.keys(req.body).every((k) => ['mode', 'vertical', 'params'].includes(k))) return res.status(400).json({ error: 'unknown_field', detail: 'the body carries a field the lab does not take' });
      if (req.body.vertical !== undefined && !(typeof req.body.vertical === 'string' && Object.hasOwn(VERTICALS, req.body.vertical))) return res.status(400).json({ error: 'bad_vertical', detail: 'the vertical is not one the lab has' });
      const vertical = verticalOf(req);
      const params = req.body.params === undefined ? {} : req.body.params;
      const route = { method: 'POST', url: '/api/act/(action)' };
      if (mode === 'mock' && !isPure(op)) return res.status(409).json({ error: 'mock_is_read_only', detail: 'Mock mode only reads tables: switch to Live to act' });
      const cast = castFor(req);
      const r = runAction({ ws: id, workspaces, vertical, cast, op, params, traceparent: req.headers.traceparent, route, engine: mode === 'mock' ? new Engine(cast) : undefined });
      res.set('traceparent', r.traceparent);
      const common = { workspace: id, mode, vertical, hops: r.hops, hopsTruncated: r.hopsTruncated, traceId: r.traceId, ...(mode === 'live' ? { state: r.state } : {}) };
      if (r.outcome.ok) return res.json({ ok: true, op, result: r.outcome.result, ...common });
      return res.status(r.outcome.status || 400).json({ ok: false, op, error: r.outcome.code, detail: r.outcome.detail, ...(r.outcome.data ? { data: r.outcome.data } : {}), ...common });
    } catch (e) { return next(e); }
  });

  // Reset clears this workspace's engines (apps, policies, aggregate, deployments, OAuth state, proposals, audit, the clock) and nothing else.
  api.post('/reset', workspace, (req, res) => { const id = req.workspaceId; noStore(res); workspaces.reset(id); return res.json({ reset: 'ok', workspace: id }); });
  api.use((_req, res) => fail(res, 404, 'not_found'));
  app.use('/api', api);

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, dotfiles: 'ignore', fallthrough: true, redirect: false })); // real files only: no directory index or redirect (a Location header would echo the path)
    // The page is served for a page address only: no dot-file or dot segment, and no file extension in the last segment. A missing file with an extension
    // (/favicon.ico, /x.js, /missing.css) is a 404, not the page (a script or a stylesheet that "loads" HTML hides the real problem). GET and HEAD both.
    app.use((req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && isPageAddress(req.path) ? res.sendFile(path.join(webDist, 'index.html')) : next()));
  }
  // The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an HTML stack
  // trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path.
  app.use((_req, res) => fail(res, 404, 'not_found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    const status = Number(err?.status || err?.statusCode);
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code });
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status === 415) return res.status(415).json({ error: 'unsupported_charset' }); // body-parser's own refusal (it accepts only utf-8 spelled with the hyphen)
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
