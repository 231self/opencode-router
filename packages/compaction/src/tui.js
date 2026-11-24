import { readConfig, saveConfig, setConfigValue } from "@231self/opencode-shared/config.js"
import { costState, normaliseCost } from "@231self/opencode-shared/cost.js"
import { join, note, prose, section } from "@231self/opencode-shared/format.js"
import { creditCost, creditsFromTurns, planLabel, projectBurn, resolveBilling, resolveBillings, withPlan } from "@231self/opencode-shared/plan.js"
import { applyPlanFacts, fetchLimitDex, planFacts } from "@231self/opencode-shared/plan-feed.js"
import { claimPlanPrompt, dialogAdapter, runPlanWizard, shouldPromptPlanSetup } from "@231self/opencode-shared/plan-wizard.js"
import { readPin, readTurns, writePin } from "@231self/opencode-shared/state.js"

import { readCompactionNoise } from "./noise.js"
import { registerCompactionSidebar } from "./tui-sidebar.js"

const HOST = "opencode"

/** Usage lines for commands that take optional parameters. */
const USAGE = {
  menu: "/ctx",
  report: "/ctx report",
  here: "/ctx here",
  plan: "/ctx plan",
  refresh: "/ctx plan refresh",
  help: "/ctx help [command]",
}

/**
 * Command reference. One row per command: the menu, `/ctx help`, and
 * `/ctx help <command>` all read it, so nothing drifts out of the menu.
 */
const HELP = [
  { command: "menu", line: "/ctx", detail: "Action menu with every command below" },
  { command: "report", line: "/ctx report", detail: "The current advisory: verdict, economics, and what to do" },
  { command: "here", line: "/ctx here", detail: "Ask the host to compact this session now" },
  { command: "plan", line: "/ctx plan", detail: "Set up or change the plan billing facts" },
  {
    command: "refresh",
    line: "/ctx plan refresh",
    detail: "Re-read this plan's price from the public tracker feed",
  },
  {
    command: "help",
    line: "/ctx help [command]",
    detail: "Command reference; name one command to see its options",
  },
]

function helpLine(entry) {
  return USAGE[entry.command] ?? entry.line ?? `/ctx ${entry.command}`
}

/** The help listing row: the command name, then its usage line. */
function helpRow(entry) {
  return [entry.command, helpLine(entry)]
}

function helpEntry(name) {
  return HELP.find((entry) => entry.command === String(name ?? "").trim()) ?? null
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

/** A turn count as a noun: `1 turn`, `8 turns`, or `never`. */
function turns(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number} turn${number === 1 ? "" : "s"}` : "never"
}

/** A bare count with a pluralised noun. */
function count(value, noun) {
  const number = Math.round(Number(value) || 0)
  return `${number} ${noun}${number === 1 ? "" : "s"}`
}

function dollars(value) {
  const number = Number(value) || 0
  // A tiny positive amount is not zero. Printing `$0.0000` for it would read
  // as "nothing", which is false. `<$0.0001` says what is true: the figure is
  // real but below the display's resolution.
  if (number > 0 && number < 0.0001) return "<$0.0001"
  return `$${number.toFixed(4)}`
}

/** A credit count as a compact number: `1.2M credits`, `150M credits`. */
function credits(value) {
  const number = Number(value) || 0
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`
  return String(Math.round(number))
}

function signedDollars(value) {
  const number = Number(value) || 0
  return `${number < 0 ? "-" : ""}$${Math.abs(number).toFixed(4)}`
}

function percent(value) {
  const number = Number(value) || 0
  return `${number < 0 ? "-" : "+"}${Math.round(Math.abs(number) * 100)}%`
}

function sign(value) {
  const number = Math.round(Number(value) || 0)
  return `${number < 0 ? "-" : "+"}${Math.abs(number)}`
}

