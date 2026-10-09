import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Deps, HINT, onSessionStart, onStop } from "../lib/adviser.ts";
import { loadApiKey, loadConfig } from "../lib/config.ts";
import type { Transport } from "../lib/judge.ts";
import { loadState, statePath } from "../lib/store.ts";
import {
  contextTokensAt,
  latestAssistant,
  loadTranscript,
  messagesUpTo,
} from "../lib/transcript.ts";
import {
  answers,
  type Call,
  completion,
  fakeTransport,
  tempDir,
  writeTranscript,
} from "./support.ts";

function setup(transport: Transport, env: Record<string, string> = {}) {
  const home = tempDir();
  const deps: Deps = {
    env: { COMPACT_ADVISER_HOME: home, OPENROUTER_API_KEY: "sk-or-test-key-123456", ...env },
    now: () => 1_000_000,
    transport,
  };
  return { home, deps, transcript: writeTranscript(home) };
}

const stop = (sessionId: string, transcript: string) => ({
  session_id: sessionId,
  transcript_path: transcript,
  hook_event_name: "Stop",
});

describe("transcript", () => {
  test("rebuilds the message view and context size", () => {
    const recs = loadTranscript(writeTranscript(tempDir(), 90000, 3));
    const last = latestAssistant(recs);
    assert.ok(last);
    assert.equal(contextTokensAt(last), 90000);
    const msgs = messagesUpTo(recs, last);
    assert.equal(msgs.length, 7);
    assert.equal(msgs[1]?.toolUses[0]?.text, "ok");
  });
});

describe("Stop hook", () => {
  test("hints once at a qualifying checkpoint, then not again for the same one", async () => {
    const calls: Call[] = [];
    const { home, deps, transcript } = setup(fakeTransport(200, completion(answers(1, 1)), calls));
    assert.deepEqual(await onStop(stop("s1", transcript), deps), { systemMessage: HINT });
    assert.deepEqual(await onStop(stop("s1", transcript), deps), {});
    assert.equal(calls.length, 1);
    const sent = JSON.stringify(calls[0]?.body);
    assert.ok(!sent.includes("sk-or-test-key-123456"), "the key never enters the body");
    assert.equal(loadState(home, "s1", 0).completed, 2);
  });

  test("no hint when the work is unfinished", async () => {
    const { deps, transcript } = setup(fakeTransport(200, completion(answers(0.1, 1))));
    assert.deepEqual(await onStop(stop("s2", transcript), deps), {});
  });

  test("no request below the minimum context or without a key", async () => {
    const calls: Call[] = [];
    const t = fakeTransport(200, completion(answers(1, 1)), calls);
    const low = setup(t, { COMPACT_ADVISER_MIN_CONTEXT_TOKENS: "500000" });
    assert.deepEqual(await onStop(stop("s3", low.transcript), low.deps), {});
    const nokey = setup(t, { OPENROUTER_API_KEY: "" });
    assert.deepEqual(await onStop(stop("s4", nokey.transcript), nokey.deps), {});
    assert.equal(calls.length, 0);
  });

  test("mode off and stop_hook_active do nothing", async () => {
    const calls: Call[] = [];
    const { deps, transcript } = setup(fakeTransport(200, completion(answers(1, 1)), calls), {
      CLAUDE_PLUGIN_OPTION_MODE: "off",
    });
    assert.deepEqual(await onStop(stop("s5", transcript), deps), {});
    const on = setup(fakeTransport(200, completion(answers(1, 1)), calls));
    assert.deepEqual(
      await onStop({ ...stop("s5", on.transcript), stop_hook_active: true }, on.deps),
      {},
    );
    assert.equal(calls.length, 0);
  });

  test("a bad key is surfaced and backs off; a server error stays silent", async () => {
    const auth = setup(fakeTransport(401, ""));
    const out = await onStop(stop("s6", auth.transcript), auth.deps);
    assert.match(out.systemMessage ?? "", /OPENROUTER_API_KEY/);
    assert.ok(loadState(auth.home, "s6", 0).retryAfter > 1_000_000);
    const server = setup(fakeTransport(500, ""));
    assert.deepEqual(await onStop(stop("s7", server.transcript), server.deps), {});
  });

  test("request log never contains the key", async () => {
    const { home, deps, transcript } = setup(fakeTransport(200, completion(answers(1, 1))), {
      COMPACT_ADVISER_LOG_REQUESTS: "true",
    });
    await onStop(stop("s8", transcript), deps);
    const log = readFileSync(join(home, "requests-s8.jsonl"), "utf8");
    assert.match(log, /"kind":"response"/);
    assert.ok(!log.includes("sk-or-test-key-123456"));
  });
});

describe("SessionStart after compaction", () => {
  test("restarts cooldowns so the next hint waits for fresh work", async () => {
    const calls: Call[] = [];
    const { home, deps, transcript } = setup(fakeTransport(200, completion(answers(1, 1)), calls));
    onSessionStart({ session_id: "s9", source: "compact" }, deps);
    assert.equal(loadState(home, "s9", 0).compacted, true);
    // Right after a compaction the cooldown needs 20k new tokens and 3 exchanges.
    assert.deepEqual(await onStop(stop("s9", transcript), deps), {});
    assert.equal(calls.length, 0);
    onSessionStart({ session_id: "s10", source: "startup" }, deps);
    assert.throws(() => readFileSync(statePath(home, "s10")));
  });
});

describe("config", () => {
  test("env beats plugin option beats config file; key from project .env last", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ minContextTokens: 111, mode: "off" }),
    );
    const base = { COMPACT_ADVISER_HOME: home };
    assert.equal(loadConfig(base).minContextTokens, 111);
    assert.equal(loadConfig(base).mode, "off");
    const opt = { ...base, CLAUDE_PLUGIN_OPTION_MINCONTEXTTOKENS: "222" };
    assert.equal(loadConfig(opt).minContextTokens, 222);
    assert.equal(
      loadConfig({ ...opt, COMPACT_ADVISER_MIN_CONTEXT_TOKENS: "333" }).minContextTokens,
      333,
    );
    // The judge model is pinned: no setting can change it.
    assert.equal("model" in loadConfig({ ...base, COMPACT_ADVISER_MODEL: "other/model" }), false);
    const project = tempDir();
    writeFileSync(join(project, ".env"), 'OPENROUTER_API_KEY="from-dotenv"\n');
    assert.equal(loadApiKey(base, project), "from-dotenv");
    assert.equal(
      loadApiKey({ ...base, CLAUDE_PLUGIN_OPTION_OPENROUTERAPIKEY: "opt" }, project),
      "opt",
    );
    assert.equal(loadApiKey({ ...base, OPENROUTER_API_KEY: "env" }, project), "env");
  });
});
