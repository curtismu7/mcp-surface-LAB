# MCP Surface LAB

A simulation of Ping's MCP gateway release claims (deck slides 36 to 39, release 2026-11-02): an MCP Aggregate whose own policy caps its members, entitlement-aware discovery, OpenAPI to MCP, backend credential injection with token pass-through, an MCP Catalog, OAuth 2.1 with CIMD, and approval-gated creation.

Tier: Demo
Repo: https://github.com/curtismu7/mcp-surface-LAB
Catalog: D106

**Every product claim is a Ping release claim, UNVERIFIED on our tenant.** The release is not on our tenant. Nothing here calls a real gateway, MCP server, identity provider or network. The Real-or-mock modal says so when the page opens, and a claim tag sits on every tab, presenter mode included.

## What is simulated

**Mock mode (default).** Everything runs offline in one process and is read-only. Eight scripted scenarios per vertical (the aggregate cap, members, discovery, OpenAPI, credentials, catalog, authorization, creation) are generated from the lab's own engine into tables; a doctor check and a test fail if the tables drift from the engine. The OpenAPI preview also runs in Mock, because it changes nothing.

**Live mode (owner-run, still local).** The same engine acts on your own calls, edits and proposals, one engine per workspace and vertical. Loopback only, zero outbound network (a runtime netguard plus a test that asserts zero attempts). Three things are real: the OpenAPI parser and tool generator, PKCE S256 and the authorization server logic, and RS256 signing and verification with a locally generated RSA key. Everything else is a state machine.

Seven tabs and two more: Aggregate, Discovery and policy, OpenAPI to MCP, Credentials and pass-through, Catalog, Authorization (OAuth/CIMD), Creation and hosting, Diagram (three diagram-studio/1 diagrams: movable boxes, Simulate, speed, Reset), Talk track (with the "Why it matters" entries for slides 36 to 39, marked as Ping claims). Three vertical packs (finance, health, retail) change every name.

### What is lab-invented, lab reading, measured and deck

Each field in the app is tagged: **deck claim**, **console swagger name (schema only)** (bare field-name rows only), **lab reading** (behaviour inferred), **lab-invented**, or **measured (AI-DEMO2 note)**. The measured notes are from October 2026 on an earlier gateway and are not about this release. Highlights:

- Deck claims: slides 36 to 39 (one endpoint, namespaced tools, the aggregate policy as the cap enforced twice, lazy members, per-user upstream OAuth, OpenAPI to MCP, five credential modes, catalog, CIMD, approval-gated creation, path addressing).
- Console swagger names (schema only): `Members[]`, `AppRef`, `Alias`, `ToolFilter`, the `AuthMode` values, `CIMDConfig`, `CIMDClient`, `CIMDDocument`.
- Measured: the prefixed form in an aggregate grant, a renamed alias stranding the grant, the aggregate answering refusals as JSON-RPC errors with HTTP 200 and a member app answering a bare 403, deny by default from `initialize`, and a listed member that can hang. The page shows the deck claim and our measured note side by side.
- Lab-invented: the grant shape, the fault switches, connection counters, the OpenAPI limits and naming rule, assertion claims, the 300 second lifetime cap and the replay check, catalog entries and states, proposal states and revision check, token lifetimes, all limits.
- Slide 36's deployment line is clipped in the PDF; the lab says only what is visible and labels the rest "not stated".

### Known limits of the model