/** The advisory popup body: one fact per row, 72 columns, hanging indent. */
export function advisoryReport(pin, { noise = null, expectedTurns = 0, planBurn = null, planBurns = null } = {}) {
  const state = pin?.compaction ?? null
  const advisory = state?.advisory ?? null
  if (!advisory) {
    return join(
      note(
        "No advisory yet. The next turn computes it; run /ctx report again after a turn.",
      ),
    )
  }
  const held = Math.max(0, (Number(state.turns) || 0) - (Number(state.changedTurns) || 0))
  // The outcome of the last `/ctx here`. This path used to fail silently, so
  // the report has to say what the host did with the request.
  const request = state?.requestedResult ?? null
  const cache = advisory.cache ?? {}
  const ratio = Number(cache.ratio) || 0
  const source =
    cache.source === "measured"
      ? "measured"
      : cache.source === "turn-log"
        ? "turn log"
        : cache.source === "expired"
          ? "expired (idle)"
          : cache.source === "fallback"
            ? "configured fallback"
            : "none"
  const projections = Array.isArray(advisory.projections) ? advisory.projections : []
  const estimates = advisory.estimates ?? null
  // Three pricing states. `priced` computed real economics; `flat` is a
  // flat-rate pool whose list price usually lives in a sibling catalog entry;
  // `unknown` has no price data at all. Only real prices may state a break-even
  // as the user's own cost.
  const pricing = advisory.pricing ?? estimates?.pricing ?? "unknown"
  const computed = advisory.worthIt != null
  const atListPrice = Boolean(advisory.moneyBasis)
  const planEstimates = estimates?.plan ?? null
  // The plans to show, one row each. `planBurns` is the multi-plan form;
  // `planBurn` is the single-plan form older callers pass, named after the
  // plan the advisory priced this model at. A row with no burn still shows
  // its plan name — an unpriced plan is a fact, not a gap.
  const planRows = Array.isArray(planBurns) && planBurns.length > 0
    ? planBurns
    : planBurn
      ? [{ label: planEstimates?.plan ?? "plan", burn: planBurn }]
      : planEstimates?.plan
        ? [{ label: planEstimates.plan, burn: null }]
        : []
  // Only a plan that actually priced this model may be called "plan rate".
  const atPlanRate = Boolean(planEstimates?.atPlanRate) && !atListPrice && computed
  const referenceLabel = advisory.priceSource ?? "no reference price"
  const capacity = advisory.capacity ?? null
  const contextSource = pin?.lastContextSource === "billed" ? "billed" : "estimated"
  // A plan makes cost irrelevant but the window finite. When headroom runs
  // out the advice has to say so, whatever the money says.
  const headroomShare = capacity?.limit ? capacity.headroom / capacity.limit : null
  const lowHeadroom = headroomShare != null && headroomShare < 0.15
  const closing =
    advisory.verdict === "delegate"
      ? "The next step looks like review or verification. Send it to a fresh subagent; a reviewer without this session's history usually judges the work better."
      : advisory.verdict === "compact-now"
        ? computed
          ? atPlanRate
            ? "Compaction pays for itself soon in plan credits. Run /ctx here to compact."
            : atListPrice
              ? "Compaction pays for itself soon at list price. Your plan charges nothing either way. Run /ctx here to compact."
              : "Compaction pays for itself soon. Run /ctx here to compact at the recommended checkpoint."
          : "This looks like a safe checkpoint. Run /ctx here to compact. Compaction economics were not computed for this model."
        : lowHeadroom
          ? `Keep working — but the window is nearly full: ${Math.round(capacity.headroom)} tokens left. A safe checkpoint may not arrive before you run out. /ctx here compacts now.`
          : computed
            ? atPlanRate
              ? "Keep working. There is no safe checkpoint yet, or compaction would not pay for itself in plan credits within the horizon."
              : atListPrice
                ? "Keep working. There is no safe checkpoint yet. At list price compaction saves money; your plan charges nothing either way."
                : "Keep working. There is no safe checkpoint yet, or compaction would not pay for itself within the horizon."
            : pricing === "flat"
              ? "Keep working. There is no safe checkpoint yet. This is a free tier: cost is not the constraint here, the context window is."
              : "Keep working. There is no safe checkpoint yet. Compaction economics were not computed: this model has no price data."
  const unpricedLine = pricing === "flat" ? "flat plan · $0 net" : "not computed · no price data"
  const horizonRows =
    projections.length > 0
      ? projections.map((entry) => [
          count(entry.turns, "turn"),
          entry.worthIt == null
            ? unpricedLine
            : `${entry.worthIt ? "worth it" : "not yet"} · ${signedDollars(entry.net)} net`,
        ])
      : [["all", unpricedLine]]
  return join(
    section("context", [
      ["size", `${Math.round(Number(advisory.signals?.contextTokens) || 0)} tokens (${contextSource})`],
      ...(capacity?.limit ? [["limit", `${Math.round(capacity.limit)} tokens`]] : []),
      ...(capacity?.headroom != null && capacity?.limit
        ? [
            [
              "headroom",
              `${Math.round(capacity.headroom)} tokens (${Math.round(
                (capacity.headroom / capacity.limit) * 100,
              )}% free)`,
            ],
          ]
        : []),
      ["growth", `${sign(Math.round(Number(advisory.signals?.growth) || 0))} tokens`],
      // One block per recorded plan, each with its own burn. A single blended
      // figure would hide which allowance is the one running out. A plan with
      // no published allowance shows its name and no burn rather than an
      // invented number.
      ...planRows.flatMap((entry) => [
        ["plan", entry.label],
        ...(entry.burn
          ? [
              [
                "burn",
                `${credits(entry.burn.used)} of ${credits(entry.burn.allowance)} credits (${Math.round(
                  entry.burn.percentUsed,
                )}% · ${entry.burn.basis})`,
              ],
              ...(entry.burn.daysLeft != null
                ? [
                    [
                      "projection",
                      `${credits(entry.burn.projected)} by reset${entry.burn.daysLeft < 1 ? " · less than a day" : ` · ${Math.round(entry.burn.daysLeft)} days left`}`,
                    ],
                  ]
                : []),
            ]
          : []),
      ]),
      ...(planEstimates
        ? [
            ...(planEstimates.keepCredits != null
              ? [["per turn", `${credits(planEstimates.keepCredits)} credits of allowance`]]
              : []),
            ...(planEstimates.expiry
              ? [
                  [
                    "cache expiry",
                    `${credits(planEstimates.expiry.cold)} credits to re-bill (${Math.round(
                      planEstimates.expiry.ratio,
                    )}x hot · premium ${credits(planEstimates.expiry.premium)})`,
                  ],
                ]
              : []),
          ]
        : []),
    ]),
    section("advisory", [
      ["verdict", advisory.verdict],
      ["source", advisory.source],
      ["confidence", (Number(advisory.confidence) || 0).toFixed(2)],
    ]),
    section(
      "economics",
      computed
        ? [
            ...(atPlanRate
              ? [
                  ["basis", "plan rate · your own credits"],
                  ["priced at", referenceLabel],
                ]
              : atListPrice
                ? [
                    ["basis", "flat plan · $0 marginal to you"],
                    ["priced at", referenceLabel],
                  ]
                : [["basis", "catalog prices"]]),
            // The KV-cache invalidation is the cost of compacting, so it leads
            // when there is one. A flat plan's cash cost rounds to nothing —
            // the real cost there is the window it burns, not dollars — so the
            // row is left out rather than printing a zero that reads as a
            // finding.
            ...(advisory.invalidationCost > 0
              ? [
                  [
                    "cost to compact",
                    `${dollars(advisory.invalidationCost)}${advisory.summaryCost > 0 && advisory.invalidationCost > advisory.summaryCost ? ` · mostly KV-cache invalidation` : ""}${atListPrice ? " (at list price)" : ""}`,
                  ],
                ]
              : []),
            [
              "break-even",
              `${turns(advisory.breakEvenTurns)}${atListPrice ? " (at list price)" : ""}`,
            ],
            [
              "per turn",
              `${dollars(advisory.perTurnSavings)}${atListPrice ? " (at list price)" : ""}`,
            ],
            ["horizon", turns(expectedTurns)],
            [
              "worth it",
              `${advisory.worthIt ? "yes" : "no"}${atListPrice ? " · free on your plan" : atPlanRate ? " · in credits" : ""}`,
            ],
          ]
        : [
            [
              "basis",
              pricing === "flat" ? "free tier · $0 marginal" : "no price data · not computed",
            ],
            ["horizon", turns(expectedTurns)],
            ["worth it", pricing === "flat" ? "not a cost decision" : "unknown"],
          ],
    ),
    // The same trade in credits when a plan covers the model. On a plan the
    // dollar figures are near zero and hide the real cost: the KV-cache
    // invalidation reads as $0.0172 there but 148.8M credits here, and
    // credits are what the allowance burns. This is the honest measure.
    ...(advisory.planEconomics
      ? [
          section("plan credits", [
            ["unit", "the credits your plan actually burns"],
            [
              "cost to compact",
              `${credits(advisory.planEconomics.invalidationCost)} credits · KV-cache invalidation`,
            ],
            ["per turn saved", `${credits(advisory.planEconomics.perTurnSavings)} credits`],
            ["break-even", turns(advisory.planEconomics.breakEvenTurns)],
          ]),
        ]
      : []),
    section("cache", [
      ["hit rate", source === "none" ? "unknown" : `${Math.round(ratio * 100)}%`],
      ["source", source],
      ["samples", String(Number(cache.samples) || 0)],
    ]),
    section("horizons", horizonRows),
    ...(estimates
      ? [
          section("estimation", [
            ["summary", `${Math.round(Number(estimates.summaryTokens) || 0)} tokens (${estimates.summarySource})`],
            [
              "summary cost",
              estimates.summaryCost == null
                ? String(estimates.summaryCostSource ?? "not computed")
                : `${dollars(estimates.summaryCost)} (${estimates.summaryCostSource})`,
            ],
            [
              "rebuild",
              estimates.rebuildCost == null
                ? String(estimates.rebuildSource ?? "not computed")
                : `${dollars(estimates.rebuildCost)} (${estimates.rebuildSource})`,
            ],
            ...(estimates.lastPrediction
              ? [
                  [
                    "last size",
                    `${Math.round(estimates.lastPrediction.predicted)} → ${Math.round(
                      estimates.lastPrediction.actual,
                    )} (${percent(estimates.lastPrediction.error)})`,
                  ],
                  ["mean error", `${Math.round((Number(estimates.predictionError) || 0) * 100)}%`],
                ]
              : []),
          ]),
        ]
      : []),
    section("steady", [
      ["held for", count(held, "turn")],
      ["noise band", (Number(noise?.instability) || 0).toFixed(2)],
    ]),
    ...(request
      ? [
          section("last /ctx here", [
            [
              "outcome",
              request.ok ? "accepted" : `failed · ${request.error ?? "unknown error"}`,
            ],
            ["via", String(request.via ?? "session.compact")],
          ]),
        ]
      : []),
    note(closing),
  )
}

