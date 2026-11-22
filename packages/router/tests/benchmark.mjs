#!/usr/bin/env bun
/**
 * Reproducible routing benchmark.
 *
 * Simulates a coding session and compares:
 *   - a fixed cheap, mid, and frontier model,
 *   - a static complexity-tier baseline (simulated category baseline),
 *   - this router in cache, balanced, switch, and mixed-weight modes.
 *
 * Decisions come from the real WASM core with recorded (oracle) verdicts, so
 * runs are deterministic. Costs are modelled from published per-million-token
 * prices and assume 80% of the stable prefix is a cache read on repeated turns.
 *
 * Usage:
 *   bun tests/benchmark.mjs
 *   bun tests/benchmark.mjs --long
 *   bun tests/benchmark.mjs --json
 *   bun tests/benchmark.mjs --write
 *
 * Beyond the scenario table, the report sweeps the cache-hit assumption
 * (50/80/95%) two ways: rescoring the same recorded decisions, and re-running
 * the router with the assumption as an input. Judge wall-clock is reported
 * from measured usage next to the modelled dollars.
 */

import fs from "node:fs"
import path from "node:path"

import os from "node:os"

import { modelledTurnCost } from "@231self/opencode-shared/cost.js"
import { DEFAULT_CONFIG, mergeConfig } from "@231self/opencode-shared/config.js"
import { readJudgeNoise } from "../src/judge.js"
import { readDecisions, readTurns } from "@231self/opencode-shared/state.js"
import { loadCore } from "../src/wasm.js"

const OUTPUT_TOKENS = 800
const DEFAULT_CACHE_HIT_RATIO = 0.8
const SENSITIVITY_RATIOS = [0.5, 0.8, 0.95]

const SUITES = {
  short: {
    name: "short",
    title: "Routing benchmark",
    file: "2026-11-17-routing.md",
    turns: 10,
    tokensAt: (turn) => 4000 + 3000 * turn,
  },
  long: {
    name: "long",
    title: "Long-session routing benchmark",
    file: "2026-11-17-routing-long.md",
    turns: 24,
    tokensAt: (turn) => 12500 + 8500 * (turn - 1),
  },
}

