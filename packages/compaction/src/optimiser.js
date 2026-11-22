import { estimateTokens, partTokens } from "@231self/opencode-shared/tokens.js"

function systemTokens(system) {
  return (system ?? []).reduce((total, part) => total + partTokens(part), 0)
}

function partInput(part, index) {
  if (!part) return null
  if (part.type === "tool") {
    const state = part.state ?? {}
    if (state.status !== "completed") return null
    const text = String(state.output ?? "")
    if (!text) return null
    return {
      index,
      type: "tool",
      tool: part.tool ?? "tool",
      tokens: partTokens(part),
      text,
    }
  }
  const tokens = partTokens(part)
  if (tokens === 0) return null
  return { index, type: part.type ?? "unknown", tokens }
}

/** Build the optimise request from an OpenCode `context` hook event. */
export function buildOptimiseRequest({ model, config, system = [], messages = [] }) {
  const settings = config?.optimiser ?? {}
  const limit = {
    context: Number(model?.limit?.context) || 0,
    output: Number(model?.limit?.output) || 0,
  }
  const label = model ? `${model.providerID}/${model.id ?? model.modelID}` : ""
  const mapped = messages.map((message, index) => {
    // A completed checkpoint's summary is top-level text, not a part. Count
    // it like the shared counter so the optimiser's before/after sizes agree
    // with the rest of the plugin.
    if (message?.type === "compaction" && typeof message.summary === "string") {
      return {
        index,
        role: "compaction",
        parts: [{ index: 0, type: "text", tokens: estimateTokens(message.summary) + 16 }],
      }
    }
    return {
      index,
      role: message?.info?.role ?? message?.role ?? "",
      parts: (message?.parts ?? []).map((part, partIndex) => partInput(part, partIndex)).filter(Boolean),
    }
  })
  return {
    abi: 1,
    model: { label, limit },
    settings: {
      reserveOutputTokens: Number(settings.reserveOutputTokens) || 8192,
      safetyTokens: Number(settings.safetyTokens) || 1024,
      maxToolTokens: Number(settings.maxToolTokens) || 2000,
      keepRecentToolOutputs: Number(settings.keepRecentToolOutputs) || 3,
      keepRecentTurns: Number(settings.keepRecentTurns) || 2,
    },
    messages: mapped.filter((message) => message.parts.length > 0),
    systemTokens: systemTokens(system),
  }
}

function codePoints(text) {
  return Array.from(String(text ?? ""))
}

/** Apply a core pruning plan in place; returns the number of parts changed. */
export function applyPlan(messages, plan) {
  let applied = 0
  for (const action of plan ?? []) {
    const message = messages[action.message]
    const part = message?.parts?.[action.part]
    if (!part) continue
    const original = String(part.state?.output ?? "")
    if (action.action === "truncate") {
      const characters = codePoints(original)
      const head = characters.slice(0, Math.max(0, Number(action.headChars) || 0)).join("")
      const tail = characters.slice(-Math.max(0, Number(action.tailChars) || 0)).join("")
      part.state = { ...(part.state ?? {}), output: `${head}${action.marker ?? "\n\n[...truncated...]\n\n"}${tail}` }
      applied += 1
    } else if (action.action === "stub") {
      const characters = codePoints(original)
      const keep = Math.max(0, Number(action.keepHeadChars) || 0)
      const prefix = keep > 0 ? `${characters.slice(0, keep).join("")}\n` : ""
      part.state = {
        ...(part.state ?? {}),
        output: `${prefix}${action.placeholder ?? "[omlx-router: pruned output]"}`,
      }
      applied += 1
    }
  }
  return applied
}

export { estimateTokens }
