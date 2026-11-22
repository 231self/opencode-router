import { readConfig } from "@231self/opencode-shared/config.js"
import { JudgeClient } from "@231self/opencode-shared/judge-client.js"
import { createKiloContext } from "@231self/opencode-shared/kilo.js"
import { refOf } from "@231self/opencode-shared/refs.js"

import { contextMessages, runContext } from "./context.js"
import { UsageTracker } from "./usage.js"
import { VERSION } from "./version.js"
import { loadCore } from "./wasm.js"

/**
 * One default export for both hosts:
 * - OpenCode V2 reads `id` and calls `setup(ctx)`.
 * - Kilo calls `server(input)` (V1 plugin API).
 *
 * The plugin advises and enables context compaction; it never fires
 * compaction itself. It owns the optimiser surface (moved from the router).
 */
export default {
  id: "omlx-compaction",

  async setup(ctx) {
    const options = ctx?.options ?? {}
    const read = () => readConfig({ env: process.env, seed: options, write: true }).config
    const { path, seeded, error } = readConfig({ seed: options, write: true })
    let core = null
    let coreError = null
    try {
      core = await loadCore()
    } catch (cause) {
      coreError = String(cause?.message ?? cause)
    }

    const disposers = []
    const register = async (name, handler) => {
      try {
        disposers.push(await ctx.session.hook(name, handler))
      } catch (cause) {
        coreError ??= `hook ${name}: ${cause?.message ?? cause}`
      }
    }

    // The judge refines "uncertain" compaction verdicts only; it is created
    // once and reconfigured per turn so settings changes apply live.
    const judge = new JudgeClient({ config: read().judge, env: process.env })
    const usage = new UsageTracker({ host: "opencode" })

    await register("context", (event) => {
      const config = read()
      judge.configure(config.judge)
      return runContext({ host: "opencode", env: process.env, ctx, config, core, event, judge, usage })
    })

    // Provider-reported cache usage, kept in memory per session. The router
    // persists the same numbers; reading its turn log seeds a plugin restart.
    if (ctx.event?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          const events = ctx.event.subscribe({
            types: ["session.step.started", "session.step.ended"],
            signal: controller.signal,
          })
          for await (const event of events) {
            const data = event?.data ?? {}
            const at = Number(event?.created) || Date.now()
            if (event?.type === "session.step.started") {
              usage.noteStepStart({
                sessionID: data.sessionID,
                model: data.model,
                at,
                assistantMessageID: data.assistantMessageID,
              })
            } else if (event?.type === "session.step.ended") {
              usage.noteStepEnd({
                sessionID: data.sessionID,
                tokens: data.tokens,
                at,
                assistantMessageID: data.assistantMessageID,
              })
            }
          }
        } catch {
          // Never stringify the exception: its payload may contain prompt text.
          if (read().debug) console.error("[omlx-compaction] usage stream stopped")
        }
      })()
      disposers.push({ dispose: () => controller.abort() })
    }

    if (read().debug) {
      console.log("[omlx-compaction] loaded", {
        version: VERSION,
        config: path,
        seeded,
        abi: core?.abi ?? null,
        error: error ?? coreError,
      })
    }

    return () => {
      for (const registration of disposers) {
        try {
          registration?.dispose?.()
        } catch {
          // Cleanup must not mask unload.
        }
      }
    }
  },

  async server(input) {
    const { config } = readConfig({ write: true })
    let core = null
    try {
      core = await loadCore()
    } catch (cause) {
      if (config.debug) console.error("[omlx-compaction] kilo core unavailable:", String(cause?.message ?? cause))
      return {}
    }
    const ctx = createKiloContext(input, config)
    if (!ctx) return {}

    const assistantModel = (messages) => {
      for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info
        if (info?.role === "assistant" && info?.model?.providerID) return refOf(info.model)
      }
      return null
    }

    return {
      "experimental.chat.messages.transform": async (_hook, output) => {
        try {
          const reference = assistantModel(output?.messages)
          if (!reference) return
          const models = await ctx.model.list()
          const found = models.find(
            (model) => model.providerID === reference.providerID && (model.id ?? model.modelID) === reference.id,
          )
          if (found) contextMessages({ core, config, model: found, messages: output.messages })
        } catch {
          // Transform is best-effort in Kilo.
        }
      },
    }
  },
}
