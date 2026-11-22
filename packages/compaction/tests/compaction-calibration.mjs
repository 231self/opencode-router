#!/usr/bin/env bun
/**
 * Compaction-verdict calibration for the real oMLX model.
 *
 * Re-samples the judge's when-to-compact verdict on recorded-shaped trajectory
 * cases, reports stability per case, and writes the instability band to
 * `~/.local/state/omlx-router/compaction-noise.json`, where the advisory's
 * flip-flop guard scales its cooldown with it.
 *
 * Usage:
 *   bun packages/compaction/tests/compaction-calibration.mjs
 *   bun packages/compaction/tests/compaction-calibration.mjs --model Qwen3-4B-Instruct-2507-4bit
 *   bun packages/compaction/tests/compaction-calibration.mjs --repeat 5 --json
 */

import { JudgeClient } from "@231self/opencode-shared/judge-client.js"
import { compactionNoisePath, instabilityBand, verdictInstability, writeCompactionNoise } from "../src/noise.js"
import { refineVerdict } from "../src/refine.js"
import { extractSignals } from "../src/trigger.js"

function parseArgs(argv) {
  const options = { model: "auto", baseURL: "http://127.0.0.1:1234/v1", timeoutMs: 120_000, repeat: 3, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--json") options.json = true
    else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      options.baseURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = Number(arg.includes("=") ? arg.split("=")[1] : argv[++index])
    } else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      options.repeat = Math.max(2, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]) || 3)
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function toolPart(text) {
  return { type: "tool", tool: "bash", state: { status: "completed", output: text } }
}
function textPart(text) {
  return { type: "text", text }
}
function message(role, ...parts) {
  return { info: { role }, parts }
}

const CASES = [
  {
    id: "boundary-under-pressure",
    promptText: "implement the parser change",
    tailDigest: "tool bash x3 (git status, edits, tests), then a summary of the changes",
    messages: [
      message("user", textPart("implement the parser change")),
      message("assistant", toolPart("x".repeat(4000)), toolPart("x".repeat(4000)), toolPart("x".repeat(4000))),
      message("assistant", textPart("Changes applied: ".concat("y".repeat(400)))),
    ],
    measuredTokens: 60_000,
    previousTokens: 40_000,
    expect: ["compact", "wait"],
  },
  {
    id: "mid-derivation",
    promptText: "trace the race in the scheduler and fix it",
    tailDigest: "mid-debugging: two failed hypotheses, a third in progress",
    messages: [
      message("user", textPart("trace the race in the scheduler and fix it")),
      message("assistant", textPart("Hypothesis two failed; trying a third approach ".concat("z".repeat(3000)))),
    ],
    measuredTokens: 60_000,
    previousTokens: 55_000,
    expect: ["wait"],
  },
  {
    id: "review-boundary",
    promptText: "now review the diff for correctness",
    tailDigest: "tool bash x4, then a summary; the implementation is complete",
    messages: [
      message("user", textPart("now review the diff for correctness")),
      message("assistant", toolPart("x".repeat(2000)), toolPart("x".repeat(2000)), toolPart("x".repeat(2000))),
      message("assistant", textPart("Implementation complete: ".concat("y".repeat(400)))),
    ],
    measuredTokens: 45_000,
    previousTokens: 30_000,
    expect: ["delegate", "wait"],
  },
  {
    id: "small-context",
    promptText: "fix the typo in the README",
    tailDigest: "one tool call, short summary",
    messages: [
      message("user", textPart("fix the typo in the README")),
      message("assistant", toolPart("x".repeat(200))),
      message("assistant", textPart("Done: ".concat("y".repeat(100)))),
    ],
    measuredTokens: 4_000,
    previousTokens: 3_500,
    expect: ["wait", "delegate"],
  },
]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun packages/compaction/tests/compaction-calibration.mjs [--model <id>] [--base-url <url>] [--timeout ms] [--repeat n] [--json]")
    return 0
  }

  const judge = new JudgeClient({
    config: { baseURL: options.baseURL, model: options.model, timeoutMs: options.timeoutMs },
  })

  const results = []
  for (const testCase of CASES) {
    const signals = extractSignals(testCase)
    const verdicts = []
    const confidences = []
    const latencies = []
    for (let sample = 0; sample < options.repeat; sample += 1) {
      const verdict = await refineVerdict({
        judge,
        promptText: testCase.promptText,
        tailDigest: testCase.tailDigest,
        signals,
      })
      verdicts.push(verdict?.action ?? "unparsable")
      if (verdict) {
        confidences.push(verdict.confidence)
        latencies.push(verdict.ms ?? 0)
      }
    }
    const sorted = [...latencies].sort((left, right) => left - right)
    results.push({
      id: testCase.id,
      expect: testCase.expect,
      verdicts,
      instability: verdictInstability(verdicts),
      medianConfidence: confidences.length ? confidences.sort((a, b) => a - b)[Math.floor(confidences.length / 2)] : 0,
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    })
  }

  const band = instabilityBand(results.map((result) => result.verdicts))
  const noise = {
    at: Date.now(),
    judge: { model: options.model, baseURL: options.baseURL },
    samples: options.repeat,
    cases: results.map(({ id, verdicts, instability }) => ({ id, verdicts, instability })),
    instability: band,
  }
  writeCompactionNoise(noise)

  if (options.json) {
    console.log(JSON.stringify({ ...noise, results }, null, 2))
  } else {
    for (const result of results) {
      const expected = result.verdicts.every((verdict) => result.expect.includes(verdict))
      console.log(
        `${expected ? "ok  " : "warn"} ${result.id.padEnd(24)} ${result.verdicts.join(", ").padEnd(28)} ` +
          `instability=${result.instability} confidence=${result.medianConfidence} median=${result.medianMs}ms`,
      )
    }
    console.log(`\ninstability band: ${band} (samples per case: ${options.repeat})`)
    console.log(`wrote ${compactionNoisePath()}`)
  }
  return 0
}

process.exit(await main())
