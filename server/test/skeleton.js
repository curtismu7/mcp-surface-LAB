// One valid request body per action (a skeleton), and every variant of it with a probe typed into each string leaf / key. Shared by the echo test and the control-character test.
import { C } from './helpers.js';
import { sampleSpec } from '../src/world.js';

export const spec = JSON.stringify(sampleSpec(C));
export const url0 = `https://agent.${C.castHost}.example/client.json`;
export const SKEL = {
  mcp: { user: C.castUser, target: { kind: 'app', id: C.castApp1 }, rpc: { method: 'tools/call', params: { name: 'search', arguments: { query: 'q' } } }, style: 'json' },
  advance: { minutes: 5 }, setPolicy: { actor: C.castAdmin, appId: C.castApp1, grants: [{ group: 'staff', tools: ['search'], prompts: [], resources: [] }] },
  setTransport: { actor: C.castAdmin, appId: C.castApp5, transport: 'sse' }, setFault: { actor: C.castAdmin, hopIgnoresCap: false }, setAppUp: { actor: C.castAdmin, appId: C.castApp4, up: true },
  aggSetMember: { actor: C.castAdmin, aggregateId: 'all-in-one', refId: C.castApp1, alias: 'books', toolFilter: { Elems: ['search'] } }, aggRemoveMember: { actor: C.castAdmin, aggregateId: 'all-in-one', refId: C.castMissing },
  aggSetPolicy: { actor: C.castAdmin, aggregateId: 'all-in-one', grants: [{ group: 'staff', tools: [`${C.castApp1}__search`] }] },
  oaPreview: { spec }, oaDeploy: { actor: C.castAdmin, name: 'invoices', spec }, oaRedeploy: { actor: C.castAdmin, id: 'oa-1', spec },
  setAuth: { actor: C.castAdmin, appId: C.castApp1, authMode: 'static-token', staticHeader: 'X-Api-Key' }, vaultSet: { actor: C.castUser, user: C.castUser, appId: C.castApp1, present: true },
  upstreamAuthorize: { user: C.castUser, appId: C.castApp3 }, upstreamRevoke: { user: C.castUser, appId: C.castApp3 }, passThrough: { user: C.castUser, appId: C.castApp2, defect: 'none' },
  catDeploy: { actor: C.castAdmin, entryId: 'kb-search', name: 'kb', tenant: C.castHost, config: { logLevel: 'info', maxResults: 5 } }, catCrash: { actor: C.castAdmin, id: `tenant-${C.castHost}/kb` }, catHealth: { actor: C.castAdmin, id: `tenant-${C.castHost}/kb` },
  catRedeploy: { actor: C.castAdmin, id: `tenant-${C.castHost}/kb` }, catConfigure: { actor: C.castAdmin, id: `tenant-${C.castHost}/kb`, config: { logLevel: 'debug' } }, catPublish: { actor: C.castAdmin },
  oauthRegister: { clientName: 'client', redirectUris: [`https://agent.${C.castHost}.example/callback`] }, cimdSet: { actor: C.castAdmin, clients: [{ URL: url0, IsPrivate: false }], cacheTTLHours: 3 }, cimdResolve: { clientId: url0 },
  oauthAuthorize: { user: C.castUser, clientId: 'dcr-0001', redirectUri: `https://agent.${C.castHost}.example/callback`, codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', codeChallengeMethod: 'S256', scope: ['mcp:tools'] },
  oauthToken: { grant: 'authorization_code', code: 'mock-code-0001', codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', clientId: 'dcr-0001', redirectUri: `https://agent.${C.castHost}.example/callback` },
  propose: { actor: C.castUser, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${C.castHost}.example/mcp`, authMode: 'static-token', note: 'for support' }, amend: { actor: C.castUser, proposalId: 'prop-0001', note: 'again', name: 'helpdesk-2' },
  decide: { actor: C.castAdmin2, proposalId: 'prop-0001', decision: 'approve', revision: 1, adjust: { name: 'desk' }, reason: 'ok' }, setSessionLogging: { actor: C.castAdmin, enabled: true }, setAgent: { actor: C.castAdmin, agentId: C.castAgent, enabled: true },
  route: { path: `/${C.castApp1}/mcp` }, setPinning: { actor: C.castAdmin, enabled: true }, sessionOpen: { user: C.castUser, replica: 'replica-a' }, sessionUse: { sessionId: 'sess-001', replica: 'replica-a' },
};

// Every variant of a skeleton: each string leaf replaced; each object given an extra key named by the secret; each existing key renamed; everything replaced at once.
export function* variants(p, v) {
  const leaves = []; const objs = [];
  (function walk(x, path) { if (typeof x === 'string') leaves.push(path); else if (Array.isArray(x)) x.forEach((y, i) => walk(y, [...path, i])); else if (x && typeof x === 'object') { objs.push(path); for (const k of Object.keys(x)) walk(x[k], [...path, k]); } })(p, []);
  const at = (root, path) => path.reduce((o, k) => o[k], root);
  for (const path of leaves) { const c = structuredClone(p); at(c, path.slice(0, -1))[path.at(-1)] = v; yield c; }
  for (const path of objs) { const c = structuredClone(p); at(c, path)[v] = 1; yield c; }
  for (const path of objs) { const c = structuredClone(p); const o = at(c, path); for (const k of Object.keys(o).slice(0, 2)) { o[v] = o[k]; delete o[k]; } yield c; }
  const all = structuredClone(p); for (const path of leaves) at(all, path.slice(0, -1))[path.at(-1)] = v; yield all;
}