async function show(context, message, title = "Context Compaction") {
  if (context.ui?.dialog?.alert) {
    await context.ui.dialog.alert({ title, message })
  } else {
    await context.ui.toast.show({ title, message })
  }
}

/**
 * The action menu, opened by `/ctx menu` (and bare `/ctx menu` with no
 * other command). Mirrors the router's menu: every command one row, a help
 * picker that drills into `/ctx help <command>`, and a close row.
 */
async function openMenu(context, config) {
  const choice = await context.ui.dialog.select({
    title: "Context Compaction",
    options: [
      { title: "Report", value: "report", description: "Verdict, economics, and what to do" },
      { title: "Compact now", value: "here", description: "Ask the host to compact this session now" },
      {
        title: resolveBillings(config?.billing).length > 0 ? "Add a plan" : "Plan setup",
        value: "plan",
        description:
          resolveBillings(config?.billing).length > 0
            ? "Record another plan beside the ones on file"
            : "Set up or change the plan billing facts",
      },
      ...(resolveBilling(config?.billing)?.feed
        ? [
            {
              title: "Refresh plan price",
              value: "refresh",
              description: "Re-read this plan's price from the public tracker feed",
            },
          ]
        : []),
      { title: "Help", value: "help", description: "Command reference; pick a command for its options" },
      { title: "Close", value: "close", description: "Close the context menu" },
    ],
  })
  if (!choice || choice === "close") return
  if (choice === "help") {
    const picked = await context.ui.dialog.select({
      title: "Context Compaction help",
      options: HELP.map((entry) => ({
        title: helpLine(entry),
        value: entry.command,
        description: entry.detail,
      })),
    })
    if (!picked) return
    await runCommand(context, `help ${picked}`)
    return
  }
  await runCommand(context, choice)
}

