import { readConfig } from "@231self/opencode-shared/config.js"
import { join, note, prose, section } from "@231self/opencode-shared/format.js"
import { readPin, writePin } from "@231self/opencode-shared/state.js"

import { readCompactionNoise } from "./noise.js"

const HOST = "opencode"

function currentSession(context) {
  try {
    const route = context.ui?.router?.current?.()
    if (route?.type === "session" && route.sessionID) return route.sessionID
  } catch {
    // ignore
  }
  return undefined
}

function turns(value) {
  return Number.isFinite(value) ? String(value) : "never"
}

function dollars(value) {
  return `$${(Number(value) || 0).toFixed(4)}`
}

function signedDollars(value) {
  const number = Number(value) || 0
  return `${number < 0 ? "-" : ""}$${Math.abs(number).toFixed(4)}`
}

function percent(value) {
  const number = Number(value) || 0
  return `${number < 0 ? "-" : "+"}${Math.round(Math.abs(number) * 100)}%`
}

/** The advisory popup body: one fact per row, 72 columns, hanging indent. */
export function advisoryReport(pin, { noise = null, expectedTurns = 0 } = {}) {
  const state = pin?.compaction ?? null
  const advisory = state?.advisory ?? null
  if (!advisory) {
    return join(
      note(
        "No advisory yet. The next turn computes it; run /ctx again after a turn.",
      ),
    )
  }
  const held = Math.max(0, (Number(state.turns) || 0) - (Number(state.changedTurns) || 0))
  const cache = advisory.cache ?? {}
  const ratio = Number(cache.ratio) || 0
  const source =
    cache.source === "measured"
      ? "measured"
      : cache.source === "expired"
        ? "expired (idle)"
        : cache.source === "fallback"
          ? "configured fallback"
          : "none"
  const projections = Array.isArray(advisory.projections) ? advisory.projections : []
  const estimates = advisory.estimates ?? null
  return join(
    section("advisory", [
      ["verdict", advisory.verdict],
      ["source", advisory.source],
      ["confidence", (Number(advisory.confidence) || 0).toFixed(2)],
    ]),
    section("economics", [
      ["break-even", `${turns(advisory.breakEvenTurns)} turns`],
      ["per turn", dollars(advisory.perTurnSavings)],
      ["horizon", `${expectedTurns} turns`],
      ["worth it", advisory.worthIt ? "yes" : "no"],
    ]),
    section("cache", [
      ["hit rate", source === "none" ? "unknown" : `${Math.round(ratio * 100)}%`],
      ["source", source],
      ["samples", String(Number(cache.samples) || 0)],
    ]),
    ...(projections.length > 0
      ? [
          section(
            "horizons",
            projections.map((entry) => [
              `${entry.turns} turns`,
              `${entry.worthIt ? "worth it" : "not yet"} · ${signedDollars(entry.net)} net`,
            ]),
          ),
        ]
      : []),
    ...(estimates
      ? [
          section("estimation", [
            ["summary", `${Math.round(Number(estimates.summaryTokens) || 0)} tokens (${estimates.summarySource})`],
            [
              "summary cost",
              `${dollars(estimates.summaryCost)} (${estimates.summaryCostSource})`,
            ],
            [
              "rebuild",
              estimates.rebuildCost == null
                ? "modelled"
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
      ["held for", `${held} turns`],
      ["noise band", (Number(noise?.instability) || 0).toFixed(2)],
    ]),
    note(
      advisory.verdict === "delegate"
        ? "The next step looks like review or verification. Send it to a fresh subagent; a reviewer without this session's history usually judges the work better."
        : advisory.verdict === "compact-now"
          ? "Compaction pays for itself soon. Run /ctx here to compact at the recommended checkpoint."
          : "Keep working. There is no safe checkpoint yet, or compaction would not pay for itself within the horizon.",
    ),
  )
}

async function show(context, message, title = "Context Compaction") {
  if (context.ui?.dialog?.alert) {
    await context.ui.dialog.alert({ title, message })
  } else {
    await context.ui.toast.show({ title, message })
  }
}

async function runCommand(context, input) {
  const wanted = String(input?.text ?? input ?? "").trim()
  const [command = "", ...rest] = wanted.split(/\s+/)
  const config = readConfig({ write: false }).config
  const sessionID = currentSession(context)

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
        "Compaction requested. The next turn asks the host to compact; if it declines, the request is dropped and nothing repeats.",
      ),
    )
    return
  }

  if (command === "help" || rest.includes("help")) {
    await show(
      context,
      join(
        section("commands", [
          ["/ctx", "the current advisory: verdict, economics, and what to do"],
          ["/ctx here", "ask the host to compact this session now"],
          ["/ctx help", "this text"],
        ]),
      ),
    )
    return
  }

  if (command !== "") {
    await show(context, prose(`Unknown command: ${command}. Try /ctx help.`))
    return
  }

  if (!sessionID) {
    await show(context, prose("No active session."))
    return
  }
  const pin = readPin(HOST, sessionID)
  await show(context, advisoryReport(pin, { noise: readCompactionNoise(), expectedTurns: config.compaction?.expectedTurns ?? 0 }))
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
                  ? "Compaction is worth doing soon. Run /ctx for the numbers."
                  : verdict === "delegate"
                    ? "This step looks like review. A fresh subagent may judge it better. Run /ctx for details."
                    : "Compaction verdict changed. Run /ctx for details.",
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

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },
}
