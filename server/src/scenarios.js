// Scripted scenarios: data (with names from the cast) run through the real engine. The Mock tables are generated from this by `npm run mock-table`, so Mock cannot
// show anything the engine would not do (a doctor check and a test fail on drift). A step's params may be a function of the earlier results (for example a code the
// authorization server just issued).
import { Engine } from './engine.js';
import { VERTICALS } from './cast.js';
import { perform } from './actions.js';
import { s256 } from './oauth.js';
import { sampleSpec } from './world.js';

// The RFC 7636 appendix B example verifier (assembled so no key-shaped string sits in the source).
export const PKCE_VERIFIER = ['dBjftJeZ4CVP-mB92K27uhbUJU1p1r_', 'wW1gFWFOEjXk'].join('');
export const PKCE_CHALLENGE = s256(PKCE_VERIFIER);

const agg = { kind: 'aggregate', id: 'all-in-one' };
const app = (id) => ({ kind: 'app', id });
const call = (user, target, name, args = {}, extra = {}) => ({ op: 'mcp', params: { user, target, rpc: { method: 'tools/call', params: { name, arguments: args } }, ...extra } });
const rpc = (user, target, method, params = {}, extra = {}) => ({ op: 'mcp', params: { user, target, rpc: { method, params }, ...extra } });

