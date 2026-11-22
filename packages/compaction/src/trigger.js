import { partTokens } from "@231self/opencode-shared/tokens.js"

/**
 * Deterministic compaction-safety scoring over trajectory signals. Signals
 * and hashes only: nothing here ever records prompt or message text (the
 * `reviewIntent` keyword check runs in memory and stores a boolean).
 *
 * The verdict space:
 * - "compact-now" — a sub-task boundary with real growth pressure
 * - "delegate"    — the next step is review-like; a fresh-context subagent
 *                   serves it better than any amount of history (the
 *                   Elephant-Goldfish finding: review quality improves at
 *                   zero context)
 * - "not-yet"     — keep going; no pressure or no safe point yet
 * - "uncertain"   — the deterministic read is unclear; the judge refines
 */
export const TRIGGER_DEFAULTS = {
  growthFloor: 2000, // per-turn growth above which the context is under pressure
  contextFloor: 24_000, // context size where compaction becomes relevant at all
  toolBurst: 3, // completed tool parts that count as a sub-task burst
  synthesisTokens: 80, // assistant text size that counts as synthesis, not a fragment
  recentWindow: 6, // tail messages inspected for the boundary pattern
}

const REVIEW_WORDS =
  /\b(review|verify|verification|check|audit|grade|critique|evaluate|validate|sanity[- ]?check)\b/i

function tailParts(messages, window) {
  const tail = messages.slice(Math.max(0, messages.length - window))
  const out = []
  for (const message of tail) {
    const role = message?.info?.role ?? message?.role ?? ""
    for (const part of message?.parts ?? []) out.push({ role, part })
  }
  return out
}

/**
 * Structural signals from the message list and the measured context. All
 * values are numbers; the prompt never leaves this function.
 */
export function extractSignals({ messages = [], measuredTokens = 0, previousTokens = 0, settings = {} }) {
  const s = { ...TRIGGER_DEFAULTS, ...settings }

  const walked = tailParts(messages, s.recentWindow)
  let toolTokens = 0
  let textTokens = 0
  let completedTools = 0
  let tailSynthesis = 0
  let tailIsAssistant = false
  let tailToolRun = 0
  for (const { role, part } of walked) {
    const tokens = partTokens(part)
    if (part?.type === "tool") {
      if (part?.state?.status !== "completed") {
        // A running tool means mid-flight work: no boundary here.
        tailToolRun = 0
        tailIsAssistant = false
        tailSynthesis = 0
        continue
      }
      toolTokens += tokens
      completedTools += 1
      tailToolRun += 1
      tailIsAssistant = false
      tailSynthesis = 0
      continue
    }
    if (part?.type === "text") {
      textTokens += tokens
      if (role === "user") {
        // A new user turn breaks the burst pattern.
        tailToolRun = 0
        tailIsAssistant = false
        tailSynthesis = 0
        continue
      }
      if (role === "assistant" && tailToolRun > 0) {
        tailIsAssistant = true
        tailSynthesis += tokens
      }
    }
  }

  // Content stays in memory: the last user prompt only decides whether the
  // next step is review-like. Records keep the boolean.
  let reviewIntent = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.info?.role ?? messages[index]?.role ?? ""
    if (role !== "user") continue
    const parts = messages[index]?.parts ?? []
    const text = parts
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join(" ")
    reviewIntent = REVIEW_WORDS.test(text)
    break
  }

  const total = toolTokens + textTokens
  return {
    contextTokens: Math.max(0, Number(measuredTokens) || 0),
    previousTokens: Math.max(0, Number(previousTokens) || 0),
    growth: Math.max(0, (Number(measuredTokens) || 0) - (Number(previousTokens) || 0)),
    toolShare: total > 0 ? toolTokens / total : 0,
    tailToolRun,
    tailSynthesis,
    tailIsAssistant,
    boundary: tailIsAssistant && tailSynthesis >= s.synthesisTokens && tailToolRun >= s.toolBurst,
    reviewIntent,
  }
}

/**
 * Pure structural verdict from signals. The advisory layer (advisory.js)
 * overlays compaction economics and the flip-flop guard on top.
 */
export function scoreSignals(signals, settings = {}) {
  const s = { ...TRIGGER_DEFAULTS, ...settings }
  const { contextTokens, growth, boundary, reviewIntent, toolShare } = signals

  if (reviewIntent && boundary) {
    return { verdict: "delegate", confidence: 0.8, signals }
  }
  if (contextTokens < s.contextFloor) {
    return { verdict: "not-yet", confidence: 0.85, signals }
  }
  if (boundary && growth >= s.growthFloor) {
    const confidence = Math.min(0.9, 0.55 + 0.2 * toolShare + Math.min(0.15, growth / 100_000))
    return { verdict: "compact-now", confidence, signals }
  }
  if (boundary) {
    return { verdict: "not-yet", confidence: 0.6, signals }
  }
  if (growth >= s.growthFloor) {
    return { verdict: "uncertain", confidence: 0.5, signals }
  }
  return { verdict: "not-yet", confidence: 0.7, signals }
}
