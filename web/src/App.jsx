import { Component, useCallback, useEffect, useRef, useState } from "react";
import ShelfLink from "./components/ShelfLink";
import AggregateTab from "./components/AggregateTab";
import DiscoveryTab from "./components/DiscoveryTab";
import OpenapiTab from "./components/OpenapiTab";
import CredentialsTab from "./components/CredentialsTab";
import CatalogTab from "./components/CatalogTab";
import AuthorizationTab from "./components/AuthorizationTab";
import CreationTab from "./components/CreationTab";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import LastAction from "./components/LastAction";
import { ClaimTag } from "./components/Bits";
import useLab from "./hooks/useLab";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";
import { getJson, resetWorkspace, setMode } from "./api";

import fs from "node:fs";
const LAB_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || null; } catch { return null; } })();

export const TABS = [
  { id: "aggregate", label: "Aggregate" },
  { id: "discovery", label: "Discovery and policy" },
  { id: "openapi", label: "OpenAPI to MCP" },
  { id: "credentials", label: "Credentials and pass-through" },
  { id: "catalog", label: "Catalog" },
  { id: "authorization", label: "Authorization (OAuth/CIMD)" },
  { id: "creation", label: "Creation and hosting" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims one mode before it knows: until the story answers it says both, honestly.
const TAIL = "Every product claim is a Ping release claim, UNVERIFIED on our tenant (release 2026-11-02). Nothing here calls a real gateway, MCP server, identity provider or tenant.";
export const BANNER_UNKNOWN = `SIMULATED, MOCK or LIVE mode (loopback only, no outbound network). ${TAIL}`;
const MODE_KEY = "msf.mode";
const THEME_KEY = "msf.theme";
function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}
const ACTION_TABS = ["aggregate", "discovery", "openapi", "credentials", "catalog", "authorization", "creation"];

const tabFromHash = () => { const h = window.location.hash.replace("#", ""); return TABS.some((t) => t.id === h) ? h : "aggregate"; };
const savedMode = () => { try { const m = window.localStorage.getItem(MODE_KEY); return m === "live" || m === "mock" ? m : null; } catch { return null; } };

// A tab that throws must not blank the whole page: the boundary shows the problem as text and a way back, and resets when the tab, the vertical or the mode changes.
export class TabBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(prev) { if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p className="app-error" role="alert" data-testid="tab-error">This tab could not be drawn. Switch tab, vertical or mode, or press Reset.</p> : this.props.children; }
}

