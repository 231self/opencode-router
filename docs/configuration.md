# Configuration reference

One file is authoritative: `~/.config/omlx-router/config.json`. Plugin options in
`opencode.jsonc` (or Kilo config) are read **once** to seed the file when it does
not exist; afterwards the file wins, so manual edits and the TUI/CLI always take
effect. `/router status` warns if the option seed and the file drift.

Environment overrides (useful for tests and multi-profile setups):

| Variable | Effect |
|---|---|
| `OMLX_ROUTER_CONFIG` | Config file path |
| `OMLX_ROUTER_STATE` | State root (default `~/.local/state/omlx-router`) |
| `OMLX_ROUTER_HOST` | CLI default host (`opencode` or `kilo`) |
| `OMLX_ROUTER_FAVORITES` | Host model-state file used for favorites |

## Top level

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch; hooks stay registered but do nothing |
| `policy` | `"cost"` | `cost`, `quality`, or `latency` |
| `policyWeights` | `null` | Partial override of the preset: `{cost, quality, latency}` |
| `policyByClass` | `{}` | Per-turn-class overrides, merged over `policyWeights` |
| `debug` | `false` | Adapter debug logs (never prompt text) |

Weights are clamped at zero; if all three resolve to zero the preset is used.
Turn classes are `trivial`, `routine`, `agentic`, `planning`, `review`, and
`tool_continuation`. Example:

```json
{
  "policy": "cost",
  "policyWeights": { "cost": 0.6, "quality": 0.35, "latency": 0.05 },
  "policyByClass": {
    "planning": { "cost": 0.1, "quality": 0.8, "latency": 0.1 },
    "trivial": { "cost": 0.85, "quality": 0.1, "latency": 0.05 }
  }
}
```

Weights select a model within a turn. Pin thresholds decide whether the router
switches at all.

## `telemetry`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Record per-turn timing in `turns.jsonl` |

Telemetry subscribes to the host's public events and writes one record per
turn: routing time (including the local judge), remote model-call time, tool
time, time to first token, steps, tokens, and cost. It stores a hashed session
id and model ids, never prompt or tool text. Disable it if you do not want the
extra file; decision records still contain `timing.routeMs/judgeMs`.

## `pool`

| Key | Default | Notes |
|---|---|---|
| `source` | `"favorites"` | `favorites`, `list`, or `available` |
| `models` | `[]` | Used with `source: "list"`; `provider/model` or `provider/model#variant` |
| `include` | `[]` | Glob patterns force-added after source resolution |
| `exclude` | `[]` | Glob patterns dropped; matched against `provider/model` and the bare id |
| `maxModels` | `8` | Candidate table size sent to the judge |
| `requireTools` | `true` | Drop models without tool calling |
| `minContext` | `32000` | Minimum context window |
| `localCostZero` | `true` | Price loopback providers at zero, even when the catalog has a price |

### Local models

A model is local when its provider base URL is loopback or its provider is in
`latency.localProviders`. With `localCostZero` on, its expected cost is zero and
it competes on quality alone.

Free local models get a size-based default quality (overrides still win):

| Size | Quality |
|---|---:|
| under 3B | 0.35 |
| 3–8B | 0.45 |
| 8–30B | 0.55 |
| 30B and above | 0.72 |
| unknown | 0.40 |

`limits.allowLocalForComplexity` (default 2) still drops a local model above that
complexity when its quality is below the turn's requirement. A 27B local model
clears routine edits; a 4B model stays on trivial turns.

Favorites live in the host state file: `~/.local/state/opencode/model.json` or
`~/.local/state/kilo/model.json`, field `favorite`. Empty favorites produce an
empty pool and a warning in `/router pool`; routing leaves the host model
unchanged. This is deliberate: the router never opts into every model on your
behalf. The TUI shows a startup hint and `/router pool` offers favorites, an
explicit list, or the explicit `available` opt-in. An unknown source also
selects nothing.

## `judge`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Disable to use deterministic triage only |
| `baseURL` | `http://127.0.0.1:1234/v1` | oMLX OpenAI-compatible endpoint |
| `model` | `"auto"` | `auto` picks the smallest advertised model by parameter size |
| `apiKey` | `"{env:OMLX_API_KEY}"` | `{env:NAME}` expanded; empty means no Authorization header |
| `timeoutMs` | `5000` | Per-request timeout; the 4B judge is usually under 1 s, but cold/first calls can take 3-4 s. Use 20000+ for a large judge |
| `cacheTtlMs` | `600000` | Verdict cache TTL |
| `cacheSize` | `128` | LRU entries |

### `judge.provision`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Allows the plugin to *offer* a download; consent is always required |
| `backend` | `"auto"` | `auto` probes the endpoint, `omlx` forces the admin API, `none` disables downloads |
| `repo` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | Recommended judge |
| `adminApiKey` | `{env:OMLX_ADMIN_API_KEY}` | oMLX main key; sub-keys cannot administer downloads |
| `readSettingsKey` | `true` | Fall back to `auth.api_key` in `~/.omlx/settings.json` |
| `hfToken` | `{env:HF_TOKEN}` | Optional, for gated Hugging Face repos |
| `allowNonMlx` | `false` | Permit repositories that do not look MLX-compatible |

