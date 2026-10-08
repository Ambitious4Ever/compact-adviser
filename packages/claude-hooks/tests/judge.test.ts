import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import {
  chatEndpoint,
  DEFAULT_MODEL,
  ENDPOINT,
  FLOOR_MAX,
  FLOOR_MIN,
  floorFor,
  JudgeError,
  judge,
  MAX_REQUEST_BYTES,
  nodeTransport,
  parseCompletion,
  qualifies,
  requestBody,
  score,
} from "../lib/judge.ts";
import { answers, type Call, completion, fakeTransport } from "./support.ts";

const kind = (k: string) => (e: unknown) => e instanceof JudgeError && e.kind === k;

describe("scoring (unchanged from upstream)", () => {
  test("finished hands-on work scores near 1, coordination near 0.5", () => {
    assert.ok(score(parseCompletion(completion(answers(1, 1)))) > 0.99);
    assert.ok(Math.abs(score(parseCompletion(completion(answers(1, 0)))) - 0.5) < 0.01);
  });
  test("the floor slides from strict to loose with context pressure", () => {
    assert.equal(floorFor(Number.NaN), FLOOR_MAX);
    assert.equal(floorFor(0.05), FLOOR_MAX);
    assert.equal(floorFor(0.95), FLOOR_MIN);
    assert.ok(floorFor(0.5) < FLOOR_MAX && floorFor(0.5) > FLOOR_MIN);
  });
  test("qualifies compares score to the floor", () => {
    const j = parseCompletion(completion(answers(0.8, 0.9)));
    assert.equal(qualifies(j, 0.05), false);
    assert.equal(qualifies(j, 0.9), true);
  });
});

describe("request body", () => {
  test("asks OpenRouter for strict JSON with both questions", () => {
    const body = JSON.parse(requestBody({ recent: [] }));
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.response_format.type, "json_schema");
    assert.deepEqual(body.response_format.json_schema.schema.required, ["done", "shape"]);
    assert.match(body.messages[0].content, /untrusted conversation data/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { state: { recent: [] } });
  });
  test("oversized state is refused before any request", () => {
    assert.throws(() => requestBody({ text: "x".repeat(MAX_REQUEST_BYTES) }), kind("input"));
  });
});

describe("completion parsing", () => {
  test("accepts fenced JSON and rescales slightly-off probabilities", () => {
    const a = answers(0.9, 0.9);
    a.done.probabilities.finished = 0.95; // sums to 1.05
    a.done.confidence = 0.95;
    const j = parseCompletion(completion(`\`\`\`json\n${JSON.stringify(a)}\n\`\`\``));
    const sum = Object.values(j.done.probabilities).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.equal(j.model, "typesafe/jev-latest");
    assert.equal(j.inputTokens, 1000);
  });
  test("rejects malformed answers", () => {
    assert.throws(() => parseCompletion(completion("not json")), kind("response"));
    assert.throws(() => parseCompletion({ choices: [] }), kind("response"));
    const wrong = answers(0.9, 0.9);
    wrong.done.choice = "not_finished"; // not the most probable option
    assert.throws(() => parseCompletion(completion(wrong)), kind("response"));
    const missing = answers(0.9, 0.9) as { done: unknown; shape: unknown };
    delete (missing.shape as { probabilities: Record<string, number> }).probabilities.unclear;
    assert.throws(() => parseCompletion(completion(missing)), kind("response"));
  });
});

describe("judge transport", () => {
  test("posts to OpenRouter with the bearer key", async () => {
    const calls: Call[] = [];
    const j = await judge({}, "sk-or-test", fakeTransport(200, completion(answers(1, 1)), calls));
    assert.equal(j.done.choice, "finished");
    assert.equal(calls[0]?.url, ENDPOINT);
    assert.equal(calls[0]?.headers.Authorization, "Bearer sk-or-test");
  });
  test("maps HTTP failures to error kinds, never to a judgment", async () => {
    await assert.rejects(judge({}, "k", fakeTransport(401, "")), kind("authentication"));
    await assert.rejects(judge({}, "k", fakeTransport(429, "")), kind("rate-limit"));
    await assert.rejects(judge({}, "k", fakeTransport(502, "")), kind("server"));
    await assert.rejects(judge({}, "k", fakeTransport(200, "<html>")), kind("response"));
  });
  test("times out against a real slow loopback server", async () => {
    const server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      await assert.rejects(
        judge({}, "k", {
          ...nodeTransport,
          endpoint: chatEndpoint(`http://127.0.0.1:${port}/api/v1`),
          timeoutMs: 200,
        }),
        kind("timeout"),
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("endpoint override", () => {
  test("only https or loopback http, without credentials or query", () => {
    assert.equal(chatEndpoint(undefined), ENDPOINT);
    assert.equal(
      chatEndpoint("https://example.com/v1/"),
      "https://example.com/v1/chat/completions",
    );
    assert.equal(chatEndpoint("http://localhost:9/x"), "http://localhost:9/x/chat/completions");
    assert.equal(chatEndpoint("http://example.com"), undefined);
    assert.equal(chatEndpoint("https://u:p@example.com"), undefined);
    assert.equal(chatEndpoint("https://example.com?a=1"), undefined);
  });
});
