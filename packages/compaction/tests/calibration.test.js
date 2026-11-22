import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  bucketCost,
  calibrationFor,
  calibrationPath,
  readCalibration,
  recordObservation,
  updateCalibration,
  writeCalibration,
} from "../src/calibration.js"

const MODEL = { providerID: "deepseek", id: "deepseek-v4-pro" }
const OTHER = { providerID: "anthropic", id: "claude-opus-5-5" }

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-calibration-"))
  return { OMLX_ROUTER_STATE: path.join(dir, "state") }
}

test("summary observations fold into a running mean", () => {
  let calibration = recordObservation(null, { model: MODEL, kind: "summary", value: 1000 })
  calibration = recordObservation(calibration, { model: MODEL, kind: "summary", value: 2000 })
  const summary = calibrationFor(calibration, MODEL).summary
  expect(summary.samples).toBe(2)
  expect(summary.value).toBeCloseTo(1500, 6)
})

test("request and rebuild buckets average field by field", () => {
  let calibration = recordObservation(null, {
    model: MODEL,
    kind: "rebuild",
    value: { input: 1000, read: 4000, write: 500, output: 200 },
  })
  calibration = recordObservation(calibration, {
    model: MODEL,
    kind: "rebuild",
    value: { input: 3000, read: 6000, write: 1500, output: 400 },
  })
  const rebuild = calibrationFor(calibration, MODEL).rebuild
  expect(rebuild.samples).toBe(2)
  expect(rebuild.value.input).toBeCloseTo(2000, 6)
  expect(rebuild.value.read).toBeCloseTo(5000, 6)
  expect(rebuild.value.write).toBeCloseTo(1000, 6)
  expect(rebuild.value.output).toBeCloseTo(300, 6)
})

test("one model's observations do not leak into another", () => {
  let calibration = recordObservation(null, { model: MODEL, kind: "summary", value: 1000 })
  calibration = recordObservation(calibration, { model: OTHER, kind: "summary", value: 50 })
  expect(calibrationFor(calibration, MODEL).summary.value).toBeCloseTo(1000, 6)
  expect(calibrationFor(calibration, OTHER).summary.value).toBeCloseTo(50, 6)
  expect(calibrationFor(calibration, null)).toBeNull()
})

test("an observation keeps the session dedup metadata", () => {
  const calibration = recordObservation(
    { sessions: { abc: { checkpoint: "cp-1" } } },
    { model: MODEL, kind: "summary", value: 1 },
  )
  expect(calibration.sessions.abc.checkpoint).toBe("cp-1")
})

test("a held lock fails fast instead of stealing it", () => {
  const env = tempEnv()
  const file = calibrationPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.lock`, "held")
  expect(() => updateCalibration(env, (value) => value)).toThrow(/busy/)
  fs.rmSync(`${file}.lock`)
})

test("calibration is stored under the shared state directory", () => {
  const env = tempEnv()
  expect(calibrationPath(env)).toBe(path.join(env.OMLX_ROUTER_STATE, "compaction-calibration.json"))
  const value = recordObservation(null, { model: MODEL, kind: "summary", value: 1200 })
  writeCalibration(value, env)
  expect(readCalibration(env).models["deepseek/deepseek-v4-pro"].summary.value).toBeCloseTo(1200, 6)
  expect(readCalibration({ ...env, OMLX_ROUTER_COMPACTION_CALIBRATION: path.join(env.OMLX_ROUTER_STATE, "x.json") }).models).toEqual({})
})

test("a compaction count is recorded separately from values", () => {
  let calibration = recordObservation(null, { model: MODEL, kind: "compaction" })
  calibration = recordObservation(calibration, { model: MODEL, kind: "compaction" })
  expect(calibrationFor(calibration, MODEL).compactions).toBe(2)
})

test("bucket cost uses per-million prices and the write fallback", () => {
  const price = { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }
  const cost = bucketCost(price, { input: 1000, read: 10_000, write: 2000, output: 500 })
  expect(cost).toBeCloseTo((1000 * 1 + 10_000 * 0.1 + 2000 * 1.25 + 500 * 2) / 1_000_000, 9)

  const noWritePrice = bucketCost(
    { input: 1, output: 2, cache: { read: 0.1 } },
    { input: 0, read: 0, write: 1000, output: 0 },
  )
  expect(noWritePrice).toBeCloseTo(0.001, 9)
})
