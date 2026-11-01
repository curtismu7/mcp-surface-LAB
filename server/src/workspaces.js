// Rule 13: a workspace id keeps one visitor's state apart from another's. Server state per workspace is one MCP-surface Engine per vertical. Bounded in count
// and age. The browser sends its id in X-Workspace (default "default"). Reset clears the current workspace only.
// A NEW workspace past the cap is REFUSED (503), never made by evicting someone else's: a busy lab must not erase a visitor's state.
import { Engine } from './engine.js';
import { findCredentials } from './credentials.js';
import { refuse } from './errors.js';

export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  // An id that looks like a credential (a 40-hex token, a long mixed run) is refused rather than echoed back in the `workspace` field and the hop headers.
  return typeof raw === 'string' && WORKSPACE_RE.test(raw) && findCredentials(raw).length === 0 ? raw : null;
}

export function createWorkspaces({ max = 200, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> { engines: Map(vertical -> Engine), at }; insertion order = least recently used first
  const sweep = () => { const t = now(); for (const [id, v] of map) { if (t - v.at > ttlMs) map.delete(id); else break; } };
  return {
    // The engine for this workspace and vertical, created on first use with the cast of that moment. Refuses a new workspace at the cap.
    engine(id, vertical, cast) {
      sweep();
      let v = map.get(id);
      if (!v) { if (map.size >= max) throw refuse('workspace_limit', `the lab holds at most ${max} workspaces and none has expired yet: try again later, or reset one`, 503); v = { engines: new Map(), at: 0 }; }
      v.at = now(); map.delete(id); map.set(id, v);
      if (!v.engines.has(vertical)) v.engines.set(vertical, new Engine(cast));
      return v.engines.get(vertical);
    },
    // Refuses (503) when this id would be a NEW workspace past the cap; touches nothing. Called before a request does any work.
    assertRoom(id) { sweep(); if (!map.has(id) && map.size >= max) throw refuse('workspace_limit', `the lab holds at most ${max} workspaces and none has expired yet: try again later, or reset one`, 503); },
    // Stores an engine a request built and CHANGED. A request that changed nothing visible never calls this, so a refused request holds no slot.
    adopt(id, vertical, engine) {
      this.assertRoom(id);
      let v = map.get(id) || { engines: new Map(), at: 0 };
      v.at = now(); map.delete(id); map.set(id, v);
      if (!v.engines.has(vertical)) v.engines.set(vertical, engine);
    },
    // Read-only look: the engine if the workspace has one, else null (nothing is created).
    peek(id, vertical) { sweep(); return map.get(id)?.engines.get(vertical) || null; },
    reset(id) { map.delete(id); },
    size() { return map.size; },
  };
}
