// The run-record panel on its own, with the answers of GET /api/run-record stubbed: what the page shows for a record, for the documented "no run" answer, for an error, and for
// every answer that is none of those (it must be an alert, never the empty state "Run the demo" right after a call).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import RunRecordPanel from "./components/RunRecordPanel";
import { mockRecord } from "./run-observability/fixtures.js";
import { forgetWorkspace } from "./workspace";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answerWith = (make) => vi.stubGlobal("fetch", vi.fn(async () => make()));
const LIVE = { mode: "live", vertical: "finance", last: { op: "mcp", runId: "run-abc-1" }, scenarioId: null };
const T = { timeout: 5000 };
beforeEach(() => { cleanup(); forgetWorkspace(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("an answer that is not a run record is an alert", () => {
  const cases = [
    ["a 502 HTML page from a proxy", () => new Response("<html><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["a JSON string", () => json("nothing ran")],
    ["a JSON array", () => json([])],
    ["an empty object", () => json({})],
    ["an object whose record is a string", () => json({ record: "x" })],
    ["a record on a non-2xx status", () => json({ record: mockRecord }, 500)],
    ["a null record with no message", () => json({ record: null })],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      answerWith(make);
      render(<RunRecordPanel {...LIVE} />);
      const alert = await screen.findByTestId("ro-error", {}, T);
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveTextContent(/not a run record/);
      expect(screen.queryByTestId("ro-empty")).toBeNull();
    });
  }
  it("an { error, message } answer shows its message", async () => {
    answerWith(() => json({ error: "unknown_run", message: "This workspace does not hold that run." }, 404));
    render(<RunRecordPanel {...LIVE} />);
    expect(await screen.findByTestId("ro-error", {}, T)).toHaveTextContent(/does not hold that run/);
  });
  it("a server that cannot be reached is an alert too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RunRecordPanel {...LIVE} />);
    expect(await screen.findByTestId("ro-error", {}, T)).toHaveTextContent(/could not be reached/);
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});

describe("the answers the panel does show", () => {
  it("a record is drawn with the shared panel", async () => {
    answerWith(() => json({ record: mockRecord }));
    render(<RunRecordPanel {...LIVE} />);
    expect(await screen.findByTestId("run-observability", {}, T)).toBeInTheDocument();
    expect(screen.queryByTestId("ro-error")).toBeNull();
  });
  it("the documented no-run answer is a quiet note under the empty state", async () => {
    answerWith(() => json({ record: null, message: "This scripted scenario takes no gateway, policy or approval decision, so it has no run record." }));
    render(<RunRecordPanel mode="mock" vertical="finance" last={null} scenarioId="authorization" />);
    expect(await screen.findByTestId("ro-none", {}, T)).toHaveTextContent(/no run record/);
    expect(screen.queryByTestId("ro-error")).toBeNull();
  });
});

describe("a log writer that failed for a run", () => {
  it("with a record: the record is shown and the page says not every decision reached stdout", async () => {
    answerWith(() => json({ record: mockRecord }));
    render(<RunRecordPanel {...LIVE} last={{ op: "mcp", runId: "run-abc-2", runLogFailed: true }} />);
    expect(await screen.findByTestId("run-observability", {}, T)).toBeInTheDocument();
    const note = screen.getByTestId("ro-log-failed");
    expect(note).toHaveAttribute("role", "alert");
    expect(note).toHaveTextContent(/log writer failed for this run/);
    expect(note).toHaveTextContent(/not every one reached stdout/);
    expect(screen.queryByTestId("ro-no-run")).toBeNull();
  });
  it("without a record (the recorder itself failed): it says so, and not that the attempt was turned away", async () => {
    answerWith(() => json({}));
    render(<RunRecordPanel {...LIVE} last={{ op: "mcp", runId: null, runLogFailed: true }} />);
    const note = await screen.findByTestId("ro-no-run", {}, T);
    expect(note).toHaveTextContent(/recorder failed for this run/);
    expect(note).not.toHaveTextContent(/turned away/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an attempt that began no run says it was turned away, and asks for nothing", async () => {
    answerWith(() => json({}));
    render(<RunRecordPanel {...LIVE} last={{ op: "mcp", runId: null }} />);
    expect(await screen.findByTestId("ro-no-run", {}, T)).toHaveTextContent(/turned away before the gateway took any decision/);
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });
});

describe("what each kind of action that makes no run says", () => {
  const say = async (op) => {
    answerWith(() => json({}));
    cleanup();
    render(<RunRecordPanel {...LIVE} last={{ op, runId: null }} />);
    return (await screen.findByTestId("ro-no-run", {}, T)).textContent;
  };
  it("a configuration change, a protocol request and a preview are each named for what they are", async () => {
    expect(await say("setPolicy")).toMatch(/changes configuration and takes no gateway, policy or approval decision/);
    expect(await say("catCrash")).toMatch(/changes configuration/);
    for (const op of ["oauthToken", "oauthAuthorize", "oauthRegister", "cimdResolve", "route", "sessionUse", "sessionOpen", "upstreamAuthorize"]) {
      const text = await say(op);
      expect(text, op).toMatch(/OAuth, CIMD, routing or session traffic/);
      expect(text, op).toMatch(/audit log holds what it did/);
      expect(text, op).not.toMatch(/changes configuration/);
    }
    expect(await say("oaPreview")).toMatch(/only reads a specification/);
  });
});
