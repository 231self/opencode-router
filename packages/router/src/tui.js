import { configPath, formatWeights, readConfig, resolvePolicyWeights, saveConfig, setConfigValue } from "@231self/opencode-shared/config.js"
import { spawn } from "node:child_process"
import { facts, join, note, plural, prose, section } from "@231self/opencode-shared/format.js"
import { planLabel, resolveBillings, withPlan } from "@231self/opencode-shared/plan.js"
import { dialogAdapter, runPlanWizard } from "@231self/opencode-shared/plan-wizard.js"
import { Judge } from "./judge.js"
import {
  Provisioner,
  confirmThenPull,
  detectProvisioning,
  formatBytes,
  judgeAvailability,
  provisionHint,
} from "./provision.js"
import { readHostModelState, resolvePool } from "./pool.js"
import { loadPricing, refreshPricing } from "./pricing.js"
import { dashboardServer, startDashboard, stopDashboard } from "./web.js"
import {
  loadQualityScores,
  qualityCacheAgeMs,
  qualityCachePath,
  readQualityCache,
  refreshQuality,
  qualitySource,
} from "./quality.js"
import {
  clearPin,
  clearPins,
  listPins,
  readDecisions,
  readPin,
  readTurns,
  sessionHash,
  summariseTurns,
  writePin,
} from "@231self/opencode-shared/state.js"
import {
  buildStatus,
  formatMilliseconds,
  formatStatus,
  formatTiming,
  formatTuiStatus,
  shortPath,
} from "./status.js"
import { collectDebug, formatDebug } from "./debug.js"
import { registerRouterSidebar } from "./tui-sidebar.js"
import { ABI_VERSION, VERSION } from "./version.js"

const HOST = "opencode"

/** Usage lines for commands that take optional parameters. */
const USAGE = {
  policy: "/router policy [cost|quality|latency|custom]",
  retention: "/router retention [cache|balanced|switch]",
  pricing: "/router pricing [refresh]",
  pins: "/router pins [clear]",
  plan: "/router plan",
  quality: "/router quality [refresh]",
  history: "/router history [n]",
  timing: "/router timing [n]",
  judge: "/router judge [pull|status|cancel|probe]",
  subagents: "/router subagents on|off",
}

/**
 * Command reference. One row per command: the menu, `/router help`, and
 * `/router help <command>` all read it, so nothing drifts out of the menu.
 */
const HELP = [
  { command: "menu", line: "/router", detail: "Action menu with every command below" },
  { command: "status", line: "/router status", detail: "State, judge, pool, pins, and the last decision" },
  { command: "on", line: "/router on | off", detail: "Enable or disable routing; on by default" },
  { command: "policy", detail: "Cost / quality / latency or custom weights; clears pins when changed" },
  {
    command: "retention",
    detail: "How long the router keeps a model: cache reuse, balanced, or switch every turn; clears pins when changed",
  },
  { command: "pool", line: "/router pool", detail: "Models available to the router and how to edit them" },
  {
    command: "web",
    line: "/router web",
    detail: "Local dashboard on 127.0.0.1 with unit prices, plan burn, and trends; stop closes it",
  },
  { command: "pricing", detail: "Input/output/cache prices for the pool, and the price source" },
  { command: "pins", detail: "Per-session model choice, active blocks, and age; list or clear" },
  {
    command: "plan",
    line: "/router plan",
    detail: "Record the plan you pay for, so the pool is priced at your own rates",
  },
  { command: "quality", detail: "Score source, cache age, and refresh" },
  { command: "timing", detail: "Local judge vs remote model vs tool time" },
  { command: "history", detail: "Recent per-turn decisions, including subagents" },
  { command: "explain", line: "/router explain", detail: "Why this session chose or kept its model" },
  { command: "pin", line: "/router pin [provider/model]", detail: "Force this session onto a model" },
  { command: "auto", line: "/router auto", detail: "Resume automatic routing for this session" },
  { command: "judge", detail: "Probe the local judge or pull the recommended model" },
  { command: "subagents", detail: "Route child sessions with their agent policy" },
  { command: "version", line: "/router version", detail: "Router version, host, and core ABI" },
  { command: "debug", line: "/router debug", detail: "Paths, judge, pool, last decision, and timing" },
  {
    command: "help",
    line: "/router help [command]",
    detail: "Command reference; name one command to see its options",
  },
]

function helpLine(entry) {
  return USAGE[entry.command] ?? entry.line ?? `/router ${entry.command}`
}

/** The help listing row: the command name, then its usage line. */
function helpRow(entry) {
  return [entry.command, helpLine(entry)]
}

/** Older command names kept working. */
const ALIASES = { "pin-mode": "retention", pinmode: "retention" }

function canonical(name) {
  const key = String(name ?? "").trim()
  return ALIASES[key] ?? key
}

function helpEntry(name) {
  return HELP.find((entry) => entry.command === canonical(name)) ?? null
}

function usageLine(name) {
  return USAGE[canonical(name)] ?? `/router ${canonical(name)}`
}

/** Default output followed by the optional parameters. */
function withUsage(text, name) {
  return `${text}\n\nusage: ${usageLine(name)}`
}

/** An unrecognised parameter: say what was wrong, then what is allowed. */
async function showUsage(context, name, detail) {
  const entry = helpEntry(name)
  const lines = []
  if (detail) lines.push(detail, "")
  if (entry) lines.push(entry.detail)
  lines.push(`usage: ${usageLine(name)}`)
  await show(context, prose(...lines))
}

function currentSession(context) {
  try {
    const route = context.ui?.router?.current?.()
    if (route?.type === "session" && route.sessionID) return route.sessionID
  } catch {
    // ignore
  }
  return undefined
}

