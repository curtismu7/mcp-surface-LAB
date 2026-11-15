// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that call
// reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { createWorkspaces } from "../../server/src/workspaces.js";
import App from "./App";
import { forgetWorkspace } from "./workspace";

let server; let base; let shelf = null; const realFetch = globalThis.fetch;
beforeAll(async () => {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json", workspaces: createWorkspaces({ max: 5000 }) }) }));
  base = base.replace(/\/$/, "");
  globalThis.fetch = async (u, init = {}) => {
    if (u === "/api/shelf" && shelf) return new Response(JSON.stringify(shelf), { headers: { "content-type": "application/json" } });
    const url = typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u;
    return realFetch(url, { ...init, headers: { origin: base, ...(init.headers || {}) } });
  };
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => { cleanup(); forgetWorkspace(); shelf = null; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; });

const T = { timeout: 120000 };
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
// the header renders before the app has loaded: wait for the tab list, then query the top menu
const bar = async () => { await screen.findByRole("tablist", {}, T); return within(screen.getByTestId("top-menu")); };

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's, with the note as its tooltip", async () => {
    shelf = { shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "mcp-surface-lab", verification: mark("verified", "Verified", { note: "Every tab run on the mock" }) }] };
    render(<App />);
    const menu = await bar();
    expect(await menu.findByText("Verified", {}, T)).toBeInTheDocument();
    expect(menu.getByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(menu.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(menu.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every tab run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has only shelfUrl) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-surface-lab", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "mcp-surface-lab", verification: mark("none", "") }] }]) {
      shelf = payload;
      const { unmount } = render(<App />);
      const menu = await bar();
      expect(await menu.findByRole("link", { name: "Shelf" }, T)).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