No download starts without a TUI confirmation or a CLI `y` / `--yes`. Downloads
use oMLX's admin API (`/admin/api/hf/*`), so the model appears in oMLX's model
directory and is rediscovered on completion. The admin key is never logged.

### `failover`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Route around provider failures instead of hammering a dead model |
| `cooldownMs` | `300000` | 429 cooldown; the model is excluded from routing |
| `serverCooldownMs` | `60000` | 5xx, timeout, and overload cooldown |
| `authCooldownMs` | `300000` | 401/402/403, billing, and quota cooldown (5 min) |
| `redirectTtlMs` | `60000` | How long a queued same-turn redirect stays valid |
| `retryDelayMs` | `1000` | Delay used only when the host decided not to retry |

On a provider failure the plugin blocks the model for the session, clears the
pin, and queues the next candidate from the last decision. OpenCode's
`model.resolve` hook performs the swap on the retry; if it never fires, the
blocked model is simply excluded from the next turn. Auth, payment, billing, and
quota failures block the whole provider; 429 and 5xx block the model. 400-class
request errors are not treated as provider failures. A switch requires another
eligible model or provider in the pool.

## `pin`

| Key | Default | Notes |
|---|---|---|
| `mode` | `"balanced"` | `cache` (sticky), `balanced` (default), or `switch` (best every turn) |
| `switchThreshold` | `0.12` | Keep the incumbent unless the challenger wins by more; floored at the judge's calibrated verdict-noise band when one has been measured (`bun run judge:calibrate`) |
| `idleTtlMs` | `300000` | Re-route after this much idle time |
| `maxAgeMs` | `1800000` | Release a pin after 30 minutes even while active |
| `maxTurns` | `8` | Reconsider a pin after this many turns |
| `costSwitchRatio` | `4` | Switch when the incumbent costs more than 4× an adequate challenger |
| `flipFlopTurns` | `3` | Do not switch back to a model used in the last N turns |
| `cacheHitRatio` | `0.8` | Assumed cache-read share when costing a pinned model and nothing is measured yet. Once the session has logged turns, the pinned model's measured share from its last turn is used instead; a pin that has not served a turn is priced cold. `0` disables the discount |

## `optimiser`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | No pruning when false (token measurement continues) |
| `reserveOutputTokens` | `8192` | Capped by the model's output limit |
| `safetyTokens` | `1024` | Extra headroom |
| `maxToolTokens` | `2000` | Outputs above this are truncated |
| `keepRecentToolOutputs` | `3` | Never stubbed |
| `keepRecentTurns` | `2` | Never stubbed or truncated |

## `limits`

| Key | Default | Notes |
|---|---|---|
| `shortfallTolerance` | `0.2` | Candidate excluded when required quality exceeds it by more |
| `allowLocalForComplexity` | `2` | Local models are blocked above this complexity unless overridden |
| `expectedOutputTokens` | `1200` | Cost estimate baseline; agentic turns use `max(expected, input/12)` |
| `contextFitRatio` | `0.9` | Required input must fit within this share of the window |

## `quality` and `latency`

| Key | Default | Notes |
|---|---|---|
| `source` | `"auto"` | `auto`, `epoch`, `lmarena`, or `manual` |
| `sources` | `["epoch", "lmarena"]` | Priority order used by `auto` |
| `refreshHours` | `24` | Cache age before a background refresh |
| `timeoutMs` | `20000` | Dataset request timeout |
| `lmarena.dataset` | `lmarena-ai/leaderboard-dataset` | Public dataset |
| `lmarena.config` | `webdev` | Code Arena subset |
| `lmarena.split` | `latest` | Leaderboard snapshot |
| `epoch.eciURL` | `https://epoch.ai/data/eci_scores.csv` | Epoch capability index |
| `epoch.benchmarksURL` | `https://epoch.ai/data/benchmarks.csv` | Coding benchmark rows |
| `epoch.coding` | `true` | Prefer SWE-bench Verified / MirrorCode over ECI |
| `overrides` | `{}` | Manual `provider/modelID` scores; always win |

Epoch is read first: SWE-bench Verified or MirrorCode when the model has a
coding row, otherwise its ECI. LMArena Code Arena fills the rest. Each source is
normalised into the same 0.35–0.97 band, cached at
`~/.local/state/omlx-router/quality.json`, and merged by `sources` order.
Unmatched models keep the heuristic. `/router quality` shows per-source counts
and age; `/router pool` shows the source used per model.

```jsonc
{
  "quality": {
    "overrides": { "omlx/Qwen3.8-27B-MLX-4bit": 0.72 },
    "source": "lmarena"
  },
  "latency": {
    "overrides": { "openai/gpt-6.1-sol": 1400 },
    "localProviders": ["omlx"]
  }
}
```

