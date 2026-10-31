// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
// The pack uses .invalid placeholders and no documentation URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const UNV = 'Ping release claim, UNVERIFIED on our tenant.';

export function buildPack() {
  const story = buildStory(DEFAULT_CAST, 'finance');
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = {
    'aggregate-cap': ['aggregate', 'aggregate-cap', 'namespaced-tools'], members: ['lazy-members', 'namespaced-tools', 'aggregate'], discovery: ['entitlement-discovery', 'per-tool-policy'],
    openapi: ['openapi-to-mcp'], credentials: ['credential-injection', 'token-pass-through'], catalog: ['mcp-catalog'], authorization: ['oauth-pkce', 'cimd'], creation: ['approval-gated-creation', 'hosted-servers'],
  };
  const why = (id) => story.talkTrack.find((t) => t.id === id).say;
  return {
    schema: 'demo-content-pack/1',
    id: 'mcp-surface-lab',
    title: 'MCP Surface LAB',
    version,
    demo: { id: 'mcp-surface-lab', name: 'MCP Surface LAB', catalog: 'D106', baseUrl: 'http://localhost:7350', doctor: '/api/health', tags: ['mcp-gateway', 'aggregate', 'discovery', 'openapi', 'credential-injection', 'pass-through', 'catalog', 'oauth', 'cimd', 'simulated'] },
    glossary: [
      { id: 'aggregate', term: 'MCP Aggregate', definition: `One endpoint that fronts many MCP servers: every member's tools appear in one listing under namespaced names, each member prefixed with its alias (defaulting to the application's own name). Members are resolved from the tenant's applications and connected on demand; a missing or unreachable member is reported. The member shape names (Members, AppRef, Alias, ToolFilter) are console swagger names, schema only. ${UNV}`, aliases: ['aggregate app'] },
      { id: 'aggregate-cap', term: 'The aggregate policy is the cap', definition: `A tool is visible through the aggregate only if the aggregate's own policy permits it, enforced on the listing and call at the aggregate and again at the member hop. The lab proves each point alone with two lab-invented fault switches. A measured AI-DEMO2 note says a listed member can hang; the deck does not. ${UNV}`, aliases: ['cap', 'enforced twice'] },
      { id: 'namespaced-tools', term: 'Namespaced tools', definition: `alias__tool. The AI-DEMO2 note found a renamed alias strands the existing grant (measured). ${UNV}`, aliases: [] },
      { id: 'lazy-members', term: 'Lazy member connections', definition: `A member is connected when a tool is first called, not by a listing. The counters and states are lab-invented; how the gateway knows a member is down without connecting is a lab reading. ${UNV}`, aliases: [] },
      { id: 'per-tool-policy', term: 'Per-tool policy', definition: `Authorization on the actual JSON-RPC method and target (tools, prompts, resources; listing and invocation). The grant shape is lab-invented. ${UNV}`, aliases: [] },
      { id: 'entitlement-discovery', term: 'Entitlement-aware discovery', definition: `Tools a user is not entitled to are removed from listings in flight, including streamed and gzip responses, so the agent never learns they exist; a hidden tool also cannot be called. The frame parser and the fail-closed rules are the lab's own. ${UNV}`, aliases: [] },
      { id: 'openapi-to-mcp', term: 'OpenAPI to MCP', definition: `Every operation of an OpenAPI document becomes an MCP tool with a per-operation schema; the generated server is fronted by the gateway as an ordinary application. Here the parser runs for real, locally, under lab-invented limits; the naming rule is lab-invented; the backend is an in-process mock. Authentication is header-based only. ${UNV}`, aliases: ['spec-driven tools'] },
      { id: 'credential-injection', term: 'Backend credential injection', definition: `none, an app-wide static token, a per-user credential from the User Vault, a second OAuth flow, or token pass-through (AuthMode values are console swagger names). Every credential shown is a labelled MOCK. ${UNV}`, aliases: [] },
      { id: 'token-pass-through', term: 'Token pass-through', definition: `A front-end application acting as an agent mints a short-lived signed assertion naming the end user, itself and the target backend; the gateway verifies it and forwards it unchanged. The lab signs with real RS256 and a local RSA key; the claims, lifetime cap and replay check are lab-invented. ${UNV}`, aliases: ['assertion'] },
      { id: 'mcp-catalog', term: 'MCP Catalog', definition: `Verified servers deploy as managed containers in one step with policy, credential injection and audit from the first request, and are health-checked and redeployed on configuration change. The entries and the four states are lab-written; customer-published entries are on the roadmap. ${UNV}`, aliases: [] },
      { id: 'hosted-servers', term: 'Hosted MCP servers', definition: `Managed containers, namespaced per tenant, with the calling user's vault credential in their environment. ${UNV}`, aliases: [] },
      { id: 'oauth-pkce', term: 'OAuth 2.1 with mandatory PKCE', definition: `Dynamic registration, S256-only PKCE (verified for real), single-use codes, rotating refresh tokens and discovery metadata. Token lifetimes are lab-invented. ${UNV}`, aliases: ['PKCE'] },
      { id: 'cimd', term: 'CIMD client registration', definition: `A client identifies itself by an allowlisted document URL; the gateway fetches, validates and caches it. The lab never fetches: fixed mock documents keyed by .example URLs. Console swagger names (schema only): CIMDConfig, CIMDClient, CIMDDocument. ${UNV}`, aliases: ['client ID metadata document'] },
      { id: 'approval-gated-creation', term: 'Approval-gated creation', definition: `Non-administrators propose; an administrator reviews, can adjust and approves before anything is created. States, revision check and expiry are lab-invented; values are re-validated at approval. ${UNV}`, aliases: [] },
    ],
    sources: [
      { id: 'deck-slides', title: 'Ping ID4AI Workforce H2 2026 deck, slides 35 to 39', url: 'https://example.invalid/ping-id4ai-workforce-h2-2026-deck', kind: 'deck', use: 'The MCP gateway, aggregate, OpenAPI to MCP and catalog release claims.', status: 'read', checked: '2026-10-31' },
      { id: 'console-swagger', title: 'Privilege console swagger, 2026-10-31 (schema only)', url: 'https://example.invalid/privilege-console-swagger', kind: 'schema', use: 'Field names for aggregate members, auth modes and CIMD configuration. It proves names exist, not behaviour.', status: 'read', checked: '2026-10-31' },
      { id: 'measured-notes', title: 'AI-DEMO2 aggregate and discovery notes, October 2026', url: 'https://example.invalid/ai-demo2-aggregate-notes', kind: 'note', use: 'Measured behaviour on an earlier gateway release: the member hang, refusal shapes, the cap header. Not about the 2026-11-02 release.', status: 'read', checked: '2026-10-31' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.say, group: 'try-it', action: { type: 'route', href: `/#${['aggregate', 'aggregate', 'discovery', 'openapi', 'credentials', 'catalog', 'authorization', 'creation'][i]}` }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'concept-why-gateway', label: 'Why it matters: MCP Gateway (slide 36)', description: why('why-gateway'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['per-tool-policy', 'entitlement-discovery', 'credential-injection'] },
      { id: 'concept-why-aggregate', label: 'Why it matters: MCP Aggregate (slide 37)', description: why('why-aggregate'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['aggregate', 'aggregate-cap'] },
      { id: 'concept-why-openapi', label: 'Why it matters: OpenAPI to MCP (slide 38)', description: why('why-openapi'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['openapi-to-mcp'] },
      { id: 'concept-why-catalog', label: 'Why it matters: MCP Catalog (slide 39)', description: why('why-catalog'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['mcp-catalog'] },
      { id: 'concept-hang', label: 'Deck claim versus our measured note: a member can hang', description: story.discrepancies.find((d) => d.id === 'hang').text, group: 'concept', action: { type: 'route', href: '/#aggregate' }, terms: ['lazy-members', 'aggregate'] },
      { id: 'concept-diagram', label: 'Diagrams', description: 'Three diagrams: the aggregate cap enforced twice; the discovery filter; and the pass-through assertion.', group: 'concept', action: { type: 'route', href: '/#diagram' }, terms: ['aggregate-cap', 'entitlement-discovery', 'token-pass-through'] },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.say })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
  console.log('wrote content-pack.json');
}
