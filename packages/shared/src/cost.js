/**
 * Cost shapes seen in the wild:
 * - `[{ input, output, cache: { read, write }, tier? }]` — OpenCode V2 catalog
 * - `{ input, output, cache_read, cache_write, tiers?, context_over_200k? }` — models.dev
 * - `{ text: { input: { price, cache, overrides }, output: { price, overrides } } }` — V2 client
 * - `{ input: { price }, output: { price } }` — models.dev v1 style
 *
 * Missing prices stay `undefined` so a display can say "unknown" instead of
 * inventing `$0`, and a real zero still reads as free.
 */
import { cacheHitShare } from "./tokens.js"

function price(value) {
  if (value == null || value === "") return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value === "object") {
    if ("price" in value) return price(value.price)
    if ("value" in value) return price(value.value)
    return undefined
  }
  return undefined
}

function tierDefinition(entry) {
  const tier = entry?.tier
  if (tier && typeof tier === "object") {
    const size = Number(tier.size)
    return Number.isFinite(size) && size > 0 ? { type: tier.type ?? "context", size } : null
  }
  // V2 client overrides use `when: { context: { gt: size } }`.
  const threshold = Number(entry?.when?.context?.gt)
  return Number.isFinite(threshold) && threshold > 0 ? { type: "context", size: threshold } : null
}

/**
 * Keep a real zero (a genuinely free field) but treat a zero as "the source
 * had no price" when an external table does have one.
 */
function fill(value, fallback) {
  if (fallback === undefined || fallback === null) return value
  if (value === undefined) return fallback
  if (value === 0 && fallback !== 0) return fallback
  return value
}

function toTier({ input, output, read, write, definition }) {
  return {
    ...(definition ? { tier: definition } : {}),
    input,
    output,
    cache: { read, write },
  }
}

/**
 * Overrides carry either `input`/`output` (models.dev) or a bare `price`
 * (V2 client), so the caller says which side of the bill the override belongs
 * to. They are merged by context size into one tier per size.
 */
function applyOverrides(tiers, overrides) {
  const bySize = new Map()
  for (const { side, entry } of overrides) {
    if (!entry || typeof entry !== "object") continue
    const definition = tierDefinition(entry)
    if (!definition) continue
    const current =
      bySize.get(definition.size) ??
      toTier({
        definition,
        input: undefined,
        output: undefined,
        read: undefined,
        write: undefined,
      })
    const cache = entry.cache && typeof entry.cache === "object" ? entry.cache : {}
    if (side === "output") {
      current.output = price(entry.output ?? entry.price) ?? current.output
    } else {
      current.input = price(entry.input ?? entry.price) ?? current.input
      current.cache.read = price(cache.read ?? entry.cache_read) ?? current.cache.read
      current.cache.write = price(cache.write ?? entry.cache_write) ?? current.cache.write
    }
    bySize.set(definition.size, current)
  }
  tiers.push(...bySize.values())
}

/** One catalog entry may hold several tiers: base prices plus overrides. */
export function tiersOf(entry) {
  if (!entry || typeof entry !== "object") return []
  const nested = ["text", "image", "audio", "video"]
    .map((key) => entry[key])
    .filter((value) => value && typeof value === "object")
  if (nested.length > 0) return nested.flatMap((value) => tiersOf(value))

  const input = entry.input
  const output = entry.output
  const inputObject = input && typeof input === "object" ? input : null
  const outputObject = output && typeof output === "object" ? output : null
  const cache = entry.cache && typeof entry.cache === "object" ? entry.cache : {}

  const tiers = [
    toTier({
      definition: tierDefinition(entry),
      input: price(inputObject ? inputObject.price ?? inputObject.input : input),
      output: price(outputObject ? outputObject.price ?? outputObject.output : output),
      read: price(
        cache.read ??
          entry.cache_read ??
          inputObject?.cache?.read ??
          inputObject?.cache_read,
      ),
      write: price(
        cache.write ??
          entry.cache_write ??
          inputObject?.cache?.write ??
          inputObject?.cache_write,
      ),
    }),
  ]

  const overrides = []
  for (const value of inputObject?.overrides ?? []) overrides.push({ side: "input", entry: value })
  for (const value of outputObject?.overrides ?? []) overrides.push({ side: "output", entry: value })
  applyOverrides(tiers, overrides)

  // models.dev long-context entries are complete price tables, not partial
  // overrides, so they are parsed as tiers of their own.
  for (const value of entry.tiers ?? []) tiers.push(...tiersOf(value))

  return tiers
}