export function scenarioList(c) {
  const A = c.castAdmin; const A2 = c.castAdmin2; const U = c.castUser; const U2 = c.castUser2; const X = c.castOutsider;
  const [a1, a2, a3, a4, a5, miss] = [c.castApp1, c.castApp2, c.castApp3, c.castApp4, c.castApp5, c.castMissing];
  const spec = JSON.stringify(sampleSpec(c));
  const spec2 = (() => { const s = sampleSpec(c); delete s.paths['/items/{id}'].delete; return JSON.stringify(s); })();
  const h = (n) => `https://${n}.${c.castHost}.example/client.json`;
  const redirect = `https://agent.${c.castHost}.example/callback`;
  const authz = (extra = {}) => ({ op: 'oauthAuthorize', params: { user: U, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect, codeChallenge: PKCE_CHALLENGE, codeChallengeMethod: 'S256', ...extra } });
  return [
    {
      id: 'aggregate-cap', title: 'The aggregate\'s policy is the cap, enforced twice',
      say: `One endpoint fronts ${a1}, ${a2}, ${a3}, ${a4} and ${a5}. A tool the member allows but the aggregate denies is hidden and refused at the aggregate; a tool the aggregate allows but the member denies is refused at the member hop. Each fault switch shows one layer alone is enough.`,
      steps: [
        { say: `${U} lists tools through the aggregate: namespaced names, only what the aggregate permits and the member allows.`, ...rpc(U, agg, 'tools/list') },
        { say: `${a2}__create_item: the member allows it for staff, the aggregate's policy does not. Refused at the aggregate.`, ...call(U, agg, `${a2}__create_item`, { name: 'x' }) },
        { say: `${a2}__refund_item: the aggregate allows it, the member does not. Refused at the member hop.`, ...call(U, agg, `${a2}__refund_item`, { id: 'r-1' }) },
        { say: `${a1}__read_record: allowed by both. The call goes through, with the static token the member's auth mode injects.`, ...call(U, agg, `${a1}__read_record`, { id: 'r-1' }) },
        { say: `${A} switches off the aggregate's own check (a lab fault switch).`, op: 'setFault', params: { actor: A, aggregateSkipsCheck: true } },
        { say: `The same create_item call is still refused: the second enforcement, at the member hop, carries the aggregate's cap.`, ...call(U, agg, `${a2}__create_item`, { name: 'x' }) },
        { say: `${A} also makes the member hop ignore the cap header.`, op: 'setFault', params: { actor: A, hopIgnoresCap: true } },
        { say: 'With both layers broken the call goes through: the aggregate is wider than its own policy. This is why the cap is enforced twice.', ...call(U, agg, `${a2}__create_item`, { name: 'x' }) },
        { say: 'Both switches off again.', op: 'setFault', params: { actor: A, aggregateSkipsCheck: false, hopIgnoresCap: false } },
      ],
    },
    {
      id: 'members', title: 'Aliases, lazy connections and members that are missing, down or hang',
      say: 'Members are resolved from the tenant\'s own applications and connected only when a tool is called. A missing or unreachable member is reported, not dropped; a member recorded as sse hangs (a measured note). An alias clash is refused, and renaming an alias strands the old grant.',
      steps: [
        { say: 'A listing connects nothing: every member reports "not connected yet", the down one "unreachable" and the dangling reference "missing".', ...rpc(U, agg, 'tools/list') },
        { say: `A first call to ${a1} connects it (one connection).`, ...call(U, agg, `${a1}__search`, { query: 'q' }) },
        { say: 'A second call reuses the connection: one connect, two calls.', ...call(U, agg, `${a1}__get_status`) },
        { say: `${a4} is down: the call fails with the reason, named after the member.`, ...call(A, agg, `${a4}__search`, { query: 'q' }) },
        { say: `${a5} is recorded as sse: the call never answers (the lab times it out at a simulated 30 seconds).`, ...call(U, agg, `${a5}__search`, { query: 'q' }) },
        { say: `${miss} does not exist: reported as missing.`, ...call(A, agg, `${miss}__search`, { query: 'q' }) },
        { say: `${A} records ${a5} as streamable-http (the measured fix was a 405-on-GET front).`, op: 'setTransport', params: { actor: A, appId: a5, transport: 'streamable-http' } },
        { say: 'The same call now answers.', ...call(U, agg, `${a5}__search`, { query: 'q' }) },
        { say: `A bare tool name with no alias is refused.`, ...call(U, agg, 'search', { query: 'q' }) },
        { say: `${A} tries to give ${a1} the alias of ${a2}: identical tool names would collide.`, op: 'aggSetMember', params: { actor: A, aggregateId: 'all-in-one', refId: a1, alias: a2 } },
        { say: `${A} renames ${a1} to "books". Its old grant now matches nothing.`, op: 'aggSetMember', params: { actor: A, aggregateId: 'all-in-one', refId: a1, alias: 'books' } },
        { say: `A call by the old name is refused: that prefix is no longer a member alias.`, ...call(U, agg, `${a1}__search`, { query: 'q' }) },
      ],
    },
    {
      id: 'discovery', title: 'Entitlement-aware discovery: removed in flight, never callable',
      say: 'The upstream lists everything. The gateway filters the listing in flight on a plain body, on a stream split into small chunks with comments and notifications, and on gzip. A tool you may not see cannot be called, and the refusal is the same as for one that does not exist.',
      steps: [
        { say: `${U} lists ${a1}'s tools: 3 of 5.`, ...rpc(U, app(a1), 'tools/list') },
        { say: 'The same listing over a chunked event stream: the same 3.', ...rpc(U, app(a1), 'tools/list', {}, { style: 'sse' }) },
        { say: 'Over gzip: the same 3.', ...rpc(U, app(a1), 'tools/list', {}, { style: 'gzip' }) },
        { say: 'Over a gzip-compressed event stream: the same 3.', ...rpc(U, app(a1), 'tools/list', {}, { style: 'gzip-sse' }) },
        { say: 'A hidden tool cannot be called.', ...call(U, app(a1), 'export_all') },
        { say: 'A tool that does not exist gets the identical refusal.', ...call(U, app(a1), 'no_such_tool') },
        { say: `${X} has no policy on ${a1}: even initialize is refused (deny by default).`, ...rpc(X, app(a1), 'initialize') },
        { say: 'Prompts are filtered too: staff see one of two.', ...rpc(U, app(a1), 'prompts/list') },
        { say: 'Resources too: staff see one of three.', ...rpc(U, app(a1), 'resources/list') },
        { say: 'Reading a resource staff may not see is refused.', ...rpc(U, app(a1), 'resources/read', { uri: 'records://all' }) },
        { say: 'Reading a resource staff may see works.', ...rpc(U, app(a1), 'resources/read', { uri: 'docs://guide' }) },
        { say: 'A JSON-RPC method the gateway does not recognise is refused: the method is part of the decision.', ...rpc(U, app(a1), 'tools/delete') },
        { say: `${A} grants staff export_all on ${a1}.`, op: 'setPolicy', params: { actor: A, appId: a1, grants: [{ group: 'staff', tools: ['search', 'get_status', 'read_record', 'export_all'], prompts: ['summarise'], resources: ['docs://guide'] }, { group: 'admins', tools: ['*'], prompts: ['*'], resources: ['*'] }] } },
        { say: 'It now appears in the listing and can be called.', ...call(U, app(a1), 'export_all') },
      ],
    },
    {
      id: 'openapi', title: 'OpenAPI to MCP: a spec becomes tools, and follows the spec',
      say: 'This runs for real. The spec is parsed under hard limits, every operation becomes a tool, the generated server is fronted as an ordinary application, and a removed operation disappears on redeploy. Remote references and YAML are refused.',
      steps: [
        { say: 'Preview the sample specification: four operations, one named by the fallback rule.', op: 'oaPreview', params: { spec } },
        { say: 'A remote reference is refused.', op: 'oaPreview', params: { spec: JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/a': { get: { operationId: 'a', responses: { 200: { $ref: 'https://spec.example/other.json#/x' } } } } } }) } },
        { say: 'YAML is refused: JSON only.', op: 'oaPreview', params: { spec: 'openapi: 3.0.0\ninfo:\n  title: t' } },
        { say: `${A} deploys the specification as an application.`, op: 'oaDeploy', params: { actor: A, name: c.castApi, spec } },
        { say: 'Staff see only the read-only operations (the lab default grant).', ...rpc(U, app(c.castApi), 'tools/list') },
        { say: 'Call getItem: the path parameter drives the request to the mock backend.', ...call(U, app(c.castApi), 'getItem', { id: 'i-2' }) },
        { say: 'A mutating operation is hidden from staff and refused.', ...call(U, app(c.castApi), 'createItem', { body: { name: 'z' } }) },
        { say: 'Arguments are checked against the generated schema: a wrong type is refused.', ...call(U, app(c.castApi), 'listItems', { limit: 'many' }) },
        { say: `${A} redeploys the specification with the DELETE operation removed.`, op: 'oaRedeploy', params: { actor: A, id: 'oa-1', spec: spec2 } },
        { say: 'The removed operation is gone for everyone, administrators included.', ...call(A, app(c.castApi), 'delete_items_by_id', { id: 'i-1' }) },
      ],
    },
    {
      id: 'credentials', title: 'Five ways to inject a backend credential',
      say: 'The agent never holds the credential. A static token makes everyone the same service account; a vault credential, a second OAuth flow and a signed assertion let the backend see the person. The assertion is real RS256 and is verified twice.',
      steps: [
        { say: `${a1} has an app-wide static token, so the backend sees only a service account, not ${U}.`, ...call(U, app(a1), 'read_record', { id: 'r-1' }) },
        { say: `${A} switches ${a1} to the per-user vault.`, op: 'setAuth', params: { actor: A, appId: a1, authMode: 'user-token' } },
        { say: `${U2} has no vault credential for ${a1}: refused before the backend is called.`, ...call(U2, app(a1), 'read_record', { id: 'r-3' }) },
        { say: `${A} cannot set ${U2}'s vault entry: the vault is self-service, with no administrator override.`, op: 'vaultSet', params: { actor: A, user: U2, appId: a1, present: true } },
        { say: `${U2} stores their own.`, op: 'vaultSet', params: { actor: U2, user: U2, appId: a1, present: true } },
        { say: `Now the backend sees ${U2} and scopes the answer to them.`, ...call(U2, app(a1), 'read_record', { id: 'r-3' }) },
        { say: `${a3} uses a second OAuth flow, per user: ${U} has not authorized it yet.`, ...call(U, app(a3), 'list_cases') },
        { say: `${U} authorizes the member's own server.`, op: 'upstreamAuthorize', params: { user: U, appId: a3 } },
        { say: 'The call now works.', ...call(U, app(a3), 'list_cases') },
        { say: 'Twenty minutes later the access token has expired: it is refreshed on the next call.', op: 'advance', params: { minutes: 20 } },
        { say: 'Still works.', ...call(U, app(a3), 'list_cases') },
        { say: `${A} switches ${a2} to token pass-through.`, op: 'setAuth', params: { actor: A, appId: a2, authMode: 'token-pass' } },
        { say: `A valid assertion: the gateway verifies and forwards it unchanged; the backend verifies it too and scopes to ${U}.`, op: 'passThrough', params: { user: U, appId: a2 } },
        { say: 'A wrong audience is refused by the gateway.', op: 'passThrough', params: { user: U, appId: a2, defect: 'wrong-audience' } },
        { say: 'An expired assertion is refused.', op: 'passThrough', params: { user: U, appId: a2, defect: 'expired' } },
        { say: 'A tampered payload fails the signature.', op: 'passThrough', params: { user: U, appId: a2, defect: 'tampered' } },
        { say: 'An untrusted issuer is refused.', op: 'passThrough', params: { user: U, appId: a2, defect: 'untrusted-issuer' } },
        { say: 'alg "none" is refused: one algorithm is accepted.', op: 'passThrough', params: { user: U, appId: a2, defect: 'alg-none' } },
        { say: 'A lifetime over the cap is refused.', op: 'passThrough', params: { user: U, appId: a2, defect: 'lifetime-too-long' } },
        { say: 'A replay: the first presentation was accepted, the second is refused by the backend.', op: 'passThrough', params: { user: U, appId: a2, defect: 'replay' } },
      ],
    },
    {
      id: 'catalog', title: 'The catalog: a verified server in one step, operated and redeployed',
      say: 'A verified catalog entry deploys as a namespaced managed container with policy, credential injection and audit in place before the first request. Unknown and unverified entries are refused. A crash is found by a health check, and a configuration change redeploys.',
      steps: [
        { say: `${A} deploys the verified "kb-search" entry in one step.`, op: 'catDeploy', params: { actor: A, entryId: 'kb-search', name: 'kb' } },
        { say: 'The very first request already has the policy: staff see the read-only tools.', ...rpc(U, app('kb'), 'tools/list') },
        { say: 'And the first call is authorized, injected and audited.', ...call(U, app('kb'), 'search_docs', { query: 'q' }) },
        { say: 'An unknown entry is refused.', op: 'catDeploy', params: { actor: A, entryId: 'nope', name: 'x' } },
        { say: 'An unverified entry is refused.', op: 'catDeploy', params: { actor: A, entryId: 'community-weather', name: 'w' } },
        { say: 'The same name in the same tenant namespace is refused.', op: 'catDeploy', params: { actor: A, entryId: 'kb-search', name: 'kb' } },
        { say: `The same name in another tenant's namespace is fine: containers are namespaced per tenant.`, op: 'catDeploy', params: { actor: A, entryId: 'kb-search', name: 'kb', tenant: c.castTenant2 } },
        { say: 'The container exits.', op: 'catCrash', params: { actor: A, id: `tenant-${c.castHost}/kb` } },
        { say: 'Before a health check notices, a call fails at the connect.', ...call(U, app('kb'), 'search_docs', { query: 'q' }) },
        { say: 'The health check marks it unhealthy.', op: 'catHealth', params: { actor: A, id: `tenant-${c.castHost}/kb` } },
        { say: 'Calls are refused while it is unhealthy.', ...call(U, app('kb'), 'search_docs', { query: 'q' }) },
        { say: 'Redeploy: it is healthy again, one generation later.', op: 'catRedeploy', params: { actor: A, id: `tenant-${c.castHost}/kb` } },
        { say: 'A configuration change redeploys it.', op: 'catConfigure', params: { actor: A, id: `tenant-${c.castHost}/kb`, config: { logLevel: 'debug' } } },
        { say: 'The same configuration again changes nothing, so nothing redeploys.', op: 'catConfigure', params: { actor: A, id: `tenant-${c.castHost}/kb`, config: { logLevel: 'debug' } } },
        { say: 'Customer-published entries are on the roadmap: refused.', op: 'catPublish', params: { actor: A } },
      ],
    },
    {
      id: 'authorization', title: 'OAuth 2.1 with mandatory PKCE, refresh tokens and CIMD',
      say: 'Dynamic registration, PKCE S256 verified for real, single-use codes and rotating refresh tokens; and CIMD, where the client is named by a document URL the tenant has allowlisted. The lab never fetches: each URL has one fixed mock outcome.',
      steps: [
        { say: 'Register a client dynamically.', op: 'oauthRegister', params: { clientName: 'Agent client', redirectUris: [redirect] } },
        { say: 'An authorization request with no PKCE challenge is refused.', op: 'oauthAuthorize', params: { user: U, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect } },
        { say: 'The "plain" method is refused: S256 only.', ...authz({ codeChallengeMethod: 'plain' }) },
        { say: 'A redirect URI that does not match exactly is refused.', ...authz({ redirectUri: `https://agent.${c.castHost}.example/other` }) },
        { say: 'A valid request with S256 gets a single-use code.', ...authz({ scope: ['mcp:tools', 'offline_access'] }) },
        { say: 'A wrong code_verifier fails PKCE (the hash does not match).', op: 'oauthToken', params: { grant: 'authorization_code', code: (prev) => prev[4].result.code, codeVerifier: `${PKCE_VERIFIER.slice(0, 40)}xyz`, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect } },
        { say: 'The right verifier exchanges the code for an access token and a refresh token.', op: 'oauthToken', params: { grant: 'authorization_code', code: (prev) => prev[4].result.code, codeVerifier: PKCE_VERIFIER, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect } },
        { say: 'Using the same code again is refused, and revokes what it issued.', op: 'oauthToken', params: { grant: 'authorization_code', code: (prev) => prev[4].result.code, codeVerifier: PKCE_VERIFIER, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect } },
        { say: 'The refresh token was revoked with its family: refreshing fails.', op: 'oauthToken', params: { grant: 'refresh_token', refreshToken: (prev) => prev[6].result.refresh_token, clientId: (prev) => prev[0].result.client_id } },
        { say: 'A new code, a new exchange.', ...authz({ scope: ['mcp:tools', 'offline_access'] }) },
        { say: 'Exchange it.', op: 'oauthToken', params: { grant: 'authorization_code', code: (prev) => prev[9].result.code, codeVerifier: PKCE_VERIFIER, clientId: (prev) => prev[0].result.client_id, redirectUri: redirect } },
        { say: 'Refresh: a rotated pair is issued.', op: 'oauthToken', params: { grant: 'refresh_token', refreshToken: (prev) => prev[10].result.refresh_token, clientId: (prev) => prev[0].result.client_id } },
        { say: 'Presenting the old refresh token again is reuse: the whole family is revoked.', op: 'oauthToken', params: { grant: 'refresh_token', refreshToken: (prev) => prev[10].result.refresh_token, clientId: (prev) => prev[0].result.client_id } },
        { say: 'CIMD: a client_id that is not an https URL is refused.', op: 'cimdResolve', params: { clientId: 'http://insecure.example/client.json' } },
        { say: 'A URL the tenant has not allowlisted is refused.', op: 'cimdResolve', params: { clientId: h('unlisted') } },
        { say: 'An allowlisted document is fetched (a fixed mock), validated and cached.', op: 'cimdResolve', params: { clientId: h('agent') } },
        { say: 'The second resolution is a cache hit: no fetch.', op: 'cimdResolve', params: { clientId: h('agent') } },
        { say: 'A document whose client_id is not its own URL is refused.', op: 'cimdResolve', params: { clientId: h('notes') } },
        { say: 'A document over the size limit is refused.', op: 'cimdResolve', params: { clientId: h('big') } },
        { say: 'Refused: a document that asks for a symmetric client credential.', op: 'cimdResolve', params: { clientId: h('secret') } },
        { say: 'A wrong content type is refused.', op: 'cimdResolve', params: { clientId: h('wrongtype') } },
        { say: 'A fetch that times out is refused.', op: 'cimdResolve', params: { clientId: h('slow') } },
        { say: 'A redirect is refused.', op: 'cimdResolve', params: { clientId: h('redir') } },
        { say: 'A document whose redirect URI is off the reserved hosts is refused.', op: 'cimdResolve', params: { clientId: h('wild') } },
        { say: 'A day passes: the cache entry has expired and the document is fetched again.', op: 'advance', params: { minutes: 1440 } },
        { say: 'The second fetch.', op: 'cimdResolve', params: { clientId: h('agent') } },
      ],
    },
    {
      id: 'creation', title: 'Approval-gated creation, session logging, headless agents and hosting',
      say: 'Nothing is created until an administrator approves; nobody decides their own proposal; a denied proposal cannot be approved; a changed proposal is stale. Session logging records invocations; a headless agent acts as its owner; one hostname serves every application by path, and sessions must be pinned to a replica.',
      steps: [
        { say: `${U} proposes a new MCP application.`, op: 'propose', params: { actor: U, kind: 'mcp', name: 'helpdesk', backend: `https://helpdesk.${c.castHost}.example/mcp`, authMode: 'static-token', note: 'for the support team' } },
        { say: `${U} cannot approve it.`, op: 'decide', params: { actor: U, proposalId: 'prop-0001', decision: 'approve', revision: 1 } },
        { say: `${A} proposes one too, then tries to approve their own.`, op: 'propose', params: { actor: A, kind: 'http', name: 'billing', backend: `https://billing.${c.castHost}.example`, authMode: 'none' } },
        { say: 'Self-approval is refused, administrators included.', op: 'decide', params: { actor: A, proposalId: 'prop-0002', decision: 'approve', revision: 1 } },
        { say: `${U} amends the first proposal after ${A2} has looked at revision 1.`, op: 'amend', params: { actor: U, proposalId: 'prop-0001', authMode: 'user-token' } },
        { say: `${A2} approves revision 1: stale, refused.`, op: 'decide', params: { actor: A2, proposalId: 'prop-0001', decision: 'approve', revision: 1 } },
        { say: `${A2} approves revision 2 and adjusts the name.`, op: 'decide', params: { actor: A2, proposalId: 'prop-0001', decision: 'approve', revision: 2, adjust: { name: 'support-desk' } } },
        { say: `${A2} denies the second proposal.`, op: 'decide', params: { actor: A2, proposalId: 'prop-0002', decision: 'deny', revision: 1, reason: 'use the existing billing application' } },
        { say: 'A denied proposal cannot be approved afterwards.', op: 'decide', params: { actor: A2, proposalId: 'prop-0002', decision: 'approve', revision: 1 } },
        { say: `${A} switches session logging on.`, op: 'setSessionLogging', params: { actor: A, enabled: true } },
        { say: 'A call is recorded with its arguments.', ...call(U, app(a1), 'search', { query: 'quarterly figures' }) },
        { say: `The headless agent ${c.castAgent} calls as its owner ${U}.`, ...call(undefined, app(a1), 'get_status', {}, { as: c.castAgent, user: undefined }) },
        { say: 'An agent key scoped for llm only is refused for MCP.', ...call(undefined, app(a1), 'get_status', {}, { as: `${c.castAgent}-llm`, user: undefined }) },
        { say: `${A} revokes the agent.`, op: 'setAgent', params: { actor: A, agentId: c.castAgent, enabled: false } },
        { say: 'A revoked agent is refused.', ...call(undefined, app(a1), 'get_status', {}, { as: c.castAgent, user: undefined }) },
        { say: 'One hostname, addressed by path: a path resolves to one application.', op: 'route', params: { path: `/${a1}/mcp` } },
        { say: 'A path nobody serves is a 404.', op: 'route', params: { path: '/nothing/mcp' } },
        { say: `${U} opens a session on replica A.`, op: 'sessionOpen', params: { user: U, replica: 'replica-a' } },
        { say: 'The next request lands on replica B, which holds no state for it.', op: 'sessionUse', params: { sessionId: 'sess-001', replica: 'replica-b' } },
        { say: `${A} pins client sessions to a replica.`, op: 'setPinning', params: { actor: A, enabled: true } },
        { say: 'The same request now reaches the replica that holds the session.', op: 'sessionUse', params: { sessionId: 'sess-001', replica: 'replica-b' } },
      ],
    },
  ];
}

const resolveParams = (value, prev) => {
  if (typeof value === 'function') return value(prev);
  if (Array.isArray(value)) return value.map((v) => resolveParams(v, prev));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, resolveParams(v, prev)]));
  return value;
};
export const stepParams = (step, prev) => resolveParams(step.params, prev);

