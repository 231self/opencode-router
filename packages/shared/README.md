# @231self/opencode-shared

Shared runtime for
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router)
and `@231self/opencode-compaction`. Plain ESM, no npm dependencies.

- `cost.js` — normalises every cost shape seen in the wild (OpenCode V2
  catalog, models.dev, V2 client) into per-million-token tier prices
  (`normaliseCost`, `tiersOf`, `mergeCost`, `costSource`) and models a turn's
  cost with a measured cache-hit share (`modelledTurnCost`). The economics
  model adds `contextDebt` (the per-turn carrying cost of the accumulated
  context and the projected cost of the next N turns) and `compactionRoi`
  (per-turn savings, the one-time cache-invalidation premium, break-even
  turns). Missing prices stay `undefined` so displays say "unknown" instead
  of inventing `$0`.
- `tokens.js` — token estimation (`estimateTokens`, `partTokens`,
  `countContextTokens`), V2 active-context measurement
  (`measureSessionContext`, including `type: "compaction"` checkpoints), and
  `cacheHitShare`: the observed cache-read share of a turn's prompt, with the
  denominator `input + cache.read + cache.write` verified against recorded
  provider costs.
- `config.js` / `state.js` — the host adapters both plugins share: the
  `OMLX_ROUTER_*` env vars, the config file schema (including the `{env:}`
  placeholder handling), and the `~/.local/state/omlx-router/` state paths
  (pins, decisions, turns). One source of truth for the security-sensitive
  parsing and schema.
- `judge-client.js` — the oMLX judge client: model discovery, JSON-only chat
  with one repair round, an LRU cache, and timeouts. Each plugin supplies its
  own system message and validates its own verdict shape. `refs.js` holds
  model-reference equality, `kilo.js` is the Kilo host shim, and `format.js`
  is the labelled popup layout shared by the router TUI, the CLI, and Kilo.

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.