function currentModel(context) {
  try {
    const model = context.ui?.model?.current?.()
    if (!model?.providerID) return null
    return {
      providerID: model.providerID,
      id: model.id ?? model.modelID,
      variant: model.variant ?? "default",
    }
  } catch {
    return null
  }
}

function parseModel(text) {
  const value = String(text ?? "").trim()
  if (!value.includes("/")) return null
  const [reference, variant] = value.split("#")
  const [providerID, ...rest] = reference.split("/")
  const id = rest.join("/")
  if (!providerID || !id) return null
  return { providerID, id, variant: variant ?? "default" }
}

/** One row per session pin: the model, then its routing state. */
function pinEntries(pins) {
  const now = Date.now()
  return [...pins]
    .sort((left, right) => (Number(right.lastTurnAt) || 0) - (Number(left.lastTurnAt) || 0))
    .map((pin) => {
      const age = formatAge(now - (Number(pin.lastTurnAt) || Number(pin.since) || now))
      const blocks = (Array.isArray(pin.blocked) ? pin.blocked : []).filter(
        (block) => block && Number(block.until) > now,
      )
      const blocked = blocks.length
        ? ` · blocked ${blocks
            .map((block) => `${block.providerID}/${block.id}${block.providerWide ? " (provider)" : ""}`)
            .join(", ")}`
        : ""
      return [modelLabel(pin.model), `${pin.forced ? "manual" : "auto"} · ${age} old${blocked}`]
    })
}

/** Toast text stays short: the first fragment of a possibly long error. */
function brief(text) {
  const value = String(text ?? "")
  return value.length <= 60 ? value : `${value.slice(0, 59)}…`
}

function modelLabel(reference) {
  if (!reference) return "none"
  const variant = reference.variant && reference.variant !== "default" ? `#${reference.variant}` : ""
  return `${reference.providerID}/${reference.id ?? reference.modelID}${variant}`
}

async function show(context, message, title = "OpenCode Router") {
  if (context.ui?.dialog?.alert) {
    await context.ui.dialog.alert({ title, message })
  } else {
    await context.ui.toast.show({ title, message })
  }
}

function weightsReport(config) {
  const blocks = [
    section("policy", [
      ["active", config.policy],
      ["weights", formatWeights(resolvePolicyWeights(config))],
    ]),
  ]
  const classes = Object.keys(config.policyByClass ?? {})
  if (classes.length) {
    blocks.push(
      section(
        "classes",
        classes.map((name) => [name, formatWeights(resolvePolicyWeights(config, name))]),
      ),
    )
  }
  blocks.push(facts([["config", shortPath(configPath())]]))
  blocks.push(note("set policyWeights / policyByClass in config.json"))
  return join(...blocks)
}

function poolLines(config, models, providers) {
  const resolved = resolvePool({
    models,
    providers,
    config,
    host: HOST,
    qualityScores: loadQualityScores({ config }),
    prices: loadPricing({ config }),
  })
  const shown = resolved.pool.slice(0, 12)
  const entries = shown.map((model) => {
    const quality =
      model.qualityOverride != null
        ? `${Number(model.qualityOverride).toFixed(2)}${model.qualitySource ? ` (${model.qualitySource})` : ""}`
        : "auto"
    const free = model.local && config.pool.localCostZero !== false
    const cost = free
      ? "free (local)"
      : `${formatCost(model.cost)}${model.costSource === "modelsdev" ? " (models.dev)" : ""}`
    // The unit price is what 1M tokens of a typical turn cost on this model
    // for this user, and its basis says whether the mix is measured or the
    // published stand-in.
    const unit =
      !free && model.unitPrice ? ` · unit ${money(model.unitPrice.usdPerMTok)}/M · ${model.unitPrice.basis}` : ""
    return [
      `${model.providerID}/${model.modelID}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`,
      `ctx ${model.limit.context} · cost ${cost}${unit} · quality ${quality} · local ${model.local ? "yes" : "no"}`,
    ]
  })
  const blocks = [
    section("models", entries.length ? entries : [["none", "no models selected"]]),
  ]
  if (resolved.pool.length > shown.length) {
    blocks.push(note(`… ${resolved.pool.length - shown.length} more`))
  }
  for (const warning of resolved.warnings) blocks.push(note(`warning: ${warning}`))
  blocks.push(
    facts([
      ["source", `${resolved.source} · ${resolved.pool.length} usable · ${resolved.candidates} available`],
      ["config", shortPath(configPath())],
    ]),
  )
  blocks.push([
    "set models:",
    "  opencode-model-router config set pool.source list",
    `  opencode-model-router config set pool.models '["provider/model"]'`,
  ])
  return join(...blocks)
}

function pricingLines(config, models, providers) {
  const resolved = resolvePool({
    models,
    providers,
    config,
    host: HOST,
    qualityScores: loadQualityScores({ config }),
    prices: loadPricing({ config }),
  })
  const entries = resolved.pool.map((model) => {
    const localFree = model.local && config.pool.localCostZero !== false
    const price = localFree ? "free (local)" : priceText(model.cost, model.costSource)
    return [
      `${model.providerID}/${model.modelID}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`,
      price,
    ]
  })
  const cache = loadPricing({ config })
  const blocks = [
    section("prices · per million tokens", entries.length ? entries : [["none", "no models selected"]]),
    facts([
      ["source", `${resolved.source} · ${plural(resolved.pool.length, "model")}`],
      [
        "prices",
        cache
          ? `${plural(cache.count, "model")} · ${cache.source} · ${formatAge(Date.now() - Number(cache.fetchedAt ?? 0))} old`
          : "none · run /router pricing refresh",
      ],
      ["config", shortPath(configPath())],
    ]),
  ]
  return join(...blocks)
}

