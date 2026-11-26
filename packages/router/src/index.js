import { readConfig } from "@231self/opencode-shared/config.js"
import { createKiloContext } from "@231self/opencode-shared/kilo.js"
import { VERSION } from "./version.js"
import { Router } from "./router.js"
import { refreshPricingIfStale } from "./pricing.js"
import { refreshQualityIfStale } from "./quality.js"
import { TELEMETRY_EVENTS, Telemetry } from "./telemetry.js"
import { stopDashboard } from "./web.js"
import { loadCore } from "./wasm.js"

/**
 * One default export for both hosts:
 * - OpenCode V2 reads `id` and calls `setup(ctx)`.
 * - Kilo calls `server(input)` (V1 plugin API).
 */
export default {
  id: "omlx-router",

  async setup(ctx) {
    const { config, path, seeded, error } = readConfig({ seed: ctx?.options ?? {}, write: true })
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

    // Hooks are registered so wiring is exercised. The router owns all logic
    // and never logs prompt or message text.
    const telemetry = config.telemetry?.enabled === false ? null : new Telemetry({ host: "opencode" })
    const router = new Router({
      ctx,
      host: "opencode",
      core,
      telemetry,
      configOptions: ctx?.options ?? {},
    })

    if (config.quality?.source === "lmarena") {
      void refreshQualityIfStale({ config }).catch((cause) => {
        if (config.debug) {
          console.error("[omlx-router] quality refresh failed:", String(cause?.message ?? cause))
        }
      })
    }
    void refreshPricingIfStale({ config }).catch((cause) => {
      if (config.debug) {
        console.error("[omlx-router] pricing refresh failed:", String(cause?.message ?? cause))
      }
    })
    await register("prompt", (event) => router.prompt(event))
    await register("compaction", (event) => router.compaction(event))
    await register("retry", (event) => router.retry(event))
    await register("experimental.model.resolve", (event) => router.resolveModel(event))
    try {
      disposers.push(await ctx.tool.hook("execute.after", (event) => router.toolAfter(event)))
    } catch (cause) {
      coreError ??= `tool hook: ${cause?.message ?? cause}`
    }

    if (telemetry && ctx.event?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          const events = ctx.event.subscribe({ types: TELEMETRY_EVENTS, signal: controller.signal })
          await telemetry.subscribe(events)
        } catch (cause) {
          if (config.debug) console.error("[omlx-router] telemetry stopped:", String(cause?.message ?? cause))
        }
      })()
      disposers.push({ dispose: () => controller.abort() })
    }

    // The local dashboard (if `/router web` started one) closes with the
    // plugin, never outlives it holding a port.
    disposers.push({
      dispose: () => {
        stopDashboard().catch(() => {})
      },
    })

    if (config.debug) {
      console.log("[omlx-router] loaded", {
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
    void refreshPricingIfStale({ config }).catch(() => {
      // Pricing is a fallback; a failed refresh must not block the plugin.
    })
    let core = null
    try {
      core = await loadCore()
    } catch (cause) {
      if (config.debug) console.error("[omlx-router] kilo core unavailable:", String(cause?.message ?? cause))
      return {}
    }
    const ctx = createKiloContext(input, config)
    if (!ctx) return {}

    const router = new Router({ ctx, host: "kilo", core, appliedMode: "boundary" })

    return {
      "chat.message": async (event, output) => {
        const sessionID = event?.sessionID
        if (!sessionID || String(sessionID).startsWith("title-")) return
        const text = (output?.parts ?? [])
          .filter((part) => part?.type === "text")
          .map((part) => part.text ?? "")
          .join("\n")
        await router.prompt({ sessionID, prompt: { text, files: [] } })
      },

      "tool.execute.after": async (hookInput, hookOutput) => {
        if (!hookInput?.sessionID) return
        const failed = Boolean(hookOutput?.error)
        router.toolAfter({
          sessionID: hookInput.sessionID,
          tool: hookInput.tool,
          status: failed ? "error" : "completed",
        })
      },
    }
  },
}
