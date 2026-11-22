import { expect, test } from "bun:test"

import { LABEL_WIDTH, WIDTH, facts, join, note, prose, section, wrap } from "../src/format.js"

test("wrap keeps lines inside the width and prefers fragment boundaries", () => {
  const lines = wrap("auto · 3m old · blocked deepseek/deepseek-flash (provider)", 46)
  expect(lines).toEqual(["auto · 3m old", "blocked deepseek/deepseek-flash (provider)"])
  expect(lines.every((line) => line.length <= 46)).toBe(true)
})

test("wrap only breaks inside a fragment as a last resort", () => {
  const lines = wrap("score 0.710 · cost $0.008000", 12)
  expect(lines).toEqual(["score 0.710", "cost", "$0.008000"])
})

test("wrap keeps every generated line within the budget", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve thirteen"
  for (const width of [20, 30, 40]) {
    for (const line of wrap(text, width)) {
      expect(line.length).toBeLessThanOrEqual(width)
    }
  }
})

test("facts align values on one column with a hanging indent", () => {
  const lines = facts([
    ["model", "deepseek/deepseek-flash"],
    ["confidence", "0.95"],
  ])
  expect(lines[0]).toBe(`  model${" ".repeat(LABEL_WIDTH - "model".length)} deepseek/deepseek-flash`)
  const column = (line, value) => line.indexOf(value)
  expect(column(lines[0], "deepseek/deepseek-flash")).toBe(column(lines[1], "0.95"))
})

test("facts wrap long values under the value column", () => {
  const value = "in $4 · out $20 · cache read $0.2 /M (models.dev) · sourced from the public tables"
  const lines = facts([["anthropic/claude-opus-5-5", value]])
  expect(lines.length).toBeGreaterThan(1)
  const indent = lines[1].length - lines[1].trimStart().length
  expect(indent).toBe(2 + "anthropic/claude-opus-5-5".length + 1)
  expect(lines.every((line) => line.length <= WIDTH)).toBe(true)
})

test("a label wider than the column drops its value below", () => {
  const lines = facts([["kilo/anthropic/claude-fable-5.2-very-long-name", "score 0.710"]])
  expect(lines[0]).toBe(`  kilo/anthropic/claude-fable-5.2-very-long-name`)
  expect(lines[1].trim()).toBe("score 0.710")
})

test("multi-line values keep their own lines under the value column", () => {
  const lines = facts([["usage", ["/router pricing [refresh]", "prices for the pool"]]])
  expect(lines[0]).toContain("/router pricing [refresh]")
  expect(lines[1].trim()).toBe("prices for the pool")
})

test("sections stack a title over aligned facts and join keeps them apart", () => {
  const report = join(
    section("decision", [
      ["model", "m"],
      ["source", "judge"],
    ]),
    note("a hint"),
  )
  expect(report.split("\n")).toEqual([
    "decision",
    `  model${" ".repeat(LABEL_WIDTH - "model".length)} m`,
    `  source${" ".repeat(LABEL_WIDTH - "source".length)} judge`,
    "",
    "  a hint",
  ])
})

test("prose wraps paragraphs and keeps them separated", () => {
  const text = prose(
    "Pool source is now favorites, but you have not favorited any models yet.",
    "Second paragraph.",
  )
  const lines = text.split("\n")
  expect(lines).toContain("")
  expect(lines.every((line) => line.length <= WIDTH)).toBe(true)
  expect(text).toContain("Second paragraph.")
})

test("no helper produces a line longer than the width for normal input", () => {
  const blocks = [
    section("decision", [
      ["model", "provider/some-very-long-model-name-indeed"],
      ["source", "judge · first-turn · judge/cost · one-more-fragment · and-another"],
    ]),
    note("hint text ".repeat(10)),
  ]
  for (const block of blocks) {
    for (const line of block) {
      expect(line.length).toBeLessThanOrEqual(WIDTH)
    }
  }
})
