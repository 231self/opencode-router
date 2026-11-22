import fs from "node:fs"
import path from "node:path"

import { JudgeClient, JudgeError, clamp, extractJson, paramBillions } from "@231self/opencode-shared/judge-client.js"
import { stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"

export { JudgeError, paramBillions }

const ROUTING_SYSTEM = "You are a routing classifier. Reply with JSON only, no prose."

/**
 * Judge noise calibration: how far re-judged verdicts move the score gap
 * between an incumbent and its best challenger. Measured by
 * `bun run judge:calibrate` (re-sampled verdicts per case), stored here, and
 * used by the router to floor `pin.switchThreshold` — a gap inside the judge's
 * own spread must not flip the model.
 */
export function judgeNoisePath(env = process.env) {
  return env.OMLX_ROUTER_JUDGE_NOISE || path.join(stateRoot(env), "judge-noise.json")
}

export function readJudgeNoise(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(judgeNoisePath(env), "utf8"))
  } catch {
    return null
  }
}

export function writeJudgeNoise(value, env = process.env) {
  writeJsonAtomic(judgeNoisePath(env), value)
  return value
}

/** Peak-to-peak movement of one case's score-gap samples. */
export function gapSpread(gaps) {
  const values = (Array.isArray(gaps) ? gaps : []).map(Number).filter(Number.isFinite)
  if (values.length < 2) return 0
  return Math.max(...values) - Math.min(...values)
}

/**
 * The noise band from per-case gap samples: the widest movement observed in
 * any one case, clamped to [0, 0.5].
 */
export function verdictNoiseBand(caseGaps) {
  let band = 0
  for (const gaps of caseGaps ?? []) band = Math.max(band, gapSpread(gaps))
  return Math.min(0.5, Math.round(band * 1e6) / 1e6)
}

function validate(raw) {
  if (!raw || typeof raw !== "object") return null
  const complexity = Number(raw.complexity)
  if (!Number.isFinite(complexity)) return null
  const contextNeed = ["small", "medium", "large"].includes(raw.contextNeed) ? raw.contextNeed : "medium"
  const reasoningNeed = ["low", "medium", "high"].includes(raw.reasoningNeed) ? raw.reasoningNeed : "medium"
  return {
    task: typeof raw.task === "string" ? raw.task : "edit",
    complexity: clamp(Math.round(complexity), 1, 5),
    needsTools: Boolean(raw.needsTools ?? raw.needs_tools ?? true),
    needsVision: Boolean(raw.needsVision ?? raw.needs_vision ?? false),
    contextNeed,
    reasoningNeed,
    confidence: clamp(Number(raw.confidence ?? 0.5) || 0, 0, 1),
  }
}

/** oMLX routing judge: the shared client plus the routing rubric and probe. */
export class Judge extends JudgeClient {
  /**
   * Return a validated routing verdict, using the cache when possible.
   * Throws JudgeError on transport, HTTP, or parse failure.
   */
  async verdict({ prompt, cacheKey }) {
    if (cacheKey) {
      const cached = this.getCached(cacheKey)
      if (cached) return { verdict: cached, cached: true, model: this.selected }
    }
    const started = Date.now()
    let text = await this.chat(prompt, { system: ROUTING_SYSTEM })
    let verdict = validate(extractJson(text))
    if (!verdict) {
      text = await this.chat(prompt, { system: ROUTING_SYSTEM, repair: true })
      verdict = validate(extractJson(text))
    }
    if (!verdict) throw new JudgeError("judge returned unparsable JSON")
    if (cacheKey) this.setCached(cacheKey, verdict)
    return { verdict, cached: false, model: this.selected, ms: Date.now() - started }
  }

  async probe() {
    const started = Date.now()
    const models = await this.listModels()
    const selected = await this.pickModel()
    const prompt =
      'Turn: "Fix the failing parser test and run the suite"\nSignals: prompt_tokens=12, last_context_tokens=4000, images=0, tool_failures=0\n\nJSON schema: {"task":"edit","complexity":2,"needsTools":true,"needsVision":false,"contextNeed":"small","reasoningNeed":"medium","confidence":0.8}'
    const text = await this.chat(prompt, { system: ROUTING_SYSTEM })
    return {
      models,
      selected,
      ms: Date.now() - started,
      sample: validate(extractJson(text)),
    }
  }
}
