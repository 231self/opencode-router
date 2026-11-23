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

Cost economics need real prices, and not every model has them. `/ctx` keeps
three cases apart instead of printing the same numbers for all of them:
`priced` computes break-even turns and per-turn savings, a flat-rate pool
whose catalog entry is all zeros is shown as `flat plan · $0 marginal` (no
cost savings), and a model with no price entry is shown as `no price data`
with `worth it unknown`. A break-even is never stated when it was not
computed.

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

**`/ctx`** in the TUI opens with the current context size and growth, then the
verdict with its numbers and what to do about it. **`/ctx here`** asks the
host to compact this session; the
request clears itself even if the host refuses. OpenCode already has its own
`/compact`; this plugin leaves that command alone and does not register a
`compact` alias.

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
