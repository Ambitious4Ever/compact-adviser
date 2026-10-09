// The Stop-hook decision, with its inputs injected so tests drive it without a network or a
// real home directory: count the exchange, run the cheap gates, judge, and maybe hint.

import { createHash } from "node:crypto";
import {
  type Config,
  type Env,
  loadApiKey,
  loadConfig,
  dataDir as resolveDataDir,
} from "./config.ts";
import {
  contextPressure,
  decisionsEndpoint,
  floorFor,
  JudgeError,
  judge,
  nodeTransport,
  qualifies,
  requestBody,
  score,
  type Transport,
} from "./judge.ts";
import { parseProfile } from "./profile.ts";
import { snapshot } from "./snapshot.ts";
import { backoff, completeExchange, cooldownReason, initialState } from "./state.ts";
import { appendLog, loadState, pruneSessions, saveState } from "./store.ts";
import { contextTokensAt, latestAssistant, loadTranscript, messagesUpTo } from "./transcript.ts";

export const HINT =
  "compact-adviser: work appears completed or recorded. Run /compact to save tokens.";

/** Failures a person must fix are surfaced; transient ones only back off. */
const SURFACED = new Set(["authentication", "configuration", "input"]);

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  source?: string;
}

export interface Deps {
  env: Env;
  now: () => number;
  transport: Transport;
}

export const liveDeps = (): Deps => ({ env: process.env, now: Date.now, transport: nodeTransport });

export interface HookOutput {
  systemMessage?: string;
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function log(config: Config, dir: string, sessionId: string, entry: Record<string, unknown>) {
  if (!config.logRequests) return;
  try {
    appendLog(dir, sessionId, entry);
  } catch {
    // Logging must never replace or delay the decision.
  }
}

export async function onStop(input: HookInput, deps: Deps): Promise<HookOutput> {
  const sessionId = input.session_id;
  if (!sessionId || !input.transcript_path || input.stop_hook_active) return {};
  const config = loadConfig(deps.env);
  if (config.mode === "off") return {};
  const dir = resolveDataDir(deps.env);

  const recs = loadTranscript(input.transcript_path);
  const latest = latestAssistant(recs);
  if (!latest) return {};
  const tokens = contextTokensAt(latest);
  const now = deps.now();
  const state = completeExchange(loadState(dir, sessionId, now), tokens, now);
  saveState(dir, sessionId, state);

  const key = loadApiKey(deps.env, input.cwd);
  if (!key || tokens < config.minContextTokens || cooldownReason(state, tokens, now)) return {};

  let profile: ReturnType<typeof parseProfile>;
  try {
    profile = parseProfile(config.profile);
  } catch (error) {
    return { systemMessage: `compact-adviser: ${(error as Error).message}` };
  }
  const endpoint = decisionsEndpoint(deps.env.OPENROUTER_BASE);
  const view = snapshot(messagesUpTo(recs, latest), [key]);
  if (view.conversationTokens <= 20000) return {};
  const print = fingerprint(view.checkpointText);
  if (state.lastHintKey === print) return {};

  let result: Awaited<ReturnType<typeof judge>>;
  try {
    if (endpoint === undefined) throw new JudgeError("configuration");
    log(config, dir, sessionId, {
      kind: "request",
      body: JSON.parse(requestBody(view.state, profile)),
    });
    result = await judge(view.state, key, { ...deps.transport, endpoint }, profile);
  } catch (error) {
    const kind = error instanceof JudgeError ? error.kind : "unavailable";
    log(config, dir, sessionId, { kind: "error", error: kind });
    saveState(dir, sessionId, backoff(state, deps.now()));
    return SURFACED.has(kind) ? { systemMessage: (error as Error).message } : {};
  }

  const usage = contextPressure(tokens, config.contextLimitTokens, config.contextBudgetTokens);
  const ok = qualifies(result, usage, profile);
  log(config, dir, sessionId, {
    kind: "response",
    model: result.model,
    done: result.done,
    shape: result.shape,
    score: score(result, profile),
    floor: floorFor(usage, profile),
    usage,
    qualifies: ok,
  });
  const after = deps.now();
  if (!ok) {
    saveState(dir, sessionId, { ...state, failures: 0, retryAfter: 0, updatedAt: after });
    return {};
  }
  saveState(dir, sessionId, {
    ...state,
    failures: 0,
    retryAfter: 0,
    lastHintAt: state.completed,
    lastHintKey: print,
    updatedAt: after,
  });
  return { systemMessage: HINT };
}

/** SessionStart after a compaction restarts the cooldowns; any SessionStart prunes old files. */
export function onSessionStart(input: HookInput, deps: Deps): HookOutput {
  const dir = resolveDataDir(deps.env);
  const now = deps.now();
  if (input.session_id && input.source === "compact") {
    saveState(dir, input.session_id, initialState(true, now));
  }
  pruneSessions(dir, now);
  return {};
}
