// Rule 13: each browser tab gets its own workspace id, kept in sessionStorage, and sends it as X-Workspace on every API call
// that touches server state. Storage can be blocked, so a failure falls back to a per-load id.
const KEY = "msf.workspace";
let memo = null;

// Tests only: forget the id held in memory so the next call picks a new one.
export const forgetWorkspace = () => { memo = null; };

export function workspaceId() {
  if (memo) return memo;
  try { const saved = window.sessionStorage.getItem(KEY); if (saved && /^[a-z0-9-]{1,40}$/.test(saved)) return (memo = saved); } catch { /* blocked */ }
  const bytes = new Uint8Array(8);
  (window.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  memo = `w-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  try { window.sessionStorage.setItem(KEY, memo); } catch { /* blocked */ }
  return memo;
}

// A stored id the server refuses (it fits the pattern but looks like a credential, e.g. 40 hex characters) would brick the tab: every call would be a 400.
// So a 400 bad_workspace makes a NEW id, stored in its place, and the same request is sent once more.
export const newWorkspace = () => { memo = null; try { window.sessionStorage.removeItem(KEY); } catch { /* blocked */ } return workspaceId(); };
const send = (url, opts) => fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), "x-workspace": workspaceId() } });
export async function workspaceFetch(url, opts = {}) {
  const r = await send(url, opts);
  if (r.status !== 400) return r;
  let refused = false;
  try { refused = (await r.clone().json()).error === "bad_workspace"; } catch { /* not JSON */ }
  if (!refused) return r;
  newWorkspace();
  return send(url, opts);
}
