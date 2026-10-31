// The seeded world: users and groups, the tenant's existing applications, their upstream MCP servers (tools, prompts, resources), the aggregate,
// the catalog entries, the headless agents and the mock CIMD client documents. Every name comes from the cast. Everything here is lab-invented
// (the deck gives no sample data); only the SHAPES that the console swagger names are marked as such in the story data.
export const BASE_EPOCH = Date.UTC(2026, 10, 2, 9, 0, 0) / 1000; // the lab clock starts at 2026-11-02T09:00:00Z, the release date in the deck

export const GROUPS = ['admins', 'staff', 'contractors'];

// The upstream MCP servers behind the applications. readOnly is the lab's own label (used for the sample default grants).
const tool = (name, description, readOnly, args = {}) => ({ name, description, readOnly, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(args).map(([k, { required, ...rest }]) => [k, rest])), additionalProperties: false, required: Object.keys(args).filter((k) => args[k].required) } });
const arg = (type, description, extra = {}) => ({ type, description, ...extra });
const q = arg('string', 'free-text query', { required: true });
const rid = arg('string', 'record id', { required: true });

export const UPSTREAMS = {
  u1: {
    tools: [tool('search', 'Search records', true, { query: q }), tool('get_status', 'Service status', true), tool('read_record', 'Read a record the caller may see', true, { id: rid }), tool('write_record', 'Write a record', false, { id: rid, note: arg('string', 'note') }), tool('export_all', 'Export every record', false)],
    prompts: [{ name: 'summarise', description: 'Summarise a record' }, { name: 'draft_reply', description: 'Draft a reply' }],
    resources: [{ uri: 'docs://guide', name: 'guide' }, { uri: 'docs://policy', name: 'policy' }, { uri: 'records://all', name: 'all records' }],
  },
  u2: { tools: [tool('search', 'Search items', true, { query: q }), tool('get_status', 'Service status', true), tool('create_item', 'Create an item', false, { name: arg('string', 'item name', { required: true }) }), tool('refund_item', 'Refund an item', false, { id: rid })], prompts: [], resources: [] },
  u3: { tools: [tool('search', 'Search cases', true, { query: q }), tool('list_cases', 'List open cases', true), tool('close_case', 'Close a case', false, { id: rid })], prompts: [], resources: [] },
  u4: { tools: [tool('search', 'Search the archive', true, { query: q })], prompts: [], resources: [] },
  u5: { tools: [tool('search', 'Search the legacy system', true, { query: q }), tool('bulk_export', 'Bulk export', false)], prompts: [], resources: [] },
};
export const RECORDS = (c) => [{ id: 'r-1', owner: c.castUser, text: 'Q3 reconciliation' }, { id: 'r-2', owner: c.castUser, text: 'Vendor onboarding' }, { id: 'r-3', owner: c.castUser2, text: 'Year-end review' }, { id: 'r-4', owner: c.castAdmin, text: 'Board pack' }];

export const roster = (c) => [
  { id: c.castAdmin, role: 'admin', groups: ['admins'] }, { id: c.castAdmin2, role: 'admin', groups: ['admins'] },
  { id: c.castUser, role: 'user', groups: ['staff'] }, { id: c.castUser2, role: 'user', groups: ['staff'] }, { id: c.castOutsider, role: 'user', groups: ['contractors'] },
];

const g = (group, tools = [], prompts = [], resources = []) => ({ group, tools, prompts, resources });

// The tenant's existing applications. Auth modes use the console swagger's enum values (none, static-token, user-token, oauth, token-pass).
export function seedApps(c) {
  const mk = (name, upstream, over) => ({ id: name, name, kind: 'mcp', source: 'seed', upstream, up: true, transport: 'streamable-http', authMode: 'none', staticHeader: 'Authorization', entryPath: `/${name}/mcp`, policy: { grants: [] }, ...over });
  return [
    mk(c.castApp1, 'u1', { authMode: 'static-token', policy: { grants: [g('staff', ['search', 'get_status', 'read_record'], ['summarise'], ['docs://guide']), g('admins', ['*'], ['*'], ['*'])] } }),
    mk(c.castApp2, 'u2', { authMode: 'user-token', policy: { grants: [g('staff', ['search', 'get_status', 'create_item']), g('contractors', ['get_status']), g('admins', ['*'])] } }),
    mk(c.castApp3, 'u3', { authMode: 'oauth', policy: { grants: [g('staff', ['search', 'list_cases']), g('admins', ['*'])] } }),
    mk(c.castApp4, 'u4', { up: false, policy: { grants: [g('staff', ['search']), g('admins', ['*'])] } }),
    mk(c.castApp5, 'u5', { transport: 'sse', policy: { grants: [g('staff', ['search']), g('admins', ['*'])] } }),
  ];
}

// The seeded aggregate. Members are application references with an alias (empty alias = the application's own name) and a tool filter (swagger: AppRef, Alias, ToolFilter).
export function seedAggregate(c) {
  const m = (name, extra = {}) => ({ appRef: { RefKind: 'application', RefID: name }, alias: '', toolFilter: { Elems: [] }, ...extra });
  return {
    id: 'all-in-one', name: 'all-in-one', entryPath: '/all-in-one/mcp',
    members: [m(c.castApp1), m(c.castApp2), m(c.castApp3), m(c.castApp4), m(c.castApp5), m(c.castMissing)],
    policy: {
      grants: [
        g('staff', [`${c.castApp1}__search`, `${c.castApp1}__get_status`, `${c.castApp1}__read_record`, `${c.castApp2}__search`, `${c.castApp2}__get_status`, `${c.castApp2}__refund_item`, `${c.castApp3}__list_cases`, `${c.castApp5}__search`]),
        g('contractors', [`${c.castApp2}__get_status`]),
        g('admins', ['*']),
      ],
    },
  };
}