Without a score, quality is a documented heuristic (price percentile, parameter
size, context size, reasoning support), not a benchmark. Free local models use
the size tiers above. Overrides are keyed `provider/modelID`.

## `pricing`

| Key | Default | Notes |
|---|---|---|
| `source` | `"modelsdev"` | `modelsdev` or `off` |
| `sources` | `["modelsdev", "litellm"]` | Priority order; every enabled source is fetched |
| `refreshHours` | `24` | Cache age before a background refresh |
| `timeoutMs` | `20000` | Price table request timeout |
| `url` | `https://models.dev/api.json` | Override for the first source |

Host catalogs are incomplete: OpenCode reports `cost: []` for some providers and
all-zero prices for others, which used to display as `$0`. When the catalog has
no price, the router falls back to public price tables — models.dev first, then
LiteLLM — which need no access token. Only missing or zero fields are filled, so
first-party billing still wins when the host does report it. Prices are cached at
`~/.local/state/omlx-router/pricing.json`.

```jsonc
{
  "pricing": {
    "source": "modelsdev",
    "sources": ["modelsdev", "litellm"],
    "refreshHours": 24
  }
}
```

`/router pricing` shows each pool model with its source; `/router pricing
refresh` refetches. `opencode-model-router pricing provider/model` looks up one
model. Set `"source": "off"` to use only what the host reports.

## `billing`

What you pay for, so plan rates can replace list prices. The schema is
**type → vendor → plan**:

| Level | Values | Decides |
|---|---|---|
| `type` | `subscription`, `payg` | Which economics apply: plan rates, or list prices |
| `vendor` | catalog key or `custom` | Which mechanism and published parameters: credits, dollar budget, token quota, usage window |
| `plan` | one of the vendor's plans | The exact numbers: price, allowance, per-model rates |

A subscription record names one vendor and one of its plans:

```json
{ "billing": { "type": "subscription", "vendor": "xiaomi-mimo", "plan": "max", "renewsDay": 1 } }
```

`payg` is the type with no vendor and no plan — list prices stand and nothing
is priced at plan rates. Several plans may be held at once (a JSON array); each
covers the models it names in `models`, and a plan it does not name keeps list
prices. `/ctx plan` and `/router plan` write this record from the wizard; the
full catalog lives in `packages/shared/src/plan.js` and extends through
`~/.config/omlx-router/plans.json` (a vendor has `plans`; `tiers` is the
earlier name for the same table and still reads).

Legacy keys are read unchanged: `tier` is the older name for `plan`, and
`payg: true` the older marker for `"type": "payg"`. A plan whose allowance the
vendor does not publish is recorded unpriced — it is never given an invented
allowance, and its display names the allowance that is consumed.

## `web`

The local dashboard, started on demand by `/router web` and closed by
`/router web stop`.

| Key | Default | Notes |
|---|---|---|
| `port` | `7410` | The dashboard's port. Busy ports fall back to an ephemeral one and the reported URL says where it landed. |

The bind address is `127.0.0.1` and is **not** configurable: the dashboard
is local by construction, and that line is the wall between it and any
hosted service. Every response is an allow-list projection — counts, sizes,
prices, and labels only.

## `subagents`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Route child sessions |
| `overrideExplicitModel` | `false` | When false, an agent's configured model is a forced pin |
| `default` | `{policy:"cost", qualityFloor:0}` | Fallback policy for children |
| `agents` | see below | Per-agent policy |

```jsonc
{
  "subagents": {
    "agents": {
      "explore": { "policy": "latency", "qualityFloor": 0.45, "minContext": 128000 },
      "general": { "policy": "cost",    "qualityFloor": 0.55 },
      "review":  { "policy": "quality", "qualityFloor": 0.75 },
      "plan":    { "policy": "quality", "qualityFloor": 0.8 }
    }
  }
}
```

Per-agent keys: `policy`, `qualityFloor`, `minContext`, `requireTools`,
`maxComplexity` (local-model ceiling).

## Examples

Explicit two-model pool, cost-first, 4B judge:

```jsonc
{
  "policy": "cost",
  "pool": {
    "source": "list",
    "models": ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]
  },
  "judge": { "model": "Qwen3-4B-Instruct-2507-4bit", "timeoutMs": 5000 },
  "quality": { "overrides": { "deepseek/deepseek-v4-pro": 0.9 } }
}
```

All enabled models, latency-first, local excluded:

```jsonc
{
  "policy": "latency",
  "pool": { "source": "available", "exclude": ["omlx/*"] }
}
```

Favorites with a local model force-added:

```jsonc
{
  "pool": {
    "source": "favorites",
    "include": ["omlx/*"],
    "minContext": 128000
  },
  "quality": { "overrides": { "omlx/Qwen3.8-27B-MLX-4bit": 0.72 } }
}
```
