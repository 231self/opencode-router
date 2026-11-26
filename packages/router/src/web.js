/**
 * The dashboard's local web server: `127.0.0.1` only, started on demand by
 * `/router web`. Serves the static page and the JSON API built by
 * `web-data.js` from state the plugin already holds.
 *
 * Two rules are structural, not settings:
 *
 * - The bind address is loopback and not configurable. That line is the
 *   wall between this dashboard and any future hosted service.
 * - Every response comes from the builders' allow-list projection, and a
 *   request path never reaches the filesystem: the asset map is an
 *   allow-list of exact file names.
 *
 * A failing builder answers `503` and nothing else — the dashboard must
 * never take the turn path down with it.
 */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildDecisions,
  buildModels,
  buildPlans,
  buildSummary,
  buildTrends,
} from "./web-data.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.join(HERE, "..", "web")

/** The only address the server binds. Not configurable, on purpose. */
const LOOPBACK = "127.0.0.1"
const DEFAULT_PORT = 7410

/** The asset allow-list: exact request paths to exact files. */
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
])

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(body))
}

/** The one JSON payload for a request, or null for an unknown route. */
async function apiPayload(url, data, session, now) {
  const scope = url.searchParams.get("scope") === "session" ? "session" : "all"
  const source = await Promise.resolve(data())
  const limit = url.searchParams.get("limit") ?? undefined
  const days = url.searchParams.get("days") ?? undefined
  switch (url.pathname) {
    case "/api/summary.json":
      return buildSummary({ ...source, scope, session, now })
    case "/api/models.json":
      return buildModels({ ...source, scope, session })
    case "/api/plans.json":
      return buildPlans({ ...source, now })
    case "/api/trends.json":
      return buildTrends({ ...source, scope, session, days, bucket: url.searchParams.get("bucket") ?? undefined, now })
    case "/api/decisions.json":
      return buildDecisions({ ...source, scope, session, limit })
    default:
      return null
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve(server.address().port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, LOOPBACK)
  })
}

/**
 * Start one dashboard server and return `{ url, port, close }`. `data` is a
 * supplier (sync or async) for the state inputs the builders take;
 * `session` is the launching session hash and fixes `scope=session`.
 *
 * A busy configured port falls back to an ephemeral one and the returned
 * URL reports where it actually landed.
 */
export async function startWebServer({
  config = {},
  data = () => ({}),
  session = null,
  now = () => Date.now(),
} = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        sendJson(res, 503, { error: String(error?.message ?? "internal error").slice(0, 200) })
      } catch {
        // The socket is already gone; there is nothing left to answer.
      }
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`)
    if (url.pathname.startsWith("/api/")) {
      const payload = await apiPayload(url, data, session, now())
      if (!payload) return sendJson(res, 404, { error: "not found" })
      return sendJson(res, 200, payload)
    }
    const asset = ASSETS.get(url.pathname)
    if (!asset) return sendJson(res, 404, { error: "not found" })
    const [file, type] = asset
    const body = await fs.promises.readFile(path.join(WEB_ROOT, file))
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" })
    res.end(body)
  }

  const wanted = Number(config?.web?.port)
  const port = Number.isInteger(wanted) && wanted >= 0 ? wanted : DEFAULT_PORT
  let bound
  try {
    bound = await listen(server, port)
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error
    bound = await listen(server, 0)
  }

  return {
    url: `http://${LOOPBACK}:${bound}`,
    port: bound,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** One dashboard per process: `/router web` twice reports, it does not double-bind. */
let running = null

export async function startDashboard(options) {
  if (!running) running = await startWebServer(options)
  return running
}

export async function stopDashboard() {
  const server = running
  running = null
  if (server) await server.close()
  return Boolean(server)
}

export function dashboardServer() {
  return running
}
