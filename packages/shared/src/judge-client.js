import { resolveSecret } from "./config.js"

export class JudgeError extends Error {
  constructor(message) {
    super(message)
    this.name = "JudgeError"
  }
}

export function paramBillions(label) {
  const text = String(label)
  let best = null
  const pattern = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[1])
    if (Number.isFinite(value)) best = best === null ? value : Math.max(best, value)
  }
  return best
}

/** Extract the first balanced JSON object from judge output, fences and all. */
export function extractJson(text) {
  const value = String(text ?? "").trim()
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : value
  const start = body.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const character = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

export function messageText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("")
  }
  return ""
}

/**
 * oMLX judge client: model discovery, JSON-only chat, LRU cache, timeouts.
 * Reused by the router (routing verdicts) and the compaction plugin
 * (compaction rubric); each caller supplies its own system message and
 * validates its own verdict shape.
 */
export class JudgeClient {
  constructor({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? {}
    this.env = env
    this.fetchImpl = fetchImpl
    this.cache = new Map()
    this.models = null
    this.modelsAt = 0
    this.selected = null
  }

  configure(config) {
    this.config = config ?? this.config
    if (this.selected && this.config.model !== "auto" && this.selected !== this.config.model) {
      this.selected = null
      this.models = null
      this.modelsAt = 0
    }
  }

  baseURL() {
    return String(this.config.baseURL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, "")
  }

  headers() {
    const key = resolveSecret(this.config.apiKey, this.env)
    return {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    }
  }

  async request(path, init = {}) {
    const controller = new AbortController()
    const timeout = Math.max(250, Number(this.config.timeoutMs) || 1500)
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      return await this.fetchImpl(`${this.baseURL()}${path}`, { ...init, headers: this.headers(), signal: controller.signal })
    } catch (error) {
      throw new JudgeError(controller.signal.aborted ? `judge timeout after ${timeout} ms` : `judge request failed: ${error.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async listModels() {
    const now = Date.now()
    if (this.models && now - this.modelsAt < 60_000) return this.models
    const response = await this.request("/models")
    if (!response.ok) throw new JudgeError(`judge /models returned HTTP ${response.status}`)
    const body = await response.json().catch(() => null)
    const models = (body?.data ?? []).map((model) => model?.id).filter(Boolean)
    if (models.length === 0) throw new JudgeError("judge /models returned no models")
    this.models = models
    this.modelsAt = now
    return models
  }

  async pickModel() {
    const configured = this.config.model
    if (configured && configured !== "auto") return configured
    const models = await this.listModels()
    let best = models[0]
    let bestSize = null
    for (const id of models) {
      const size = paramBillions(id)
      if (size === null) continue
      if (bestSize === null || size < bestSize) {
        best = id
        bestSize = size
      }
    }
    this.selected = best
    return best
  }

  getCached(key) {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (entry.expires < Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.verdict
  }

  setCached(key, verdict) {
    const size = Math.max(1, Number(this.config.cacheSize) || 128)
    const ttl = Math.max(1000, Number(this.config.cacheTtlMs) || 600_000)
    if (this.cache.size >= size) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { verdict, expires: Date.now() + ttl })
  }

  /** One JSON-only chat call. A `repair` round asks for bare JSON again. */
  async chat(prompt, { system = "Reply with JSON only, no prose.", repair = false } = {}) {
    const model = await this.pickModel()
    const base = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: repair ? `${prompt}\n\nReturn only the JSON object.` : prompt },
      ],
      temperature: 0,
      max_tokens: 220,
    }
    let response = await this.request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...base, response_format: { type: "json_object" } }),
    })
    if (response.status === 400) {
      response = await this.request("/chat/completions", {
        method: "POST",
        body: JSON.stringify(base),
      })
    }
    if (!response.ok) throw new JudgeError(`judge /chat/completions returned HTTP ${response.status}`)
    const body = await response.json().catch(() => null)
    return messageText(body?.choices?.[0]?.message?.content)
  }
}
