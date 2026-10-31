# Talk track

<!-- Generated from server/src/data.js by `npm run talk-track`. Do not edit by hand. -->

> Ping release claim, UNVERIFIED on our tenant: every product claim here comes from the Ping ID4AI Workforce H2 2026 deck, slides 35 to 39 (release 2026-11-02). Nothing here ran against a real gateway, MCP server, identity provider or tenant.

## What this lab shows

Slides 36 to 39 describe the MCP gateway as the single, governed way agents reach MCP servers. This lab models the parts that are about behaviour you can watch: an aggregate whose own policy caps its members, discovery that removes what you may not use before the agent sees it, OpenAPI turned into tools (really, locally), five ways to inject a backend credential, a catalog, OAuth with CIMD, and approval-gated creation. Everything is a Ping release claim, unverified on our tenant.

## One endpoint, namespaced tools

The agent connects once to the aggregate. Every member's tools arrive in one listing, each prefixed with its alias, so ledger__search and payments__search never collide. Rename an alias and the tool names change with it; a grant written for the old name stops matching (a measured note).

## The aggregate's policy is the cap

Look at the payments member: it allows create_item for staff, but the aggregate's policy does not, so the tool is hidden from the listing and refused at the aggregate. The other way round, refund_item is allowed by the aggregate and denied by the member, so it is refused at the member hop. Switch on the two faults to see each layer alone is enough: the cap is enforced twice.

## Lazy, honest members

Nothing connects until a tool is called: the counters stay at zero through a listing. A member that is missing or down is reported with its reason, not dropped. Our own measured note adds something the deck does not: a member recorded as sse can hang. The lab shows the deck claim and the measured note side by side, labelled.

## The agent never learns what it may not use

Authorization is evaluated on the JSON-RPC method and its target, for tools, prompts and resources, listing and invocation. The filter works in flight, on a plain body, on a stream split mid-frame, and on gzip. A hidden tool cannot be called either, and the refusal looks the same as for a tool that does not exist.

## OpenAPI in, MCP tools out

Paste an OpenAPI document and every operation becomes a tool with a per-operation schema. This part is real: the parser is bounded, refuses remote references and YAML, and the generated tools run against an in-process mock backend. Remove an operation and redeploy: it disappears. Authentication is header-based; login flows stay the agent's job.

## The agent never holds the credential

None, a static token, a per-user credential from the vault, a second OAuth flow, or pass-through. For each, compare what the agent sees (nothing) with what the backend receives, and whether the backend can tell who acted. A static token makes every user the same service account; the others let the backend see the person.

## Pass-through, with real signatures

The front-end application mints a short-lived RS256 assertion naming the end user, itself and the target. The gateway verifies and forwards it unchanged; the backend verifies it again and scopes its answer to that user. Try a wrong audience, an expired token, a tampered payload, an untrusted issuer, a replay and alg none: each is refused, and the page says by whom.

## A verified catalog, one step

A catalog entry deploys as a managed container behind the gateway in one step, and its policy, credential injection and audit are there from the first request. It is health-checked and redeployed when its configuration changes. An unknown or unverified entry is refused; customer-published entries are on the roadmap. The entries here are the lab's own.

## OAuth 2.1, and CIMD

Dynamic registration, mandatory PKCE S256 (checked for real), single-use codes, rotating refresh tokens, discovery metadata. CIMD: a client names itself by a document URL the tenant has allowlisted; the gateway validates and caches the document. The lab never fetches anything: it holds fixed mock documents, and says so.

## Nothing is created until an administrator approves

A non-administrator proposes a new MCP or HTTP application; an administrator reviews, can adjust, and approves. Nobody decides their own proposal, a denied proposal cannot be approved, and a proposal that changed after you looked is refused as stale. Session logging records invocations and arguments when it is on.

## Hosting, headless agents and deployment

Hosted servers run as namespaced containers with the calling user's vault credential in their environment. A headless agent acts as its owning user. One hostname serves every application by path. OAuth session state is per gateway process, so client sessions must be pinned to a replica: slide 36 is clipped after that, so the lab says nothing more.

