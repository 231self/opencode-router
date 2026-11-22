import os from "node:os"

import { readConfig } from "@231self/opencode-shared/config.js"
import { facts, join, plural, section } from "@231self/opencode-shared/format.js"
import {
  hostStateDir,
  listPins,
  readDecisions,
  readStats,
  readTurns,
  summariseTurns,
} from "@231self/opencode-shared/state.js"
import { VERSION } from "./version.js"

/**
 * Snapshot of router state for the TUI and CLI.
 *
 * Read-only: never creates or repairs files.
 */
export function buildStatus({ host = "opencode", env = process.env, core = null } = {}) {
  const { config, path, existed, error } = readConfig({ env, write: false })

  let pins = []
  let blocked = []
  let last = null
  let stats = null
  let turns = []
  let timing = null
  let stateError = null
  try {
    pins = listPins(host, env)
    blocked = pins.flatMap((pin) =>
      (Array.isArray(pin?.blocked) ? pin.blocked : []).filter(
        (entry) => entry && Number(entry.until) > Date.now(),
      ),
    )
    last = readDecisions(host, 1, env)[0] ?? null
    stats = readStats(host, env)
    turns = readTurns(host, 50, env)
    timing = summariseTurns(turns, 20)
  } catch (cause) {
    stateError = String(cause?.message ?? cause)
  }

  return {
    name: "opencode-router",
    version: VERSION,
    host,
    enabled: Boolean(config.enabled),
    policy: config.policy,
    pool: config.pool.source,
    judge: {
      enabled: Boolean(config.judge.enabled),
      baseURL: config.judge.baseURL,
      model: config.judge.model,
    },
    configPath: path,
    configExists: existed,
    stateDir: hostStateDir(host, env),
    pins: pins.length,
    pinModels: pins.slice(0, 3).map((pin) => pin.model ?? pin.chosen ?? null).filter(Boolean),
    blocked,
    last,
    lastTurn: turns.at(-1) ?? null,
    timing,
    stats,
    core,
    error: error ?? stateError,
  }
}

export function formatMilliseconds(value) {
  const milliseconds = Number(value) || 0
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.round(milliseconds)}ms`
}

export function shortPath(value) {
  const text = String(value ?? "")
  const home = os.homedir()
  return home && text.startsWith(home) ? `~${text.slice(home.length)}` : text
}

function shortHost(value) {
  try {
    return new URL(String(value)).host
  } catch {
    return String(value ?? "")
  }
}

/** Compact status for the TUI dialog; the CLI keeps the wider format. */
export function formatTuiStatus(status) {
  const blocks = [
    `OpenCode Router ${status.version} · ${status.host}`,
    section("state", [
      [
        "routing",
        `${status.enabled ? "enabled" : "disabled"} · policy ${status.policy} · pool ${status.pool}`,
      ],
      [
        "judge",
        `${status.judge.enabled ? status.judge.model : "disabled"} · ${shortHost(status.judge.baseURL)}`,
      ],
      [
        "pins",
        `${plural(status.pins, "session")}${status.pinModels.length ? ` · ${status.pinModels.map(modelLabel).join(", ")}` : ""}`,
      ],
    ]),
  ]
  if (status.timing?.count) {
    const average = status.timing.averages
    blocks.push(
      section("timing", [
        ["judge", formatMilliseconds(average.judgeMs)],
        ["remote", formatMilliseconds(average.modelMs)],
        ["turn", formatMilliseconds(average.turnMs)],
      ]),
    )
  }
  if (status.last) {
    const rows = [
      ["model", status.last.chosen ?? "unknown"],
      ["stage", [status.last.stage, status.last.pinned ? "pinned" : null].filter(Boolean).join(" · ")],
    ]
    if (status.last.hint) rows.push(["hint", status.last.hint])
    blocks.push(section("last", rows))
  }
  blocks.push(facts([["config", shortPath(status.configPath)]]))
  if (status.error) blocks.push(facts([["warning", status.error]]))
  return join(...blocks)
}

export function formatTiming(summary) {
  if (!summary?.count) return null
  const share = (value) => `${Math.round((Number(value) || 0) * 100)}%`
  const average = summary.averages
  return section("timing", [
    ["local judge", `${formatMilliseconds(average.judgeMs)} (${share(summary.shares.judge)})`],
    ["remote model", `${formatMilliseconds(average.modelMs)} (${share(summary.shares.model)})`],
    ["tools/other", `${formatMilliseconds(average.toolMs)} (${share(summary.shares.tools)})`],
    ["turn", `${formatMilliseconds(average.turnMs)} (last ${summary.count})`],
  ]).join("\n")
}

function modelLabel(model) {
  if (!model) return "none"
  if (typeof model === "string") return model
  const variant = model.variant && model.variant !== "default" ? `#${model.variant}` : ""
  return `${model.providerID}/${model.id ?? model.modelID}${variant}`
}

export function formatStatus(status) {
  const blocks = [
    `${status.name} ${status.version} · ${status.host}`,
    section("state", [
      [
        "routing",
        `${status.enabled ? "enabled" : "disabled"} · policy ${status.policy} · pool ${status.pool}`,
      ],
      ["config", `${shortPath(status.configPath)}${status.configExists ? "" : " (not created yet)"}`],
      ["state dir", shortPath(status.stateDir)],
      ["judge", `${status.judge.enabled ? status.judge.model : "disabled"} · ${status.judge.baseURL}`],
      [
        "pins",
        `${plural(status.pins, "session")}${status.pinModels.length ? ` · ${status.pinModels.map(modelLabel).join(", ")}` : ""}`,
      ],
      ["core", status.core?.abi ? `ABI ${status.core.abi}` : "not loaded"],
    ]),
    section(
      "last",
      status.last
        ? [
            ["model", status.last.chosen ?? "unknown"],
            [
              "stage",
              [status.last.stage, status.last.pinned ? "pinned" : "switched"].filter(Boolean).join(" · "),
            ],
          ]
        : [["decision", "none"]],
    ),
  ]
  const timing = formatTiming(status.timing)
  if (timing) blocks.push(timing)
  if (status.error) blocks.push(facts([["warning", status.error]]))
  return join(...blocks)
}

export { modelLabel }
