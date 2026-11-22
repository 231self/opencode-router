import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveSecret } from "@231self/opencode-shared/config.js"
import { facts, join, prose } from "@231self/opencode-shared/format.js"
import { paramBillions } from "@231self/opencode-shared/judge-client.js"

export const DEFAULT_JUDGE_REPO = "mlx-community/Qwen3-4B-Instruct-2507-4bit"

export class ProvisionError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message)
    this.name = "ProvisionError"
    this.status = status
    this.detail = detail
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Derive the admin base URL from `judge.baseURL` (`/v1` is stripped). */
export function adminBase(config) {
  const raw = String(config?.judge?.baseURL ?? "http://127.0.0.1:1234/v1")
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProvisionError(`invalid judge.baseURL: ${raw}`)
  }
  let pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3)
  if (!pathname.endsWith("/admin")) pathname = `${pathname}/admin`
  url.pathname = pathname || "/admin"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

/**
 * The oMLX admin API needs the main API key. Resolution order:
 * configured/env key, then the local oMLX settings file when allowed.
 */
export function adminKey(config, env = process.env) {
  const provision = config?.judge?.provision ?? {}
  const configured = resolveSecret(provision.adminApiKey, env)
  if (configured) return { key: configured, source: "config" }

  if (provision.readSettingsKey !== false) {
    const file = env.OMLX_ROUTER_OMLX_SETTINGS || path.join(os.homedir(), ".omlx", "settings.json")
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf8"))
      const key = settings?.auth?.api_key
      if (key) return { key, source: "settings" }
    } catch {
      // fall through to the error below
    }
  }

  throw new ProvisionError(
    "no oMLX admin API key: set judge.provision.adminApiKey or OMLX_ADMIN_API_KEY " +
      "(sub-keys cannot administer downloads), or allow reading ~/.omlx/settings.json",
  )
}

async function detailOf(response) {
  try {
    const body = await response.json()
    return body?.detail ?? body?.error ?? JSON.stringify(body)
  } catch {
    return response.statusText
  }
}

/**
 * Decide whether judge downloads can be managed through the configured
 * endpoint. Downloads use the oMLX admin API; any other OpenAI-compatible
 * server (for example llama.cpp) exposes only `/v1`.
 */
export async function detectProvisioning({ config, fetchImpl = globalThis.fetch } = {}) {
  const provision = config?.judge?.provision ?? {}
  const backend = provision.backend ?? "auto"
  if (backend === "none") {
    return { supported: false, backend: "none", reason: "judge.provision.backend is none" }
  }
  if (backend === "omlx") return { supported: true, backend: "omlx" }

  let response
  try {
    response = await fetchImpl(`${adminBase(config)}/api/hf/tasks`, { method: "GET" })
  } catch (error) {
    return { supported: false, backend: "openai-compatible", reason: String(error?.message ?? error) }
  }
  // A 401/403 still proves the oMLX admin API exists; 404 means the endpoint
  // only speaks the OpenAI-compatible API.
  if (response.status === 404) {
    return { supported: false, backend: "openai-compatible", reason: "no oMLX admin API at this endpoint" }
  }
  return { supported: true, backend: "omlx" }
}

/** Explain how to get a judge without the oMLX download helper. */
export function provisionHint(config) {
  const base = String(config?.judge?.baseURL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, "")
  return join(
    prose(
      "Judge downloads use the oMLX admin API, which this endpoint does not expose.",
      "Any OpenAI-compatible endpoint works as a judge; only the download helper is oMLX-specific.",
    ),
    [
      "llama.cpp",
      "  llama-server -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf --port 8080",
      "  opencode-model-router config set judge.baseURL http://127.0.0.1:8080/v1",
      "  opencode-model-router config set judge.model auto",
    ],
    facts([["endpoint", base]]),
  )
}

export class Provisioner {
  constructor({ config, env = process.env, fetchImpl = globalThis.fetch, sleep } = {}) {
    this.config = config
    this.env = env
    this.fetchImpl = fetchImpl
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.cookieValue = null
  }

  provision() {
    return this.config?.judge?.provision ?? {}
  }

  defaultRepo() {
    return this.provision().repo || DEFAULT_JUDGE_REPO
  }

  allowNonMlx() {
    return this.provision().allowNonMlx === true
  }

