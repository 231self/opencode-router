# @231self/opencode-compaction

Context management for [OpenCode](https://opencode.ai) and Kilo sessions:
the deterministic context optimiser, a priced "should I compact now?"
advisory, and the plumbing to compact on request. Install it alongside
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router):

```sh
opencode plugin add @231self/opencode-compaction
```

## Why this exists

An agent session's context is sent again on every turn. Providers bill most
of it as cache reads (cheap), so letting context grow feels free — until the
session nears its window and someone summarizes the history. Summarizing
destroys the prompt cache: the next turn re-writes the compacted prefix at
the cache-write price instead of reading the old one at the cache-read
price. Whether compaction pays is arithmetic, and this plugin does the
arithmetic for you before anything is thrown away.

It also knows when *not* to summarize. Compacting in the middle of a
derivation discards partial work — the failure mode the SelfCompact paper
measured. And for review steps, a fresh subagent with no context often
judges work better than a session drowning in it (the Elephant-Goldfish
pattern). The advisory weighs all three: keep, compact, or delegate.

## What you get

**The optimiser.** When a turn's request does not fit the model's budget,
oversized tool outputs are deduplicated, truncated, and stubbed in a fixed
order until it fits. Recent turns, system instructions, and error outputs
are never touched. If nothing can make it fit, the session is left alone and
the host is told to compact. When the request fits, nothing is changed.

**The advisory.** Each turn computes a verdict and stores it with the
session:

- `compact-now` — a sub-task just finished, the context is under pressure,
  and compaction pays for itself within the expected horizon.
- `delegate` — the next step looks like review or verification. Send it to a
  fresh subagent instead.
- `not-yet` — keep working.

The verdict combines three layers: deterministic signals from the message
shape (a tool burst followed by a summary is a sub-task boundary), the
cache economics (break-even turns, per-turn savings), and — only when the
signals are unclear — a small local judge answering a rubric. The verdict
cannot flicker: changes wait out a cooldown that grows with the judge's
measured instability.

The cache hit rate is the share the provider served from cache over the last
five steps on the current model, or the router's turn log after a plugin
restart. An idle gap longer than the provider's cache lifetime is treated as a
cold cache. `/ctx` shows the rate, its source, and the sample
count; the configured `pin.cacheHitRatio` is only the fallback before the
first measurement.

The decision horizon stays `expectedTurns`, but `/ctx` also shows the same
economics at 3, 8, and 15 turns (`horizons`), so you can see where the answer
flips instead of guessing when the session ends.

Context size comes from the prompt the provider billed — `input +
cache.read + cache.write` on the newest request — whenever a request has run
since the last compaction. Counting messages measures parts the host prunes
from the request, so the message estimate is only the fallback, and `/ctx`
says which one it is showing.

Cost economics need real prices, and not every model publishes them. `/ctx`
keeps the cases apart instead of printing the same numbers for all of them.
A model with its own prices computes break-even turns and per-turn savings.
A flat-rate pool publishes zeros for a model whose list price lives in a
sibling catalog entry — `xiaomi-token-plan-sgp/mimo-v2.6-pro` and
`xiaomi/mimo-v2.6-pro` are the same model — so the comparison is computed at
that list price and labelled `priced at list price · xiaomi/mimo-v2.6-pro`,
alongside the plan fact that it costs you nothing either way. A `-free` model
with no priced sibling, and a model with no catalog entry at all, are shown as
`no reference price` and `no price data`. A break-even is never stated as your
own cost when it was not computed from your own prices.

Because a plan makes cost irrelevant but the window finite, `/ctx` reports
capacity next to the size: the model's limit, the headroom left, and the share
free. When headroom drops below 15% the closing note says so rather than
telling you to keep working.

**`/ctx here`** asks the host to compact this session; the host runs an
admitted compaction at the next step boundary. `/ctx` reports what it did with
the request (`last /ctx here`, `outcome accepted` or `failed · http 409`), and
only a status code or an error name is ever persisted — an error message may
echo prompt text. The request never repeats on its own.

**Plan billing.** A flat-rate plan charges no cash per token, but every token
burns a share of a finite allowance. `/ctx plan` sets up the plan facts (price,
allowance, credit weights) — either from the built-in catalog of published
tiers (Xiaomi MiMo Token Plan, ChatGPT plans) or typed in by hand — and records
them in the config with their source and check date. On first load with a
flat-plan model and no billing recorded, the plugin asks once; "skip" and "pay
per token" are recorded too, so the question never repeats. With a plan
recorded, `/ctx` prices the economics in plan credits at your own rates (`basis
plan rate · your own credits`), shows the allowance burn (`12.4B of 82.0B
credits (15% · renews monthly)`), and prices a cache expiry as the credit
premium it charges over staying hot. Plan prices are your own bill, so unlike a
sibling's list price they may veto a compaction that does not pay.

