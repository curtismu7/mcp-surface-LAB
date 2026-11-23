// These tests drive the real UI against the real Express app (started on a loopback port inside the test), so a green run means the pieces actually work together.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { createWorkspaces } from "../../server/src/workspaces.js";
import { VERTICALS } from "../../server/src/cast.js";
import App, { BANNER_UNKNOWN, TABS } from "./App";
import { labelOffsets } from "./components/PatternDiagram";
import { visible } from "./safeText";
import { forgetWorkspace } from "./workspace";
import { setJsonView } from "./components/JsonPane.jsx";

const C = VERTICALS.finance;
let server; let base; const realFetch = globalThis.fetch; let seen = []; let failDiagram = 0; // failDiagram: how many /api/diagram requests to abort (a dropped connection)
beforeAll(async () => {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json", workspaces: createWorkspaces({ max: 5000 }) }) }));
  base = base.replace(/\/$/, "");
  globalThis.fetch = async (u, init = {}) => {
    const url = typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u;
    seen.push({ url: String(url), body: typeof init.body === "string" ? init.body : "" });
    if (failDiagram > 0 && String(url).includes("/api/diagram")) { failDiagram -= 1; throw new TypeError("Failed to fetch"); }
    return realFetch(url, { ...init, headers: { origin: base, ...(init.headers || {}) } });
  };
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => { cleanup(); forgetWorkspace(); setJsonView("form"); seen = []; failDiagram = 0; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; realFetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ source: "mock" }) }).catch(() => {}); });

// Every wait is on a STATE (an element enabled or a text present), never on a clock; the timeouts are generous hang guards because the suite runs at machine load 60-500.
const T = { timeout: 120000 };
const mount = async () => { render(<App />); await screen.findByTestId("members", {}, T); };
const tab = (name) => userEvent.click(within(screen.getByRole("navigation", { name: "Lab sections" })).getByRole("link", { name }));
const click = async (id) => { await waitFor(() => expect(screen.getByTestId(id)).toBeEnabled(), T); await userEvent.click(screen.getByTestId(id)); };
const live = async () => { await fireEvent.change(screen.getByTestId("mode-select"), { target: { value: "real" } }); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/), T); await screen.findByTestId("actor", {}, T); await waitFor(() => expect(screen.getByTestId("list-tools")).toBeEnabled(), T); };
const setValue = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } });
const pick = (id, value) => userEvent.selectOptions(screen.getByTestId(id), value);

describe("shell", () => {
  it("has the nine tabs and the banner says Ping claim UNVERIFIED in the right mode on every tab, presenter mode included", async () => {
    expect(TABS.map((t) => t.id)).toEqual(["aggregate", "discovery", "openapi", "credentials", "catalog", "authorization", "creation", "diagram", "talk"]);
    expect(BANNER_UNKNOWN).toMatch(/UNVERIFIED on our tenant/);
    await mount();
    // shell bar first, then main with the banner as its first child (STANDALONE-UI-PATTERNS sections 1 and 2)
    expect(document.querySelector(".app").firstElementChild.matches("header.shell-bar")).toBe(true);
    expect(document.querySelector("main").firstElementChild).toBe(screen.getByTestId("banner"));
    for (const t of TABS) {
      await tab(t.label);
      await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode.*UNVERIFIED on our tenant/), T);
      expect(within(screen.getByRole("navigation", { name: "Lab sections" })).getByRole("link", { name: t.label })).toHaveAttribute("aria-current", "page");
      expect(document.querySelector("main").firstElementChild).toBe(screen.getByTestId("banner"));
    }
    await tab("Aggregate"); await userEvent.keyboard("p");
    expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED on our tenant/);
    expect(screen.getByTestId("presenter-say")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("presenter-say")).toBeNull();
    await live();
    expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/); expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
  });

  it("makes no non-local request", async () => {
    await mount(); await live(); await tab("Talk track");
    expect(seen.every((r) => r.url.startsWith(base))).toBe(true);
  });
});

