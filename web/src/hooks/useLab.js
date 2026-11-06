import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "../api";

// The lab's state, from either source: Mock reads a generated table (read-only), Live reads the workspace's engine. Both give the same shape, so every
// tab renders one thing. Every load and every action carries a sequence number: an answer that is no longer the latest is dropped.
export default function useLab({ mode, vertical, scenario }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const seq = useRef(0);       // loads
  const actSeq = useRef(0);    // writes
  const inflight = useRef(0);
  const ctx = useRef("");
  ctx.current = `${mode}|${vertical}`;

  // A mode switch passes the engine's mode name directly: the state API takes "mock" or "live",
  // never the toggle's source word, so the reload right after the switch cannot race the state update.
  const load = useCallback((modeOverride) => {
    const m = modeOverride || mode;
    if (!m) return Promise.resolve();
    const mine = ++seq.current;
    const q = `mode=${m}&vertical=${encodeURIComponent(vertical)}${m === "mock" && scenario ? `&scenario=${encodeURIComponent(scenario)}` : ""}`;
    return getJson(`/api/state?${q}`).then((j) => { if (mine === seq.current) { setData(j); setError(null); } }, (e) => { if (mine === seq.current) setError(e.message); });
  }, [mode, vertical, scenario]);
  // Switching mode or vertical clears the page; switching only the scenario keeps the old one on screen until the new one arrives.
  useEffect(() => { setData(null); setLast(null); }, [mode, vertical]);
  useEffect(() => { load(); }, [load]);

  // act(op, params): one action. The state in the answer replaces the page's state, unless a newer load or write has started.
  // A refusal keeps its honest HTTP status (400, 403, 404, 409, 502 ...); the page reads it as data. The browser logs a non-2xx answer in its console.
  const act = useCallback(async (op, params = {}) => {
    const mine = ++actSeq.current; const key = `${mode}|${vertical}`;
    inflight.current += 1; setBusy(true);
    try {
      const r = await sendJson("POST", `/api/act/${op}`, { mode, vertical, params });
      if (mine === actSeq.current && key === ctx.current) {
        seq.current += 1; // a load that started before this action must not overwrite its newer state
        if (r.body?.state) setData((d) => ({ ...(d || {}), mode, vertical, state: r.body.state }));
        setLast({ ok: r.ok && r.body?.ok !== false, status: r.status, op, error: r.body?.error, detail: r.body?.detail, data: r.body?.data, result: r.body?.result, hops: r.body?.hops || [], traceId: r.body?.traceId, truncated: r.body?.hopsTruncated, route: `POST /api/act/${op}`, at: Date.now() });
      }
      return r;
    } finally { inflight.current -= 1; if (inflight.current === 0) setBusy(false); }
  }, [mode, vertical]);

  return { data, state: data?.state || null, scenario: data?.scenario || null, scenarios: data?.scenarios || [], error, busy, last, act, reload: load, readOnly: mode !== "live" };
}
