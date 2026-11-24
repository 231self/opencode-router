import fs from "node:fs"
import path from "node:path"

import { stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"
import { normalizeModelName } from "@231self/opencode-shared/price-table.js"

export { normalizeModelName }

const DATASETS_SERVER = "https://datasets-server.huggingface.co/rows"
const DEFAULT_DATASET = "lmarena-ai/leaderboard-dataset"
const DEFAULT_CONFIG = "webdev"
const DEFAULT_SPLIT = "latest"
const PAGE_SIZE = 100
const MAX_PAGES = 50
const DEFAULT_SOURCES = ["epoch", "lmarena"]
const MIN_QUALITY = 0.35
const MAX_QUALITY = 0.97

export function qualityCachePath(env = process.env) {
  return env.OMLX_ROUTER_QUALITY_CACHE || path.join(stateRoot(env), "quality.json")
}

/** Catalog keys to try for one model: label, id, and display name. */
export function modelKeys(model) {
  const id = model?.id ?? model?.modelID
  const label = model?.providerID && id ? `${model.providerID}/${id}` : ""
  return [...new Set([label, id, model?.name].map(normalizeModelName).filter(Boolean))]
}

export function qualityForModel(scores, model) {
  if (!scores) return null
  for (const key of modelKeys(model)) {
    if (scores[key]) return scores[key]
  }
  return null
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

/** Minimal RFC 4180 parser; the Epoch downloads contain quoted commas. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  const input = String(text ?? "").replace(/^\uFEFF/, "")
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ",") {
      row.push(field)
      field = ""
    } else if (character === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (character !== "\r") {
      field += character
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const header = rows.shift() ?? []
  return rows
    .filter((entry) => entry.some((value) => value !== ""))
    .map((entry) => Object.fromEntries(header.map((name, index) => [name, entry[index] ?? ""])))
}

function scale(value, low, high) {
  if (!Number.isFinite(value) || !Number.isFinite(low) || !Number.isFinite(high)) return (MIN_QUALITY + MAX_QUALITY) / 2
  if (high <= low) return (MIN_QUALITY + MAX_QUALITY) / 2
  const ratio = Math.max(0, Math.min(1, (value - low) / (high - low)))
  return round3(MIN_QUALITY + (MAX_QUALITY - MIN_QUALITY) * ratio)
}

function scoreTable(values, source, config) {
  const entries = [...values.entries()].filter(([, value]) => Number.isFinite(value))
  const numbers = entries.map(([, value]) => value)
  const low = Math.min(...numbers)
  const high = Math.max(...numbers)
  const scores = {}
  for (const [name, value] of entries) {
    const quality = scale(value, low, high)
    const key = normalizeModelName(name)
    if (key && !scores[key]) scores[key] = { quality, raw: value, model: name, source }
  }
  return {
    source,
    config,
    fetchedAt: Date.now(),
    count: entries.length,
    scores,
  }
}

/**
 * Build LMArena scores. Rank percentile maps into the router's quality scale:
 * rank 1 -> 0.97, last -> 0.35. When a model has several variants, the best
 * rank wins.
 */
export function buildScores(rows, { source = "lmarena", config = DEFAULT_CONFIG, count } = {}) {
  const usable = (rows ?? []).filter(
    (row) =>
      row &&
      row.model_name &&
      Number.isFinite(Number(row.rank)) &&
      (!row.category || row.category === "overall"),
  )
  const total = Math.max(1, usable.length)
  const scores = {}
  for (const row of usable) {
    const key = normalizeModelName(row.model_name)
    if (!key) continue
    const rank = Number(row.rank)
    const percentile = 1 - (rank - 1) / Math.max(1, total - 1)
    const quality = round3(0.35 + 0.62 * Math.max(0, Math.min(1, percentile)))
    const current = scores[key]
    if (!current || rank < current.rank) {
      scores[key] = { quality, rank, model: row.model_name, source }
    }
  }
  return {
    source,
    config,
    fetchedAt: Date.now(),
    count: Number(count) || total,
    scores,
  }
}

function codingValues(csv) {
  const swe = new Map()
  const mirror = new Map()
  for (const row of parseCsv(csv)) {
    const task = String(row.task ?? "").toLowerCase()
    const name = row.Model || row.model || row["Display name"]
    if (!name) continue
    const bucket = task.includes("swe-bench") ? swe : task.includes("mirrorcode") ? mirror : null
    if (!bucket) continue
    let value = Number(row.mean_score)
    if (!Number.isFinite(value)) value = Number(row.best_score)
    if (!Number.isFinite(value)) value = Number(row["Best score (across scorers)"])
    if (!Number.isFinite(value)) continue
    if (value > 1) value /= 100
    bucket.set(name, Math.max(bucket.get(name) ?? 0, value))
  }
  for (const [name, value] of mirror) {
    if (!swe.has(name)) swe.set(name, value)
  }
  return swe
}

function eciValues(csv) {
  const values = new Map()
  for (const row of parseCsv(csv)) {
    const name = row.Model || row["Display name"]
    const value = Number(row.eci)
    if (name && Number.isFinite(value)) {
      values.set(name, Math.max(values.get(name) ?? -Infinity, value))
    }
  }
  return values
}

/** Build Epoch scores: SWE-bench Verified or MirrorCode first, ECI fallback. */
export function buildEpochScores({ eciCsv = "", benchmarksCsv = "" } = {}) {
  const coding = codingValues(benchmarksCsv)
  const eci = eciValues(eciCsv)
  const codingTable = scoreTable(coding, "epoch", "coding")
  const eciTable = scoreTable(eci, "epoch", "eci")
  const scores = { ...eciTable.scores }
  for (const [key, entry] of Object.entries(codingTable.scores)) {
    scores[key] = { ...entry, metric: "coding" }
  }
  return {
    source: "epoch",
    config: coding.size > 0 ? "coding+eci" : "eci",
    fetchedAt: Date.now(),
    count: eci.size,
    scores,
  }
}

export function readQualityCache(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(qualityCachePath(env), "utf8"))
    if (!raw || typeof raw !== "object" || !raw.scores) return null
    if (!raw.sources) {
      const name = raw.source ?? "lmarena"
      raw.sources = {
        [name]: {
          source: name,
          config: raw.config,
          fetchedAt: raw.fetchedAt,
          count: raw.count,
          scores: raw.scores,
        },
      }
    }
    return raw
  } catch {
    return null
  }
}

