import { expect, test } from "bun:test"

import { cacheHitShare, contextMessageTokens, countContextTokens, estimateTokens } from "../src/tokens.js"

import { RECORDED_PRICES as PRICES, RECORDED_TURN as TURN } from "./fixtures.js"

test("the cache-hit share divides hits by the full prefill", () => {
  expect(cacheHitShare(TURN)).toBeCloseTo(44928 / (39357 + 44928), 6)
})

test("the recorded turn cost reconciles with the miss/hit price split", () => {
  const cost =
    (TURN.input * PRICES.input +
      TURN.cache.read * PRICES.cacheRead +
      (TURN.output + TURN.reasoning) * PRICES.output) /
    1_000_000
  expect(cost).toBeCloseTo(0.028712, 6)
  // Hits exceed `input`, so `input` cannot be the total prompt.
  expect(TURN.cache.read).toBeGreaterThan(TURN.input)
})

test("a turn without cache activity has no share", () => {
  expect(cacheHitShare({ input: 100, output: 10, cache: { read: 0, write: 0 } })).toBe(0)
  expect(cacheHitShare(undefined)).toBe(0)
})

test("the share is capped at 1", () => {
  expect(cacheHitShare({ input: 0, output: 0, cache: { read: 50, write: 0 } })).toBe(1)
})

test("a completed compaction checkpoint counts its summary", () => {
  const summary = "parser state ".repeat(200)
  const plain = countContextTokens({
    system: [],
    messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "continue" }] }],
  })
  const compacted = countContextTokens({
    system: [],
    messages: [
      { type: "compaction", status: "completed", id: "cp-1", summary },
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ],
  })
  expect(compacted - plain).toBe(estimateTokens(summary) + 16)
})

test("the active-context counter counts prompt content, not reasoning or metadata", () => {
  const message = {
    type: "assistant",
    content: [
      { type: "text", text: "here is the answer" },
      {
        type: "reasoning",
        text: "thinking it through ".repeat(400),
        native: { reasoningEncryptedContent: "A".repeat(4000) },
      },
      { type: "tool", tool: "bash", state: { status: "completed", output: "ok".repeat(200), input: {} } },
    ],
    // Host bookkeeping the provider never bills as prompt.
    snapshot: { id: "snap", body: "z".repeat(2000) },
    tokens: { input: 1, output: 2, cache: { read: 3 } },
    time: { created: 1_800_000_000_000 },
  }
  const prompt =
    estimateTokens("here is the answer") +
    estimateTokens("ok".repeat(200)) +
    estimateTokens("{}") +
    16
  expect(contextMessageTokens(message)).toBe(prompt)
  // Stringifying the whole message counted reasoning and metadata as prompt.
  expect(prompt).toBeLessThan(300)
})
