/**
 * Standing recorded fixtures. Values are real; do not "fix" them.
 *
 * A recorded deepseek/deepseek-v4-pro turn with its host-reported cost.
 * Provider usage reports cached tokens apart from `input`, which covers only
 * cache misses: misses × input price + hits × cache-read price + (output +
 * reasoning) × output price reproduces the recorded cost exactly ($0.028712),
 * so the cache-hit share divides hits by the full prefill.
 */
export const RECORDED_TURN = {
  input: 39357,
  output: 423,
  reasoning: 460,
  cache: { read: 44928, write: 0 },
}
export const RECORDED_PRICES = { input: 0.66, output: 1.98, cacheRead: 0.022 }
export const RECORDED_COST = 0.028712

/** The same turn as an economics input: full prefill, output incl. reasoning. */
export const RECORDED_PREFILL = RECORDED_TURN.input + RECORDED_TURN.cache.read + RECORDED_TURN.cache.write
export const RECORDED_OUTPUT = RECORDED_TURN.output + RECORDED_TURN.reasoning

/**
 * A recorded-shaped V2 active-context response with an applied compaction
 * checkpoint, as `measureSessionContext` parses it. The post-compaction
 * context is the checkpoint summary; the messages after it are the live turn.
 */
export const RECORDED_COMPACTED_SESSION = [
  { type: "compaction", status: "completed", id: "applied", summary: "Parser refactor state: plan agreed, edits pending." },
  { type: "user", text: "continue with the edits" },
  { type: "assistant", content: [{ type: "text", text: "Applying the agreed edits now." }] },
]