export function writeQualityCache(cache, env = process.env) {
  writeJsonAtomic(qualityCachePath(env), cache)
  return cache
}

export function qualityCacheAgeMs(cache, now = Date.now()) {
  return cache?.fetchedAt ? Math.max(0, now - Number(cache.fetchedAt)) : null
}

export function qualitySource(config) {
  const source = config?.quality?.source ?? "auto"
  return ["manual", "lmarena", "epoch", "auto"].includes(source) ? source : "auto"
}

export function sourceOrder(config) {
  const source = qualitySource(config)
  if (source === "manual") return []
  if (source !== "auto") return [source]
  const configured = config?.quality?.sources
  const list = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_SOURCES
  return [...new Set(list.filter((entry) => entry === "epoch" || entry === "lmarena"))]
}

export function mergeQualitySources(sources, order) {
  const scores = {}
  for (const name of order) {
    for (const [key, entry] of Object.entries(sources?.[name]?.scores ?? {})) {
      if (!scores[key]) scores[key] = { ...entry, source: name }
    }
  }
  return scores
}

function datasetSettings(config) {
  const quality = config?.quality ?? {}
  return {
    dataset: quality.lmarena?.dataset ?? DEFAULT_DATASET,
    config: quality.lmarena?.config ?? quality.category ?? DEFAULT_CONFIG,
    split: quality.lmarena?.split ?? DEFAULT_SPLIT,
    timeoutMs: Math.max(1000, Number(quality.timeoutMs) || 20_000),
  }
}

async function fetchJson(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`LMArena rows returned HTTP ${response.status}`)
  const body = await response.json().catch(() => null)
  if (!body) throw new Error("LMArena rows returned invalid JSON")
  return body
}

async function fetchText(url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}

