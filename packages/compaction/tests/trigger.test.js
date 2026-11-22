import { expect, test } from "bun:test"

import { extractSignals, scoreSignals } from "../src/trigger.js"

function toolPart(text = "x".repeat(4000)) {
  return { type: "tool", tool: "bash", state: { status: "completed", output: text } }
}
function textPart(text) {
  return { type: "text", text }
}
function message(role, ...parts) {
  return { info: { role }, parts }
}

// A sub-task boundary: a tool burst followed by real assistant synthesis.
const BOUNDARY_TAIL = [
  message("user", textPart("implement the parser change")),
  message("assistant", toolPart(), toolPart(), toolPart()),
  message("assistant", textPart("The burst finished: ".concat("y".repeat(400)))),
]

test("a tool burst followed by synthesis is a boundary with growth pressure", () => {
  const signals = extractSignals({ messages: BOUNDARY_TAIL, measuredTokens: 60_000, previousTokens: 40_000 })
  expect(signals.boundary).toBe(true)
  expect(signals.growth).toBe(20_000)
  const scored = scoreSignals(signals)
  expect(scored.verdict).toBe("compact-now")
  expect(scored.confidence).toBeGreaterThan(0.55)
})

test("a boundary without growth pressure does not advise compaction", () => {
  const signals = extractSignals({ messages: BOUNDARY_TAIL, measuredTokens: 41_000, previousTokens: 40_000 })
  expect(signals.boundary).toBe(true)
  expect(scoreSignals(signals).verdict).toBe("not-yet")
})

test("growth without a boundary is uncertain, not a compaction", () => {
  const messages = [
    message("user", textPart("keep going ".concat("z".repeat(2000)))),
    message("assistant", textPart("working on it ".concat("w".repeat(2000)))),
  ]
  const signals = extractSignals({ messages, measuredTokens: 80_000, previousTokens: 40_000 })
  expect(signals.boundary).toBe(false)
  expect(scoreSignals(signals).verdict).toBe("uncertain")
})

test("a small context is not-yet whatever the shape", () => {
  const signals = extractSignals({ messages: BOUNDARY_TAIL, measuredTokens: 5_000, previousTokens: 1_000 })
  expect(scoreSignals(signals).verdict).toBe("not-yet")
})

test("review intent at a boundary delegates to a fresh-context subagent", () => {
  const messages = [
    message("user", textPart("now review the diff carefully")),
    message("assistant", toolPart(), toolPart(), toolPart()),
    message("assistant", textPart("changes applied ".concat("y".repeat(400)))),
  ]
  const signals = extractSignals({ messages, measuredTokens: 60_000, previousTokens: 40_000 })
  expect(signals.reviewIntent).toBe(true)
  expect(signals.boundary).toBe(true)
  const scored = scoreSignals(signals)
  expect(scored.verdict).toBe("delegate")
  expect(scored.confidence).toBe(0.8)
})

test("a user turn breaks the tool burst", () => {
  const messages = [
    message("user", textPart("do the thing")),
    message("assistant", toolPart(), toolPart()),
    message("user", textPart("and now this")),
    message("assistant", textPart("ok ".concat("y".repeat(400)))),
  ]
  const signals = extractSignals({ messages, measuredTokens: 60_000, previousTokens: 10_000 })
  expect(signals.boundary).toBe(false)
})

test("a running tool marks mid-flight", () => {
  const messages = [
    message("user", textPart("do the thing")),
    message("assistant", toolPart(), { type: "tool", tool: "bash", state: { status: "running" } }),
    message("assistant", textPart("ok ".concat("y".repeat(400)))),
  ]
  const signals = extractSignals({ messages, measuredTokens: 60_000, previousTokens: 10_000 })
  expect(signals.boundary).toBe(false)
})

test("signals never contain text, only numbers and booleans", () => {
  const signals = extractSignals({ messages: BOUNDARY_TAIL, measuredTokens: 10, previousTokens: 0 })
  for (const value of Object.values(signals)) {
    expect(["number", "boolean"]).toContain(typeof value)
  }
})

test("malformed messages are inert, not fatal", () => {
  const signals = extractSignals({ messages: [null, {}, { parts: null }, { info: null, parts: [null] }], measuredTokens: NaN })
  expect(signals.contextTokens).toBe(0)
  expect(() => scoreSignals(signals)).not.toThrow()
})
