import { expect, test } from "bun:test"

import {
  judgeTarget,
  parseModelLabel,
  summariseTolerance,
} from "../src/tolerance.js"
import { makeTasks } from "./tolerance-fixtures.js"

test("pool labels keep the full model id when it contains slashes", () => {
  expect(parseModelLabel("openrouter/meta-llama/llama-3.1-70b")).toEqual({
    providerID: "openrouter",
    id: "meta-llama/llama-3.1-70b",
  })
  expect(parseModelLabel("deepseek/deepseek-flash")).toEqual({
    providerID: "deepseek",
    id: "deepseek-flash",
  })
  // A provider-only or unlabelled entry has no usable model id.
  expect(parseModelLabel("deepseek")).toBeNull()
  expect(parseModelLabel("deepseek/")).toBeNull()
  expect(parseModelLabel("/deepseek-flash")).toBeNull()
  expect(parseModelLabel("")).toBeNull()
})

test("an override to another origin never carries the configured credential", () => {
  const configured = {
    baseURL: "http://127.0.0.1:1234/v1",
    apiKey: "{env:OMLX_API_KEY}",
    model: "auto",
  }
  // No override: the configured endpoint and key stay together.
  expect(judgeTarget({ configured }).apiKey).toBe("{env:OMLX_API_KEY}")
  // Same-origin override (a different path only) still gets the key.
  expect(
    judgeTarget({ configured, overrideURL: "http://127.0.0.1:1234/v2" }).apiKey,
  ).toBe("{env:OMLX_API_KEY}")
  // A different host or port must not receive the key.
  for (const url of ["http://evil.example/v1", "http://127.0.0.1:9999/v1", "https://127.0.0.1:1234/v1"]) {
    expect(judgeTarget({ configured, overrideURL: url }).apiKey).toBeUndefined()
  }
})

test("unparseable grades are counted, never averaged as zeros", () => {
  const summary = summariseTolerance([
    { model: "steady", task: "a", intact: 0.9, compacted: 0.88 },
    { model: "steady", task: "b", intact: null, compacted: 0.4 },
    { model: "fragile", task: "a", intact: 0.9, compacted: 0.5 },
  ])
  const steady = summary.find((entry) => entry.model === "steady")
  expect(steady.tasks).toBe(1)
  expect(steady.invalid).toBe(1)
  // The null pair contributes nothing: 0.9/0.88, not 1.8/1.28 across two.
  expect(steady.intact).toBeCloseTo(0.9, 5)
  expect(steady.compacted).toBeCloseTo(0.88, 5)
  const fragile = summary.find((entry) => entry.model === "fragile")
  expect(fragile.invalid).toBe(0)
})

test("control rows are excluded from the tolerance summary", () => {
  const summary = summariseTolerance([
    { model: "m", task: "a", intact: 0.9, compacted: 0.7 },
    { model: "m", task: "control", intact: 0.9, compacted: 0, control: true },
  ])
  expect(summary).toHaveLength(1)
  expect(summary[0].tasks).toBe(1)
  expect(summary[0].degradation).toBeCloseTo((0.9 - 0.7) / 0.9, 5)
})

test("the fixture answer key is derived from the facts the prompts contain", () => {
  const tasks = makeTasks()
  const audit = tasks.find((task) => task.id === "scattered-facts")
  // (42 * 7) % 91 === 21, not 11: the hardcoded key was wrong.
  expect(audit.reference).toContain("fact-3 is value-21")
  expect(audit.reference).toContain("fact-17 is value-28")
  expect(audit.reference).toContain("fact-42 is value-21")
  for (const index of [3, 17, 42]) {
    expect(audit.compacted).toContain(`The fact-${index} parameter is set to value-${(index * 7) % 91}.`)
  }
})

test("the control task drops the evidence the tolerance task keeps", () => {
  const tasks = makeTasks()
  const control = tasks.find((task) => task.kind === "control")
  expect(control).toBeDefined()
  for (const index of [3, 17, 42]) {
    expect(control.compacted).not.toContain(`The fact-${index} parameter`)
  }
})