export default function App() {
  const [vertical, setVertical] = useState("finance");
  const [story, setStory] = useState(null);
  const [mode, setModeState] = useState(null);
  const [scenarioId, setScenarioId] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(tabFromHash());
  const [presenter, setPresenter] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [actorChoice, setActor] = useState("");
  const [adminChoice, setAdmin] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const [fontStep, setFontStep] = useState(() => { try { const f = localStorage.getItem("msf.font"); return ["S", "M", "L"].includes(f) ? f : "M"; } catch { return "M"; } });
  const tabsRef = useRef(null);
  const lab = useLab({ mode, vertical, scenario: scenarioId });

  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { applyFontSize(fontStep); try { localStorage.setItem("msf.font", fontStep); } catch { /* not remembered */ } }, [fontStep]);

  useEffect(() => { getJson("/api/info").then((i) => setModeState((m) => m || savedMode() || i.mode), () => setModeState((m) => m || savedMode() || "mock")); }, []);
  useEffect(() => {
    let live = true; // a late story for a vertical the visitor has already left is dropped
    getJson(`/api/story?vertical=${encodeURIComponent(vertical)}`).then((j) => { if (live) { setStory(j); setError(null); } }, (e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [vertical]);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const applyMode = (m) => { setModeState(m); try { window.localStorage.setItem(MODE_KEY, m); } catch { /* storage blocked */ } };
  // Rule 19: the Mock/Real toggle POSTs the source to the server's runtime mode, then reloads the page's data.
  // A refusal (the 409 body) is data, not an exception; it is shown where the reset note is shown.
  const switchSource = useCallback(async (source) => {
    const next = source === "real" ? "live" : "mock";
    if (next === mode) return;
    const r = await setMode(source);
    if (!r.ok) { setResetMsg(r.body?.detail || r.body?.message || `Could not switch to ${source}.`); return; }
    applyMode(next);
    setResetSignal((n) => n + 1);
    await lab.reload(next === "real" ? "live" : "mock");
  }, [mode, lab.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

  // Keep the active tab fully in view in the scrolling tab strip (375px).
  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Reset: the server clears this workspace's engines (applications, policies, aggregate, deployments, OAuth state, proposals, audit, the lab clock); the diagram goes back in place.
  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    await lab.reload();
    setResetMsg(ok ? "Reset: your workspace's applications, policies, aggregate, deployments, OAuth state, proposals, audit trail and clock are back to the start, and the diagram is back in place." : "Reset failed on the server; the view was reloaded.");
  }, [lab.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const users = lab.state?.users || [];
  const people = users.filter((p) => p.role === "user"); const admins = users.filter((p) => p.role === "admin");
  // The calling user and the configuring administrator: the visitor's pick if it is still on the roster, else the first of each.
  const actor = users.some((p) => p.id === actorChoice) ? actorChoice : (people[0]?.id || "");
  const admin = users.some((p) => p.id === adminChoice) ? adminChoice : (admins[0]?.id || "");
  const banner = story && mode ? story.banner[mode] : BANNER_UNKNOWN;
  // The story (names) and the state (applications) must be for the SAME vertical before a tab is drawn: during a switch they briefly differ.
  const ready = story && mode && story.vertical === vertical;
  const stateReady = !!lab.state && lab.data?.vertical === vertical;
  const props = { story, mode, vertical, lab, actor, admin, scenarioId, setScenarioId };
  const Tab = { aggregate: AggregateTab, discovery: DiscoveryTab, openapi: OpenapiTab, credentials: CredentialsTab, catalog: CatalogTab, authorization: AuthorizationTab, creation: CreationTab }[tab];
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header>
        <p className="banner" role="status" data-state={mode === "live" ? "live" : "mock"} data-testid="banner">{banner}</p>
        <div className="head">
          <div>
            <h1 className="head__title">MCP Surface LAB</h1>
            {!presenter && story && <p className="head__intro">{story.intro}</p>}
          </div>
          <div className="head__tools">
            <TopMenu
              mode={{ value: mode === "live" ? "real" : (mode || "mock"), onChange: switchSource }}
              vertical={{ value: vertical, onChange: setVertical, options: story ? story.verticals : ["finance"] }}
              theme={{ value: theme, onChange: pickTheme }}
              fontSize={{ value: fontStep, onChange: setFontStep }}
              present={{ active: presenter, onToggle: () => setPresenter((v) => !v), label: "Presenter (P)" }}
              help={{ href: "https://github.com/curtismu7/mcp-surface-LAB#readme" }}
              version={LAB_VERSION}
              onReset={reset}
            >
              <ShelfLink />
            </TopMenu>
            <span className="chip" data-testid="mode">Mode: {mode || "..."}{mode === "live" ? " (local engine, loopback)" : mode === "mock" ? " (tables)" : ""}</span>
            {!presenter && mode === "live" && users.length > 0 && (
              <>
                <label className="inline">Call as{" "}
                  <select value={actor} onChange={(e) => setActor(e.target.value)} data-testid="actor">
                    {users.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.groups.join(", ")})</option>)}
                  </select>
                </label>
                <label className="inline">Configure as{" "}
                  <select value={admin} onChange={(e) => setAdmin(e.target.value)} data-testid="admin">
                    {users.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.role})</option>)}
                  </select>
                </label>
              </>
            )}
          </div>
        </div>
      </header>
      <main>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div role="tablist" aria-label="Lab sections" className="tabs" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {error || lab.error ? <p className="app-error" role="alert">Could not load the lab ({error || lab.error}). Is the server running?</p> : !ready ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  <p><ClaimTag /></p>
                  {story.talkTrack.filter((t) => (story.presenterTalk[tab] || []).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {ACTION_TABS.includes(tab) && (!stateReady ? <p className="muted">Loading...</p> : <TabBoundary resetKey={`${tab}|${vertical}|${mode}`}><Tab {...props} /></TabBoundary>)}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
              {mode === "live" && ACTION_TABS.includes(tab) && <LastAction last={lab.last} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
