import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createWorkspaces } from '../src/workspaces.js';
import { Engine } from '../src/engine.js';
import { perform } from '../src/actions.js';
import { VERTICALS } from '../src/cast.js';

export const C = VERTICALS.finance;
export const newEngine = (cast = C, opts) => new Engine(cast, opts);

export async function withServer(fn, { configFile = '/nonexistent/customer.config.json', workspaces = createWorkspaces(), webDist = '/nonexistent/dist', env, proxyHosts } = {}) {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  await health.ready;
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, configFile, workspaces, webDist, ...(env ? { env } : {}), ...(proxyHosts ? { proxyHosts } : {}) }) });
  try { await fn(url.replace(/\/$/, ''), { workspaces }); } finally { health.stop(); await new Promise((res) => server.close(res)); }
}

export const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const get = (url, path, headers = {}) => fetch(`${url}${path}`, { headers });
export const json = async (res) => res.json();

// fetch cannot set Host; node:http can.
export function rawHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

export const W = (id) => ({ 'x-workspace': id });
export const act = async (url, op, params, ws = 'default', extra = {}) => { const r = await post(url, `/api/act/${op}`, { mode: 'live', vertical: 'finance', params, ...extra }, W(ws)); return { status: r.status, body: await r.json() }; };

// people and applications (finance pack)
export const A = C.castAdmin; export const A2 = C.castAdmin2; export const U = C.castUser; export const U2 = C.castUser2; export const X = C.castOutsider;
export const [A1, A2N, A3, A4, A5, MISS] = [C.castApp1, C.castApp2, C.castApp3, C.castApp4, C.castApp5, C.castMissing];
export const AGG = { kind: 'aggregate', id: 'all-in-one' };
export const APP = (id) => ({ kind: 'app', id });

// engine-level helpers: return the perform() outcome
export const run = (e, op, p) => perform(e, op, p);
export const mcp = (e, user, target, method, params = {}, extra = {}) => perform(e, 'mcp', { user, target, rpc: { method, params }, ...extra });
export const callTool = (e, user, target, name, args = {}, extra = {}) => mcp(e, user, target, 'tools/call', { name, arguments: args }, extra);
export const listNames = (e, user, target, extra = {}) => { const r = mcp(e, user, target, 'tools/list', {}, extra); if (!r.ok) throw new Error(`list refused: ${r.code}`); return r.result.rpc.result.tools.map((t) => t.name); };
export const codeOf = (r) => (r.ok ? 'ok' : r.code);
export const ok = (r) => { if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.detail}`); return r.result; };