- The in-flight filter refuses the WHOLE response if a name hidden from a listing survives anywhere else in it (a notification, error data, structured content, plain text), and refuses a stream that yields no readable message; nested listings are filtered wherever they sit. A hidden name that appears in a visible tool's description therefore also refuses the response (fail closed). The match is on the WHOLE name: a hidden tool `list` does not refuse a listing because a visible tool is called `listItems` (a letter, digit, `_` or `-` next to the name means it is part of a longer name). The price: a hidden name written inside a longer word of a visible description is not seen.
- Replay after the clock has moved past the assertion's lifetime is reported as `expired`, not `replay`: expiry is checked first.
- Not modelled: AIGuard inspection and end-user sign-in through the aggregate; prompts and resources through an aggregate (not tested in our notes); `obo` (see intent-purpose-behaviour-LAB); container runtimes.
- A listing never connects a member (lab reading): the catalog and the health are recorded.
- **Integrity claims.** The pass-through assertion is verified by signature, issuer, audience, expiry and lifetime, by the gateway and again by the backend. Replay is detected only at the backend, only for ids it has seen (a cache of 200). "Forwarded unchanged" is a digest comparison between the token the front end minted and the string the backend received. The mock gateway hands on the very string it was given, so the comparison shows what the mock does, not an independent proof; what protects a real token is that a rewritten token fails the backend's own signature check. The key is a throwaway RSA key and is never shown. A mock-issued assertion is shown raw (labelled mock).
- **Masking is a heuristic, and it is the shared one.** Typed text is masked by the canonical shared masker (shared-masker 1.4.0, commit 9bc664a, copied unchanged to `server/src/shared/mask.js` and `hygiene.js`; the lab's `mask.js` and `credentials.js` are thin adapters over it). Visitor text is masked FIRST (whole, before any cut to length, so a secret that straddles the limit is masked, never half shown) and then tidied: control characters and bidi overrides become a space, zero-width characters are left in place (the masker reads through them), white space is collapsed. Every JSON answer is masked again on the way out, values AND object keys, including `hops[].request` bodies, ids from the path and error details; the hop panes and the audit use a typed-text masker that leaves only the mock OAuth server's own `mock-access/refresh/code-NNNN` tokens raw (shown raw by design, labelled mock). The story is lab prose and is read with key names off. The edge is boring on purpose: an unknown address or method on an unknown path is a fixed JSON 404; a known route with the wrong method is a 405 with `Allow` (also POST, PUT, DELETE and PATCH on `/`, which allows GET and HEAD) built from one route table; a request in a charset other than UTF-8 is a 415 with a fixed body (the typed charset is never answered or logged); a malformed body is a fixed 400 and an over-size one a 413; an unhandled error is a fixed 500 that never carries its message; the page is served for page addresses only, so a missing asset is a 404 and not a page; a workspace id shaped like a credential (a long hex or mixed run, or a `pw-`, `token-`, `password-`, `secret-`, `bearer-`, `ghp-`, `sk-` prefix) is refused with 400 `bad_workspace` before a slot is taken and is never echoed. Names taken from an OpenAPI document (operationId, parameter, property, required entry, scheme key, header name) are judged on their raw text before they become identifiers: a header or parameter name shaped like a secret refuses the whole document with 400 `credential_in_spec`, a secret-shaped operationId or property name falls back to a generated name. The hop panes show a path TEMPLATE and argument NAMES, never the substituted path; the lab always starts its own trace and never echoes a caller-sent trace id. **What it does and does not catch:** token shapes (prefixes, JWTs, PEM blocks, cloud keys), `key=value` and `key: value` under credential words, `login: bob / x`, `password - x`, `user:password@host`, plain-language statements (`my password is x`), and percent-, HTML-, unicode-escape and similar encodings up to 10 decode rounds (the lab's tests cover four-fold percent-encoding). A secret with no keyword and no recognisable shape is not found (a bare `p@ssw0rd`, a short random value), a passphrase of plain words is masked only as far as its first word, and not at all when that word is an everyday one (`password: correct horse battery staple` is shown as typed), a 31-character keyless run and a short `ghp_` token are missed, and other languages' words for password are not read. **The false-positive trade-off:** the masker prefers hiding a value that looks like a secret (6 or more characters with a digit, symbol or capital after a credential word), so `password=required` and `token: dolphins` are masked, while `The secret is out`, `password reset` and `token requirements` stay readable. A lab name that STARTS with `password-` or `token-` is refused as a workspace id for the same reason. Where the lab's own words trip the masker the lab rewords them (two messages were reworded for this); the credentials panel of the state is read as lab data (key names off), so a secret typed as a KEY inside that one panel is the known gap, and the engine never stores a typed value under a key there.
- Limits (what happens when full: the request is refused whole, nothing is dropped): 40,000 characters, 60 operations, 100 paths, depth 40 per OpenAPI document, an expansion budget of 1,500 schema nodes per tool and 20,000 in all (counted while the schemas are expanded, and a list entry or a parameter looked at counts as one more unit, so the work is bounded whatever the layout: a small spec whose levels reference each other, or one `required` list reached through 25 references in 64 operations, is refused with 413 after a bounded amount of work, which a test proves by counting units of work, not by timing it); a list of more than 60 `required` entries, 50 `enum` values, 10 `allOf` branches or 80 `parameters` (anywhere in the document) refuses the WHOLE document with 413 `list_too_long` before any schema work, as do more than 10 security schemes (`too_many_security_schemes`), more than 25 parameters in one operation and more than 60 properties in one schema (nothing is cut or skipped; an earlier version cut an enum to 50 values and ignored parameters past the 80th); the two report lists (parameters the gateway does not expose, warnings) show 40 entries each and count the rest in a last line; a file that does not exist under the page (an address with an extension, a dot segment or a dot-file) is a JSON 404, not the page; 500 audit entries (an action that changes anything is refused with 507 BEFORE it changes anything once fewer than 8 entries remain; a refusal that could not be written is counted, never dropped silently); 200 recorded calls (the call is refused rather than left unrecorded); with session logging on, arguments that a recording cannot hold without cutting (more than 12 list items, 24 keys, 4 levels or 300 characters per text) are refused whole with 413; 8 hosted containers; 30 applications; 12 aggregate members; 30 proposals; 20 DCR clients; 20 CIMD cache entries; 20 sessions; 200 workspaces (a new one is refused with 503, nothing is evicted; a refused request, and a pure preview (also in Live, also at the cap), leave no workspace behind, so they cannot use up a slot; a used authorization code takes no slot of the 50 pending ones); 40 hops per answer; bodies 64 KB.

## Run from a clone

Prerequisites: Node 26 or newer. Docker only if you use the Docker form. Mock mode works with no setup at all.

```
git clone https://github.com/ping-sandbox/mcp-surface-LAB.git
cd mcp-surface-LAB
npm ci
npm run build
npm start
```

Open http://localhost:7350/. Or `./scripts/run.sh` (installs and builds if needed, runs the doctor, starts).

## Settings file

All standalone apps read one settings file, `~/Development/.env` (mode 600; `STANDALONE_ENV` overrides the path). This lab needs none of it. It parses the file with `util.parseEnv` and takes exactly one optional key:

- `MSF_LAB_MODE` (optional): `mock` (default) or `live`, the mode the page opens in. A bare `MODE` in the shared file is ignored, because it may belong to another app.

The lab holds no credential for anything. The doctor reports whether the file exists and its mode, never a value.

## Ports, and what to do if the port is taken

```
Ports: mcp-surface-LAB listens on 7350 (set with PORT, default 7350).
Port range for this app: 7350-7399.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7350 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.
```

Other variables: `VITE_PORT` (Vite dev server, default 7351, `npm run dev -w web`), `HOST_PORT` (Docker host port, default 7350). Keep all of them inside 7350-7399.

## Mock and live modes

The header has a **Mock / Live** toggle on every page; the Real-or-mock modal and the mode chip show the same mode (Live reads as REAL in the modal, with a line saying it is still simulated). Mock reads the generated tables (a scenario picker on each tab) and is read-only: write controls are off and the API answers 409. Live drives this workspace's engine. "Call as" is the calling user; "Configure as" is the administrator for edits.

**What Privilege did.** In Live mode, each Call or List under a tab ends with a "What Privilege did" panel under the last action: the request the agent sent to the lab's simulated gateway (a reserved `.invalid` host), the exact answer, and each decision the engine evaluated in between, all marked "checked" because this lab's own engine computed them (it never reads a real gateway). The shared panel is vendored and pinned (Rule 25).

### What each layer logged for this run (Rule 27)

Under the last action in Live, and under the scripted scenario in Mock, the lab shows the shared run-observability panel: one run in time order across six layers (person, agent, Authorize, Privilege, agent gateway, resource server). It is vendored and pinned, and it is a different view from "What Privilege did": that one is the exact request, answer and checks of one call, this one is the run's decisions layer by layer.

- **Every row is `simulated`, and the record's source is `mock` in both modes.** Mock reads the decisions the engine took when the tables were generated (`npm run mock-table` stores them); Live is the same local engine acting on your calls. Nothing is read from a product log: the lab has no log reader, no `RUN_OBS_*` setting and no Docker socket, and a test pins all three. The header toggle is untouched (its Live is the rule-19 source `real`).
- **What is a run.** Live: one action that decides something: a gateway call (any method), a token pass-through attempt, a proposal, an approver's decision. Each has its own run id, and the panel reads the run of the last action. A configuration change (policy, transport, OpenAPI, catalog, vault, agent and logging switches) makes no run and leaves only the audit log. OAuth, CIMD, routing and session requests are protocol traffic: the lab can answer or refuse them, but this panel does not map them to rows, so the page says that and the audit log holds them. A request that fails validation before it becomes a gateway call (a malformed JSON-RPC body, a wire style the lab does not know, an unknown user) began no run: it gets no id, the page says so instead of showing an older record, and the decisions already taken for it (an agent key checked before the body was read) are written to stdout with `run=-`. A repeat decision on a proposal is refused the same way whether the first answer was approve or deny (a run with a refused row). Reset clears what the last action showed, its run included. Mock: the scripted scenario on screen is the run, so each row starts with the step (the call) that made it and the summary adds up every call of the scenario. The Authorization scenario takes no such decision, so it has no record.
- **The layers, as this lab has them.** Person: the roster user the action is for, `info` (the lab has no sign-in). Agent: the agent key and its grant check, the backend credential step (`info`), the front end's signed assertion (`info`: an issuance is not a decision). Authorize: not modelled, `not logged`. Privilege: the lab's own policy engine: policy for the caller, tool in the policy, the aggregate cap, tool filter, and approvals (`allowed` or `refused`; a proposal is `info` because the decision waits for an approver). Agent gateway: this lab's own simulated gateway, not Ping's. The method check is against the gateway's fixed list of methods, the same for every caller, so it is not a policy decision: `info` when it passes, `refused` when the method is outside the list, like an unknown tool or a name with no member prefix. Its other steps (member connection, in-flight filter) are `info`, and so is a fault: an application that is down, or a catalog container that is not running, is not a refusal. The lab's own recording limits stop a call as `blocked`. The same entitlement is `refused` under Privilege when a call names a tool outside the policy, and `info` under Agent gateway when a listing is filtered in flight (the filter hides names and turns no request away). Resource server: the lab's mock MCP server answering (`info`), and the backend's own verification of a pass-through assertion (`allowed` or `refused`). A check a fault switch skips is `info`, never an allow.
- **Time is the lab's own clock**, not the wall clock: it starts at 2026-11-02T09:00:00Z and moves only when you advance it, so one action's rows share an instant and keep the order the engine decided them in. Each row is stamped once, when the engine decided it, and Live writes the same time on its stdout line.
- **Where this lab's run leaves logs.** Live writes one line per decision to the container's stdout (and the terminal): `<lab time> mcp-surface-lab decision check=<id> layer=<layer> actor=<user> agent=<agent or -> result=<passed|stopped|unclear> run=<id>`, with only safe characters, masked like the rows, never a token. Mock reads recorded tables and writes none. If the writer fails, the run and its id are kept, the remaining lines are still tried, the server's stderr says why, and the page says the log writer failed for that run. **Where they can stream:** nowhere today. The family log collector (`shared/ping-log-collector`) does not list this container, so a SIEM holds nothing for it; if it did, the SIEM time would be Docker's wall-clock time per line and the lab time would stay inside the line.
- **Not logged today.** PingOne Authorize (not modelled). A real Ping gateway, Privilege and MCP servers (not run by this lab). Everything a layer did outside a run: configuration changes, OAuth and CIMD (audit log only).

## Health, doctor and reset

```
npm run doctor   # 21 checks, including a live aggregate cap cycle over the HTTP API; PORT=7359 npm run doctor to use a spare port
npm run reset    # clears the default workspace; the UI Reset also restores the diagram
```

`GET /api/health` returns `demo-health/1`. **Honest statuses.** A refused action is a real HTTP 400, 401, 403, 404, 409, 502, 504 or 507 with `ok: false`, an error code and, for a call, the JSON-RPC error and the wire form beside it. The browser logs every such answer as a console message: those are the refusals you asked to see, nothing else produces one.

## Docker (optional)

```
HOST_PORT=7350 docker compose up --build -d
```

The container publishes to 127.0.0.1 only (a test pins it), runs as a non-root user, read-only, no capabilities. Use OrbStack, not Docker Desktop. `MSF_LAB_MODE=live` opens the page in Live mode.

## Tests

```
npm test    # server (node --test), web (vitest, against the real server), scripts
```

The shared checks are run by hand: `check-drift.sh`, `check-css.sh` (AI-DEMO-Standalone) and `conformance.mjs . --new` (demo-kit-base).

On Node 26: 516 tests pass (342 server, 142 web, 32 scripts; the web count includes the 25 tests of the vendored run-observability panel). The server count includes the shared-masker corpora run through the adapters in process (3,754 leak probes, 338 of them structured, and 1,926 ordinary strings that must stay unchanged) and an HTTP sample of 60 payloads typed into free text, keys, path segments, queries and headers (a sample, not the whole corpus: the lab is a demo and takes no load tests).

Every stated limit has a test with its literal number (`server/test/boundaries.test.js`: N accepted, N+1 refused), so changing a limit fails a test until the page, this README and the test agree. Mutation checks (apply one change, run the server tests, revert; a hang counts as killed): the 13 mutants of the shared-masker adoption (the response mask, the 415 gate, the credential-id check on workspaces, a 405 table entry, the `/` entry, a widened page address, the opaque decision, the typed-text masker, mask-before-tidy, the error handler echoing a message, the static redirect, the hop-body mask, the bad_workspace refusal) are all killed; the 71 limit mutants of the second review (33 survived at the first commit of this lab, all 71 are killed now) and 62 mutants of the third-review behaviour (controls, keyword rule, list caps, work budget, static 404, whole-name check, workspace retry, diagram retry, layout).

**Known equivalent or unreachable mutants** (they cannot change an answer, so no test can kill them):
- the per-document cache of name verdicts in `openapi.js` is only a speed-up: never clearing it changes memory, not an answer;
- in `containsWholeName`, continuing the search after an occurrence at `at + 1` or at `at + name.length` gives the same answer, because two occurrences of one name cannot overlap and both be whole;
- `[...new Set(...)]` before the name check in a `required` list only saves repeated checks of one string;
- the doctor's scan of the story text for credential shapes has no test that plants a secret in the story data (the story is fixed text in this repo); the response mask and `echo.test.js` cover what a visitor can type;
- the 20,000-node limit cannot be reached by a 40,000-character document (three characters is the least a node costs), so its test raises the character limit for the length of that one test.

## Troubleshooting

- **The page says "Could not load the lab".** The server is not running or is on another port. Start it (`npm start`) and check `PORT`.
- **Port is taken.** See "Ports, and what to do if the port is taken" above.
- **`npm start` refuses to start.** Run `npm run doctor`; the first failing line says why.
- **A button is greyed out.** Mock is read-only. Switch to Live.
- **The mock table is out of date after an engine change.** Run `npm run mock-table` and `npm run talk-track`.

## Ownership

- Owner: the Ping demo family owner (Demo tier).
- License: MIT (see `LICENSE`).
- Found a problem? Open an issue on the repo.

## Not done

- Nothing is verified on a tenant: the release is not on our tenant. Re-diff the swagger and re-check the gateway image after 2026-11-02 before removing any UNVERIFIED label.
- No SE k8s build (deferred by the owner). The repo is not pushed and has no GitHub repo or runner yet.

---

## Real mode: through the PingOne Privilege gateway

Real mode here is one live call through the SE PingOne Privilege gateway
(the gateway host is in the shared settings file) with an agent access key from the shared
settings file (`~/Development/.env`, or the file `STANDALONE_ENV` names).

**Privilege objects this lab uses:** the Agentic App `aggregate-limited` — the gateway's
MCP aggregate with a tool filter — at client path `/aggregate-limited/mcp`, called with the
agent access key `MSF_GW_KEY_LAB_AGENT` (write-only, never shown). **What runs in Real:** the
**Privilege gateway check** (`POST /api/gateway-check`): one live `tools/list` through the gateway,
then one `tools/call` probe of a tool no policy grants, so you see the gateway's own refusal
shape. The lab's own Live engine stays loopback-only; the gateway hop is the one outbound call.
Settings keys: `MSF_GW_URL`, `MSF_GW_APPS`, `MSF_GW_KEY_<NAME>`.
