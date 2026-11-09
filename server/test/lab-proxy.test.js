// The family lab-proxy (launcher at https://local.ping-devops.com:8443) sends Host `<name>:<port>` for this lab, plus
// X-Forwarded-Host/-Proto; the browser's Origin on a write is the launcher's. LAB_ALLOWED_HOSTS names the lab; loopback
// always works and never vouches for forwarded headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { labProxyHosts } from '../src/safety.js';
import { withServer } from './helpers.js';

const NAME = 'mcp-surface-lab.local.ping-devops.com';
const PORT = 7350;
const LAUNCHER = 'https://local.ping-devops.com:8443';
const PROXIED = { host: `${NAME}:${PORT}`, 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https' };
const WRITE_PATH = '/api/reset';

const withLab = (proxyHosts, fn) => withServer((url) => fn(url), { proxyHosts });

function raw(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
const write = (url, headers) => raw(`${url}${WRITE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace': 'lab-proxy', ...headers }, body: '{}' });

test('labProxyHosts: each LAB_ALLOWED_HOSTS name with this port; unset means none (loopback only)', () => {
  assert.deepEqual([...labProxyHosts({}, PORT)], []);
  assert.deepEqual([...labProxyHosts({ LAB_ALLOWED_HOSTS: ` ${NAME.toUpperCase()} , ,other.example ` }, PORT)], [`${NAME}:${PORT}`, `other.example:${PORT}`]);
});

test('lab-proxy: the launcher Host is accepted for GET /api/health', async () => {
  await withLab(labProxyHosts({ LAB_ALLOWED_HOSTS: NAME }, PORT), async (url) => {
    const res = await raw(`${url}/api/health`, { headers: PROXIED });
    assert.equal(res.status, 200, res.text);
  });
});

test('lab-proxy: a proxied same-origin write (Origin === X-Forwarded-Proto://X-Forwarded-Host) is accepted', async () => {
  await withLab(labProxyHosts({ LAB_ALLOWED_HOSTS: NAME }, PORT), async (url) => {
    const res = await write(url, { ...PROXIED, origin: LAUNCHER, 'sec-fetch-site': 'same-origin' });
    assert.notEqual(res.status, 403, res.text);
    assert.doesNotMatch(res.text, /cross_origin|bad_host/);
  });
});

test('lab-proxy: a foreign or mismatched Origin is refused on the launcher Host', async () => {
  await withLab(labProxyHosts({ LAB_ALLOWED_HOSTS: NAME }, PORT), async (url) => {
    for (const origin of ['https://evil.example', 'http://local.ping-devops.com:8443', 'https://local.ping-devops.com']) {
      const res = await write(url, { ...PROXIED, origin });
      assert.equal(res.status, 403, origin);
    }
    assert.equal((await write(url, { ...PROXIED, 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' })).status, 403);
    assert.equal((await write(url, { ...PROXIED, 'x-forwarded-host': '', origin: 'https://' })).status, 403);
  });
});

test('lab-proxy: forwarded headers on a loopback Host are ignored', async () => {
  await withLab(labProxyHosts({ LAB_ALLOWED_HOSTS: NAME }, PORT), async (url) => {
    const port = new URL(url).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await write(url, { host, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' })).status, 403, host);
      assert.equal((await write(url, { host, 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', origin: LAUNCHER })).status, 403, host);
    }
  });
});

test('lab-proxy: a Host outside the set is refused, and so is the launcher Host when LAB_ALLOWED_HOSTS is unset', async () => {
  await withLab(labProxyHosts({ LAB_ALLOWED_HOSTS: NAME }, PORT), async (url) => {
    for (const host of [`local.ping-devops.com:${PORT}`, 'local.ping-devops.com:8443', `evil.example:${PORT}`, `${NAME}:1`, NAME]) {
      const res = await raw(`${url}/api/health`, { headers: { ...PROXIED, host } });
      assert.equal(res.status, 403, host);
      assert.match(res.text, /bad_host/);
    }
  });
  await withLab(labProxyHosts({}, PORT), async (url) => {
    assert.equal((await raw(`${url}/api/health`, { headers: PROXIED })).status, 403);
    assert.equal((await write(url, { ...PROXIED, origin: LAUNCHER })).status, 403);
  });
});