async function refreshLmarena(config, fetchImpl) {
  const settings = datasetSettings(config)
  const rows = []
  let total = null
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url =
      `${DATASETS_SERVER}?dataset=${encodeURIComponent(settings.dataset)}` +
      `&config=${encodeURIComponent(settings.config)}` +
      `&split=${encodeURIComponent(settings.split)}` +
      `&offset=${offset}&length=${PAGE_SIZE}`
    const body = await fetchJson(url, settings.timeoutMs, fetchImpl)
    const pageRows = (body.rows ?? []).map((entry) => entry?.row).filter(Boolean)
    rows.push(...pageRows)
    total = Number(body.num_rows_total) || total
    offset += pageRows.length
    if (pageRows.length === 0 || (total !== null && offset >= total)) break
  }
  if (rows.length === 0) throw new Error("LMArena returned no rows")
  return buildScores(rows, {
    source: "lmarena",
    config: settings.config,
    count: total ?? rows.length,
  })
}

async function refreshEpoch(config, fetchImpl) {
  const quality = config?.quality ?? {}
  const timeoutMs = Math.max(1000, Number(quality.timeoutMs) || 20_000)
  const eciURL = quality.epoch?.eciURL ?? "https://epoch.ai/data/eci_scores.csv"
  const benchmarksURL = quality.epoch?.benchmarksURL ?? "https://epoch.ai/data/benchmarks.csv"
  const eciCsv = await fetchText(eciURL, timeoutMs, fetchImpl)
  let benchmarksCsv = ""
  if (quality.epoch?.coding !== false) {
    try {
      benchmarksCsv = await fetchText(benchmarksURL, timeoutMs, fetchImpl)
    } catch {
      // The coding table is optional; ECI alone is still useful.
      benchmarksCsv = ""
    }
  }
  const built = buildEpochScores({ eciCsv, benchmarksCsv })
  if (Object.keys(built.scores).length === 0) throw new Error("Epoch returned no scores")
  return built
}

/** Fetch enabled sources and store a merged, priority-ordered score table. */
export async function refreshQuality({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const order = sourceOrder(config)
  if (order.length === 0) {
    throw new Error("quality.source is manual; set it to auto, lmarena, or epoch to refresh")
  }
  const previous = readQualityCache(env)
  const sources = { ...(previous?.sources ?? {}) }
  const errors = []
  let succeeded = 0

  for (const name of order) {
    try {
      sources[name] = name === "epoch" ? await refreshEpoch(config, fetchImpl) : await refreshLmarena(config, fetchImpl)
      succeeded += 1
    } catch (error) {
      errors.push(`${name}: ${error?.message ?? error}`)
    }
  }

  if (succeeded === 0 && Object.keys(sources).length === 0) {
    throw new Error(`quality refresh failed (${errors.join("; ")})`)
  }
  const scores = mergeQualitySources(sources, order)
  if (Object.keys(scores).length === 0) {
    throw new Error(`quality refresh produced no scores (${errors.join("; ")})`)
  }
  const cache = {
    source: qualitySource(config),
    fetchedAt: Date.now(),
    sources,
    scores,
    count: Object.keys(scores).length,
  }
  return writeQualityCache(cache, env)
}

export function qualityIsStale(config, cache, now = Date.now()) {
  if (!cache) return true
  const hours = Number(config?.quality?.refreshHours)
  const ttl = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000
  return now - Number(cache.fetchedAt ?? 0) > ttl
}

/** Refresh only when the source is enabled and the cache is stale. */
export async function refreshQualityIfStale({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (qualitySource(config) === "manual") return null
  const cache = readQualityCache(env)
  if (!qualityIsStale(config, cache)) return cache
  return refreshQuality({ config, env, fetchImpl })
}

/** Scores for routing: null when the source is manual or no cache exists. */
export function loadQualityScores({ config, env = process.env } = {}) {
  if (qualitySource(config) === "manual") return null
  const cache = readQualityCache(env)
  if (!cache) return null
  return mergeQualitySources(cache.sources ?? {}, sourceOrder(config))
}

export { DEFAULT_CONFIG as DEFAULT_LMARENA_CONFIG, DEFAULT_DATASET }
