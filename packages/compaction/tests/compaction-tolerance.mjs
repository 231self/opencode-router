#!/usr/bin/env bun
/**
 * Per-pin compaction tolerance: run each task twice per pool model — once
 * with the full context, once with it compacted at the task's checkpoint —
 * and score both answers with the local judge. The degradation per model is
 * written to `~/.local/state/omlx-router/compaction-tolerance.json`.
 *
 * Live: needs the model endpoint and the oMLX judge. Uses only synthetic
 * task fixtures (no recorded prompts).
 *
 * Usage:
 *   bun packages/compaction/tests/compaction-tolerance.mjs
 *   bun packages/compaction/tests/compaction-tolerance.mjs --base-url http://127.0.0.1:1234/v1 --repeat 2
 */

import { readConfig } from "@231self/opencode-shared/config.js"
import { JudgeClient, extractJson } from "@231self/opencode-shared/judge-client.js"

import { summariseTolerance, tolerancePath, writeTolerance } from "../src/tolerance.js"

function parseArgs(argv) {
  const options = { baseURL: "http://127.0.0.1:1234/v1", judgeURL: "http://127.0.0.1:1234/v1", repeat: 1, model: null }
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

/**
 * Synthetic long-context tasks: a body of facts followed by a question whose
 * answer depends on facts scattered through it. Compaction quality is
 * exactly whether the summary kept those facts.
 */
function makeTasks() {
  const facts = Array.from({ length: 60 }, (_, index) => {
    const key = `fact-${index}`
    const value = `value-${(index * 7) % 91}`
    return `The ${key} parameter is set to ${value}.`
  })
  return [
    {
      id: "scattered-facts",
      intact: [...facts, "Based on the parameters above, what are the settings of fact-3, fact-17, and fact-42? Answer briefly."].join("\n"),
      compacted: [
        "[Compacted summary: a long parameter list was here; the work is a parameter audit.]",
        "Based on the parameters above, what are the settings of fact-3, fact-17, and fact-42? Answer briefly.",
      ].join("\n"),
      reference: "fact-3 is value-21, fact-17 is value-28, fact-42 is value-11.",
    },
    {
      id: "procedure-order",
      intact: [
        "The deploy procedure: 1) freeze the cache, 2) rotate the token, 3) warm the standby, 4) flip traffic.",
        ...facts.slice(0, 20),
        "In order, what are the four deploy steps?",
      ].join("\n"),
      compacted: [
        "[Compacted summary: a deploy procedure and parameter list were here.]",
        "In order, what are the four deploy steps?",
      ].join("\n"),
      reference: "freeze the cache, rotate the token, warm the standby, flip traffic.",
    },
  ]
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

async function scoreAnswer({ judge, answer, reference }) {
  const prompt = [
    "Score how well the answer matches the reference on 0..1 scale.",
    `Reference: ${JSON.stringify(reference)}`,
    `Answer: ${JSON.stringify(String(answer).slice(0, 600))}`,
    'Reply with JSON only: {"score":0..1}',
  ].join("\n")
  const raw = extractJson(await judge.chat(prompt, { system: "You are a strict grader. Reply with JSON only." }))
  const score = Number(raw?.score)
  return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { config } = readConfig({ write: false })
  const judge = new JudgeClient({ config: { ...config.judge, baseURL: options.judgeURL } })

  // Pool models come from the router's config; fall back to the judged
  // endpoint itself so the script runs standalone.
  const models = []
  for (const label of config.pool?.models ?? []) {
    const [providerID, id] = String(label).split("/")
    if (id) models.push({ providerID, id })
  }
  if (models.length === 0) models.push({ providerID: "local", id: options.model ?? "default" })

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
          intact: await scoreAnswer({ judge, answer: intactAnswer, reference: task.reference }),
          compacted: await scoreAnswer({ judge, answer: compactedAnswer, reference: task.reference }),
        })
      }
    }
  }

  const summary = summariseTolerance(results)
  writeTolerance({ at: Date.now(), judge: { baseURL: options.judgeURL }, results, summary })
  for (const entry of summary) {
    console.log(
      `${entry.model.padEnd(40)} degradation=${entry.degradation.toFixed(3)} ` +
        `intact=${entry.intact.toFixed(2)} compacted=${entry.compacted.toFixed(2)} tasks=${entry.tasks}`,
    )
  }
  console.log(`\nwrote ${tolerancePath()}`)
  return 0
}

process.exit(await main())