describe("Mock", () => {
  it("is read-only: every write control is off, and a scenario picker shows generated steps with their refusals", async () => {
    await mount();
    expect(screen.getByTestId("list-tools")).toBeDisabled(); expect(screen.getByTestId("save-policy")).toBeDisabled();
    await click("scn-aggregate-cap");
    await waitFor(() => expect(screen.getByTestId("scenario-steps")).toHaveTextContent(/refused \(access_denied\)/), T);
  });
  it("still runs the pure OpenAPI preview", async () => {
    await mount(); await tab("OpenAPI to MCP");
    await click("preview"); await screen.findByTestId("tool-table", {}, T);
    expect(screen.getByTestId("tool-getItem")).toBeInTheDocument(); expect(screen.getByTestId("deploy")).toBeDisabled();
  });
});

describe("Live flows", () => {
  it("aggregate: the cap is proven at the aggregate, at the member hop, and by each fault switch alone", async () => {
    await mount(); await live();
    await click("list-tools"); const list = await screen.findByTestId("agent-tools", {}, T);
    expect(list).toHaveTextContent("ledger__search"); expect(list).not.toHaveTextContent("payments__create_item");
    await click("preset-agg-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("enforced-at")).toHaveTextContent(/^aggregate$/), T);
    await click("preset-member-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("enforced-at")).toHaveTextContent(/member-hop \(member policy\)/), T);
    await click("fault-agg"); await click("preset-agg-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("enforced-at")).toHaveTextContent(/member-hop \(aggregate cap\)/), T);
    await click("preset-ok"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("conn-ledger")).toHaveTextContent(/connects 1/), T);
    expect(screen.getByTestId("conn-cases")).toHaveTextContent(/connects 0/);
  });

  it("aggregate: an alias collision is refused with its code, and a rename warns about the stranded grant", async () => {
    await mount(); await live();
    setValue("alias-ledger", "payments"); await click("save-member-ledger");
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/alias_collision/), T);
    setValue("alias-ledger", "books"); await click("save-member-ledger");
    await screen.findByTestId("stale-grants", {}, T);
  });

  it("discovery: the listing is filtered in flight over a compressed stream, and a hidden tool is refused", async () => {
    await mount(); await live(); await tab("Discovery and policy");
    await pick("disc-style", "gzip-sse"); await click("list-tools");
    await waitFor(() => expect(screen.getByTestId("agent-list").querySelectorAll("li").length).toBe(3), T);
    expect(screen.getByTestId("upstream-list").querySelectorAll("li").length).toBe(5);
    expect(screen.getByTestId("gateway-log")).toHaveTextContent(/Removing unauthorized tool from MCP response: export_all/);
    await click("disc-call"); await waitFor(() => expect(screen.getByTestId("disc-verdict")).toHaveTextContent(/refused \(access_denied, HTTP 403\)/), T);
  });

  it("OpenAPI: paste, generate tools, deploy, call, remove an operation, redeploy; YAML and bad JSON are refused", async () => {
    await mount(); await live(); await tab("OpenAPI to MCP");
    await click("preview"); await screen.findByTestId("tool-table", {}, T);
    expect(screen.getByTestId("tool-table").querySelectorAll("tbody tr").length).toBe(4);
    await click("deploy"); await screen.findByTestId("server-invoices", {}, T);
    await pick("oa-tool", "getItem"); setValue("oa-args", '{"id":"i-2"}'); await click("oa-call");
    await waitFor(() => expect(screen.getByTestId("oa-answer")).toHaveTextContent(/Beta/), T);
    await click("remove-delete_items_by_id"); await click("preview");
    await waitFor(() => expect(screen.getByTestId("tool-table").querySelectorAll("tbody tr").length).toBe(3), T);
    await click("redeploy"); await waitFor(() => expect(screen.getByTestId("redeploy-diff")).toHaveTextContent(/Removed: delete_items_by_id/), T);
    setValue("spec", "openapi: 3.0.0"); await click("preview");
    await waitFor(() => expect(screen.getByTestId("spec-error")).toHaveTextContent(/not_json/), T);
  });

  it("credentials: the five modes differ in what the backend sees; pass-through verifies and each defect is refused by the right party", async () => {
    await mount(); await live(); await tab("Credentials and pass-through");
    await click("cred-call"); await waitFor(() => expect(screen.getAllByTestId("identity")[0]).toHaveTextContent(/service-account:ledger/), T);
    await pick("cred-app", "payments"); await pick("cred-mode", "token-pass");
    await waitFor(() => expect(screen.getByTestId("mint")).toBeInTheDocument(), T);
    await click("mint"); await waitFor(() => expect(screen.getByTestId("pass-verdict")).toHaveTextContent(/accepted/), T);
    expect(screen.getByTestId("unchanged")).toHaveTextContent(/same string/); expect(screen.getByTestId("mock-token").textContent.startsWith("eyJ")).toBe(true);
    for (const d of ["wrong-audience", "expired", "tampered", "untrusted-issuer", "alg-none", "replay"]) {
      await pick("defect", d); await click("mint");
      await waitFor(() => expect(screen.getByTestId("pass-verdict")).toHaveTextContent(/^refused \(assertion_/), T);
    }
    expect(screen.getByTestId("attempts").querySelectorAll("tbody tr").length).toBeGreaterThan(6);
  });

  it("catalog: a verified entry deploys in one step, the lifecycle runs, an unverified entry is refused, publishing is roadmap", async () => {
    await mount(); await live(); await tab("Catalog");
    await click("deploy-kb-search"); const dep = `tenant-${C.castHost}/kb`;
    await waitFor(() => expect(screen.getByTestId(`history-${dep}`)).toHaveTextContent(/deploying > healthy/), T);
    await click(`crash-${dep}`); await click(`health-${dep}`);
    await waitFor(() => expect(screen.getByTestId(`history-${dep}`)).toHaveTextContent(/unhealthy/), T);
    await click(`redeploy-${dep}`); await waitFor(() => expect(screen.getByTestId(`history-${dep}`)).toHaveTextContent(/redeploying > healthy/), T);
    await click("deploy-community-weather"); await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/unverified_catalog_entry/), T);
    await click("publish"); await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/roadmap/), T);
  });

  it("authorization: PKCE S256 code exchange, plain refused, a wrong verifier refused, CIMD resolves then hits the cache", async () => {
    await mount(); await live(); await tab("Authorization (OAuth/CIMD)");
    await click("register"); await waitFor(() => expect(screen.getByTestId("client-select").options.length).toBeGreaterThan(0), T);
    await click("authorize"); await waitFor(() => expect(screen.getByTestId("code").value).toMatch(/^mock-code-/), T);
    setValue("verifier", "a".repeat(43)); await click("exchange"); await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/invalid_grant/), T);
    await pick("method", "plain"); await click("authorize"); await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/pkce_s256_required/), T);
    await click("cimd-resolve"); await screen.findByTestId("cimd-ok", {}, T); expect(screen.getByTestId("cimd-ok")).toHaveTextContent(/fetched/);
    await click("cimd-resolve"); await waitFor(() => expect(screen.getByTestId("cimd-ok")).toHaveTextContent(/cache, no fetch/), T);
  });

  it("creation: a proposal needs an administrator; self-approval is refused; the approval creates the application", async () => {
    await mount(); await live(); await tab("Creation and hosting");
    await click("propose"); await screen.findByTestId("proposal-prop-0001", {}, T);
    await pick("admin", C.castUser); await click("approve-prop-0001");
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent(/admin_only/), T);
    await pick("admin", C.castAdmin); await click("approve-prop-0001");
    await waitFor(() => expect(screen.getByTestId("proposal-prop-0001")).toHaveTextContent(/approved/), T);
    await click("pinning"); await click("open-replica-a"); await click("use-sess-001-replica-b");
    await waitFor(() => expect(screen.getByTestId("session-served")).toHaveTextContent(/replica-a/), T);
  });

  it("Reset clears the workspace", async () => {
    await mount(); await live();
    await click("fault-agg"); await waitFor(() => expect(screen.getByTestId("fault-agg")).toBeChecked(), T);
    await click("reset"); await waitFor(() => expect(screen.getByTestId("fault-agg")).not.toBeChecked(), T);
  });

  it("a typed credential in a free field never appears on the page", async () => {
    await mount(); await live(); await tab("Creation and hosting");
    const secret = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    setValue("p-note", `please ${secret}`); await click("propose");
    await screen.findByTestId("proposal-prop-0001", {}, T);
    expect(document.body.textContent).not.toContain(secret.slice(4, 20)); expect(document.body.textContent).toMatch(/masked/);
  });
});