function formatAge(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value)) return "unknown"
  const minutes = Math.floor(value / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A single price: `$0.15`, or `?` when the source has no value for it. */
function money(value) {
  return value === undefined || value === null ? "?" : `$${value}`
}

/**
 * Token prices for one pool model. Missing prices read as `unknown` rather
 * than `$0`, and the source is named when it is not the host catalog.
 */
function priceText(cost, source) {
  const tier = Array.isArray(cost) ? cost[0] : null
  const parts = []
  if (tier?.input !== undefined) parts.push(`in $${tier.input}`)
  if (tier?.output !== undefined) parts.push(`out $${tier.output}`)
  if (tier?.cache?.read !== undefined) parts.push(`cache read $${tier.cache.read}`)
  if (parts.length === 0) return "unknown (no pricing data)"
  const origin = source && source !== "catalog" ? ` (${source === "modelsdev" ? "models.dev" : source === "plan" ? "plan rate" : source})` : ""
  return `${parts.join(" · ")} /M${origin}`
}

function formatCost(cost) {
  const tier = Array.isArray(cost) ? cost[0] : null
  if (!tier || (tier.input === undefined && tier.output === undefined)) return "unknown"
  return `${money(tier.input)}/${money(tier.output)}`
}

function explainLines(record) {
  const blocks = [
    section("decision", [
      ["model", `${record.chosen ?? "none"}${record.pinned ? " · pinned" : ""}`],
      ["source", [record.source, record.reason, record.stage].filter(Boolean).join(" · ") || "?"],
      ["policy", `${record.policy ?? "?"} · complexity ${record.complexity ?? "?"} · ${record.turnClass ?? "?"}`],
      ["applied", `${record.applied ?? "?"}${record.error ? ` · error ${record.error}` : ""}`],
    ]),
  ]
  const verdict = record.verdict
  if (verdict) {
    blocks.push(
      section("verdict", [
        ["task", `${verdict.task} / ${verdict.complexity}`],
        ["reasoning", verdict.reasoningNeed],
        ["context", verdict.contextNeed],
        ["tools", verdict.needsTools ? "yes" : "no"],
        ["confidence", Number(verdict.confidence ?? 0).toFixed(2)],
      ]),
    )
  }
  const judge = record.judge ?? {}
  if (judge.used !== undefined || judge.ms !== undefined) {
    blocks.push(
      section("judge", [
        ["used", judge.used ? "yes" : "no"],
        ["cached", judge.cached ? "yes" : "no"],
        ["latency", `${judge.ms ?? 0}ms`],
      ]),
    )
  }
  const timing = record.timing
  if (timing) {
    blocks.push(
      section("timing", [
        ["route", formatMilliseconds(timing.routeMs)],
        ["judge", formatMilliseconds(timing.judgeMs)],
        ["switch", formatMilliseconds(timing.switchMs)],
      ]),
    )
  }
  const top = Array.isArray(record.top) ? record.top : []
  if (top.length > 0) {
    blocks.push(
      section(
        "candidates",
        top.map((entry) => [
          `${entry.providerID}/${entry.id}${entry.variant && entry.variant !== "default" ? `#${entry.variant}` : ""}`,
          `score ${Number(entry.score ?? 0).toFixed(3)} · cost $${Number(entry.costUsd ?? 0).toFixed(6)}`,
        ]),
      ),
    )
  }
  if (record.hint) blocks.push(note(record.hint))
  return join(...blocks)
}

async function poolCatalog(context) {
  const location = context.location ?? context.data.location.default()
  try {
    await Promise.all([
      context.data.location.model.sync(location),
      context.data.location.provider.sync(location),
    ])
  } catch {
    // best effort; the cached lists may still be usable
  }
  return {
    models: context.data.location.model.list(location) ?? [],
    providers: context.data.location.provider.list(location) ?? [],
  }
}

async function poolMenu(context) {
  const { models, providers } = await poolCatalog(context)
  let config = readConfig({ write: true }).config
  let resolved = resolvePool({
    models,
    providers,
    config,
    host: HOST,
    qualityScores: loadQualityScores({ config }),
    prices: loadPricing({ config }),
  })

  if (resolved.pool.length > 0) {
    await show(context, poolLines(config, models, providers))
    const choice = await context.ui.dialog.select({
      title: "OpenCode Router pool",
      options: [
        {
          title: "Change pool",
          value: "change",
          description: "Choose host favorites, an explicit list, or every available model",
        },
        { title: "Keep current pool", value: "close", description: "Leave routing unchanged" },
      ],
    })
    if (choice !== "change") return
  }

  const source = await context.ui.dialog.select({
    title: resolved.pool.length > 0 ? "OpenCode Router pool source" : "No models selected · choose a pool",
    options: [
      {
        title: "Use my favorites",
        value: "favorites",
        description: "Favorite models in OpenCode's model picker; routing reads them",
      },
      {
        title: "Enter an explicit list",
        value: "list",
        description: "Comma-separated provider/model names",
      },
      {
        title: "Use all available models",
        value: "available",
        description: "Explicit opt-in; cost-first may pick zero-cost models",
      },
      { title: "Cancel", value: "cancel", description: "Leave the current pool unchanged" },
    ],
  })
  if (!source || source === "cancel") return

  if (source === "favorites") {
    const favorites = readHostModelState(HOST)
    saveConfig({ ...config, pool: { ...config.pool, source: "favorites" } })
    clearPins(HOST)
    if (favorites.favorite.length === 0) {
      await show(
        context,
        prose(
          "Pool source is now favorites, but you have not favorited any models yet.",
          "Open OpenCode's model picker and favorite the models you want, then run /router pool again.",
          "Or run /router pool and choose 'Enter an explicit list' to name them directly.",
        ),
      )
    } else {
      await context.ui.toast.show({
        title: "OpenCode Router",
        message: `favorites pool · ${favorites.favorite.length} model(s)`,
        variant: "success",
      })
    }
    return
  }

  if (source === "list") {
    if (!context.ui.dialog.prompt) {
      await show(context, prose(`This host has no text prompt. Edit pool.models in ${shortPath(configPath())}.`))
      return
    }
    const text = await context.ui.dialog.prompt({
      title: "Models for the router",
      placeholder: "deepseek/deepseek-flash, deepseek/deepseek-v4-pro",
    })
    if (!text) return
    const references = String(text)
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (references.length === 0) {
      await show(context, "Enter at least one provider/model.")
      return
    }
    const available = new Set(models.map((model) => `${model.providerID}/${model.id ?? model.modelID}`))
    const missing = references.filter((reference) => !available.has(reference.split("#")[0]))
    if (missing.length > 0) {
      await show(
        context,
        prose(
          `Not in the host model catalog: ${missing.join(", ")}`,
          `Examples: ${[...available].slice(0, 6).join(", ") || "(none advertised)"}`,
        ),
      )
      return
    }
    saveConfig({ ...config, pool: { ...config.pool, source: "list", models: references } })
    clearPins(HOST)
    await context.ui.toast.show({
      title: "OpenCode Router",
      message: `pool · ${references.length} model(s)`,
      variant: "success",
    })
    return
  }

  if (source === "available") {
    const confirmed = await context.ui.dialog.confirm({
      title: "Use every available model?",
      message:
        "This opts into all eligible chat models. Cost-first routing may choose free or zero-cost models.\n\nContinue?",
      label: { confirm: "Use all", cancel: "Cancel" },
    })
    if (!confirmed) return
    saveConfig({ ...config, pool: { ...config.pool, source: "available" } })
    clearPins(HOST)
    await context.ui.toast.show({
      title: "OpenCode Router",
      message: "pool · all available models",
      variant: "success",
    })
  }
}

/** One download task row: the repo, then its status and progress. */
function taskEntry(task) {
  const total = Number(task.total_size) || 0
  const done = Number(task.downloaded_size) || 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : Number(task.progress) || 0
  return [task.repo_id, `${task.status} · ${percent}% (${formatBytes(done)} / ${formatBytes(total)})`]
}

async function offerPull(context, config, repo, reason, background) {
  const backend = await detectProvisioning({ config })
  if (!backend.supported) {
    await show(context, join(reason ? note(reason) : "", provisionHint(config)))
    return
  }
  const provision = new Provisioner({ config })
  let result
  try {
    result = await confirmThenPull({
      provision,
      repo: repo || provision.defaultRepo(),
      confirm: async (summary) => {
        const rows = [["model", summary.repo]]
        if (summary.params) rows.push(["params", summary.params])
        rows.push(
          ["weights", summary.weightsFormatted],
          ["size", `${summary.sizeFormatted} (all files)`],
          ["license", summary.license],
          ["source", `Hugging Face · MLX ${summary.mlx ? "yes" : "no"}`],
        )
        const blocks = [
          section("download", rows),
          note("This downloads into oMLX's model directory and is served locally."),
        ]
        if (reason) blocks.unshift(note(reason))
        return context.ui.dialog.confirm({
          title: "Download judge model",
          message: join(...blocks),
          label: { confirm: "Download", cancel: "Cancel" },
        })
      },
    })
  } catch (error) {
    await show(context, prose(`cannot prepare download: ${error?.message ?? error}`))
    return
  }

  if (!result.approved) {
    await context.ui.toast.show({ title: "OpenCode Router", message: "download cancelled" })
    return
  }

  await context.ui.toast.show({
    title: "OpenCode Router",
    message: `downloading ${String(result.summary.repo).split("/").pop()} (${result.summary.sizeFormatted}); check /router judge status`,
    variant: "success",
    duration: 5000,
  })

  if (background === false) return
  const taskID = result.task.task_id
  void provision
    .waitFor(taskID, {
      onProgress: (task) => {
        if (task.status === "completed") {
          void context.ui.toast.show({
            title: "OpenCode Router",
            message: `${String(task.repo_id).split("/").pop()} downloaded; run /router judge to verify`,
            variant: "success",
            duration: 8000,
          })
        }
        if (task.status === "failed" || task.status === "cancelled") {
          void context.ui.toast.show({
            title: "OpenCode Router",
            message: `download ${task.status}: ${brief(task.error || "no detail")}`,
            variant: "error",
            duration: 8000,
          })
        }
      },
    })
    .catch((error) => {
      void context.ui.toast.show({
        title: "OpenCode Router",
        message: `download monitor stopped: ${brief(error?.message ?? error)}`,
        variant: "error",
      })
    })
}

async function judgeTasks(context, config) {
  const provision = new Provisioner({ config })
  try {
    const tasks = await provision.tasks()
    if (tasks.length === 0) {
      await show(context, "no judge downloads")
      return
    }
    await show(context, join(section("downloads", tasks.map(taskEntry))))
  } catch (error) {
    await show(context, prose(`cannot read downloads: ${error?.message ?? error}`))
  }
}

async function cancelJudgeTask(context, config, taskID) {
  const provision = new Provisioner({ config })
  try {
    const tasks = await provision.tasks()
    const active = tasks.filter((task) => ["pending", "downloading"].includes(task.status))
    const target = taskID ? tasks.find((task) => task.task_id === taskID) : active[0]
    if (!target) {
      await show(context, taskID ? `no task ${taskID}` : "no active download")
      return
    }
    const approved = await context.ui.dialog.confirm({
      title: "Cancel download",
      message: facts([taskEntry(target)]).join("\n"),
      label: { confirm: "Cancel download", cancel: "Keep" },
    })
    if (!approved) return
    await provision.cancel(target.task_id)
    await context.ui.toast.show({ title: "OpenCode Router", message: "download cancelled", variant: "success" })
  } catch (error) {
    await show(context, prose(`cannot cancel download: ${error?.message ?? error}`))
  }
}

async function openMenu(context) {
  if (!context.ui?.dialog?.select) {
    await show(context, formatTuiStatus(buildStatus({ host: HOST })))
    return
  }
  for (;;) {
    const config = readConfig({ write: true }).config
    const choice = await context.ui.dialog.select({
      title: "OpenCode Router  ·  arrows move  ·  enter select",
      options: [
        { title: "Status", value: "status", description: "State, judge, pool, pins, and the last decision" },
        {
          title: "Policy",
          value: "policy",
          description: "Cost / quality / latency or custom weights; clears pins when changed",
        },
        {
          title: "Model retention",
          value: "retention",
          description: "How long the router keeps a model: cache, balanced, or switch every turn",
        },
        { title: "Pool", value: "pool", description: "Models available to the router and how to edit them" },
        { title: "Pricing", value: "pricing", description: "Input/output/cache prices for the pool" },
        {
          title: resolveBillings(config?.billing).length > 0 ? "Add a plan" : "Plan billing",
          value: "plan",
          description: "Record the plan you pay for; the pool prices covered models at its rates",
        },
        { title: "Refresh prices", value: "pricing refresh", description: "Fetch the public price tables now" },
        {
          title: "Session pins",
          value: "pins",
          description: "Per-session model choice, active blocks, and age; list or clear",
        },
        { title: "Clear all pins", value: "pins clear", description: "Release routing state for every session" },
        { title: "Quality scores", value: "quality", description: "LMArena score source, cache age, and refresh" },
        { title: "Refresh scores", value: "quality refresh", description: "Fetch Epoch and LMArena scores now" },
        { title: "Timing", value: "timing", description: "Local judge vs remote model vs tool time" },
        { title: "History", value: "history", description: "Recent per-turn decisions, including subagents" },
        { title: "Explain last decision", value: "explain", description: "Why this session chose or kept its model" },
        { title: "Judge", value: "judge", description: "Probe the local judge or pull the recommended model" },
        { title: "Pin current model", value: "pin", description: "Force this session to the currently selected model" },
        { title: "Release pin", value: "auto", description: "Resume automatic routing for this session" },
        {
          title: config.enabled ? "Disable routing" : "Enable routing",
          value: "toggle-routing",
          description: "Turn the router on or off without uninstalling it",
        },
        {
          title: config.subagents.enabled ? "Disable subagents" : "Enable subagents",
          value: "toggle-subagents",
          description: "Route child sessions with their agent policy",
        },
        { title: "Help", value: "help", description: "Command reference; pick a command for its options" },
        { title: "Diagnostics", value: "debug", description: "Version, paths, judge, pool, and the last decision" },
        { title: "Close", value: "close", description: "Close the router menu" },
      ],
    })
    if (!choice || choice === "close") return
    if (choice === "toggle-routing") {
      await runCommand(context, config.enabled ? "off" : "on")
    } else if (choice === "toggle-subagents") {
      await runCommand(context, `subagents ${config.subagents.enabled ? "off" : "on"}`)
    } else if (choice === "help") {
      const picked = await context.ui.dialog.select({
        title: "OpenCode Router help",
        options: HELP.map((entry) => ({
          title: helpLine(entry),
          value: entry.command,
          description: entry.detail,
        })),
      })
      if (!picked) return
      await runCommand(context, `help ${picked}`)
    } else {
      await runCommand(context, choice)
    }
  }
}

/**
 * `/router web` — the local dashboard. One server per process: a second
 * start reports the running URL instead of double-binding, and `stop`
 * closes it. The supplier re-reads state per request, so every poll shows
 * what the plugins have written since.
 *
 * The dialog renders plain text — no links — so the URL is plain and the
 * browser is opened directly instead of asking the reader to click.
 */
async function runWeb(context, config, rest) {
  if (rest[0] === "stop") {
    const stopped = await stopDashboard()
    await show(context, prose(stopped ? "Dashboard stopped." : "No dashboard running."))
    return
  }
  const running = dashboardServer()
  if (running) {
    await show(context, prose(`Dashboard already running: ${running.url}`))
    return
  }
  const { models, providers } = await poolCatalog(context)
  const sessionID = currentSession(context)
  const session = sessionID ? sessionHash(sessionID) : null
  const server = await startDashboard({
    config,
    session,
    data: () => {
      const live = readConfig({ write: false }).config
      const { pool } = resolvePool({
        models,
        providers,
        config: live,
        host: HOST,
        qualityScores: null,
        prices: loadPricing({ config: live }),
      })
      const byRef = new Map(
        pool.map((entry) => [`${entry.providerID}/${entry.modelID}`, entry.cost]),
      )
      return {
        turns: readTurns(HOST, 1000),
        decisions: readDecisions(HOST, 200),
        pin: sessionID ? readPin(HOST, sessionID) : null,
        billing: live?.billing ?? null,
        pool,
        ratesOf: (ref) => byRef.get(String(ref ?? "")) ?? null,
      }
    },
  })
  openBrowser(server.url)
  await show(
    context,
    prose(
      `Dashboard: ${server.url}`,
      "Opened in your browser. Local only — close with /router web stop.",
    ),
  )
}

/** Open the dashboard in the default browser. Failure is silent: the URL
 * is in the message either way. */
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref()
  } catch {
    // No browser opener here; the printed URL still works.
  }
}

