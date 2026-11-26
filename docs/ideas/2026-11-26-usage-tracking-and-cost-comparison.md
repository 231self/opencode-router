# Two future ideas

Recorded 2026-11-26. Both build on `docs/data-sources.md`; neither is
scheduled. Kept here so the current work stays aligned with where it could
go.

## 1. Online usage tracking — aggregated, reported from opencode

A website where people track their aggregated usage, reported from opencode
to a central system. Start local: the collector runs on localhost first, and
only later becomes an online service.

- Each opencode instance (or the router plugin) reports usage numbers —
  tokens, credits, turns, spend per model — to the collector.
- The collector aggregates across sessions and machines and shows the
  history online.
- The data model is the one already used locally: `type` (payg /
  subscription) → `vendor` → `plan`, plus measured workload facts.
- The privacy rule carries over unchanged: no prompt text, no tool output,
  no credentials. Only counts, sizes, and prices.
- The plan catalog and the public price list are the shared reference data;
  what a user reports is only their own usage against it.

This is the consumer product version of what the sidebars already show
locally: an individual's inventory of context, priced.

## 2. Cost comparison engine — payg vs plans, across providers

Given one measured workload, price it every way it could be bought: payg at
each provider, each provider's plans, and mixtures. The output answers "what
should I buy" and "where should this run", with every figure labelled
measured or projected per `docs/data-sources.md`.

- The workload is first-party: the user's own turn log (sizes, cache mix,
  cadence), not a synthetic benchmark.
- Equivalence across providers needs care: models are not interchangeable,
  so comparisons are per capability class or per the models the user
  actually runs.
- Plan cells that publish no allowance size stay unpriced — the engine
  shows the gap instead of filling it with a guess.
- A natural companion to the EOQ cadence work in `docs/paper/`: the
  comparison is the empirical side of the same economics.

The plugin needs neither of these today. The plugin needs only the unit
price described in the next conversation: one price per model the user
uses, weighed by the router and the compaction advisory.
