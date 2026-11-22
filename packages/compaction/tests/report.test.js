import { expect, test } from "bun:test"

import { calibrationReport } from "../src/report.js"

test("an empty calibration says what to do instead of printing a blank table", () => {
  expect(calibrationReport(null)).toContain("No compaction calibration yet")
  expect(calibrationReport({ models: {} })).toContain("No compaction calibration yet")
})

test("the report shows summary, prediction error, rebuild, and counts", () => {
  const report = calibrationReport({
    models: {
      "deepseek/deepseek-v4-pro": {
        summary: { value: 940.4, samples: 3 },
        lastPrediction: { predicted: 4300, actual: 5100, error: 0.186 },
        error: { value: 0.12, samples: 3 },
        rebuild: { value: { input: 1200, read: 4000, write: 900 }, samples: 2 },
        compactions: 3,
      },
    },
  })
  expect(report).toContain("deepseek/deepseek-v4-pro")
  expect(report).toContain("940 tokens (3 samples)")
  expect(report).toContain("4300 → 5100 (+19%)")
  expect(report).toContain("mean 12%")
  expect(report).toContain("1200 in · 4000 read · 900 write (2 samples)")
  expect(report).toContain("compactions  3")
})

test("a model with no observations says so rather than inventing numbers", () => {
  const report = calibrationReport({
    models: { "local/model": { compactions: 1 } },
  })
  expect(report).toContain("assumed (no samples)")
  expect(report).toContain("rebuild      not measured")
  expect(report).not.toContain("prediction")
})