const MODELS = {
  cheap: {
    providerID: "deepseek",
    modelID: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    variant: "default",
    local: false,
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.55,
  },
  mid: {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
    name: "DeepSeek V4.1 Pro",
    variant: "default",
    local: false,
    cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.85,
  },
  frontier: {
    providerID: "anthropic",
    modelID: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    variant: "default",
    local: false,
    cost: [{ input: 8, output: 40, cache: { read: 0.2, write: 10 } }],
    limit: { context: 1000000, output: 32000 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.95,
  },
  local27: {
    providerID: "omlx",
    modelID: "Qwen3.8-27B-MLX-4bit",
    name: "Qwen3.8 27B (local)",
    variant: "default",
    local: true,
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: 32768, output: 8192 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: true,
    status: "active",
    quality: 0.72,
  },
  local4: {
    providerID: "omlx",
    modelID: "Qwen3-4B-Instruct-2507-4bit",
    name: "Qwen3 4B (local)",
    variant: "default",
    local: true,
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    limit: { context: 32768, output: 8192 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    reasoning: false,
    status: "active",
    quality: 0.45,
  },
}

const CASES = [
  {
    id: "simple-question",
    prompt: "Explain how the --verbose flag changes ripgrep's output, and when to use it in a build script.",
    truth: { task: "research", complexity: 1, needsTools: false, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
  {
    id: "small-edit",
    prompt: "Add a null check to src/parser.rs and run the tests.",
    truth: { task: "edit", complexity: 2, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
  {
    id: "debug",
    prompt:
      "Debug why `cargo test` panics with an index out of bounds in src/lexer.rs. The stack trace points at token_at() reading past the token vector. Propose a fix and add a regression test.",
    truth: { task: "debug", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "planning",
    prompt:
      "Design a migration of the parser in src/parse.rs to a streaming API. Cover the trade-offs, failure modes, and a phased rollout.",
    truth: { task: "plan", complexity: 4, needsTools: true, needsVision: false, contextNeed: "medium", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "security-review",
    prompt:
      "Review the authentication middleware in src/auth.rs for security issues. List each vulnerability with severity and a fix.",
    truth: { task: "review", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "large-context",
    prompt: "Continue the refactor and update the call sites.",
    truth: { task: "refactor", complexity: 3, needsTools: true, needsVision: false, contextNeed: "large", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "multi-file-refactor",
    prompt:
      "Refactor the parser across src/parser.rs, src/lexer.rs, and src/ast.rs. Keep the tests passing and update the call sites.",
    truth: { task: "refactor", complexity: 4, needsTools: true, needsVision: false, contextNeed: "medium", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "ui-change",
    prompt: "Make the settings dialog keyboard-navigable and add visible focus outlines.",
    truth: { task: "ui", complexity: 3, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "research-comparison",
    prompt: "Compare three parser designs and recommend one for a streaming API. Include the trade-offs.",
    truth: { task: "research", complexity: 3, needsTools: false, needsVision: false, contextNeed: "medium", reasoningNeed: "medium", confidence: 0.9 },
  },
  {
    id: "trivial",
    prompt: "What does this flag do?",
    truth: { task: "trivial", complexity: 1, needsTools: false, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
  {
    id: "error-trace",
    prompt: "panic: index out of bounds in src/lexer.rs. Find the faulty read and add a regression test.",
    truth: { task: "debug", complexity: 4, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "high", confidence: 0.9 },
  },
  {
    id: "docs",
    prompt: "Update the README install section for the new plugin command and check the links.",
    truth: { task: "edit", complexity: 2, needsTools: true, needsVision: false, contextNeed: "small", reasoningNeed: "low", confidence: 0.9 },
  },
]

function parseArgs(argv) {
  const options = { json: false, write: false, long: false }
  for (const arg of argv) {
    if (arg === "--json") options.json = true
    else if (arg === "--write") options.write = true
    else if (arg === "--long") options.long = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function label(model) {
  return `${model.providerID}/${model.modelID}`
}

function modelKey(reference) {
  return reference ? `${reference.providerID}/${reference.id ?? reference.modelID}` : null
}

function requiredQuality(verdict) {
  const base = [0, 0.25, 0.4, 0.55, 0.75, 0.9][Math.min(5, Math.max(1, verdict.complexity))]
  const reasoning = verdict.reasoningNeed === "high" ? 0.1 : 0
  const planning = verdict.task === "plan" || verdict.task === "review" ? 0.05 : 0
  return Math.min(1, base + reasoning + planning)
}

function turnCost(model, tokens, cachedTokens, cacheHitRatio = DEFAULT_CACHE_HIT_RATIO) {
  return modelledTurnCost({
    price: model.cost[0],
    inputTokens: tokens,
    prefixTokens: cachedTokens,
    cacheHitRatio,
    outputTokens: OUTPUT_TOKENS,
  })
}

function passes(model, verdict) {
  return model.quality + 1e-9 >= requiredQuality(verdict)
}

function settings({ mode = "balanced", policy = "cost", cacheHitRatio = DEFAULT_CACHE_HIT_RATIO } = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    policy,
    pool: {
      source: "list",
      models: [label(MODELS.cheap), label(MODELS.mid), label(MODELS.frontier), label(MODELS.local27), label(MODELS.local4)],
      requireTools: true,
      minContext: 32000,
    },
    quality: {
      overrides: {
        [label(MODELS.cheap)]: MODELS.cheap.quality,
        [label(MODELS.mid)]: MODELS.mid.quality,
        [label(MODELS.frontier)]: MODELS.frontier.quality,
      },
    },
    pin: { mode, cacheHitRatio },
    judge: { enabled: true },
  })
}

function caseAt(suite, turn) {
  return CASES[(turn - 1) % CASES.length]
}

function fixedScenario(model, suite) {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const tokens = suite.tokensAt(turn)
    cost += turnCost(model, tokens, previousTokens)
    if (passes(model, testCase.truth)) passed += 1
    previousTokens = tokens
  }
  return {
    name: `fixed ${label(model)}`,
    qualityPass: passed,
    turns: suite.turns,
    switches: 0,
    cost,
  }
}

function staticTierScenario(suite) {
  let cost = 0
  let passed = 0
  let previousTokens = 0
  let previousModel = null
  let switches = 0
  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const verdict = testCase.truth
    const model = verdict.complexity >= 4 ? MODELS.frontier : verdict.complexity === 3 ? MODELS.mid : MODELS.cheap
    const tokens = suite.tokensAt(turn)
    cost += turnCost(model, tokens, previousModel === model ? previousTokens : 0)
    if (passes(model, verdict)) passed += 1
    if (previousModel && previousModel !== model) switches += 1
    previousModel = model
    previousTokens = tokens
  }
  return {
    name: "static complexity tiers (simulated)",
    qualityPass: passed,
    turns: suite.turns,
    switches,
    cost,
  }
}

async function routerScenario(
  core,
  mode,
  { suite, overrides = {}, name = `router ${mode}`, cacheHitRatio = DEFAULT_CACHE_HIT_RATIO } = {},
) {
  const config = mergeConfig(settings({ mode, cacheHitRatio }), overrides)
  let pin = null
  let current = null
  let previousTokens = 0
  let cost = 0
  let passed = 0
  let switches = 0
  let judgeCalls = 0
  const choices = []

  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const testCase = caseAt(suite, turn)
    const tokens = suite.tokensAt(turn)
    const request = {
      abi: 1,
      nowMs: turn * 1000,
      host: "benchmark",
      kind: "primary",
      role: "root",
      session: {
        hash: "benchmark",
        agentID: "build",
        agentMode: "",
        currentModel: current,
      },
      turn: {
        promptText: testCase.prompt,
        promptTokens: Math.ceil(testCase.prompt.length / 4),
        images: 0,
        lastContextTokens: tokens,
        toolFailures: 0,
        turnClassHint: null,
      },
      pool: Object.values(MODELS).map(({ quality, ...model }) => model),
      settings: config,
      pin,
      judge: { verdict: testCase.truth, cached: false, unavailable: false },
      stats: { decisions: turn - 1, switches },
    }
    // The core short-circuits deterministically when it can; only the rest
    // need a judge verdict. Count them instead of assuming one per turn.
    const probe = core.route({ ...request, judge: { verdict: null, cached: false, unavailable: false } })
    if (probe.action === "need_judge") judgeCalls += 1
    const result = core.route(request)

    const chosen = result.decision
      ? { providerID: result.decision.providerID, id: result.decision.id, variant: result.decision.variant ?? "default" }
      : current
    const key = modelKey(chosen)
    const model = Object.values(MODELS).find((entry) => label(entry) === key) ?? MODELS.cheap
    if (process.env.BENCH_TRACE) {
      const top = (result.decision?.top ?? []).map(
        (entry) => `${entry.id}:${entry.score.toFixed(2)}/${entry.quality}>=${entry.required}`,
      )
      console.error(
        `turn ${turn} ${testCase.id} req ${requiredQuality(testCase.truth)} q ${model.quality} pass ${passes(model, testCase.truth)} chosen ${chosen?.id} reason ${result.log?.reason ?? result.decision?.reason} top ${top.join(" ")}`,
      )
    }
    const switched = current ? modelKey(current) !== key : false
    if (switched) switches += 1
    cost += turnCost(model, tokens, switched ? 0 : previousTokens, cacheHitRatio)
    if (passes(model, testCase.truth)) passed += 1
    choices.push(key)
    current = chosen
    previousTokens = tokens
    pin = result.pin ?? pin
  }

  return {
    name,
    qualityPass: passed,
    turns: suite.turns,
    switches,
    cost,
    choices,
    judgeCalls,
    cacheHitRatio,
  }
}

/**
 * Rescore one recorded decision sequence at a different cache-hit assumption.
 * The choices (and therefore the switch count) stay fixed: this isolates the
 * pricing assumption from the routing behaviour.
 */
export function rescoreScenario({ name, choices, suite, cacheHitRatio, switches }) {
  let cost = 0
  let previousKey = null
  let previousTokens = 0
  for (let turn = 1; turn <= suite.turns; turn += 1) {
    const key = choices[turn - 1]
    const model = Object.values(MODELS).find((entry) => label(entry) === key) ?? MODELS.cheap
    const tokens = suite.tokensAt(turn)
    cost += turnCost(model, tokens, key === previousKey ? previousTokens : 0, cacheHitRatio)
    previousKey = key
    previousTokens = tokens
  }
  return { name, cost, switches, turns: suite.turns, fixedDecisions: true }
}

/** Both sensitivity sweeps over the cache-hit assumption. */
export async function sensitivity(core, suite) {
  const balanced = await routerScenario(core, "balanced", { suite })
  const switching = await routerScenario(core, "switch", { suite })
  const rescored = SENSITIVITY_RATIOS.map((cacheHitRatio) => ({
    cacheHitRatio,
    balanced: rescoreScenario({
      name: "balanced",
      choices: balanced.choices,
      suite,
      cacheHitRatio,
      switches: balanced.switches,
    }),
    switch: rescoreScenario({
      name: "switch",
      choices: switching.choices,
      suite,
      cacheHitRatio,
      switches: switching.switches,
    }),
  }))
  const rerun = []
  for (const cacheHitRatio of SENSITIVITY_RATIOS) {
    rerun.push({
      cacheHitRatio,
      balanced: await routerScenario(core, "balanced", { suite, cacheHitRatio }),
      switch: await routerScenario(core, "switch", { suite, cacheHitRatio }),
    })
  }
  return { recorded: { balanced, switch: switching }, rescored, rerun }
}

/**
 * Judge wall-clock measured from real usage, or null when unmeasured.
 *
 * Decision records say which turns consulted the judge and which answers came
 * from its verdict cache; turn records carry the fresh-call latency.
 */
export function measuredJudgeLatency(env = process.env) {
  const turns = readTurns("opencode", 2000, env)
  const decisions = readDecisions("opencode", 2000, env)
  const consulted = decisions.filter((record) => record.judge?.used)
  const cached = consulted.filter((record) => record.judge?.cached)
  const fresh = turns.map((turn) => Number(turn.judgeMs) || 0).filter((ms) => ms > 0)
  if (turns.length === 0 || (consulted.length === 0 && fresh.length === 0)) return null
  fresh.sort((left, right) => left - right)
  const mean = fresh.length > 0 ? fresh.reduce((sum, ms) => sum + ms, 0) / fresh.length : 0
  return {
    turns: turns.length,
    consultedTurns: consulted.length,
    consultedShare: decisions.length > 0 ? consulted.length / decisions.length : 0,
    cachedTurns: cached.length,
    freshCalls: fresh.length,
    meanMs: Math.round(mean),
    p95Ms: fresh.length > 0 ? Math.round(fresh[Math.min(fresh.length - 1, Math.floor(fresh.length * 0.95))]) : 0,
    judgeModel: readJudgeNoise(env)?.selected ?? "auto",
    platform: `${os.platform()} ${os.arch()}`,
  }
}

function money(value) {
  return `$${Number(value).toFixed(3)}`
}

/** Frame the balanced-vs-switch gap at the size of the gap, and no further. */
function costGapBullet(switchRow, balanced) {
  const gap = Math.abs(switchRow.cost - balanced.cost) / Math.max(balanced.cost, switchRow.cost)
  const cheaper = switchRow.cost <= balanced.cost ? "switch" : "balanced"
  const detail = `${(gap * 100).toFixed(1)}%`
  if (gap < 0.02) {
    return (
      `- Balanced and switch differ by ${detail} here — inside the sensitivity of` +
      " the 80% cache assumption (see the sweep below), so treat switching" +
      " frequency as cost-neutral at these settings. The cache-aware pin exists" +
      " to avoid repeated cold prefills; this scenario shows it does not pay for" +
      " that protection."
    )
  }
  return (
    `- ${cheaper} is ${detail} cheaper in this scenario` +
    ` (${money(Math.abs(switchRow.cost - balanced.cost))} on ${money(Math.max(switchRow.cost, balanced.cost))}).` +
    " Whether that holds elsewhere depends on prices, context growth, and the" +
    " assumption sweep below — read it as scenario-specific, not general."
  )
}

function sensitivitySection(sens) {
  const { recorded, rescored, rerun } = sens
  return [
    "## Sensitivity: the cache-hit assumption",
    "",
    "The modelled cost of keeping a model depends on how much of the prompt the",
    "provider's cache serves. Two sweeps vary that assumption:",
    "",
    "**Rescoring the same recorded decisions** — switch counts held at the",
    `recorded runs (balanced ${recorded.balanced.switches}, switch ${recorded.switch.switches}), so this isolates the pricing assumption:`,
    "",
    `| Assumed cache hit | balanced (${recorded.balanced.switches} switches) | switch (${recorded.switch.switches} switches) |`,
    "|---:|---:|---:|",
    ...rescored.map(
      (row) => `| ${Math.round(row.cacheHitRatio * 100)}% | ${money(row.balanced.cost)} | ${money(row.switch.cost)} |`,
    ),
    "",
    "**Re-running the router with the assumption as an input** — it changes the",
    "incumbent's modelled cost, so decisions and switch counts can move:",
    "",
    "| Assumed cache hit | balanced cost | switches | switch cost | switches |",
    "|---:|---:|---:|---:|---:|",
    ...rerun.map(
      (row) =>
        `| ${Math.round(row.cacheHitRatio * 100)}% | ${money(row.balanced.cost)} | ${row.balanced.switches} | ${money(row.switch.cost)} | ${row.switch.switches} |`,
    ),
    "",
    "A direction that holds across both sweeps is an operating envelope for this",
    "price table and workload shape — not a guarantee for other prices, context",
    "growth, or prompt mixes.",
  ]
}

function judgeLatencySection(results, judgeLatency) {
  const rows = results.filter((row) => row.judgeCalls !== undefined)
  const lines = [
    "## Judge latency",
    "",
    "The core classifies turns deterministically when it can and consults the",
    "judge only when it must. Benchmark turns are fresh synthetic prompts, so",
    "they ask for a verdict far more often than real sessions, where kept pins,",
    "manual pins, and heuristic turns skip the judge entirely:",
    "",
    ...rows.map((row) => {
      const seconds = judgeLatency
        ? ` (up to ${((row.judgeCalls * judgeLatency.meanMs) / 1000).toFixed(1)} s at the measured fresh-call mean)`
        : ""
      return `- \`${row.name}\` asked for ${row.judgeCalls} of ${row.turns} turns${seconds}.`
    }),
  ]
  if (judgeLatency) {
    lines.push(
      "",
      `Measured on real usage (${judgeLatency.turns} turns logged, judge ${judgeLatency.judgeModel}, ${judgeLatency.platform}): the judge was consulted on ${Math.round(judgeLatency.consultedShare * 100)}% of turns (${judgeLatency.cachedTurns} of those from its verdict cache). Fresh calls took mean ${judgeLatency.meanMs} ms (p95 ${judgeLatency.p95Ms} ms).`,
    )
  } else {
    lines.push("", "No measured judge timings were available on this machine.")
  }
  lines.push(
    "",
    "The judge is a local side call: no conversation tokens and no dollar cost.",
    "Wall-clock is still a cost users pay, so it is reported next to the money.",
  )
  return lines
}

function markdown(results, suite, extra = {}) {
  const byName = Object.fromEntries(results.map((row) => [row.name, row]))
  const frontier = byName["fixed anthropic/claude-fable-5-2"]
  const cheap = byName["fixed deepseek/deepseek-flash"]
  const mid = byName["fixed deepseek/deepseek-v4-pro"]
  const switchRow = byName["router switch"]
  const balanced = byName["router balanced"]
  const cache = byName["router cache"]
  const mixed = byName["router mixed (balanced)"]
  const first = suite.tokensAt(1)
  const last = suite.tokensAt(suite.turns)
  const delta = (row) => ((row.cost - frontier.cost) / frontier.cost) * 100
  const rows = results.map((row) => {
    const diff = delta(row)
    return `| ${row.name} | ${row.qualityPass}/${row.turns} | ${row.switches} | ${money(row.cost)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(0)}% |`
  })
  const passage = (row) => `${row.qualityPass}/${row.turns}`

  const bullets = [
    `- Fixed cheap passes ${passage(cheap)} turns, fixed mid ${passage(mid)}, and`,
    `  fixed frontier ${passage(frontier)}.`,
    `- \`switch\` costs ${money(switchRow.cost)} (${delta(switchRow) >= 0 ? "+" : "−"}${Math.abs(delta(switchRow)).toFixed(0)}% vs frontier) at ${passage(switchRow)} quality.`,
    `- \`balanced\` costs ${money(balanced.cost)} at ${passage(balanced)} quality, with ${balanced.switches} switches.`,
    `- \`cache\` costs ${money(cache.cost)} at ${passage(cache)} quality, with ${cache.switches} switches.`,
    `- \`mixed\` costs ${money(mixed.cost)} at ${passage(mixed)} quality, with ${mixed.switches} switches.`,
    "- Local models are priced at zero and get a size-based quality: the 27B",
    "  clears routine turns at 0.55, the 4B stays on trivial turns at 0.45.",
    costGapBullet(switchRow, balanced),
  ]

  return [
    `# ${suite.title} — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Generated by `bun run bench`" + (suite.name === "long" ? " `--long`" : "") + ".",
    "Decisions come from the real WASM core with recorded verdicts; costs are",
    "modelled from published per-million-token prices.",
    "",
    "## Setup",
    "",
    `- ${suite.turns} turns, cycling ${CASES.length} prompts from the routing eval.`,
    `- Context grows from ${Math.round(first / 1000)}k to ${Math.round(last / 1000)}k input tokens; ${OUTPUT_TOKENS} output tokens per turn.`,
    "- Prices per million tokens: cheap 0.2/0.8, mid 2/8, frontier 8/40.",
    "- Cache assumption: 80% of the stable prefix is read from cache on turns",
    "  that keep the same model; a switch pays a cold prefill. The sensitivity",
    "  section sweeps this assumption.",
    "- Quality: cheap 0.55, mid 0.85, frontier 0.95, compared against the quality",
    "  required by each recorded verdict.",
    "",
    "## Results",
    "",
    "| Scenario | Quality pass | Switches | Cost | vs frontier |",
    "|---|---:|---:|---:|---:|",
    ...rows,
    "",
    "## What this measures",
    "",
    "- **Routing and cost**, not answer quality. A quality pass means the chosen",
    "  model clears the verdict's required quality; it does not measure whether",
    "  the model actually solved the task.",
    "- The static tier baseline is simulated from verdict complexity. It is a",
    "  category baseline, not a run of another plugin.",
    "- Dollar figures cover model tokens only. Judge wall-clock is measured and",
    "  reported in its own section below.",
    "",
    "## Reading the numbers",
    "",
    ...bullets,
    "",
    ...(extra.sensitivity ? [...sensitivitySection(extra.sensitivity), ""] : []),
    ...(extra.judgeLatency === undefined ? [] : [...judgeLatencySection(results, extra.judgeLatency), ""]),
    "## Reproduce",
    "",
    "```sh",
    suite.name === "long" ? "bun run bench:long" : "bun run bench",
    "```",
    "",
  ].join("\n")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Usage: bun tests/benchmark.mjs [--long] [--json] [--write]")
    return 0
  }

  const suite = options.long ? SUITES.long : SUITES.short
  const core = await loadCore()
  const results = [
    fixedScenario(MODELS.cheap, suite),
    fixedScenario(MODELS.mid, suite),
    fixedScenario(MODELS.frontier, suite),
    fixedScenario(MODELS.local27, suite),
    fixedScenario(MODELS.local4, suite),
    staticTierScenario(suite),
    await routerScenario(core, "cache", { suite }),
    await routerScenario(core, "balanced", { suite }),
    await routerScenario(core, "switch", { suite }),
    await routerScenario(core, "balanced", {
      suite,
      name: "router mixed (balanced)",
      overrides: {
        policyWeights: { cost: 0.6, quality: 0.35, latency: 0.05 },
        policyByClass: {
          planning: { cost: 0.1, quality: 0.8, latency: 0.1 },
          review: { cost: 0.1, quality: 0.8, latency: 0.1 },
        },
      },
    }),
  ]

  const sens = await sensitivity(core, suite)
  const judgeLatency = measuredJudgeLatency()

  if (options.json) {
    console.log(
      JSON.stringify({ suite: suite.name, turns: suite.turns, results, sensitivity: sens, judgeLatency }, null, 2),
    )
    return 0
  }

  const text = markdown(results, suite, { sensitivity: sens, judgeLatency })
  if (options.write) {
    // The reports live at the repository root, not inside the package.
    const target = path.resolve(import.meta.dir, `../../../docs/benchmarks/${suite.file}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    console.log(`wrote ${target}`)
    return 0
  }

  console.log(text)
  return 0
}

if (import.meta.main) process.exit(await main())

export { MODELS, SUITES }
