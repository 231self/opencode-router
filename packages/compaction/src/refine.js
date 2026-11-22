import { clamp, extractJson } from "@231self/opencode-shared/judge-client.js"

const SYSTEM = "You are a context-management classifier. Reply with JSON only, no prose."

/**
 * The when-to-compact rubric (SelfCompact): fire when a sub-task resolved or
 * the trajectory converges; suppress mid-derivation or when stuck. Plus the
 * Elephant-Goldfish question: is the next step review-like, where a
 * fresh-context subagent would serve better?
 *
 * The prompt carries a small digest for the judge only. Nothing from it is
 * ever written to decision records or logs.
 */
export function rubricPrompt({ promptText = "", tailDigest = "", signals = {} }) {
  return [
    "Decide how this agent session should manage its context right now.",
    "",
    `Last user request: ${JSON.stringify(String(promptText).slice(0, 400))}`,
    `Recent trajectory: ${String(tailDigest).slice(0, 600)}`,
    `Signals: contextTokens=${signals.contextTokens ?? 0}, growth=${signals.growth ?? 0}, ` +
      `toolShare=${Number(signals.toolShare ?? 0).toFixed(2)}, ` +
      `toolBurst=${signals.tailToolRun ?? 0}, synthesis=${signals.tailSynthesis ?? 0}, ` +
      `boundary=${Boolean(signals.boundary)}, reviewIntent=${Boolean(signals.reviewIntent)}`,
    "",
    'Reply with JSON only: {"action":"compact"|"delegate"|"wait","confidence":0..1,"reason":"<few words>"}',
    'Choose "compact" only at a sub-task boundary or a converging trajectory; never mid-derivation or while stuck.',
    'Choose "delegate" when the next step is review or verification and a fresh, near-empty context would judge it better.',
  ].join("\n")
}

export function validateAction(raw) {
  if (!raw || typeof raw !== "object") return null
  const action = ["compact", "delegate", "wait"].includes(raw.action) ? raw.action : null
  if (!action) return null
  return {
    action,
    confidence: clamp(Number(raw.confidence ?? 0.5) || 0, 0, 1),
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 120) : "",
  }
}

/**
 * Judge refinement for candidates the deterministic scorer called
 * "uncertain". One repair round; a failed judge call returns null and the
 * deterministic verdict stands.
 */
export async function refineVerdict({ judge, cacheKey, promptText, tailDigest, signals }) {
  if (!judge?.chat) return null
  try {
    const prompt = rubricPrompt({ promptText, tailDigest, signals })
    if (cacheKey) {
      const cached = judge.getCached(cacheKey)
      if (cached) return { ...cached, cached: true }
    }
    const started = Date.now()
    let verdict = validateAction(extractJson(await judge.chat(prompt, { system: SYSTEM })))
    if (!verdict) verdict = validateAction(extractJson(await judge.chat(prompt, { system: SYSTEM, repair: true })))
    if (!verdict) return null
    const result = { ...verdict, cached: false, ms: Date.now() - started }
    if (cacheKey) judge.setCached(cacheKey, { action: result.action, confidence: result.confidence, reason: result.reason })
    return result
  } catch {
    return null
  }
}