/**
 * Run the plan-setup wizard and persist what it records. The wizard saves
 * nothing on a back-out; an explicit answer (including "skip") is persisted
 * so the first-init prompt never nags again.
 */export async function runPlanSetup(context, config) {
  const dialog = context.ui?.dialog
  if (!dialog?.select || !dialog?.prompt || !dialog?.confirm) {
    await show(context, prose("This host has no dialog support; edit billing in the config file instead."))
    return null
  }
  const record = await runPlanWizard({
    ask: dialogAdapter(dialog),
    modelLabel: "your models",
  })
  if (!record) return null
  // Plans accumulate: a second setup adds a second plan beside the first
  // rather than replacing it. "Pay per token" and "skip" still replace, since
  // they say no plan applies.
  const merged = saveConfig(setConfigValue(config, "billing", withPlan(config?.billing, record)))
  const plans = resolveBillings(merged?.billing ?? config?.billing)
  await show(
    context,
    prose(
      record.skipped
        ? "Plan setup skipped. /ctx plan runs it again; the question will not repeat on its own."
        : record.payg
          ? "Recorded: pay per token. /ctx plan adds a plan beside it."
          : `Added ${planLabel(record) ?? "custom plan"}. Now ${plans.length} plan${plans.length === 1 ? "" : "s"} on file; /ctx plan adds another.`,
    ),
  )
  return merged
}

