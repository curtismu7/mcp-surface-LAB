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
import { maskDeep } from './mask.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

  const api = express.Router();
  // Only UTF-8 bodies: a body declared utf-7 or another charset would be decoded into replacement characters that split a secret.
  api.use((req, res, next) => { const m = /charset\s*=\s*"?([^;"\s]+)/i.exec(String(req.headers['content-type'] || '')); if (m && !/^utf-?8$/i.test(m[1])) return res.status(415).json({ error: 'unsupported_charset' }); return next(); });
  api.use(express.json({ limit: '64kb' }));
  // Defence in depth: every JSON answer is masked for credential-shaped values, whatever path produced it.
  api.use((_req, res, next) => { const send = res.json.bind(res); res.json = (b) => send(maskDeep(b)); next(); });
  api.use('/health', health.router);
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const ws = (req, res) => { const id = workspaceFrom(req); if (!id) res.status(400).json({ error: 'bad_workspace' }); return id; };

  api.get('/story', (req, res) => { noStore(res); res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => { noStore(res); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  api.get('/info', (_req, res) => { noStore(res); res.json({ mode: defaultMode(), modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });

  api.get('/state', (req, res, next) => {
    try {
      const id = ws(req, res); if (!id) return;
      noStore(res);
      const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
      const vertical = verticalOf(req);
      if (mode === 'mock') return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario) });
      return res.json({ mode, vertical, workspace: id, state: liveState(id, workspaces, vertical, castFor(req)) });
    } catch (e) { return next(e); }
  });

  // Every action: Live only (a pure one also in Mock), strict top-level keys, one trace, hops, and the whole fresh state back.
  api.post('/act/:op', (req, res, next) => {
    const id = ws(req, res); if (!id) return;
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
  api.post('/reset', (req, res) => { const id = ws(req, res); if (!id) return; noStore(res); workspaces.reset(id); return res.json({ reset: 'ok', workspace: id }); });
  // A known route with the wrong method is a 405 with the allowed method (fixed JSON, nothing echoed); everything else is the JSON 404.
  for (const [route, allow] of [['/state', 'GET'], ['/story', 'GET'], ['/diagram', 'GET'], ['/info', 'GET'], ['/act/:op', 'POST'], ['/reset', 'POST']]) api.all(route, (req, res) => (req.params.op !== undefined && !isOp(req.params.op) ? res.status(404).json({ error: 'not_found' }) : res.set('Allow', allow).status(405).json({ error: 'method_not_allowed' })));
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/|assets\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  // The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an HTML stack
  // trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code });
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
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
