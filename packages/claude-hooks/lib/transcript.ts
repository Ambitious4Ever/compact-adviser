/**
 * Claude Code transcript JSONL -> the `MessageLike[]` view `snapshot()` reads. Ported from
 * packages/claude-mod/eval/transcript.ts: a command hook gets only `transcript_path`, not the
 * host's `$.session.messages()`, so the view is rebuilt from the transcript's parent chain.
 */
import { readFileSync } from "node:fs";
import { MESSAGE_LIMIT, type MessageLike, type ToolUseLike } from "./snapshot.ts";

export interface Rec {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  toolUseResult?: unknown;
  message?: {
    content?: unknown;
    stop_reason?: string;
    usage?: Record<string, unknown>;
  };
}

/** One content block of a transcript message; only the fields the replay reads. */
export interface Block {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

export function loadTranscript(file: string): Rec[] {
  const out: Rec[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Rec);
    } catch {
      /* a partially written line at the tail is skipped, as the host would */
    }
  }
  return out;
}

/** Conversation records on the main thread: no subagent sidechains, no host metadata rows. */
export function conversation(recs: Rec[]): Rec[] {
  return recs.filter(
    (r) => (r.type === "user" || r.type === "assistant") && !r.isSidechain && !r.isMeta,
  );
}

/** Assistant turns that ended cleanly - the mod judges only at a turn end. */
export function settledEntries(recs: Rec[]): Rec[] {
  return conversation(recs).filter((r) => r.message?.stop_reason === "end_turn");
}

export function blocks(r: Rec): Block[] {
  const c = r.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? (c as Block[]) : [];
}

function textOf(r: Rec): string {
  return blocks(r)
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n");
}

/** Tool results arrive in the NEXT user record, keyed by tool_use_id. */
function resultIndex(recs: Rec[]): Map<string, { text: string; isError: boolean }> {
  const map = new Map<string, { text: string; isError: boolean }>();
  for (const r of recs) {
    if (r.type !== "user") continue;
    for (const b of blocks(r)) {
      if (b?.type !== "tool_result") continue;
      const c = b.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .filter((p: Block) => p?.type === "text")
                .map((p: Block) => String(p.text ?? ""))
                .join("\n")
            : "";
      map.set(String(b.tool_use_id), { text, isError: b.is_error === true });
    }
  }
  return map;
}

/** True when this user record is only carrying tool results back, not a prompt. */
function isToolResultCarrier(r: Rec): boolean {
  const bs = blocks(r);
  return bs.length > 0 && bs.every((b) => b?.type === "tool_result");
}

/**
 * Rebuild the host's message view as of `upTo` (inclusive), walking the parent
 * chain so an edited or rewound branch replays the branch that actually ran.
 */
export function messagesUpTo(recs: Rec[], upTo: Rec): MessageLike[] {
  const byUuid = new Map<string, Rec>();
  for (const r of recs) if (r.uuid) byUuid.set(r.uuid, r);
  const chain: Rec[] = [];
  let cur: Rec | undefined = upTo;
  const seen = new Set<string>();
  while (cur) {
    if (cur.uuid && seen.has(cur.uuid)) break;
    if (cur.uuid) seen.add(cur.uuid);
    chain.push(cur);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  chain.reverse();

  const results = resultIndex(recs);
  const msgs: MessageLike[] = [];
  for (const r of chain) {
    if (r.isSidechain || r.isMeta) continue;
    if (r.type === "user") {
      if (isToolResultCarrier(r)) continue;
      const text = textOf(r);
      if (!text.trim()) continue;
      msgs.push({ role: "user", text, toolUses: [] });
    } else if (r.type === "assistant") {
      const toolUses: ToolUseLike[] = [];
      for (const b of blocks(r)) {
        if (b?.type !== "tool_use") continue;
        const res = results.get(String(b.id));
        toolUses.push({
          tool_use_id: String(b.id),
          tool: String(b.name ?? ""),
          input: (b.input ?? {}) as Record<string, unknown>,
          ...(res ? { text: res.text } : {}),
          ...(res?.isError ? { isError: true as const } : {}),
        });
      }
      msgs.push({ role: "assistant", text: textOf(r), toolUses });
    }
  }
  // The host answers at most MESSAGE_LIMIT; snapshot() reads that cap as "older ones exist".
  return msgs.slice(-MESSAGE_LIMIT);
}

/** Context size the host would have reported at this turn, from the turn's own usage. */
export function contextTokensAt(entry: Rec): number {
  const u: Record<string, unknown> = entry.message?.usage ?? {};
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? u[k] : 0);
  return (
    n("input_tokens") +
    n("cache_creation_input_tokens") +
    n("cache_read_input_tokens") +
    n("output_tokens")
  );
}

/** The newest main-thread assistant record: the turn this Stop hook fires for. */
export function latestAssistant(recs: Rec[]): Rec | undefined {
  return conversation(recs)
    .filter((r) => r.type === "assistant")
    .at(-1);
}
