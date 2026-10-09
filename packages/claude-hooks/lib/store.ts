// One JSON file per session under <dataDir>/sessions, written atomically, plus the optional
// request log. Session ids are reduced to a safe file name.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { restoreState, SESSION_RETENTION_MS, type SessionState } from "./state.ts";

export function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "session";
}

export function statePath(dir: string, sessionId: string): string {
  return join(dir, "sessions", `${safeName(sessionId)}.json`);
}

export function loadState(dir: string, sessionId: string, now: number): SessionState {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(statePath(dir, sessionId), "utf8"));
  } catch (error) {
    // A missing file is a fresh session; an unreadable one restarts conservatively.
    value = (error as { code?: string }).code === "ENOENT" ? undefined : null;
  }
  return restoreState(value, now);
}

export function saveState(dir: string, sessionId: string, state: SessionState): void {
  const path = statePath(dir, sessionId);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Drop session files untouched for longer than the retention window. */
export function pruneSessions(dir: string, now: number): void {
  const root = join(dir, "sessions");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs > SESSION_RETENTION_MS) rmSync(path, { force: true });
    } catch {
      // Another session may be pruning the same file.
    }
  }
}

export function appendLog(dir: string, sessionId: string, entry: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `requests-${safeName(sessionId)}.jsonl`),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    { mode: 0o600 },
  );
}
