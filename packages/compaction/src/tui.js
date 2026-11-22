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

/** The advisory popup body: one fact per row, 72 columns, hanging indent. */
export function advisoryReport(pin, { noise = null, expectedTurns = 0 } = {}) {
  const state = pin?.compaction ?? null
  const advisory = state?.advisory ?? null
  if (!advisory) {
    return join(
      note(
        "No advisory yet. It is computed from the next turn's context measurement; run this command again after a turn.",
      ),
    )
  }
  const held = Math.max(0, (Number(state.turns) || 0) - (Number(state.changedTurns) || 0))
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
    section("steady", [
      ["held for", `${held} turns`],
      ["noise band", (Number(noise?.instability) || 0).toFixed(2)],
    ]),
    note(
      advisory.verdict === "delegate"
        ? "The next step looks like review or verification. A fresh-context subagent judges it better than this history; the Elephant-Goldfish pattern. Route it to a subagent and keep this session for the work."
        : advisory.verdict === "compact-now"
          ? "Compaction pays for itself soon. Run /compact here to compact at the recommended checkpoint now."
          : "Keep working. Compaction is either not safe yet or does not pay for itself within the horizon.",
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
        "Compaction requested. The context hook passes it to the host at the next turn; the marker clears itself even if the host refuses, so this never loops.",
      ),
    )
    return
  }

  if (command === "help" || rest.includes("help")) {
    await show(
      context,
      join(
        section("commands", [
          ["/compact", "this advisory: verdict, economics, and what to do"],
          ["/compact here", "ask the host to compact this session now"],
          ["/compact help", "this text"],
        ]),
      ),
    )
    return
  }

  if (command !== "") {
    await show(context, prose(`unknown command: ${command}. Try /compact help`))
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
 * explicit `/compact here` request (the session side performs the host
 * compaction). Toasts when the advisory verdict changes between turns.
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
                  ? "Compaction advised: it pays for itself soon. Run /compact for details."
                  : verdict === "delegate"
                    ? "Fresh-context review advised: a subagent would judge this step better. Run /compact."
                    : "Compaction verdict changed. Run /compact for details.",
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
          slash: { name: "compact", aliases: ["ctx"], arguments: true },
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