Several plans can be recorded at once. `/ctx plan` adds a plan beside the ones
already on file rather than replacing them, and every plan is attributed to the
models it covers — the catalog's weight table says so for Xiaomi, a `models`
list says so for anything else. The sidebar and `/ctx report` show each plan
its own burn, because one blended figure would hide which allowance is the one
running out. A model no plan claims keeps its catalog price.

Not every plan can be priced. A usage-window plan (the ChatGPT ones, for
example) publishes a monthly price and limits like "5x more usage per 5-hour
session", never a token allowance. There is then no `N` to divide the price by,
so the tool records the plan by name and price, says `allowance not published`,
and computes no shadow price for it. That is a recorded plan, not a guess.

Which prices apply to a model is decided in one shared place,
`@231self/opencode-shared/cost-resolution.js`, used by this plugin and the
router alike: plan, then the public price table, then the model's own catalog
price, then a sibling entry, then none. The catalog sits below the public
table because it is the host's own opinion of a price and is not always right;
a published rate is checkable, so it wins whenever both speak. The rule carries
the `ownBill` flag that decides whether money may veto — your own bill may, a
stand-in at someone else's list price may not.

**`/ctx plan refresh`** re-reads the plan's price from a public tracker feed.
[LimitDex](https://limitdex.com) publishes its dataset as free JSON, read once
a day from vendor pricing pages, with the vendor's exact limit wording and a
check date. The command is the only path to the network: nothing is fetched on
a turn, a failure keeps the facts already recorded, and the reply shows what
the feed read (`$20/mo · read 2026-11-24`) beside whether the allowance is
published. The feed can confirm a price; it cannot supply an allowance that
does not exist in public.

The compacted size and the one-time cost are calibrated from real compactions.
After a compaction the plugin observed as it happened, it compares its
prediction with the size that actually followed and keeps the rolling error. A
checkpoint first noticed after a restart is old history and records no
prediction: using the context as it stands now as the "post-compaction" size
produced a 2,352% phantom error on a session that had grown for two days.
The first post-compaction turn's reported reads, writes, and misses replace the
modelled rebuild cost. The summary request is measured from the completed checkpoint's
own token usage and model when OpenCode supplies them; otherwise its cost is
estimated from the context it had to read and the summary it produced.

**`/ctx`** in the TUI opens the action menu: report, compact now, plan setup,
help. **`/ctx report`** shows the advisory directly — the current context
size and growth, then the verdict with its numbers and what to do about it.
**`/ctx here`** asks the
host to compact this session; the
request clears itself even if the host refuses. OpenCode already has its own
`/compact`; this plugin leaves that command alone and does not register a
`compact` alias.

**`/ctx menu`** opens the same menu explicitly.
**`/ctx plan refresh`** re-reads the plan price from the tracker feed.
**`/ctx help [command]`** is the command reference: every command with its
usage line, and naming one command shows its detail. An unrecognised command
points at the help instead of failing silently.

**Sidebar.** Both plugins add a block to the OpenCode sidebar. The
compaction block leads with the verdict — `verdict compact now · pays back in
3 turns`, `verdict keep working`, or `verdict delegate · looks like review` —
then the evidence behind it: window use (`ctx 500K/1.0M · 52% free`), each
plan and its allowance burn, and the cache-expiry exposure. The conclusion
comes first because that is the point of the block; the numbers explain it.
The router block leads the same way: `running deepseek-flash · kept for cache`
(or `switched · cheaper`, `pinned by you`, …) — which model this session is on
and the reason the decision log recorded — then the policy that decided it
and the evidence: pin, quality score, judge. The blocks
refresh on model changes and finished turns. Where the host
has no OpenTUI or no sidebar slot, the blocks are skipped and everything else
works.

## Settings

In `~/.config/omlx-router/config.json`:

```json
{
  "compaction": {
    "enabled": true,
    "expectedTurns": 8,
    "baseCooldown": 3,
    "judgeRefine": true,
    "summaryTokens": 1200,
    "horizons": [3, 8, 15],
    "cacheWindow": 5
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the advisory off. |
| `expectedTurns` | `8` | Decision horizon for "does compaction pay?" |
| `baseCooldown` | `3` | Turns a verdict change must wait. |
| `judgeRefine` | `true` | Let the judge resolve unclear cases. |
| `summaryTokens` | `1200` | Assumed size of a compaction summary. |
| `horizons` | `[3, 8, 15]` | Turns shown in the `/ctx` projection table. |
| `cacheWindow` | `5` | Provider steps used for the measured hit rate. |
| `cacheTtlMs` | `0` | Global cache lifetime override; `0` uses the provider table. |
| `cacheTtlByProvider` | Anthropic/OpenAI 5 min | Per-provider idle expiry; `0` disables it. |

Plan billing lives in the same file, one level up:

```json
{
  "billing": [
    { "vendor": "xiaomi-mimo", "tier": "max", "renewsDay": 1 },
    { "vendor": "openai-codex", "tier": "plus", "renewsDay": 1 }
  ]
}
```

`billing` is a list of plans — one entry per subscription you pay for. A
single record still works and is read as a list of one. `/ctx plan` writes the
list for you and appends to it; running it again adds another plan rather than
replacing what is there. Each plan is attributed to the models it covers, so
every model is priced at its own plan's rates.

Each entry names a built-in catalog entry (`vendor` and `tier` — published
Xiaomi MiMo Token Plan tiers and ChatGPT plans, with source and check date)
or carries its own numbers instead: `name`, `priceUsd`, `allowanceCredits`
(or `allowanceTokens`), `weights` (`cacheHitInput`, `cacheMissInput`,
`output`), `models` (which models the plan covers), `renewsDay`, and `source`.
Leave the allowance out for a plan that publishes none:

```json
{ "billing": [{ "vendor": "openai-codex", "tier": "plus", "renewsDay": 1 }] }
```

That record is kept and shown as `ChatGPT Plus · $20/mo · allowance not
published`. No burn percentage and no shadow price are computed for it,
because the vendor publishes no token allowance to divide by. `"billing": {
"payg": true }` records pay-per-token and `{ "skipped": true }` records an
explicit skip; both suppress the first-init question. The record never
contains credentials or prompt text.

The file is read as strict JSON, so keep comments out of it.

## Calibration

The judge's compaction verdicts are not perfectly stable. Measure how much
they move and the advisory's cooldown will respect it:

```sh
bun run compaction:calibrate --repeat 3
```

This writes `~/.local/state/omlx-router/compaction-noise.json`. It needs the
local judge running (the same oMLX endpoint the router uses).

Real compactions update `~/.local/state/omlx-router/compaction-calibration.json`
on their own. It stores the rolling summary size, the summary request's token
buckets, the first post-compaction turn's buckets, and the error of the last
size prediction per model. Delete it to return to the configured assumptions.

```sh
bun run compaction:report
```

That is a checkout command, not part of the installed package. It prints the
measured summary size, the last predicted-versus-actual size, the mean absolute
relative error, the rebuild buckets, and the sample counts per model. If the
prediction error stays large, the summary estimate is not earning its place
yet. The means are exponential after 20 samples, not a full sliding window.

The cache-lifetime defaults for Anthropic and OpenAI are configurable
assumptions about those providers, not guarantees. Unknown providers do not
expire by time. The calibration stream is the OpenCode V2 event API; the Kilo
transform path has no equivalent measurement and uses the fallbacks. If
another process holds the calibration lock, the update is skipped and the
advisory still runs; a crashed writer's `.lock` file needs manual removal.

Two other research tools:

```sh
bun run compaction:ablation --repeat 3              # fixed vs signal vs hybrid, on fixtures
bun run tolerance:eval --repeat 2 --model my-model  # per-model degradation under compaction
```

The ablation is offline by default; add `--judge` to use the live oMLX judge.
The signal and hybrid arms run the shipped advisory, including the economics
veto and the cooldown. Repeats are real samples. The tolerance bench scores
each model with its full context and with a compacted checkpoint; a
deliberately lossy control task is reported separately so a model is not
punished for refusing to answer from missing evidence.

## Current limits

The cache hit rate is measured from provider-reported usage. The compacted
size is calibrated from observed checkpoints, and the rebuild cost comes from
the first post-compaction turn when the host reports it. When OpenCode includes
the compaction request's own tokens on the checkpoint, that is used; otherwise
the summary cost is estimated. Native and automatic compactions are calibrated
the same way, because the checkpoint carries the fields. `/ctx` labels each
number `measured`, `estimated`, `turn log`, or `modelled` so the difference
stays visible.

## Privacy

The advisory works on signals: token counts, message roles, tool names,
growth. Decision state stores numbers and booleans. The judge call is the
one place prompt text is used, and it is never written to logs or state.

## Development

```sh
bun test packages/compaction/tests    # offline suite (judge mocked)
bun run test:rust                     # the optimise core
```

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.
