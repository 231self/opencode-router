#!/usr/bin/env bun
/**
 * The compaction-strategy ablation: the same fixture trajectories through
 * the fixed-threshold baseline, the deterministic trigger, and the hybrid
 * trigger. Offline by default (the hybrid arm uses the fixture oracle for
 * its judge); `--judge` runs the real oMLX judge as the refiner.
 *
 * Usage:
 *   bun packages/compaction/tests/compaction-ablation.mjs
 *   bun packages/compaction/tests/compaction-ablation.mjs --judge --repeat 3
 */

import { JudgeClient } from "@231self/opencode-shared/judge-client.js"

import { runAblation } from "../src/ablation.js"
import { refineVerdict } from "../src/refine.js"

function toolPart(text) {
  return { type: "tool", tool: "bash", state: { status: "completed", output: text } }
}
function textPart(text) {
  return { type: "text", text }
}
function message(role, ...parts) {
  return { info: { role }, parts }
}

const PRICE = { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }

const CASES = [
  {
    id: "boundary-under-pressure",
    promptText: "implement the parser change",
    tailDigest: "tool bash x3, then a summary of the changes",
    messages: [
      message("user", textPart("implement the parser change")),
      message("assistant", toolPart("x".repeat(4000)), toolPart("x".repeat(4000)), toolPart("x".repeat(4000))),
      message("assistant", textPart("Changes applied: ".concat("y".repeat(400)))),
    ],
    measuredTokens: 60_000,
    previousTokens: 40_000,
    compactedTokens: 4_300,
    price: PRICE,
    cacheHitRatio: 0.8,
    expectedTurns: 6,
    oracle: "compact-now",
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
    compactedTokens: 4_300,
    price: PRICE,
    cacheHitRatio: 0.8,
    expectedTurns: 6,
    oracle: "not-yet",
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
    compactedTokens: 4_300,
    price: PRICE,
    cacheHitRatio: 0.8,
    expectedTurns: 6,
    oracle: "delegate",
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
    compactedTokens: 4_300,
    price: PRICE,
    cacheHitRatio: 0.8,
    expectedTurns: 6,
    oracle: "not-yet",
  },
]

function parseArgs(argv) {
  const options = { judge: false, repeat: 3, model: "auto", baseURL: "http://127.0.0.1:1234/v1", json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--judge") options.judge = true
    else if (arg === "--json") options.json = true
    else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      options.repeat = Math.max(1, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]) || 3)
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      options.baseURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  // Without --judge the hybrid arm's refiner answers the way the fixture
  // oracle's rubric would (documented in the report as offline mode).
  const refine = options.judge
    ? (() => {
        const judge = new JudgeClient({ config: { baseURL: options.baseURL, model: options.model } })
        return (input) => refineVerdict({ judge, signals: input.signals, promptText: input.promptText, tailDigest: input.tailDigest })
      })()
    : async ({ signals }) => (signals.boundary ? { action: "compact", confidence: 1 } : { action: "wait", confidence: 1 })

  const { rows, summary } = await runAblation({ cases: CASES, refine })

  if (options.json) {
    console.log(JSON.stringify({ mode: options.judge ? "live-judge" : "offline", rows, summary }, null, 2))
    return 0
  }
  for (const row of rows) {
    console.log(
      `${row.correct ? "ok  " : "MISS"} ${row.strategy.padEnd(6)} ${row.case.padEnd(24)} ` +
        `${row.verdict.padEnd(12)} oracle=${row.oracle.padEnd(12)} source=${row.source}`,
    )
  }
  console.log("")
  for (const entry of summary) {
    console.log(
      `${entry.strategy.padEnd(6)} correct ${entry.correct}/${entry.cases} · compacted ${entry.compactions} · delegated ${entry.delegates}`,
    )
  }
  return 0
}

process.exit(await main())