## Why it matters: MCP Gateway (slide 36)

Challenge: An MCP server typically authenticates with one shared token and exposes every tool to every caller: no attribution, no per-tool control. Security cannot approve that, so MCP adoption stalls in review. Technical: per-user identity, per-tool policy and injected credentials on every call, fully audited. Business: MCP integrations proceed under existing governance, cutting time to value on agent projects. (Ping claims, unverified on our tenant.)

## Why it matters: MCP Aggregate (slide 37)

Challenge: Every agent-server pair needs its own connection, configuration and credential, so integration effort and attack surface grow with each pair. Teams delay adding servers, and agents stay narrow. Technical: one connection, one policy cap enforced twice, one audit trail across every member server. Business: new servers join by configuration, not project work: lower per-integration cost and faster rollout of agent capability. (Ping claims, unverified on our tenant.)

## Why it matters: OpenAPI to MCP (slide 38)

Challenge: Agents speak MCP but enterprise capability lives in REST APIs, so exposure demands a development project. Agent coverage waits on engineering, and adoption slows to engineering's backlog. Technical: spec-generated MCP servers under full gateway policy, with no code. Business: existing APIs reach agents without development spend, converting API assets to agent-ready in days rather than sprints. (Ping claims, unverified on our tenant.)

## Why it matters: MCP Catalog (slide 39)

Challenge: Servers found on the open internet are an unvetted supply-chain decision, and security review has nothing to base approval on. Adoption either stalls or happens unsanctioned around the review. Technical: verified, versioned images deploy behind the gateway in one step, controls applied from the first request. Business: removes blind supply-chain risk and shortens approval cycles: adopters choose between known-good options. (Ping claims, unverified on our tenant.)

## What is the deck and what is ours

Every box on the page says where it comes from: deck claim, console swagger name (schema only), lab reading, lab-invented, or measured (AI-DEMO2 note). The measured notes are from October 2026 and are not about the 2026-11-02 release. The lab holds no credential for anything, and a typed secret never comes back: it is masked wherever it would appear.

## Where the deck and our own measured notes differ (shown, not resolved)

- **Unreachable is reported; a member can also hang.** Deck (slide 37): a member that is missing or unreachable is reported as such. Our measured note (AI-DEMO2, October 2026): a member recorded with the sse transport never answered through an aggregate, although it answered when called directly; the log showed the aggregate opening an event stream and waiting. Swapping the member for another application on the same server did not help; a small front that answers that GET with 405 did. The lab models both: the deck's reported-as-unreachable, and the measured hang (a call to a member recorded as sse times out in the lab's simulated 30 seconds). It cannot say whether 2026-11-02 changes the hang.
- **Listed is not working.** Our measured note: tools appeared in the aggregate's listing and then failed or hung when called, because of the member behind them. The deck does not say a listing proves a call will work. The lab lists a down member's tools flagged as unavailable (a lab reading of "reported, not silently dropped").
- **How a refusal looks differs by path.** Measured (AI-DEMO2): a member application answers a refusal with a bare 403 and no body; an aggregate answers the same refusal as a JSON-RPC error with HTTP 200. The deck is silent. The lab API uses honest HTTP statuses and shows the wire form beside each refusal.
- **Token pass-through: deck versus swagger wording.** The deck describes an assertion minted by a front-end application acting as an agent, naming the end user, itself and the target backend. The console swagger (2026-10-31, schema only) describes the token-pass mode as "the verified inbound workload assertion, forwarded unchanged". These may be the same thing seen from two ends; the lab models the deck's version and does not resolve it. The swagger enum also has obo, a sixth mode that the deck does not list as a credential mode and this lab does not model.
- **CIMD: claimed, not proven on our tenant.** Deck (slide 36): the gateway fetches, validates, caches and advertises CIMD. Our October note (AI-DEMO2): only a public client document published by a third party was known to be fetched; Privilege accepting documents from our own agents and completing a sign-in was not yet proven. This lab never fetches: it holds fixed mock documents. For the real document flow, see the separate cimd-lab (text link only).
- **Slide 36: the deployment line is clipped.** The last row of the slide 36 table is partly hidden by the value panel in the PDF. The lab says only what is visible: one hostname serves every MCP application by path; OAuth session state is held per gateway process; and the last visible words are "pin client sessions to a replica". How replicas are pinned, and anything after that, is not stated.