describe("vertical switch", () => {
  for (const modeName of ["mock", "live"]) {
    it(`switching the vertical finance > health > retail on every tab in ${modeName} mode never throws and never blanks the page`, async () => {
      const errors = []; const onErr = (e) => errors.push(String(e.error?.message || e.message)); window.addEventListener("error", onErr);
      const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.map(String).join(" ").slice(0, 200)); });
      try {
        await mount(); if (modeName === "live") await live();
        for (const t of TABS) {
          await tab(t.label);
          for (const v of ["health", "retail", "finance"]) {
            await pick("vertical-select", v);
            await waitFor(() => expect(screen.getByTestId("vertical-select").value).toBe(v), T);
            await waitFor(() => expect(document.querySelector("main [id^=panel-]").textContent.length).toBeGreaterThan(50), T);
            expect(screen.queryByTestId("tab-error")).toBeNull();
          }
        }
        // after the last switch the page is still alive and the tab shows the right vertical's names
        await tab("Aggregate"); await waitFor(() => expect(screen.getByTestId("members")).toBeInTheDocument(), T);
        expect(errors.filter((m) => /Cannot read|undefined|TypeError|The above error/.test(m))).toEqual([]);
      } finally { spy.mockRestore(); window.removeEventListener("error", onErr); }
    });
  }
  it("a tab that throws is caught by the boundary and shown as text, and recovers when the tab changes", async () => {
    const { TabBoundary } = await import("./App");
    const Boom = () => { throw new Error("boom"); };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<TabBoundary resetKey="a"><Boom /></TabBoundary>);
    expect(screen.getByTestId("tab-error")).toBeInTheDocument();
    rerender(<TabBoundary resetKey="b"><p>fine</p></TabBoundary>);
    await waitFor(() => expect(screen.getByText("fine")).toBeInTheDocument());
    spy.mockRestore();
  });
});

