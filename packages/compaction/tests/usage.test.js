import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { appendTurn, sessionHash } from "@231self/opencode-shared/state.js"

import {
  DEFAULT_CACHE_WINDOW,
  UsageTracker,
  cacheRatio,
  ttlForProvider,
} from "../src/usage.js"

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-usage-"))
  return { OMLX_ROUTER_STATE: path.join(dir, "state") }
}

const NOW = 1_800_000_000_000
const CLAUDE = { providerID: "anthropic", id: "claude-opus-5-5" }
const DEEPSEEK = { providerID: "deepseek", id: "deepseek-v4-pro" }

test("the cache ratio is read over the whole prefill and capped", () => {
  const ratio = cacheRatio(
    [{ at: NOW, tokens: { input: 20_000, read: 80_000, write: 0 } }],
    { now: NOW },
  )
  expect(ratio.ratio).toBeCloseTo(0.8, 9)
  expect(ratio.samples).toBe(1)

  const capped = cacheRatio(
    [{ at: NOW, tokens: { input: 1_000, read: 99_000, write: 0 } }],
    { now: NOW },
  )
  expect(capped.ratio).toBe(0.95)
  expect(cacheRatio([], { now: NOW })).toBeNull()
})

test("only providers with a documented short cache expire by time", () => {
  expect(ttlForProvider("anthropic")).toBe(300_000)
  expect(ttlForProvider("OpenAI")).toBe(300_000)
  expect(ttlForProvider("deepseek")).toBe(0)
  expect(ttlForProvider("anthropic", { ttlByProvider: { anthropic: 0 } })).toBe(0)
  expect(ttlForProvider("deepseek", { ttlMs: 60_000 })).toBe(60_000)
})

test("recent provider usage becomes the hit rate for the current model", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at: NOW - 5_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 20_000, output: 500, cache: { read: 80_000, write: 0 } },
    at: NOW - 4_000,
  })

  const result = usage.ratioFor({ sessionID: "ses_1", model: CLAUDE, fallback: 0.5 })
  expect(result.ratio).toBeCloseTo(0.8, 9)
  expect(result.samples).toBe(1)
  expect(result.source).toBe("measured")
})

test("steps from another model do not contribute to the ratio", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  usage.noteStepStart({ sessionID: "ses_1", model: DEEPSEEK, at: NOW - 2_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 50_000, cache: { read: 50_000 } },
    at: NOW - 1_000,
  })

  const result = usage.ratioFor({ sessionID: "ses_1", model: CLAUDE, fallback: 0.8 })
  expect(result.source).toBe("fallback")
  expect(result.ratio).toBe(0.8)
})

test("an idle session is priced as a cold cache when the TTL is known", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at: NOW - 700_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 20_000, cache: { read: 80_000 } },
    at: NOW - 600_000,
  })

  const claude = usage.ratioFor({ sessionID: "ses_1", model: CLAUDE, fallback: 0.8 })
  expect(claude.ratio).toBe(0)
  expect(claude.source).toBe("expired")

  // DeepSeek has no configured TTL, so the same gap stays measured.
  const deepseek = new UsageTracker({ env: tempEnv(), now: () => NOW })
  deepseek.noteStepStart({ sessionID: "ses_2", model: DEEPSEEK, at: NOW - 700_000 })
  deepseek.noteStepEnd({
    sessionID: "ses_2",
    tokens: { input: 20_000, cache: { read: 80_000 } },
    at: NOW - 600_000,
  })
  const measured = deepseek.ratioFor({ sessionID: "ses_2", model: DEEPSEEK, fallback: 0.8 })
  expect(measured.ratio).toBeCloseTo(0.8, 9)
  expect(measured.source).toBe("measured")
})

test("the configured ratio is the fallback when nothing was observed", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  const result = usage.ratioFor({ sessionID: "missing", model: CLAUDE, fallback: 0.8 })
  expect(result.ratio).toBe(0.8)
  expect(result.samples).toBe(0)
  expect(result.source).toBe("fallback")
})

test("the router's persisted turns seed a restarted plugin", () => {
  const env = tempEnv()
  appendTurn(
    "opencode",
    {
      ts: NOW - 30_000,
      host: "opencode",
      session: sessionHash("ses_1"),
      usedModel: "anthropic/claude-opus-5-5",
      tokens: { input: 10_000, output: 200, cache: { read: 30_000, write: 0 } },
    },
    env,
  )
  const usage = new UsageTracker({ env, now: () => NOW })
  const result = usage.ratioFor({ sessionID: "ses_1", model: CLAUDE, fallback: 0.8 })
  expect(result.ratio).toBeCloseTo(0.75, 9)
  expect(result.samples).toBe(1)
  expect(result.source).toBe("measured")
})

test("the first step after a checkpoint is captured as the rebuild", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  usage.markPendingRebuild({ sessionID: "ses_1", checkpoint: "cp-1", at: NOW })
  usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at: NOW + 1 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 1_000, output: 200, cache: { read: 4_000, write: 900 } },
    at: NOW + 2,
  })
  // A later step is not the rebuild.
  usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at: NOW + 3 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 100, cache: { read: 5_000 } },
    at: NOW + 4,
  })

  const rebuild = usage.takeRebuild("ses_1")
  expect(rebuild.checkpoint).toBe("cp-1")
  expect(rebuild.tokens).toEqual({ input: 1_000, read: 4_000, write: 900, output: 200 })
  expect(usage.takeRebuild("ses_1")).toBeNull()
})

test("stepsSince returns only steps after the boundary", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  for (const [index, at] of [NOW - 5_000, NOW + 1_000].entries()) {
    usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at })
    usage.noteStepEnd({
      sessionID: "ses_1",
      tokens: { input: 10_000 + index, cache: { read: 10_000 } },
      at,
    })
  }
  const since = usage.stepsSince({ sessionID: "ses_1", model: CLAUDE, at: NOW })
  expect(since).toHaveLength(1)
  expect(since[0].tokens.input).toBe(10_001)
})

test("the window limits how far back the ratio looks", () => {
  const usage = new UsageTracker({ env: tempEnv(), now: () => NOW })
  const steps = [
    { input: 100_000, read: 0 },
    { input: 100_000, read: 0 },
    { input: 10_000, read: 90_000 },
    { input: 10_000, read: 90_000 },
  ]
  for (const [index, step] of steps.entries()) {
    usage.noteStepStart({ sessionID: "ses_1", model: CLAUDE, at: NOW - 1_000 })
    usage.noteStepEnd({
      sessionID: "ses_1",
      tokens: { input: step.input, cache: { read: step.read } },
      at: NOW - 100 + index,
    })
  }
  expect(usage.ratioFor({ sessionID: "ses_1", model: CLAUDE, window: 2 })).toMatchObject({
    ratio: 0.9,
    samples: 2,
    source: "measured",
  })
  expect(DEFAULT_CACHE_WINDOW).toBe(5)
})