export const CATALOG = [
  { id: 'kb-search', name: 'Knowledge search', version: '1.4.2', verified: true, publisher: 'lab', arch: ['linux/amd64', 'linux/arm64'], tools: [tool('search_docs', 'Search the knowledge base', true, { query: q }), tool('get_doc', 'Read one document', true, { id: rid })], summary: 'Search and read a document set.' },
  { id: 'ticket-desk', name: 'Ticket desk', version: '2.0.1', verified: true, publisher: 'lab', arch: ['linux/amd64', 'linux/arm64'], tools: [tool('list_tickets', 'List tickets', true), tool('create_ticket', 'Create a ticket', false, { title: arg('string', 'ticket title', { required: true }) })], summary: 'Read and raise tickets.' },
  { id: 'unit-convert', name: 'Unit converter', version: '0.9.0', verified: true, publisher: 'lab', arch: ['linux/amd64', 'linux/arm64'], tools: [tool('convert', 'Convert a quantity', true, { value: arg('number', 'amount', { required: true }), to: arg('string', 'target unit', { required: true })})], summary: 'A tiny stateless server.' },
  { id: 'community-weather', name: 'Community weather', version: '0.3.0', verified: false, publisher: 'community (not reviewed)', arch: ['linux/amd64'], tools: [tool('forecast', 'Weather forecast', true, { city: arg('string', 'city', { required: true }) })], summary: 'An unreviewed community server: the catalog lists it, but it is not verified, so it cannot be deployed.' },
];
export const LOG_LEVELS = ['info', 'warn', 'debug'];

export const AGENTS = (c) => [
  { id: c.castAgent, owner: c.castUser, auth: 'access-key', scopes: ['mcp'], enabled: true },
  { id: `${c.castAgent}-fi`, owner: c.castUser2, auth: 'federated-identity', scopes: ['mcp'], enabled: true },
  { id: `${c.castAgent}-llm`, owner: c.castUser, auth: 'access-key', scopes: ['llm'], enabled: true },
];

// Mock client documents, keyed by URL. The lab never fetches: each URL maps to one fixed outcome. Hosts are .example. size is the declared byte size.
export function cimdDocs(c) {
  const h = (n) => `https://${n}.${c.castHost}.example/client.json`;
  const doc = (url, extra = {}) => ({ client_id: url, client_name: 'Agent client', redirect_uris: [`https://${new URL(url).hostname}/callback`], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...extra });
  return {
    [h('agent')]: { outcome: 'ok', contentType: 'application/json', size: 420, doc: doc(h('agent')) },
    [h('notes')]: { outcome: 'ok', contentType: 'application/json', size: 410, doc: doc(h('notes'), { client_id: h('somebody-else') }) },
    [h('big')]: { outcome: 'ok', contentType: 'application/json', size: 12000, doc: doc(h('big')) },
    [h('slow')]: { outcome: 'timeout' },
    [h('wrongtype')]: { outcome: 'ok', contentType: 'text/html', size: 300, doc: doc(h('wrongtype')) },
    [h('redir')]: { outcome: 'redirect' },
    [h('secret')]: { outcome: 'ok', contentType: 'application/json', size: 450, doc: doc(h('secret'), { token_endpoint_auth_method: 'client_secret_basic' }) },
    [h('gone')]: { outcome: 'not_found' },
    [h('unlisted')]: { outcome: 'ok', contentType: 'application/json', size: 400, doc: doc(h('unlisted')) },
    [h('wild')]: { outcome: 'ok', contentType: 'application/json', size: 400, doc: doc(h('wild'), { redirect_uris: ['http://evil.invalid/steal'] }) },
  };
}
export const CIMD_ALLOWLIST_DEFAULT = (c) => ['agent', 'notes', 'big', 'slow', 'wrongtype', 'redir', 'secret', 'gone', 'wild'].map((n) => ({ URL: `https://${n}.${c.castHost}.example/client.json`, IsPrivate: false }));

// The sample OpenAPI document the page offers (valid, small, JSON).
export function sampleSpec(c) {
  return {
    openapi: '3.0.3', info: { title: `${c.castApi} API`, version: '1.0.0', description: 'A small example API used by the lab.' },
    servers: [{ url: `https://${c.castApi}.${c.castHost}.example/v1` }],
    components: {
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      schemas: { Item: { type: 'object', required: ['name'], properties: { id: { type: 'string', description: 'item id' }, name: { type: 'string', description: 'item name' }, qty: { type: 'integer', description: 'quantity' } } } },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/items': {
        get: { operationId: 'listItems', summary: 'List items', parameters: [{ name: 'limit', in: 'query', description: 'page size', schema: { type: 'integer', minimum: 1, maximum: 50 } }] },
        post: { operationId: 'createItem', summary: 'Create an item', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
      },
      '/items/{id}': {
        get: { operationId: 'getItem', summary: 'Get one item', parameters: [{ name: 'id', in: 'path', required: true, description: 'item id', schema: { type: 'string' } }] },
        delete: { summary: 'Delete one item', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
      },
    },
  };
}
export const MOCK_BACKEND_ITEMS = [{ id: 'i-1', name: 'Alpha', qty: 3 }, { id: 'i-2', name: 'Beta', qty: 7 }, { id: 'i-3', name: 'Gamma', qty: 1 }];