// The result each step must give, in order. 'ok' or the refusal code. A doctor check and a test compare against it.
export const EXPECTED = {
  'aggregate-cap': ['ok', 'access_denied', 'access_denied', 'ok', 'ok', 'access_denied', 'ok', 'ok', 'ok'],
  members: ['ok', 'ok', 'ok', 'member_unreachable', 'member_timeout', 'member_missing', 'ok', 'ok', 'not_namespaced', 'alias_collision', 'ok', 'unknown_server'],
  discovery: ['ok', 'ok', 'ok', 'ok', 'access_denied', 'access_denied', 'access_denied', 'ok', 'ok', 'access_denied', 'ok', 'access_denied', 'ok', 'ok'],
  openapi: ['ok', 'external_ref_refused', 'not_json', 'ok', 'ok', 'ok', 'access_denied', 'invalid_arguments', 'ok', 'access_denied'],
  credentials: ['ok', 'ok', 'no_vault_credential', 'vault_self_service_only', 'ok', 'ok', 'upstream_authorization_required', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'assertion_wrong_audience', 'assertion_expired', 'assertion_bad_signature', 'assertion_untrusted_issuer', 'assertion_alg_not_allowed', 'assertion_lifetime_too_long', 'assertion_replay'],
  catalog: ['ok', 'ok', 'ok', 'unknown_catalog_entry', 'unverified_catalog_entry', 'name_taken', 'ok', 'ok', 'container_exited', 'ok', 'deployment_not_healthy', 'ok', 'ok', 'no_change', 'roadmap'],
  authorization: ['ok', 'pkce_required', 'pkce_s256_required', 'invalid_redirect_uri', 'ok', 'invalid_grant', 'ok', 'invalid_grant', 'invalid_grant', 'ok', 'ok', 'ok', 'invalid_grant', 'invalid_client_id', 'cimd_not_allowlisted', 'ok', 'ok', 'cimd_client_id_mismatch', 'cimd_too_large', 'cimd_symmetric_secret_refused', 'cimd_wrong_content_type', 'cimd_fetch_timeout', 'cimd_redirect_refused', 'cimd_bad_redirect_uri', 'ok', 'ok'],
  creation: ['ok', 'admin_only', 'ok', 'self_approval', 'ok', 'stale_revision', 'ok', 'ok', 'approve_after_deny', 'ok', 'ok', 'ok', 'key_not_scoped_for_mcp', 'ok', 'agent_revoked', 'ok', 'no_such_path', 'ok', 'session_not_on_replica', 'ok', 'ok'],
};

export function runScenario(cast, sc) {
  const e = new Engine(cast);
  const prev = [];
  const steps = sc.steps.map((st) => {
    const params = stepParams(st, prev);
    const r = perform(e, st.op, params);
    prev.push(r);
    return { say: st.say, op: st.op, result: r };
  });
  return { engine: e, steps };
}

// Everything Mock shows, generated from the engine: per vertical, per scenario, the steps and the final state.
export function buildMockTable() {
  const verticals = {};
  for (const [v, cast] of Object.entries(VERTICALS)) {
    verticals[v] = {
      scenarios: scenarioList(cast).map((sc) => {
        const { engine, steps } = runScenario(cast, sc);
        return { id: sc.id, title: sc.title, say: sc.say, steps: steps.map((s) => ({ say: s.say, op: s.op, ok: s.result.ok, code: s.result.ok ? null : s.result.code, detail: s.result.ok ? null : s.result.detail })), state: engine.snapshot() };
      }),
    };
  }
  return { schema: 'mcp-surface-lab-mock-table/1', verticals };
}