## The scripted scenarios (Mock mode)

1. **The aggregate's policy is the cap, enforced twice.** One endpoint fronts ledger, payments, cases, archive and legacy-core. A tool the member allows but the aggregate denies is hidden and refused at the aggregate; a tool the aggregate allows but the member denies is refused at the member hop. Each fault switch shows one layer alone is enough.
2. **Aliases, lazy connections and members that are missing, down or hang.** Members are resolved from the tenant's own applications and connected only when a tool is called. A missing or unreachable member is reported, not dropped; a member recorded as sse hangs (a measured note). An alias clash is refused, and renaming an alias strands the old grant.
3. **Entitlement-aware discovery: removed in flight, never callable.** The upstream lists everything. The gateway filters the listing in flight on a plain body, on a stream split into small chunks with comments and notifications, and on gzip. A tool you may not see cannot be called, and the refusal is the same as for one that does not exist.
4. **OpenAPI to MCP: a spec becomes tools, and follows the spec.** This runs for real. The spec is parsed under hard limits, every operation becomes a tool, the generated server is fronted as an ordinary application, and a removed operation disappears on redeploy. Remote references and YAML are refused.
5. **Five ways to inject a backend credential.** The agent never holds the credential. A static token makes everyone the same service account; a vault credential, a second OAuth flow and a signed assertion let the backend see the person. The assertion is real RS256 and is verified twice.
6. **The catalog: a verified server in one step, operated and redeployed.** A verified catalog entry deploys as a namespaced managed container with policy, credential injection and audit in place before the first request. Unknown and unverified entries are refused. A crash is found by a health check, and a configuration change redeploys.
7. **OAuth 2.1 with mandatory PKCE, refresh tokens and CIMD.** Dynamic registration, PKCE S256 verified for real, single-use codes and rotating refresh tokens; and CIMD, where the client is named by a document URL the tenant has allowlisted. The lab never fetches: each URL has one fixed mock outcome.
8. **Approval-gated creation, session logging, headless agents and hosting.** Nothing is created until an administrator approves; nobody decides their own proposal; a denied proposal cannot be approved; a changed proposal is stale. Session logging records invocations; a headless agent acts as its owner; one hostname serves every application by path, and sessions must be pinned to a replica.

## Not demonstrated

- Anything about how the real gateway, console, catalog, container platform or a real identity provider behaves: nothing here ran against one. Hosts are .example, documents are fixed mocks, credentials are labelled MOCK.
- AIGuard inspection, tool-call recording at the gateway and per-user sign-in of the end user, which slide 37 says apply unchanged to aggregate traffic: this lab models per-tool policy, entitlement-aware discovery and a session-logging recording, not AIGuard or the sign-in itself.
- Resources and prompts through an aggregate: the AI-DEMO2 note did not test them, so the lab models the aggregate for tools only. Direct applications do have prompts and resources.
- The real encoding of an application reference, the real cap-header format, the real names of the gateway's log lines beyond the two measured ones, and the real shape of a catalog entry or of a managed container.
- The on-behalf-of token exchange (obo) and ID-JAG redeem: see intent-purpose-behaviour-LAB. Federated Identity token verification: see federated-identity-LAB (if built). The User Vault itself: see secrets-vault-LAB (if built).
- Multi-architecture image building, the registry pipeline, container isolation and real health probes: the catalog states are a state machine, not a container runtime.
- The deck's slide 36 deployment line beyond the words that are visible.