  async cookie() {
    if (this.cookieValue) return this.cookieValue
    const { key } = adminKey(this.config, this.env)
    let response
    try {
      response = await this.fetchImpl(`${adminBase(this.config)}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      })
    } catch (error) {
      throw new ProvisionError(`cannot reach oMLX admin API: ${error?.message ?? error}`)
    }
    if (!response.ok) {
      const detail = await detailOf(response)
      throw new ProvisionError(
        `oMLX admin login failed (HTTP ${response.status}): ${detail}. Use the main API key, not a sub-key.`,
        { status: response.status, detail },
      )
    }
    const raw = response.headers.get("set-cookie") ?? ""
    const match = raw.match(/omlx_admin_session=([^;]+)/)
    if (!match) throw new ProvisionError("oMLX admin login did not return a session cookie")
    this.cookieValue = `omlx_admin_session=${match[1]}`
    return this.cookieValue
  }

  async request(pathname, init = {}, { auth = true, retry = true } = {}) {
    const headers = { "content-type": "application/json", ...(init.headers ?? {}) }
    if (auth) headers.cookie = await this.cookie()
    let response
    try {
      response = await this.fetchImpl(`${adminBase(this.config)}${pathname}`, { ...init, headers })
    } catch (error) {
      throw new ProvisionError(`oMLX admin request failed: ${error?.message ?? error}`)
    }
    if (auth && response.status === 401 && retry) {
      this.cookieValue = null
      return this.request(pathname, init, { auth, retry: false })
    }
    return response
  }

  async json(pathname, init) {
    const response = await this.request(pathname, init)
    if (!response.ok) {
      const detail = await detailOf(response)
      throw new ProvisionError(`oMLX ${pathname} returned HTTP ${response.status}: ${detail}`, {
        status: response.status,
        detail,
      })
    }
    return response.json()
  }

  async modelInfo(repo) {
    const target = validateRepo(repo)
    return this.json(`/api/hf/model-info?repo_id=${encodeURIComponent(target)}`)
  }

  async tasks() {
    const body = await this.json("/api/hf/tasks")
    return Array.isArray(body?.tasks) ? body.tasks : []
  }

  async startDownload(repo) {
    const target = validateRepo(repo)
    const hfToken = resolveSecret(this.provision().hfToken, this.env) ?? ""
    const body = await this.json("/api/hf/download", {
      method: "POST",
      body: JSON.stringify({ repo_id: target, hf_token: hfToken }),
    })
    if (!body?.task?.task_id) throw new ProvisionError("oMLX did not return a download task")
    return body.task
  }

  async cancel(taskId) {
    await this.json(`/api/hf/cancel/${encodeURIComponent(taskId)}`, { method: "POST" })
    return true
  }

  async waitFor(taskId, { onProgress, intervalMs = 1500, timeoutMs = 45 * 60 * 1000 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const task = (await this.tasks()).find((entry) => entry.task_id === taskId)
      if (!task) throw new ProvisionError(`download task ${taskId} disappeared`)
      onProgress?.(task)
      if (["completed", "failed", "cancelled"].includes(task.status)) return task
      if (Date.now() > deadline) throw new ProvisionError(`download ${taskId} timed out`)
      await this.sleep(intervalMs)
    }
  }
}

export function validateRepo(repo) {
  const value = String(repo ?? "").trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new ProvisionError(`invalid Hugging Face repo: "${value}" (expected owner/model)`)
  }
  const segments = value.split("/")
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        segment.endsWith("."),
    )
  ) {
    throw new ProvisionError(`invalid Hugging Face repo: "${value}" (dot segments are not allowed)`)
  }
  return value
}

export function summariseModelInfo(info, { repo } = {}) {
  const files = Array.isArray(info?.files) ? info.files : []
  const weights = files.filter((file) => String(file?.name ?? "").endsWith(".safetensors"))
  const weightsBytes = weights.reduce((total, file) => total + (Number(file.size) || 0), 0)
  const sizeBytes = files.reduce((total, file) => total + (Number(file.size) || 0), 0)
  const tags = Array.isArray(info?.tags) ? info.tags : []
  const hasConfig = files.some((file) => String(file?.name ?? "") === "config.json")
  const mlx = tags.includes("mlx") || (hasConfig && weights.length > 0)
  const license = tags.find((tag) => String(tag).startsWith("license:"))?.slice(8) ?? "unknown"
  const target = info?.repo_id ?? repo ?? ""
  return {
    repo: target,
    name: info?.name ?? target,
    params: info?.params_formatted ?? "",
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
    weightsBytes,
    weightsFormatted: formatBytes(weightsBytes),
    license,
    tags,
    mlx,
  }
}

/**
 * Ask for consent, then start the download. This is the only code path that
 * starts a pull; it never runs without an explicit `confirm` result.
 */
export async function confirmThenPull({ provision, repo, confirm, onStart }) {
  const target = validateRepo(repo ?? provision.defaultRepo())
  const info = await provision.modelInfo(target)
  const summary = summariseModelInfo(info, { repo: target })
  if (!summary.mlx && !provision.allowNonMlx()) {
    throw new ProvisionError(
      `${target} does not look like an MLX model (missing the mlx tag or safetensors+config.json); ` +
        "set judge.provision.allowNonMlx to override",
    )
  }
  const approved = await confirm(summary)
  if (!approved) return { approved: false, summary }
  onStart?.(summary)
  const task = await provision.startDownload(target)
  return { approved: true, summary, task }
}

/** Check whether a usable judge model is already exposed by oMLX. */
export async function judgeAvailability({ config, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(config?.judge?.baseURL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, "")
  const key = resolveSecret(config?.judge?.apiKey, env)
  let response
  try {
    response = await fetchImpl(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })
  } catch (error) {
    return { available: false, suitable: false, selected: null, models: [], error: String(error?.message ?? error) }
  }
  if (!response.ok) {
    return { available: false, suitable: false, selected: null, models: [], error: `HTTP ${response.status}` }
  }
  const body = await response.json().catch(() => null)
  const models = (body?.data ?? []).map((model) => model?.id).filter(Boolean)
  const configured = config?.judge?.model
  let selected = null
  if (configured && configured !== "auto") {
    selected = models.includes(configured) ? configured : null
  } else {
    let bestSize = null
    for (const id of models) {
      const size = paramBillions(id)
      if (size === null) continue
      if (bestSize === null || size < bestSize) {
        selected = id
        bestSize = size
      }
    }
    if (!selected && models.length > 0) selected = models[0]
  }
  const size = selected ? paramBillions(selected) : null
  const suitable =
    selected !== null && (configured && configured !== "auto" ? true : size === null ? true : size <= 8)
  return { available: selected !== null, suitable, selected, models, error: null }
}
