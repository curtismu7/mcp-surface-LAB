import { installNetguard } from './netguard.js';
import { startHttpServer, createApp } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, labProxyHosts, resolvePort } from './safety.js';
import { modeFrom } from './config.js';
import { applySharedSettings } from './settings.js';

installNetguard(); // before anything else can open a socket

// The one shared settings file (rulebook): ~/Development/.env, or STANDALONE_ENV. Optional; only this lab's own key is taken; never printed.
applySharedSettings();

const checks = await runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[mcp-surface-lab] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const mode = modeFrom(process.env); // refuses anything but mock or live
const host = assertBindAllowed(bindHost(), process.env);
const port = resolvePort();
// LAB_ALLOWED_HOSTS (the family lab-proxy's name for this lab) is parsed before the server starts.
const proxyHosts = labProxyHosts(process.env, port);
const { url } = await startHttpServer({ port, host, app: createApp({ proxyHosts }) });
console.log(`[mcp-surface-lab] simulated lab at ${url} (opens in ${mode} mode; loopback, no outbound network)`);
console.log(`[mcp-surface-lab] health: ${url}api/health`);
