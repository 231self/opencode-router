#!/usr/bin/env bun
/**
 * Per-pin compaction tolerance: run each task twice per pool model — once
 * with the full context, once with it compacted at a realistic checkpoint —
 * and score both answers with the local judge. The degradation per model is
 * written to `~/.local/state/omlx-router/compaction-tolerance.json`.
 *
 * Live: needs the model endpoint and the oMLX judge. Uses only synthetic
 * task fixtures (no recorded prompts). The compacted prompts keep the facts
 * the question needs, so the paired scores measure whether a model continues
 * correctly, not whether it hallucinates missing evidence. A separate control
 * task drops the evidence on purpose; its scores are reported but not folded
 * into the tolerance summary.
 *
 * Usage:
 *   bun packages/compaction/tests/compaction-tolerance.mjs
 *   bun packages/compaction/tests/compaction-tolerance.mjs --base-url http://127.0.0.1:1234/v1 --repeat 2
 *   bun packages/compaction/tests/compaction-tolerance.mjs --model deepseek-v4-pro
 */

import { readConfig } from "@231self/opencode-shared/config.js"
import { JudgeClient, extractJson } from "@231self/opencode-shared/judge-client.js"

import {
  judgeTarget,
  parseModelLabel,
  summariseTolerance,
  tolerancePath,
  writeTolerance,
} from "../src/tolerance.js"
import { makeTasks } from "./tolerance-fixtures.js"

function parseArgs(argv) {
  const options = { baseURL: "http://127.0.0.1:1234/v1", judgeURL: null, repeat: 1, model: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      options.baseURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--judge-url" || arg.startsWith("--judge-url=")) {
      options.judgeURL = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = arg.includes("=") ? arg.split("=")[1] : argv[++index]
    } else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      options.repeat = Math.max(1, Number(arg.includes("=") ? arg.split("=")[1] : argv[++index]) || 1)
    }
  }
  return options
}

async function chatOnce({ baseURL, model, prompt }) {
  const response = await fetch(`${String(baseURL).replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 200,
    }),
  })
  if (!response.ok) throw new Error(`model call returned HTTP ${response.status}`)
  const body = await response.json()
  return String(body?.choices?.[0]?.message?.content ?? "")
}

/** A grade, or null when the judge could not produce one. */
async function scoreAnswer({ judge, answer, reference }) {
  try {
    const prompt = [
      "Score how well the answer matches the reference on 0..1 scale.",
      `Reference: ${JSON.stringify(reference)}`,
      `Answer: ${JSON.stringify(String(answer).slice(0, 600))}`,
      'Reply with JSON only: {"score":0..1}',
    ].join("\n")
    const raw = extractJson(await judge.chat(prompt, { system: "You are a strict grader. Reply with JSON only." }))
    const score = Number(raw?.score)
    return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null
  } catch {
    return null
  }
}

function selectedModels({ config, explicit }) {
  if (explicit) return { models: [{ providerID: "cli", id: explicit }], skipped: [] }
  const models = []
  const skipped = []
  for (const label of config.pool?.models ?? []) {
    const parsed = parseModelLabel(label)
    if (parsed) models.push(parsed)
    else skipped.push(String(label))
  }
  if (models.length === 0) models.push({ providerID: "local", id: "default" })
  return { models, skipped }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { config } = readConfig({ write: false })
  const target = judgeTarget({ configured: config.judge, overrideURL: options.judgeURL })
  const judge = new JudgeClient({ config: target })

  // Pool models come from the router's config unless --model selects one;
  // the fallback keeps the script runnable on a bare checkout.
  const { models, skipped } = selectedModels({ config, explicit: options.model })
  for (const label of skipped) console.log(`warning  cannot parse pool label ${JSON.stringify(label)}; skipped`)

  const tasks = makeTasks()
  const results = []
  for (const model of models) {
    for (const task of tasks) {
      for (let round = 0; round < options.repeat; round += 1) {
        const intactAnswer = await chatOnce({ baseURL: options.baseURL, model: model.id, prompt: task.intact })
        const compactedAnswer = await chatOnce({ baseURL: options.baseURL, model: model.id, prompt: task.compacted })
        results.push({
          model: `${model.providerID}/${model.id}`,
          task: task.id,
          control: task.kind === "control",
          intact: await scoreAnswer({ judge, answer: intactAnswer, reference: task.reference }),
          compacted: await scoreAnswer({ judge, answer: compactedAnswer, reference: task.reference }),
        })
      }
    }
  }

  const summary = summariseTolerance(results)
  writeTolerance({ at: Date.now(), judge: { baseURL: target.baseURL }, results, summary })
  for (const entry of summary) {
    console.log(
      `${entry.model.padEnd(48)} degradation=${entry.degradation.toFixed(3)} ` +
        `intact=${entry.intact.toFixed(2)} compacted=${entry.compacted.toFixed(2)} ` +
        `tasks=${entry.tasks} invalid=${entry.invalid}`,
    )
  }
  const controls = results.filter((row) => row.control)
  if (controls.length > 0) {
    const graded = controls.filter((row) => Number.isFinite(row.intact) && Number.isFinite(row.compacted))
    console.log(
      `\ncontrol (dropped facts, not folded into tolerance): ${graded.length}/${controls.length} graded, ` +
        `${graded.filter((row) => row.compacted < row.intact).length} worse after compaction`,
    )
  }
  console.log(`\nwrote ${tolerancePath()}`)
  return 0
}

process.exit(await main())
