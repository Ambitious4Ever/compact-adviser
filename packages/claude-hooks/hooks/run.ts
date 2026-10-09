// Command-hook entry: `node run.ts stop|session-start`, hook JSON on stdin, hook JSON on stdout.
// Every failure is swallowed into `{}` with exit 0: an adviser must never fail or block a turn.

import { type HookInput, liveDeps, onSessionStart, onStop } from "../lib/adviser.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let output = {};
  try {
    const input = JSON.parse((await readStdin()).replace(/^﻿/, "") || "{}") as HookInput;
    const event = process.argv[2];
    if (event === "stop") output = await onStop(input, liveDeps());
    else if (event === "session-start") output = onSessionStart(input, liveDeps());
  } catch (error) {
    if (process.env.COMPACT_ADVISER_DEBUG) console.error(error);
  }
  process.stdout.write(JSON.stringify(output));
}

await main();
