import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import {
  decisionsEndpoint,
  ENDPOINT,
  FLOOR_MAX,
  FLOOR_MIN,
  floorFor,
  JudgeError,
  judge,
  MAX_REQUEST_BYTES,
  MODEL,
  nodeTransport,
  parseJudgment,
  qualifies,
  requestBody,
  score,
} from "../lib/judge.ts";
import { answers, type Call, completion, fakeTransport } from "./support.ts";

const kind = (k: string) => (e: unknown) => e instanceof JudgeError && e.kind === k;

describe("scoring (unchanged from upstream)", () => {
  test("finished hands-on work scores near 1, coordination near 0.5", () => {
    assert.ok(score(parseJudgment(completion(answers(1, 1)))) > 0.99);
    assert.ok(Math.abs(score(parseJudgment(completion(answers(1, 0)))) - 0.5) < 0.01);
  });
  test("the floor slides from strict to loose with context pressure", () => {
    assert.equal(floorFor(Number.NaN), FLOOR_MAX);
    assert.equal(floorFor(0.05), FLOOR_MAX);
    assert.equal(floorFor(0.95), FLOOR_MIN);
    assert.ok(floorFor(0.5) < FLOOR_MAX && floorFor(0.5) > FLOOR_MIN);
  });
  test("qualifies compares score to the floor", () => {
    const j = parseJudgment(completion(answers(0.8, 0.9)));
    assert.equal(qualifies(j, 0.05), false);
    assert.equal(qualifies(j, 0.9), true);
  });
});

describe("request body", () => {
  test("asks the decisions endpoint for the pinned Jev model with both questions", () => {
    const body = JSON.parse(requestBody({ recent: [] }));
    assert.equal(body.model, "~typesafe/jev-latest");
    assert.equal(MODEL, "~typesafe/jev-latest");
    assert.deepEqual(body.state, { recent: [] });
    assert.deepEqual(Object.keys(body.questions), ["done", "shape"]);
  });
  test("oversized state is refused before any request", () => {
    assert.throws(() => requestBody({ text: "x".repeat(MAX_REQUEST_BYTES) }), kind("input"));
  });
});

describe("response parsing", () => {
  test("accepts a Jev answer", () => {
    return judge({}, "k", fakeTransport(200, completion(answers(0.9, 0.9)))).then((j) => {
      assert.equal(j.model, "typesafe/jev-1.13-20260917");
      assert.equal(j.inputTokens, 1000);
    });
  });
  test("rejects malformed answers", async () => {
    await assert.rejects(judge({}, "k", fakeTransport(200, { answers: {} })), kind("response"));
    const wrong = completion(answers(0.9, 0.9));
    wrong.answers.done.choice = "not_finished"; // not the most probable option
    await assert.rejects(judge({}, "k", fakeTransport(200, wrong)), kind("response"));
  });
  test("an answer from any other model is never used", async () => {
    const other = completion(answers(1, 1), "deepseek/deepseek-v4.1-flash");
    await assert.rejects(judge({}, "k", fakeTransport(200, other)), kind("response"));
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
          endpoint: decisionsEndpoint(`http://127.0.0.1:${port}/api/alpha`),
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
    assert.equal(decisionsEndpoint(undefined), ENDPOINT);
    assert.equal(decisionsEndpoint("https://example.com/v1/"), "https://example.com/v1/decisions");
    assert.equal(decisionsEndpoint("http://localhost:9/x"), "http://localhost:9/x/decisions");
    assert.equal(decisionsEndpoint("http://example.com"), undefined);
    assert.equal(decisionsEndpoint("https://u:p@example.com"), undefined);
    assert.equal(decisionsEndpoint("https://example.com?a=1"), undefined);
  });
});
