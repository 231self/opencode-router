/** Token estimate matching the Rust core: ASCII ~4 chars/token, CJK ~1.6. */
export function estimateTokens(text) {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const character of String(text)) {
    if (character.codePointAt(0) >= 0x2e80) wide += 1
    else ascii += 1
  }
  return Math.ceil(ascii / 4 + wide / 1.6)
}

/**
 * Prompt-visible tokens for one part: what the provider bills as prompt.
 *
 * Reasoning is regenerated rather than re-sent, and ids, timestamps and
 * snapshots are host bookkeeping, so neither belongs in a prompt size.
 */
export function promptPartTokens(part) {
  if (!part) return 0
  switch (part.type) {
    case "text":
      return estimateTokens(part.text ?? "")
    case "tool": {
      const state = part.state ?? {}
      if (state.status !== "completed") return 0
      return estimateTokens(String(state.output ?? "")) + estimateTokens(JSON.stringify(state.input ?? {}))
    }
    case "file":
    case "image":
      return 1500
    default:
      return 0
  }
}

/** Everything a part carries, reasoning included. Used to size a prune. */
export function partTokens(part) {
  if (!part) return 0
  if (part?.type === "reasoning") return estimateTokens(part.text ?? "")
  return promptPartTokens(part)
}

/** Prompt text of a message that carries fields instead of parts. */
function promptTextTokens({ text, command, output }) {
  return estimateTokens([text, command, output].filter(Boolean).join("\n"))
}

export function countContextTokens({ system, messages } = {}) {
  let total = 0
  for (const part of system ?? []) total += partTokens(part)
  for (const message of messages ?? []) {
    // A completed checkpoint carries its summary as text, not as parts.
    if (message?.type === "compaction") {
      total += estimateTokens(message.summary ?? "") + 16
      continue
    }
    const parts = message?.parts ?? message?.content
    if (typeof parts === "string") total += estimateTokens(parts)
    else if (Array.isArray(parts)) for (const part of parts) total += promptPartTokens(part)
  }
  return total
}

/**
 * Tokens for one V2 active-context message, or null when the message shape is
 * not recognized. Shared by `measureSessionContext` and the compaction tail
 * estimator so both count the same message once.
 *
 * Only prompt-visible content is counted. A message's own `native`, `snapshot`
 * and metadata fields, and a part's reasoning, are host bookkeeping: counting
 * them read a 500k-token session as 496k of context when the provider billed
 * 159k for the same turn.
 */
export function contextMessageTokens(message) {
  const { type, text, content, files, skills, command, output } = message ?? {}
  switch (type) {
    case "compaction":
      if (
        message.status !== "completed" ||
        typeof message.summary !== "string" ||
        !message.summary.trim() ||
        message.native != null
      ) {
        return null
      }
      return estimateTokens(message.summary) + 16
    case "user":
    case "synthetic":
    case "system":
    case "skill":
    case "shell":
      // Unresolved attachments can expand to an unknown size.
      if (files?.length || skills?.length) return null
      return promptTextTokens({ text, command, output }) + 16
    case "assistant": {
      if (files?.length || skills?.length) return null
      if (!Array.isArray(content)) return promptTextTokens({ text, command, output }) + 16
      let total = 16
      for (const part of content) total += promptPartTokens(part)
      return total
    }
    case "model-switched":
    case "agent-switched":
    case "location-switched":
    case "idle":
      return 0
    default:
      return null
  }
}

/** Measure a V2 active-context response without counting message metadata. */
export function measureSessionContext(response) {
  const messages = Array.isArray(response) ? response : response?.data
  if (!Array.isArray(messages)) return null
  let tokens = 0
  let checkpoint = null
  for (const message of messages) {
    const count = contextMessageTokens(message)
    if (count === null) return null
    if (message?.type === "compaction") checkpoint = message
    tokens += count
  }
  return { tokens, checkpoint }
}

/**
 * Observed cache-read share of a turn's prompt: `cache.read` over the full
 * prefill.
 *
 * Provider usage reports cached tokens apart from `input`, which covers only
 * cache misses. Verified against recorded turn costs: misses × input price +
 * hits × cache-read price + (output + reasoning) × output price reproduces the
 * host-reported cost exactly, so the denominator is `input + read + write`.
 */
export function cacheHitShare(tokens) {
  const input = Number(tokens?.input) || 0
  const read = Number(tokens?.cache?.read) || 0
  const write = Number(tokens?.cache?.write) || 0
  const prefill = input + read + write
  if (read <= 0 || prefill <= 0) return 0
  return Math.min(1, read / prefill)
}