/** Normalise any supported cost shape into catalog tier arrays. */
export function normaliseCost(cost) {
  if (cost == null) return []
  const tiers = []
  if (Array.isArray(cost)) {
    for (const entry of cost) tiers.push(...tiersOf(entry))
  } else if (typeof cost === "object") {
    tiers.push(...tiersOf(cost))
    // models.dev keeps long-context prices in separate fields.
    if (cost.context_over_200k && typeof cost.context_over_200k === "object") {
      tiers.push(
        ...tiersOf({ ...cost.context_over_200k, tier: { type: "context", size: 200000 } }),
      )
    }
  }
  const seen = new Set()
  return tiers.filter((tier) => {
    const key = JSON.stringify(tier)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Where a pool model's displayed prices came from: the host catalog, the
 * models.dev fallback, or nowhere.
 */
export function costSource(catalogTiers, fallbackTiers) {
  const hasPrice = (tiers) =>
    (tiers ?? []).some((tier) => Number(tier?.input) > 0 || Number(tier?.output) > 0)
  const isDefined = (tiers) =>
    (tiers ?? []).some((tier) => tier?.input !== undefined || tier?.output !== undefined)
  if (hasPrice(catalogTiers)) return "catalog"
  if (hasPrice(fallbackTiers)) return "modelsdev"
  if (isDefined(catalogTiers)) return "catalog"
  return "unknown"
}

export function mergeCost(tiers, fallback) {
  const base = Array.isArray(tiers) && tiers.length > 0 ? tiers : []
  if (!Array.isArray(fallback) || fallback.length === 0) return base
  if (base.length === 0) return fallback
  const [first, ...rest] = base
  const external = fallback[0] ?? {}
  return [
    {
      ...first,
      input: fill(first.input, external.input),
      output: fill(first.output, external.output),
      cache: {
        read: fill(first.cache?.read, external.cache?.read),
        write: fill(first.cache?.write, external.cache?.write),
      },
      ...(first.tier ? { tier: first.tier } : {}),
    },
    ...rest,
  ]
}

/**
 * Modelled cost of one turn at per-million-token prices.
 *
 * The stable prefix (what the provider's prompt cache can serve) is charged at
 * `cacheHitRatio` of `prefixTokens` and the cache-read price; the remainder at
 * the input price; output tokens at the output price. A turn that switches
 * models passes `prefixTokens: 0` (cold prefill).
 */
export function modelledTurnCost({
  price: tier,
  inputTokens,
  prefixTokens = 0,
  cacheHitRatio = 0,
  outputTokens = 0,
}) {
  const ratio = Math.min(1, Math.max(0, Number(cacheHitRatio) || 0))
  const cached = Math.min(inputTokens, Math.max(0, Number(prefixTokens) || 0)) * ratio
  const fresh = inputTokens - cached
  return (
    (fresh / 1_000_000) * (tier?.input ?? 0) +
    (cached / 1_000_000) * (tier?.cache?.read ?? 0) +
    (outputTokens / 1_000_000) * (tier?.output ?? 0)
  )
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * Projected cost of carrying the current context forward.
 *
 * `contextTokens` is the projected per-turn prefill and `prefixTokens` its
 * stable, cacheable part. Each future turn re-pays that prefix — mostly
 * `cache.read`, plus input price on the drift share (the part of the prefix
 * the cache no longer serves). `perTurnDelta` is that per-turn carrying cost
 * of the accumulated context alone; `projectedCost` is the full cost of the
 * next `projectedTurns` turns at the current context ("keeping this context
 * costs $X over the next N turns"). Missing prices read as 0.
 */
export function contextDebt({
  price: tier,
  contextTokens,
  prefixTokens = 0,
  cacheHitRatio = 0,
  outputTokens = 0,
  projectedTurns = 0,
}) {
  const context = count(contextTokens)
  const prefix = Math.min(context, count(prefixTokens))
  const ratio = Math.min(1, Math.max(0, Number(cacheHitRatio) || 0))
  const cached = prefix * ratio
  const misses = prefix - cached
  const perTurnDelta =
    (cached / 1_000_000) * (tier?.cache?.read ?? 0) + (misses / 1_000_000) * (tier?.input ?? 0)
  const perTurn = modelledTurnCost({
    price: tier,
    inputTokens: context,
    prefixTokens: prefix,
    cacheHitRatio: ratio,
    outputTokens: count(outputTokens),
  })
  return { perTurnDelta, projectedCost: perTurn * count(projectedTurns) }
}

/**
 * When does compaction pay for itself under cache-billed pricing?
 *
 * `contextTokens` / `compactedTokens` are the projected next-turn prefill
 * before and after compaction; `cacheHitRatio` is the measured share of the
 * prefix the cache serves (falling back to `cacheState` — the last turn's
 * recorded usage in `{ input, cache: { read, write } }` shape — when not
 * given).
 *
 * - `perTurnSavings` = modelled turn cost at `contextTokens` minus the same
 *   turn at `compactedTokens`: compaction removes the prefix re-payment.
 * - `invalidationCost` = the one-time premium: the summary request plus the
 *   first post-compaction turn's input-side rebuild cost, against a steady
 *   compacted turn. `rebuildCost` overrides the modelled rebuild when the
 *   host reported it; `summaryCost` is added either way. Output tokens are
 *   excluded from the rebuild side because they are a normal turn cost, not
 *   a compaction cost.
 * - `breakEvenTurns` = `ceil(invalidationCost / perTurnSavings)` — 0 when
 *   savings are immediate, `Infinity` when compaction never pays.
 * - `worthIt` = `breakEvenTurns <= expectedTurns`.
 *
 * Missing prices read as 0; counts are clamped to finite, non-negative values.
 */
/** The tier that applies at `tokens`: the largest matching size, else base. */
export function tierAt(tiers, tokens) {
  const list = tiers ?? []
  let chosen = null
  for (const tier of list) {
    if (!tier?.tier) {
      if (!chosen) chosen = tier
      continue
    }
    const size = Number(tier.tier.size)
    if (!Number.isFinite(size) || size > tokens) continue
    if (!chosen?.tier || size > Number(chosen.tier.size)) chosen = tier
  }
  return chosen ?? list[0] ?? null
}

export function compactionRoi({
  price: tier,
  contextTokens,
  compactedTokens,
  cacheState,
  cacheHitRatio,
  outputTokens = 0,
  expectedTurns = 0,
  summaryCost = 0,
  rebuildCost = null,
  keepCost = null,
  steadyCost = null,
  firstTurnCost = null,
}) {
  const context = count(contextTokens)
  const compacted = count(compactedTokens)
  const derived = cacheHitRatio == null && cacheState ? cacheHitShare(cacheState) : 0
  const ratio = Math.min(1, Math.max(0, Number(cacheHitRatio ?? derived) || 0))
  const output = count(outputTokens)
  const keep =
    keepCost != null
      ? Number(keepCost) || 0
      : modelledTurnCost({
          price: tier,
          inputTokens: context,
          prefixTokens: context,
          cacheHitRatio: ratio,
          outputTokens: output,
        })
  const steady =
    steadyCost != null
      ? Number(steadyCost) || 0
      : modelledTurnCost({
          price: tier,
          inputTokens: compacted,
          prefixTokens: compacted,
          cacheHitRatio: ratio,
          outputTokens: output,
        })
  const perTurnSavings = keep - steady
  const writePrice = tier?.cache?.write ?? tier?.input ?? 0
  const firstTurn =
    firstTurnCost != null
      ? Number(firstTurnCost) || 0
      : (compacted / 1_000_000) * writePrice + (output / 1_000_000) * (tier?.output ?? 0)
  // Measured rebuild is input-side only; compare it with an input-only steady
  // turn so a normal turn's output never leaks into the compaction premium.
  const steadyInput =
    steadyCost != null
      ? Number(steadyCost) || 0
      : modelledTurnCost({
          price: tier,
          inputTokens: compacted,
          prefixTokens: compacted,
          cacheHitRatio: ratio,
          outputTokens: 0,
        })
  const measuredRebuild = Number(rebuildCost)
  const measured = rebuildCost != null && Number.isFinite(measuredRebuild) && measuredRebuild >= 0
  const premium = measured ? measuredRebuild - steadyInput : firstTurn - steady
  const invalidationCost = premium + (Number(summaryCost) || 0)
  const breakEvenTurns =
    perTurnSavings > 0
      ? Math.ceil(Math.max(0, invalidationCost) / perTurnSavings)
      : invalidationCost <= 0
        ? 0
        : Infinity
  return {
    perTurnSavings,
    invalidationCost,
    breakEvenTurns,
    worthIt: perTurnSavings > 0 && breakEvenTurns <= count(expectedTurns),
    summaryCost: Number(summaryCost) || 0,
    rebuildCost: measured ? measuredRebuild : null,
  }
}