/**
 * Re-read the plan price from the public tracker feed.
 *
 * Only this explicit command reaches the network: nothing here runs on a
 * turn. A failure keeps the recorded facts and says why — it never blanks a
 * number or substitutes a guess.
 */
export async function runPlanRefresh(context, config, { fetchImpl } = {}) {
  const records = resolveBillings(config?.billing)
  if (records.length === 0) {
    await show(context, prose("No plan recorded. /ctx plan sets one up."))
    return null
  }
  // Only plans with a tracker feed are refreshed from the network; the rest
  // keep the facts they were given.
  const tracked = records.filter((record) => record.feed?.tool)
  if (tracked.length === 0) {
    await show(
      context,
      prose(
        `No tracker feed covers ${records.map((r) => r.name).join(", ")}. Their facts come from the vendor pages or your answers; /ctx plan edits them.`,
      ),
    )
    return null
  }
  const result = await fetchLimitDex(fetchImpl ? { fetchImpl } : {})
  if (!result.ok) {
    const recorded = records.map((r) => `${r.name} $${r.priceUsd}/mo`).join("; ")
    await show(
      context,
      prose(
        `Tracker feed unreachable (${result.reason}). Kept the recorded prices: ${recorded}.`,
      ),
    )
    return null
  }
  // One row per tracked plan, saying what the feed had for it. A plan the
  // feed does not list keeps its facts rather than losing them.
  const rows = []
  const updates = []
  for (const record of tracked) {
    const facts = planFacts(result.feed, { tool: record.feed.tool, plan: record.feedPlan })
    if (!facts) {
      rows.push(["plan", `${record.name} · not in the feed · kept as recorded`])
      continue
    }
    updates.push(facts)
    rows.push(["plan", `${facts.vendor ?? "?"} · ${record.name}`])
    rows.push([
      "price",
      facts.priceUsdMonthly != null
        ? `$${facts.priceUsdMonthly}/mo · read ${facts.lastVerified ?? facts.generatedAt ?? "today"}`
        : "not in the feed · kept the recorded price",
    ])
    rows.push([
      "allowance",
      facts.allowancePublished
        ? "published by the vendor"
        : "not published by the vendor · no shadow price",
    ])
    if (facts.limitsQuote) rows.push(["vendor limit", facts.limitsQuote])
  }
  let next = config?.billing
  for (const facts of updates) next = applyPlanFacts(next, facts)
  const merged = saveConfig(setConfigValue(config, "billing", next))
  rows.push(["source", "https://limitdex.com/data/plans.json"])
  await show(context, join(section("plan feed", rows)))
  return merged
}