describe("helpers", () => {
  it("visible() turns control and bidi characters into visible escapes", () => { expect(visible("a‮b​c")).toBe("a\\u202eb\\u200bc"); });
  it("labelOffsets nudges a reply away from its partner", () => { expect(labelOffsets([{ from: "a", to: "b" }, { from: "b", to: "a" }])).toEqual([-16, 16]); });
  it("diagrams: simulate, speed and reset exist and the diagram loads by name", async () => {
    await mount(); await tab("Diagram");
    await screen.findByTestId("simulate", {}, T); expect(screen.getByTestId("speed")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("simulate")); await screen.findByTestId("pattern-now", {}, T);
    await userEvent.click(screen.getByTestId("pattern-reset")); await userEvent.click(screen.getByTestId("dg-discovery-filter"));
    await waitFor(() => expect(screen.getByText(/Entitlement-aware discovery: removed in flight/)).toBeInTheDocument(), T);
  });
  it("diagrams: a request that fails shows a retry, keeps the diagram buttons, and the failure clears on retry and on choosing another diagram (N4)", async () => {
    failDiagram = 1;
    await mount(); await tab("Diagram");
    const alert = await screen.findByRole("alert", {}, T);
    expect(alert).toHaveTextContent(/Could not load the diagram/);
    for (const id of ["aggregate-cap", "discovery-filter", "passthrough-assertion"]) expect(screen.getByTestId(`dg-${id}`)).toBeInTheDocument(); // the buttons are still there
    await userEvent.click(screen.getByTestId("dg-retry"));
    await screen.findByTestId("simulate", {}, T);
    expect(screen.queryByRole("alert")).toBeNull();
    failDiagram = 1; await userEvent.click(screen.getByTestId("dg-discovery-filter"));
    await screen.findByRole("alert", {}, T);
    await userEvent.click(screen.getByTestId("dg-passthrough-assertion")); // choosing another diagram also clears it
    await screen.findByTestId("simulate", {}, T);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("a stored workspace id the server refuses (40 hex characters) is replaced and the request is sent again (N5)", async () => {
    const bad = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    window.sessionStorage.setItem("msf.workspace", bad); forgetWorkspace();
    await mount();
    const sent = seen.filter((r) => r.url.includes("/api/state"));
    expect(sent.length).toBeGreaterThanOrEqual(2); // the refused one, then the retry
    const stored = window.sessionStorage.getItem("msf.workspace");
    expect(stored).not.toBe(bad); expect(stored).toMatch(/^w-[0-9a-f]{16}$/);
  });
  it("the talk track shows the Why it matters entries as Ping claims", async () => {
    await mount(); await tab("Talk track");
    const t = await screen.findByTestId("talk-track", {}, T);
    expect(t).toHaveTextContent(/Why it matters: MCP Aggregate \(slide 37\)/); expect(t).toHaveTextContent(/Ping claims, unverified on our tenant/);
  });
});

describe("What Privilege did (Rule 25)", () => {
  it("Run shows the panel under the Last action: nothing before a call, then the request, the answer and the decisions, all checked and simulated", async () => {
    setJsonView("raw"); // the request and the answer are one text each in the raw view (the panes' own default for tests)
    await mount(); await live();
    expect(screen.queryByTestId("gateway-trace")).toBeNull(); // no call yet: nothing that could mislead
    await click("preset-agg-denies"); await click("call-tool");
    const panel = await screen.findByTestId("gateway-trace", {}, T);
    expect(panel).toHaveTextContent("What Privilege did");
    // basisNote replaces the shared sentence: the lab's own wording is shown, and the default "Real mode shows the actual gateway" is not
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent(/Real means its own local engine, not a Ping gateway/);
    expect(screen.getByTestId("gateway-trace-basis")).not.toHaveTextContent(/shows the actual gateway/);
    expect(screen.queryByTestId("gateway-trace-note")).toBeNull();
    const list = screen.getByTestId("trace-1-decisions");
    expect(list).toHaveTextContent(/Aggregate: tool in the aggregate policy/); expect(list).toHaveTextContent("FAIL");
    expect(screen.getByTestId("trace-1")).toHaveTextContent("refused at: Aggregate: tool in the aggregate policy");
    expect(screen.getByTestId("trace-1-request-box")).toHaveTextContent("https://gateway.example.invalid/");
    expect(screen.getByTestId("trace-1-request-box")).toHaveTextContent("payments__create_item");
    // the Last action panel is still there and the panel sits after it
    const last = screen.getByTestId("last-action");
    expect(last.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // a later action that makes no gateway call takes the panel away rather than leave a stale one
    await click("fault-agg");
    await waitFor(() => expect(screen.queryByTestId("gateway-trace")).toBeNull(), T);
  });

  it("Mock mode, which cannot call, draws no panel", async () => {
    await mount(); await tab("Aggregate");
    expect(screen.queryByTestId("gateway-trace")).toBeNull();
  });
});

describe("What each layer logged for this run (Rule 27)", () => {
  // The panel is re-queried every time: it is unmounted and mounted again while a run is read (empty state, then "Collecting", then the record), so a node captured
  // earlier can be a detached one.
  const panel = () => screen.getByTestId("run-observability");
  const rowsOf = (sel) => panel().querySelectorAll(sel);

  it("Mock: the record of the scripted scenario on screen, all rows simulated, source mock, each row naming its step, and a scenario that decides nothing says so (never the previous record)", async () => {
    await mount();
    await waitFor(() => expect(rowsOf('tr[data-origin="simulated"]').length).toBeGreaterThan(10), T);
    expect(panel()).toHaveTextContent("What each layer logged for this run");
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Simulated: the lab's mock computed these rows/);
    expect(screen.getByTestId("ro-coverage-privilege")).toHaveTextContent("Simulated");
    expect(screen.getByTestId("ro-coverage-authorize")).toHaveTextContent("Not logged");
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/this lab's own engine computed them, in Live as well/);
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/standing in for Ping's, not Ping's/);
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/each row starts with the step \(the call\) that made it, and the counts in the summary add up every call/);
    expect(screen.getByTestId("ro-streams")).toHaveTextContent(/nowhere today/);
    expect(rowsOf('tr[data-origin="logged"], tr[data-origin="response"]').length).toBe(0);
    expect(rowsOf("tr.ro-row .ro-msg")[0]).toHaveTextContent(/^Step 1: /);
    await tab("Authorization (OAuth/CIMD)"); await click("scn-authorization");
    await waitFor(() => expect(screen.getByTestId("ro-none")).toHaveTextContent(/no run record/), T);
    expect(screen.queryByTestId("run-observability")?.querySelectorAll("tr[data-origin]").length ?? 0).toBe(0); // the aggregate scenario's rows are gone
  });

  it("Live: empty before a call; a refused call shows its refusal under Privilege; a configuration change and a protocol request each say what they are; Mock shows the scenario, not the Live run", async () => {
    await mount(); await live();
    expect(await screen.findByTestId("ro-empty", {}, T)).toHaveTextContent(/Run the demo/);
    await click("preset-agg-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("ro-summary")).toHaveTextContent(/1 refused/), T);
    expect(rowsOf('tr[data-origin="simulated"]').length).toBeGreaterThan(3);
    const refused = panel().querySelector('tr[data-outcome="refused"]');
    expect(refused).toHaveAttribute("data-layer", "privilege");
    expect(refused).toHaveTextContent(/tool in the aggregate policy/);
    expect(screen.getByTestId("ro-coverage-resource")).toHaveTextContent("Not logged"); // the member was never asked
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/Live is the same engine acting on your calls/);
    // the panel sits after the gateway trace
    expect(screen.getByTestId("gateway-trace-panel").compareDocumentPosition(panel()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // a later configuration change makes no run: it says what it is and the call's record is gone
    await click("fault-agg");
    expect(await screen.findByTestId("ro-no-run", {}, T)).toHaveTextContent(/changes configuration and takes no gateway, policy or approval decision/);
    expect(screen.getByTestId("ro-no-run")).toHaveTextContent(/audit log holds it/);
    expect(screen.queryByTestId("run-observability")).toBeNull();
    // a protocol request is not a configuration change, and the page does not say it is
    await tab("Authorization (OAuth/CIMD)"); await click("register");
    await waitFor(() => expect(screen.getByTestId("ro-no-run")).toHaveTextContent(/OAuth, CIMD, routing or session traffic/), T);
    expect(screen.getByTestId("ro-no-run")).not.toHaveTextContent(/changes configuration/);
    // back to Mock: the scenario's record, never the Live run's
    await fireEvent.change(screen.getByTestId("mode-select"), { target: { value: "mock" } });
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
    await waitFor(() => expect(screen.getByTestId("run-observability").textContent).toMatch(/Simulated/), T);
    expect(screen.queryByTestId("ro-no-run")).toBeNull();
  });

  it("while a run's record is read the page says so and never shows the previous record; a record that cannot be read is an alert", async () => {
    await mount(); await live();
    await click("preset-agg-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("ro-summary")).toHaveTextContent(/1 refused/), T);
    const real = globalThis.fetch; let release;
    globalThis.fetch = (u, init) => (String(u).includes("/api/run-record") ? new Promise((res) => { release = () => res(real(u, init)); }) : real(u, init));
    try {
      await click("preset-ok"); await click("call-tool");
      expect(await screen.findByTestId("ro-loading", {}, T)).toHaveTextContent("Collecting this run's logs…");
      expect(screen.queryByTestId("run-observability")).toBeNull();
      await waitFor(() => expect(release).toBeTypeOf("function"), T);
      release();
      await waitFor(() => expect(screen.getByTestId("ro-summary")).toHaveTextContent(/0 refused/), T);
      globalThis.fetch = (u, init) => (String(u).includes("/api/run-record") ? Promise.resolve(new Response(JSON.stringify({ error: "unknown_run", message: "This workspace does not hold that run." }), { status: 404, headers: { "content-type": "application/json" } })) : real(u, init));
      await click("preset-agg-denies"); await click("call-tool");
      expect(await screen.findByTestId("ro-error", {}, T)).toHaveTextContent(/does not hold that run/);
    } finally { globalThis.fetch = real; }
  });

  it("Reset clears what the last action showed, its run included: the panel is back to the empty state, and going to another tab and back does not turn into an error", async () => {
    await mount(); await live();
    await click("preset-agg-denies"); await click("call-tool");
    await waitFor(() => expect(screen.getByTestId("ro-summary")).toHaveTextContent(/1 refused/), T);
    expect(screen.getByTestId("last-action")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("reset"));
    expect(await screen.findByTestId("ro-empty", {}, T)).toHaveTextContent(/Run the demo/);
    expect(screen.queryByTestId("last-action")).toBeNull();
    expect(screen.queryByTestId("ro-error")).toBeNull();
    await tab("Diagram"); await tab("Aggregate");
    await screen.findByTestId("members", {}, T);
    expect(await screen.findByTestId("ro-empty", {}, T)).toBeInTheDocument();
    expect(screen.queryByTestId("ro-error")).toBeNull();
    expect(screen.queryByTestId("last-action")).toBeNull();
  });
});
