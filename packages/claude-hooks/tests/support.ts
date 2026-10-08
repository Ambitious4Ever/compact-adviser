// Fixtures: a synthetic Claude Code transcript and OpenRouter completions.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "../lib/judge.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "compact-adviser-test-"));
}

/** A transcript whose last assistant turn reports `tokens` of context and ~25k chat tokens. */
export function writeTranscript(dir: string, tokens = 120000, turns = 12): string {
  const lines: unknown[] = [];
  let parent: string | null = null;
  const push = (rec: Record<string, unknown>) => {
    const uuid = `u${lines.length}`;
    lines.push({ uuid, parentUuid: parent, ...rec });
    parent = uuid;
  };
  for (let i = 0; i < turns; i++) {
    push({ type: "user", message: { content: `Step ${i}: please implement part ${i}.` } });
    push({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `Working on part ${i}. ${"detail ".repeat(1200)}` },
          { type: "tool_use", id: `t${i}`, name: "Write", input: { file_path: `src/part${i}.ts` } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, output_tokens: 0 },
      },
    });
    push({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] },
    });
  }
  push({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "All parts are done and tests pass." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, output_tokens: 0 },
    },
  });
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

export function answers(finished: number, handsOn: number) {
  const pick = (p: Record<string, number>) =>
    Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const done = { finished, not_finished: (1 - finished) * 0.9, unclear: (1 - finished) * 0.1 };
  const shape = {
    hands_on: handsOn,
    coordinating: (1 - handsOn) * 0.9,
    unclear: (1 - handsOn) * 0.1,
  };
  return {
    done: { choice: pick(done), confidence: Math.max(...Object.values(done)), probabilities: done },
    shape: {
      choice: pick(shape),
      confidence: Math.max(...Object.values(shape)),
      probabilities: shape,
    },
  };
}

export function completion(content: unknown, model = "typesafe/jev-latest") {
  return {
    model,
    choices: [
      { message: { content: typeof content === "string" ? content : JSON.stringify(content) } },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 50 },
  };
}

export interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A transport answering every request with `status` and `body`, recording the calls. */
export function fakeTransport(status: number, body: unknown, calls: Call[] = []): Transport {
  return {
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    },
  };
}