async function runCommand(context, input) {
  const [command = "menu", ...rest] = String(input ?? "").trim().split(/\s+/)
  const config = readConfig({ write: true }).config
  const sessionID = currentSession(context)

  switch (command) {
    case "":
    case "menu": {
      await openMenu(context)
      return
    }
    case "status": {
      await show(context, formatTuiStatus(buildStatus({ host: HOST })))
      return
    }
    case "version": {
      await show(
        context,
        join(
          `OpenCode Router ${VERSION} · ${HOST} · ABI ${ABI_VERSION}`,
          facts([["config", shortPath(configPath())]]),
        ),
      )
      return
    }
    case "debug": {
      await show(context, formatDebug(await collectDebug({ host: HOST })))
      return
    }
    case "on":
    case "off": {
      saveConfig({ ...config, enabled: command === "on" })
      await context.ui.toast.show({ title: "OpenCode Router", message: `routing ${command}`, variant: "success" })
      return
    }
    case "policy": {
      if (rest[0] === "custom" || rest[0] === "weights") {
        await show(context, weightsReport(config))
        return
      }
      if (rest[0]) {
        if (!["cost", "quality", "latency"].includes(rest[0])) {
          await showUsage(context, "policy", `"${rest[0]}" is not a policy`)
          return
        }
        saveConfig({ ...config, policy: rest[0] })
        clearPins(HOST)
        await context.ui.toast.show({ title: "OpenCode Router", message: `policy ${rest[0]}`, variant: "success" })
        return
      }
      const choice = await context.ui.dialog.select({
        title: "OpenCode Router policy",
        current: config.policy,
        options: [
          { title: "Cost first", value: "cost", description: "Cheapest model that clears the bar; escalate when needed" },
          { title: "Quality first", value: "quality", description: "Strongest capable model; cost is a tiebreak" },
          { title: "Latency first", value: "latency", description: "Fastest capable model, favouring local and flash tiers" },
          {
            title: "Custom weights",
            value: "custom",
            description: "Inspect policyWeights and policyByClass; edit them in config.json",
          },
        ],
      })
      if (!choice) return
      if (choice === "custom") {
        await show(context, weightsReport(config))
        return
      }
      saveConfig({ ...config, policy: choice })
      clearPins(HOST)
      await context.ui.toast.show({ title: "OpenCode Router", message: `policy ${choice}`, variant: "success" })
      return
    }
    case "retention":
    case "pin-mode":
    case "pinmode": {
      const modes = ["cache", "balanced", "switch"]
      if (rest[0]) {
        if (!modes.includes(rest[0])) {
          await showUsage(context, "retention", `"${rest[0]}" is not a retention mode`)
          return
        }
        saveConfig({ ...config, pin: { ...config.pin, mode: rest[0] } })
        clearPins(HOST)
        await context.ui.toast.show({ title: "OpenCode Router", message: `retention ${rest[0]}`, variant: "success" })
        return
      }
      const choice = await context.ui.dialog.select({
        title: "OpenCode Router model retention",
        current: config.pin.mode ?? "balanced",
        options: [
          {
            title: "Cache",
            value: "cache",
            description: "Keep the incumbent to reuse the prompt cache; switch only on hard breaks",
          },
          {
            title: "Balanced",
            value: "balanced",
            description: "Keep unless a challenger clearly wins; release on age, turns, or a much cheaper adequate model",
          },
          {
            title: "Switch every turn",
            value: "switch",
            description: "Always take the best model and accept the one-time cache miss",
          },
        ],
      })
      if (!choice) return
      saveConfig({ ...config, pin: { ...config.pin, mode: choice } })
      clearPins(HOST)
      await context.ui.toast.show({ title: "OpenCode Router", message: `retention ${choice}`, variant: "success" })
      return
    }
    case "pool": {
      await poolMenu(context)
      return
    }
    case "pricing": {
      if (rest[0]) {
        if (rest[0] !== "refresh") {
          await showUsage(context, "pricing", `"${rest[0]}" is not a parameter`)
          return
        }
        try {
          const cache = await refreshPricing({ config })
          await show(context, `pricing refreshed · ${cache.count} models (${cache.source})`)
        } catch (error) {
          await show(context, prose(`pricing refresh failed: ${error?.message ?? error}`))
        }
        return
      }
      const { models, providers } = await poolCatalog(context)
      await show(context, withUsage(pricingLines(config, models, providers), "pricing"))
      return
    }
    case "plan": {
      const dialog = context.ui?.dialog
      if (!dialog?.select || !dialog?.prompt || !dialog?.confirm) {
        await show(context, prose("This host has no dialog support; edit billing in the config file instead."))
        return
      }
      const record = await runPlanWizard({ ask: dialogAdapter(dialog), modelLabel: "your models" })
      if (!record) return
      // Plans accumulate: a second run adds a plan beside the ones on file.
      // "Pay per token" and "skip" replace, since they say no plan applies.
      const merged = saveConfig(setConfigValue(config, "billing", withPlan(config?.billing, record)))
      const plans = resolveBillings(merged?.billing ?? config?.billing)
      await show(
        context,
        prose(
          record.skipped
            ? "Plan setup skipped. /router plan runs it again."
            : record.payg === true || record.type === "payg"
              ? "Recorded: pay as you go — no plan, the pool keeps list prices."
              : `Added ${planLabel(record) ?? "custom plan"}. Now ${plans.length} plan${plans.length === 1 ? "" : "s"} on file; the pool prices covered models at their rates.`,
        ),
      )
      return
    }
    case "web": {
      await runWeb(context, config, rest)
      return
    }
    case "pins": {
      if (rest[0] && rest[0] !== "clear") {
        await showUsage(context, "pins", `"${rest[0]}" is not a parameter`)
        return
      }
      const pins = listPins(HOST)
      if (rest[0] === "clear") {
        if (pins.length === 0) {
          await show(context, withUsage("no routing pins", "pins"))
          return
        }
        const confirmed = await context.ui.dialog.confirm({
          title: "Clear routing pins?",
          message: `Clear ${pins.length} session pins? Each session re-routes on its next turn.`,
          label: { confirm: "Clear", cancel: "Cancel" },
        })
        if (!confirmed) return
        clearPins(HOST)
        await context.ui.toast.show({
          title: "OpenCode Router",
          message: `${pins.length} pins cleared`,
          variant: "success",
        })
        return
      }
      if (pins.length === 0) {
        await show(context, withUsage("no routing pins", "pins"))
        return
      }
      const shown = pinEntries(pins).slice(0, 10)
      const blocks = [section(`${plural(pins.length, "session")} with routing state`, shown)]
      if (pins.length > shown.length) blocks.push(note(`… ${pins.length - shown.length} more`))
      await show(context, withUsage(join(...blocks), "pins"))
      return
    }
    case "quality": {
      const action = rest[0] ?? "status"
      if (action !== "status" && action !== "refresh") {
        await showUsage(context, "quality", `"${action}" is not a parameter`)
        return
      }
      if (action === "refresh") {
        try {
          const cache = await refreshQuality({ config })
          const names = Object.keys(cache.sources ?? {}).join(" + ")
          await show(context, `quality refreshed · ${cache.count} models (${names || "none"})`)
        } catch (error) {
          await show(context, prose(`quality refresh failed: ${error?.message ?? error}`))
        }
        return
      }
      const source = qualitySource(config)
      const cache = readQualityCache()
      const rows = [["source", cache ? cache.source : source]]
      if (cache) {
        for (const [name, entry] of Object.entries(cache.sources ?? {})) {
          rows.push([name, `${entry.count} models · ${formatAge(qualityCacheAgeMs(entry))} old`])
        }
        rows.push(["models", String(cache.count)])
        rows.push(["cache", shortPath(qualityCachePath())])
      } else {
        rows.push(["cache", "none"])
      }
      await show(context, withUsage(join(facts(rows)), "quality"))
      return
    }
    case "history": {
      if (rest[0] !== undefined && !Number.isFinite(Number(rest[0]))) {
        await showUsage(context, "history", `"${rest[0]}" is not a number`)
        return
      }
      const limit = Number(rest[0]) || 10
      const decisions = readDecisions(HOST, limit)
      if (decisions.length === 0) {
        await show(context, "no decisions recorded yet")
        return
      }
      const entries = decisions.map((record) => {
        const when = new Date(record.ts ?? Date.now()).toLocaleTimeString()
        const role = record.role === "subagent" ? `sub(${record.agent ?? "?"})` : "root"
        const timing = record.timing ?? {}
        return [
          `${when} ${role}`,
          [
            record.chosen ?? "?",
            record.pinned ? "pinned" : "switched",
            record.stage,
            `judge ${formatMilliseconds(timing.judgeMs ?? record.judge?.ms ?? 0)}`,
            `route ${formatMilliseconds(timing.routeMs ?? 0)}`,
          ]
            .filter(Boolean)
            .join(" · "),
        ]
      })
      await show(context, join(section("history", entries)))
      return
    }
    case "timing": {
      if (rest[0] !== undefined && !Number.isFinite(Number(rest[0]))) {
        await showUsage(context, "timing", `"${rest[0]}" is not a number`)
        return
      }
      const limit = Number(rest[0]) || 20
      const turns = readTurns(HOST, limit)
      if (turns.length === 0) {
        await show(context, "no turn timings recorded yet")
        return
      }
      const summary = summariseTurns(turns, limit)
      const entries = turns.slice(-10).map((turn) => {
        const when = new Date(turn.ts ?? Date.now()).toLocaleTimeString()
        const role = turn.role === "subagent" ? `sub(${turn.agent || "?"})` : "root"
        return [
          `${when} ${role}`,
          [
            turn.usedModel ?? turn.model ?? "?",
            `judge ${formatMilliseconds(turn.judgeMs)}`,
            `model ${formatMilliseconds(turn.modelMs)}`,
            `tools ${formatMilliseconds(turn.toolMs)}`,
            `turn ${formatMilliseconds(turn.turnMs)}`,
          ].join(" · "),
        ]
      })
      await show(
        context,
        join(
          formatTiming(summary) ?? note("no turn timings"),
          section("recent turns", entries),
        ),
      )
      return
    }
    case "explain": {
      const hash = sessionID ? sessionHash(sessionID) : null
      const decisions = readDecisions(HOST, 100).reverse()
      const record = decisions.find((entry) => !hash || entry.session === hash)
      await show(context, record ? explainLines(record) : "no decision for this session yet")
      return
    }
    case "pin": {
      if (!sessionID) {
        await show(context, "no active session")
        return
      }
      const reference = parseModel(rest.join(" ")) ?? currentModel(context)
      if (!reference) {
        await show(context, "pass provider/model or select a model first")
        return
      }
      writePin(HOST, sessionID, {
        model: reference,
        forced: true,
        source: "user",
        since: Date.now(),
        lastApplied: reference,
        lastContextTokens: 0,
      })
      await context.ui.toast.show({ title: "OpenCode Router", message: `pinned ${modelLabel(reference)}`, variant: "success" })
      return
    }
    case "auto": {
      if (!sessionID) {
        await show(context, "no active session")
        return
      }
      clearPin(HOST, sessionID)
      await context.ui.toast.show({ title: "OpenCode Router", message: "routing resumed", variant: "success" })
      return
    }
    case "judge": {
      const action = rest[0]
      if (action && !["pull", "status", "cancel", "probe"].includes(action)) {
        await showUsage(context, "judge", `"${action}" is not a parameter`)
        return
      }
      if (action === "pull") {
        if (config.judge.provision?.enabled === false) {
          await show(context, "judge provisioning is disabled in config (judge.provision.enabled)")
          return
        }
        await offerPull(context, config, rest[1], "No suitable judge model is loaded.")
        return
      }
      if (action === "status") {
        const backend = await detectProvisioning({ config })
        if (!backend.supported) {
          await show(context, provisionHint(config))
          return
        }
        await judgeTasks(context, config)
        return
      }
      if (action === "cancel") {
        const backend = await detectProvisioning({ config })
        if (!backend.supported) {
          await show(context, provisionHint(config))
          return
        }
        await cancelJudgeTask(context, config, rest[1])
        return
      }

      const availability = await judgeAvailability({ config })
      if (!availability.available || !availability.suitable) {
        const reason = !availability.available
          ? `No judge model is available (${availability.error ?? "oMLX returned no models"}).`
          : `The smallest advertised model is ${availability.selected}, which is larger than the recommended 4B judge.`
        if (config.judge.provision?.enabled === false) {
          await show(context, `${reason}\n\nProvisioning is disabled; pull a model in oMLX.`)
          return
        }
        await offerPull(context, config, undefined, reason)
        return
      }

      const judge = new Judge({ config: config.judge })
      try {
        const probe = await judge.probe()
        await show(
          context,
          join(
            section("judge", [
              ["models", probe.models.join(", ")],
              ["selected", probe.selected],
              ["latency", `${probe.ms}ms`],
              ["sample", probe.sample ? JSON.stringify(probe.sample) : "unparsable"],
            ]),
          ),
        )
      } catch (error) {
        await show(context, prose(`judge unavailable: ${error?.message ?? error}`))
      }
      return
    }
    case "subagents": {
      if (rest[0] !== "on" && rest[0] !== "off") {
        await showUsage(
          context,
          "subagents",
          rest[0] ? `"${rest[0]}" is not a parameter` : "on or off is required",
        )
        return
      }
      const enabled = rest[0] === "on"
      saveConfig({ ...config, subagents: { ...config.subagents, enabled } })
      await context.ui.toast.show({
        title: "OpenCode Router",
        message: `subagent routing ${enabled ? "on" : "off"}`,
        variant: "success",
      })
      return
    }
    case "help": {
      const wanted = rest[0]
      if (wanted) {
        const entry = helpEntry(wanted)
        if (!entry) {
          await show(
            context,
            join(note(`unknown command: ${wanted}`), section("commands", HELP.map(helpRow))),
          )
          return
        }
        await show(
          context,
          join(
            section(entry.command, [
              ["usage", helpLine(entry)],
              ["detail", entry.detail],
            ]),
          ),
        )
        return
      }
      await show(context, join(section("commands", HELP.map(helpRow))))
      return
    }
    default:
      await show(context, prose(`unknown command: ${command}. Try /router help`))
  }
}