async function runCommand(context, input) {
  const wanted = String(input?.text ?? input ?? "").trim()
  const [command = "", ...rest] = wanted.split(/\s+/)
  const config = readConfig({ write: false }).config
  const sessionID = currentSession(context)

  if (command === "plan") {
    if (rest[0] === "refresh") {
      await runPlanRefresh(context, config)
      return
    }
    await runPlanSetup(context, config)
    return
  }

  if (command === "refresh") {
    await runPlanRefresh(context, config)
    return
  }

  if (command === "" || command === "menu") {
    await openMenu(context, config)
    return
  }

  if (command === "here") {
    if (!sessionID) {
      await show(context, prose("No active session to compact."))
      return
    }
    const pin = readPin(HOST, sessionID) ?? {}
    writePin(HOST, sessionID, { ...pin, compaction: { ...(pin.compaction ?? {}), requestedAt: Date.now() } })
    await show(
      context,
      prose(
        "Compaction requested. The host compacts at the next step boundary. Run /ctx report to see whether it was accepted; the request never repeats on its own.",
      ),
    )
    return
  }

  if (command === "help") {
    const wantedEntry = rest[0]
    if (wantedEntry) {
      const entry = helpEntry(wantedEntry)
      if (!entry) {
        await show(
          context,
          join(note(`unknown command: ${wantedEntry}`), section("commands", HELP.map(helpRow))),
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

  if (command !== "report") {
    await show(context, prose(`unknown command: ${command}. Try /ctx help`))
    return
  }

  if (!sessionID) {
    await show(context, prose("No active session."))
    return
  }
  const pin = readPin(HOST, sessionID)
  // Plan burn, measured from the turn log: one row per recorded plan, each
  // priced at its own model's weights. When the router's turn log is absent
  // (compaction runs standalone) the rows are omitted rather than guessed.
  let planBurns = null
  const billing = config?.billing
  const records = resolveBillings(billing)
  if (records.length > 0) {
    try {
      const usage = creditsFromTurns(readTurns(HOST, 2000), billing, { modelID: "" })
      if (usage) {
        planBurns = records.map((record) => {
          const share = usage.byPlan.find((entry) => entry.record === record)?.credits ?? 0
          const burn = projectBurn({ billing: record, usedCredits: share, now: Date.now() })
          if (burn) {
            burn.counted = usage.byPlan.find((entry) => entry.record === record)?.counted ?? 0
            burn.skipped = usage.skipped
          }
          return { label: planLabel(record), burn }
        })
      }
    } catch {
      // No turn log: no burn rows. The plan figures above still stand.
      planBurns = records.map((record) => ({ label: planLabel(record), burn: null }))
    }
  }
  await show(context, advisoryReport(pin, { noise: readCompactionNoise(), expectedTurns: config.compaction?.expectedTurns ?? 0, planBurns }))
}

/**
 * OpenCode TUI part. Plain object export, no JSX, no TypeScript.
 *
 * Shows the compaction advisory for the current session and takes the
 * explicit `/ctx here` request (the session side performs the host
 * compaction). Toasts when the advisory verdict changes between turns.
 *
 * The slash name is `ctx`, not `compact`: OpenCode already owns `/compact`,
 * and a plugin command with the same name shadows or duplicates it.
 */
export default {
  id: "omlx-compaction.tui",

  setup(context) {
    const disposers = []
    const lastSeen = new Map()

    // First-init plan setup: ask once per process, only when no billing is
    // recorded and the model in use has no real prices. The prompt claims the
    // flag before asking, so the router's TUI part never repeats it.
    try {
      const model = context.ui?.model?.current?.() ?? null
      const pricing = costState(normaliseCost(model?.cost))
      if (shouldPromptPlanSetup(readConfig({ write: false }).config, pricing) && claimPlanPrompt()) {
        queueMicrotask(async () => {
          try {
            await runPlanSetup(context, readConfig({ write: false }).config)
          } catch {
            // A dialog failure must not break plugin load.
          }
        })
      }
    } catch {
      // Model introspection is best-effort; the /ctx plan command remains.
    }

    if (typeof context.data?.on === "function") {
      disposers.push(
        context.data.on("session.execution.succeeded", (event) => {
          const sessionID = event?.data?.sessionID ?? event?.sessionID
          if (!sessionID) return
          try {
            const verdict = readPin(HOST, sessionID)?.compaction?.advisory?.verdict
            if (!verdict || verdict === "not-yet") return
            if (lastSeen.get(sessionID) === verdict) return
            lastSeen.set(sessionID, verdict)
            void context.ui.toast.show({
              title: "Context Compaction",
              message:
                verdict === "compact-now"
                  ? "Compaction is worth doing soon. Run /ctx report for the numbers."
                  : verdict === "delegate"
                    ? "This step looks like review. A fresh subagent may judge it better. Run /ctx report for details."
                    : "Compaction verdict changed. Run /ctx report for details.",
              duration: 8000,
            })
          } catch {
            // A missing pin or toast must not break the event.
          }
        }),
      )
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "omlx-compaction.advisory",
          title: "Context Compaction: advisory",
          group: "Context Compaction",
          palette: true,
          slash: { name: "ctx", arguments: true },
          run: async (input) => {
            try {
              await runCommand(context, input)
            } catch (error) {
              await show(context, prose(`compaction error: ${error?.message ?? error}`))
            }
          },
        },
      ],
      bindings: ["omlx-compaction.advisory"],
    }))

    // Sidebar block: window use, plan burn, expiry exposure. Without
    // OpenTUI or a slot API there is simply no sidebar and everything else
    // keeps working.
    void registerCompactionSidebar(context)
      .then((dispose) => {
        if (typeof dispose === "function") disposers.push(dispose)
      })
      .catch(() => {
        // The block is a surface extra; its failure must not break the TUI.
      })

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === "function") dispose()
          else dispose?.dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },
}
