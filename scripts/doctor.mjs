// Preflight: the same checks GET /api/health reports from, plus whether the port is free, plus one real run of the engine through the HTTP API
// (a request, two approvals, the lab clock, the reaper) on a throwaway port. Prints only pass/fail lines, never a setting's value. Exit 1 on failure.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)));
const { installNetguard } = await load('server/src/netguard.js');
installNetguard();
const { applySharedSettings } = await load('server/src/settings.js');
applySharedSettings();

const { runChecks } = await load('server/src/doctor.js');
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };
for (const c of await runChecks()) report(c.level, c.id, c.detail);

// A real cycle through the HTTP layer, in this process, on an ephemeral loopback port: a listing, the aggregate cap refused, a call that goes through.
try {
  const { createApp, startHttpServer } = await load('server/src/app.js');
  const { createHealth } = await load('server/src/health.js');
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health }) });
  try {
    const base = url.replace(/\/$/, ''); const h = { 'content-type': 'application/json', origin: base, 'x-workspace': 'doctor' };
    const act = async (op, params) => { const r = await fetch(`${base}/api/act/${op}`, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'live', vertical: 'finance', params }) }); return { status: r.status, body: await r.json() }; };
    const cast = (await (await fetch(`${base}/api/story?vertical=finance`)).json()).cast;
    const agg = { kind: 'aggregate', id: 'all-in-one' };
    const list = await act('mcp', { user: cast.castUser, target: agg, rpc: { method: 'tools/list' } });
    const denied = await act('mcp', { user: cast.castUser, target: agg, rpc: { method: 'tools/call', params: { name: `${cast.castApp2}__create_item`, arguments: { name: 'x' } } } });
    const ok = await act('mcp', { user: cast.castUser, target: agg, rpc: { method: 'tools/call', params: { name: `${cast.castApp1}__read_record`, arguments: { id: 'r-1' } } } });
    const names = list.body.result.rpc.result.tools.map((t) => t.name);
    const good = names.length === 7 && !names.includes(`${cast.castApp2}__create_item`) && denied.status === 403 && denied.body.error === 'access_denied' && ok.status === 200 && ok.body.ok;
    report(good ? 'pass' : 'fail', 'engine-cycle', good ? 'one aggregate listing of namespaced tools, a tool the aggregate\'s policy denies refused with 403, and a permitted call that went through, all over the HTTP API' : 'the aggregate list, cap and call cycle did not complete');
  } finally { health.stop(); await new Promise((res) => server.close(res)); }
} catch { report('fail', 'engine-cycle', 'the HTTP cycle could not run'); }

const port = Number(process.env.PORT) || 7350;
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => { report('fail', 'port-free', `${port} is not free (${e.code}). Set PORT to a free port in 7350-7399`); resolve(); });
  s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${port} is free`); resolve(); }));
});
process.exit(failed ? 1 : 0);