/**
 * OpenCode TUI part. Plain object export, no JSX, no TypeScript.
 *
 * Status and settings live here rather than in a server command because
 * `ctx.session.synthetic` starts a model turn (see docs/development.md).
 */
export default {
  id: "omlx-router.tui",

  setup(context) {
    const disposers = []

    try {
      const config = readConfig({ write: false }).config
      const favorites = readHostModelState(HOST)
      const noFavorites = config.pool.source === "favorites" && favorites.favorite.length === 0
      const noList =
        config.pool.source === "list" &&
        config.pool.models.length === 0 &&
        (config.pool.include ?? []).length === 0
      const noSource = !["favorites", "list", "available"].includes(config.pool.source)
      if (noFavorites || noList || noSource) {
        void context.ui.toast.show({
          title: "OpenCode Router",
          message: "No models selected. Open /router pool to choose favorites or an explicit list.",
          duration: 8000,
        })
      }
    } catch {
      // A missing config or toast must not stop the TUI part.
    }

    if (typeof context.data?.on === "function") {
      const refresh = async (event) => {
        const sessionID = event?.data?.sessionID ?? event?.sessionID
        if (!sessionID) return
        try {
          context.data.session?.invalidate?.(sessionID)
          await context.data.session?.sync?.(sessionID)
        } catch {
          // The host refreshes on its next event; routing must not be affected.
        }
      }

      disposers.push(
        context.data.on("session.model.selected", (event) => {
          const model = event?.data?.model
          const previous = event?.data?.previous
          const changed =
            model &&
            (!previous ||
              previous.providerID !== model.providerID ||
              previous.id !== model.id)
          if (changed) {
            void context.ui.toast.show({
              title: "OpenCode Router",
              message: `model → ${model.providerID}/${model.id}`,
              duration: 3000,
            })
          }
          void refresh(event)
        }),
      )
      disposers.push(context.data.on("session.execution.succeeded", (event) => void refresh(event)))
    }

    // Sidebar block: this session's model, pin, policy, and quality.
    // Without OpenTUI or a slot API there is simply no sidebar.
    void registerRouterSidebar(context)
      .then((dispose) => {
        if (typeof dispose === "function") disposers.push(dispose)
      })
      .catch(() => {
        // The block is a surface extra; its failure must not break the TUI.
      })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "omlx-router.settings",
          title: "OpenCode Router: settings",
          group: "OpenCode Router",
          palette: true,
          slash: { name: "router", aliases: ["model-router", "route"], arguments: true },
          run: async (input) => {
            try {
              await runCommand(context, input)
            } catch (error) {
              await show(context, prose(`router error: ${error?.message ?? error}`))
            }
          },
        },
      ],
      bindings: ["omlx-router.settings"],
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },
}
