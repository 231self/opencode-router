use crate::envelope::Envelope;
use crate::types::{AgentPolicy, Candidate, Pin, PoolModel, Settings, Verdict, WeightOverride};

pub struct ScoreContext<'a> {
    pub settings: &'a Settings,
    pub verdict: &'a Verdict,
    pub envelope: &'a Envelope,
    pub pin: Option<&'a Pin>,
    pub agent: Option<&'a AgentPolicy>,
    pub parent: Option<&'a crate::types::ModelRef>,
    pub policy: &'a str,
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn percentile(value: f64, values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.5;
    }
    let mut less = 0usize;
    let mut equal = 0usize;
    for candidate in values {
        if *candidate < value - 1e-9 {
            less += 1;
        } else if (*candidate - value).abs() <= 1e-9 {
            equal += 1;
        }
    }
    (less as f64 + equal as f64 * 0.5) / values.len() as f64
}

#[derive(Debug, Clone, Copy)]
pub struct Weights {
    pub cost: f64,
    pub quality: f64,
    pub latency: f64,
}

pub fn preset(policy: &str) -> Weights {
    match policy {
        "quality" => Weights {
            cost: 0.1,
            quality: 0.8,
            latency: 0.1,
        },
        "latency" => Weights {
            cost: 0.2,
            quality: 0.2,
            latency: 0.6,
        },
        _ => Weights {
            cost: 0.6,
            quality: 0.3,
            latency: 0.1,
        },
    }
}

fn apply(mut weights: Weights, overrides: Option<&WeightOverride>) -> Weights {
    if let Some(overrides) = overrides {
        if let Some(cost) = overrides.cost {
            weights.cost = cost.max(0.0);
        }
        if let Some(quality) = overrides.quality {
            weights.quality = quality.max(0.0);
        }
        if let Some(latency) = overrides.latency {
            weights.latency = latency.max(0.0);
        }
    }
    weights
}

/// Resolve the active weights: preset, then global overrides, then the
/// per-turn-class override for this envelope.
pub fn weights(settings: &Settings, turn_class: &str, policy: &str) -> Weights {
    let base = apply(preset(policy), settings.policy_weights.as_ref());
    let resolved = apply(base, settings.policy_by_class.get(turn_class));
    let total = resolved.cost + resolved.quality + resolved.latency;
    if total.is_finite() && total > 0.0 {
        resolved
    } else {
        preset(policy)
    }
}

pub fn required_quality(verdict: &Verdict, turn_class: &str, floor: f64) -> f64 {
    let base = match verdict.complexity {
        1 => 0.25,
        2 => 0.40,
        3 => 0.55,
        4 => 0.75,
        _ => 0.90,
    };
    let reasoning = if verdict.reasoning_need == "high" {
        0.10
    } else {
        0.0
    };
    let class = if turn_class == "planning" || turn_class == "review" {
        0.05
    } else {
        0.0
    };
    clamp01(base + reasoning + class).max(clamp01(floor))
}

/// Parse a parameter count out of a model name (`27B`, `Qwen3-4B`, `1.7b`).
pub fn param_billions(label: &str) -> Option<f64> {
    let bytes = label.as_bytes();
    let mut best: Option<f64> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.') {
            index += 1;
        }
        let number = label[start..index].parse::<f64>().ok();
        let mut lookahead = index;
        while lookahead < bytes.len() && bytes[lookahead] == b' ' {
            lookahead += 1;
        }
        if let (Some(number), true) = (
            number,
            lookahead < bytes.len() && matches!(bytes[lookahead], b'b' | b'B'),
        ) {
            let boundary = lookahead + 1;
            let end_of_token = boundary == bytes.len()
                || !matches!(bytes[boundary], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9');
            if end_of_token {
                best = Some(best.map_or(number, |current: f64| current.max(number)));
            }
        }
    }
    best
}

fn size_heuristic(model: &PoolModel) -> f64 {
    match param_billions(&format!("{} {}", model.name, model.model_id)) {
        Some(billions) if billions >= 30.0 => 0.95,
        Some(billions) if billions >= 8.0 => 0.75,
        Some(billions) if billions >= 3.0 => 0.55,
        Some(_) => 0.35,
        None => 0.5,
    }
}

fn price_of(tier: &crate::types::CostTier) -> f64 {
    tier.input.max(0.0) + tier.output.max(0.0)
}

/// Price for `tokens` input, honouring context tiers and cache prices:
/// `(input, output, cache_read, cache_write)`.
fn price_at(model: &PoolModel, tokens: u64) -> (f64, f64, f64, f64) {
    let mut chosen: Option<&crate::types::CostTier> = None;
    for tier in &model.cost {
        match &tier.tier {
            Some(definition) if definition.size <= tokens => {
                // The largest matching tier wins; a bare (non-tiered) entry is
                // only the default and must not block a tiered match that
                // follows it in the catalog order.
                let better = chosen.is_none_or(|current| {
                    current
                        .tier
                        .as_ref()
                        .is_none_or(|existing| definition.size > existing.size)
                });
                if better {
                    chosen = Some(tier);
                }
            }
            Some(_) => {}
            None => {
                if chosen.is_none() {
                    chosen = Some(tier);
                }
            }
        }
    }
    let tier = chosen.or_else(|| model.cost.first());
    match tier {
        Some(tier) => (
            tier.input.max(0.0),
            tier.output.max(0.0),
            tier.cache.read.max(0.0),
            tier.cache.write.max(0.0),
        ),
        None => (0.0, 0.0, 0.0, 0.0),
    }
}

/// The model's projected cost over the pin horizon, charging context debt.
///
/// The session's context keeps growing by about one prompt's worth of tokens
/// per turn. Two consequences belong to the model that incurs them:
///
/// 1. **Tier crossings.** Input is priced at the tier the model will be
///    paying once the context has grown, not today's tier.
/// 2. **Forced compaction.** A session that outgrows the model's budget
///    within the horizon must compact, and compaction invalidates the prompt
///    cache: the compacted prefix is re-written at the cache-write price
///    instead of being read at the cache-read price.
///
/// The result is the better of two context strategies — keep the growing
/// context, or compact at the overflow point — so the projection mirrors
/// `contextDebt`/`compactionRoi` on the JS side. A cheap model with a
/// bloated projected context loses its cost edge to one that can keep going.
fn projected_cost(model: &PoolModel, ctx: &ScoreContext<'_>, expected_out: u64) -> f64 {
    let horizon = ctx.settings.pin.max_turns.max(1) as f64;
    let estimated = ctx.envelope.estimated_input_tokens as f64;
    // The new prompt is the turn's growth: one prompt's worth per turn.
    let growth = ctx.envelope.prompt_tokens as f64;
    let projected = estimated + growth * (horizon - 1.0);

    let (input_price, output_price, cache_read, cache_write) = price_at(model, projected as u64);
    let pinned = ctx.pin.and_then(|pin| pin.model.as_ref());
    let cached = pinned.is_some_and(|p| p.same_model(&model.reference()))
        && ctx.settings.pin.cache_hit_ratio > 0.0
        && cache_read > 0.0;
    let ratio = if cached {
        clamp01(ctx.settings.pin.cache_hit_ratio)
    } else {
        0.0
    };

    let turn_cost = |tokens: f64| {
        let input_cost = if cached {
            tokens * (1.0 - ratio) * input_price + tokens * ratio * cache_read
        } else {
            tokens * input_price
        };
        (input_cost + expected_out as f64 * output_price) / 1_000_000.0
    };

    // Keep: every turn re-pays the growing prefix. The horizon's mean context
    // prices the growth without a per-turn loop.
    let keep = horizon * turn_cost((estimated + projected) / 2.0);

    // Compact: when the projection outgrows the budget the session compacts
    // within the horizon (modelled at a quarter of the budget) and pays the
    // cache-invalidation premium on that prefix. Writes without a billed
    // cache-write price fall back to the input price, matching
    // `compactionRoi` on the JS side.
    let budget = model.limit.context as f64 * ctx.settings.limits.context_fit_ratio;
    let compact = if projected > budget && budget > 0.0 {
        let compacted = budget / 4.0;
        let blended = if cached {
            ratio * cache_read + (1.0 - ratio) * input_price
        } else {
            input_price
        };
        let write_price = if cache_write > 0.0 {
            cache_write
        } else {
            input_price
        };
        let premium = (compacted * (write_price - blended).max(0.0)) / 1_000_000.0;
        premium + horizon * turn_cost(compacted)
    } else {
        f64::INFINITY
    };

    // Reported per turn so the number keeps its meaning (the modelled cost of
    // one turn) while carrying the horizon's debt.
    keep.min(compact) / horizon
}

fn is_free_local(model: &PoolModel, settings: &Settings) -> bool {
    model.local
        && (settings.pool.local_cost_zero || model.cost.iter().all(|tier| price_of(tier) <= 0.0))
}

fn quality(
    model: &PoolModel,
    price_percentile: f64,
    context_percentile: f64,
    settings: &Settings,
) -> f64 {
    if let Some(override_value) = model
        .quality_override
        .or_else(|| settings.quality.overrides.get(&model.label()).copied())
    {
        return clamp01(override_value);
    }
    if is_free_local(model, settings) {
        // A local model's size is the only signal available without prices.
        // Keep the tiers conservative: a 27B local model should clear routine
        // edits, not hard debugging.
        let size = param_billions(&format!("{} {}", model.name, model.model_id));
        return match size {
            Some(billions) if billions >= 30.0 => 0.72,
            Some(billions) if billions >= 8.0 => 0.55,
            Some(billions) if billions >= 3.0 => 0.45,
            Some(_) => 0.35,
            None => 0.4,
        };
    }
    clamp01(
        0.45 * price_percentile
            + 0.25 * size_heuristic(model)
            + 0.15 * context_percentile
            + 0.15 * if model.reasoning { 1.0 } else { 0.0 },
    )
}

fn expected_output(model: &PoolModel, ctx: &ScoreContext<'_>) -> u64 {
    let base = ctx.settings.limits.expected_output_tokens;
    let agentic = if ctx.envelope.turn_class == "agentic" {
        ctx.envelope.estimated_input_tokens / 12
    } else {
        0
    };
    let wanted = base.max(agentic);
    if model.limit.output > 0 {
        wanted.min(model.limit.output)
    } else {
        wanted
    }
}

fn passes_gates(model: &PoolModel, ctx: &ScoreContext<'_>) -> bool {
    if model.status == "deprecated" {
        return false;
    }
    if model.limit.context == 0
        || ctx.envelope.estimated_input_tokens as f64
            > model.limit.context as f64 * ctx.settings.limits.context_fit_ratio
    {
        return false;
    }
    let min_context = ctx
        .agent
        .and_then(|policy| policy.min_context)
        .unwrap_or(ctx.settings.pool.min_context);
    if model.limit.context < min_context {
        return false;
    }
    let require_tools = ctx.settings.pool.require_tools
        || ctx
            .agent
            .and_then(|policy| policy.require_tools)
            .unwrap_or(false);
    if require_tools && !model.capabilities.tools {
        return false;
    }
    if ctx.envelope.signals.has_images
        && !model.capabilities.input.iter().any(|kind| kind == "image")
    {
        return false;
    }
    true
}

/// Gate, score, and sort the pool. Never returns an empty list when at least one
/// model passes the hard gates: the shortfall filter relaxes rather than starving.
pub fn evaluate(pool: &[PoolModel], ctx: &ScoreContext<'_>) -> Vec<Candidate> {
    let gated: Vec<&PoolModel> = pool
        .iter()
        .filter(|model| passes_gates(model, ctx))
        .collect();
    if gated.is_empty() {
        return Vec::new();
    }

    let prices: Vec<f64> = gated
        .iter()
        .map(|model| {
            if is_free_local(model, ctx.settings) {
                0.0
            } else {
                model.cost.first().map_or(0.0, price_of)
            }
        })
        .collect();
    let contexts: Vec<f64> = gated
        .iter()
        .map(|model| model.limit.context as f64)
        .collect();

    let floor = ctx
        .agent
        .and_then(|policy| policy.quality_floor)
        .unwrap_or(0.0);
    let required = required_quality(ctx.verdict, &ctx.envelope.turn_class, floor);

    let mut scored: Vec<Candidate> = Vec::new();
    let mut near: Vec<Candidate> = Vec::new();
    let mut relaxed: Vec<Candidate> = Vec::new();
    let tolerance = ctx.settings.limits.shortfall_tolerance;

    for model in &gated {
        let free_local = is_free_local(model, ctx.settings);
        let own_price = if free_local {
            0.0
        } else {
            model.cost.first().map_or(0.0, price_of)
        };
        let price_percentile = percentile(own_price, &prices);
        let context_percentile = percentile(model.limit.context as f64, &contexts);
        let quality = quality(model, price_percentile, context_percentile, ctx.settings);

        if model.local
            && ctx.verdict.complexity > ctx.settings.limits.allow_local_for_complexity
            && quality + 1e-9 < required
        {
            continue;
        }

        let expected_out = expected_output(model, ctx);
        let cost_usd = if free_local {
            0.0
        } else {
            projected_cost(model, ctx, expected_out)
        };

        let shortfall = (required - quality).max(0.0);
        let penalty = shortfall * 2.5;
        let resolved = weights(ctx.settings, &ctx.envelope.turn_class, ctx.policy);
        let (w_cost, w_quality, w_latency) = (resolved.cost, resolved.quality, resolved.latency);
        let cost_score = 1.0
            - percentile(
                cost_usd,
                &gated
                    .iter()
                    .map(|model| {
                        if is_free_local(model, ctx.settings) {
                            return 0.0;
                        }
                        projected_cost(model, ctx, expected_output(model, ctx))
                    })
                    .collect::<Vec<f64>>(),
            );
        let latency_score = if model.local {
            1.0
        } else if let Some(milliseconds) = model
            .latency_override_ms
            .or_else(|| ctx.settings.latency.overrides.get(&model.label()).copied())
        {
            1.0 - (milliseconds / 5000.0).clamp(0.0, 1.0)
        } else {
            1.0 - price_percentile
        };

        let score = w_cost * cost_score + w_quality * quality + w_latency * latency_score - penalty;
        let candidate = Candidate {
            model: (*model).clone(),
            score,
            cost_usd,
            quality,
            required,
        };
        if shortfall <= 1e-9 {
            scored.push(candidate);
        } else if shortfall <= tolerance {
            near.push(candidate);
        } else {
            relaxed.push(candidate);
        }
    }

    if scored.is_empty() {
        scored = near;
    }
    if scored.is_empty() {
        scored = relaxed;
    }

    scored.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let left_parent = ctx
                    .parent
                    .is_some_and(|parent| parent.same_model(&left.model.reference()));
                let right_parent = ctx
                    .parent
                    .is_some_and(|parent| parent.same_model(&right.model.reference()));
                right_parent.cmp(&left_parent)
            })
            .then_with(|| {
                left.cost_usd
                    .partial_cmp(&right.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| right.model.limit.context.cmp(&left.model.limit.context))
            .then_with(|| left.model.label().cmp(&right.model.label()))
    });
    scored
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CacheCost, Capabilities, CostTier, CostTierDef, ModelLimits, Pin, TurnInfo, WeightOverride,
    };

    fn model(id: &str, input: f64, output: f64, context: u64, quality: Option<f64>) -> PoolModel {
        PoolModel {
            provider_id: "acme".to_string(),
            model_id: id.to_string(),
            name: id.to_string(),
            variant: None,
            local: false,
            cost: vec![CostTier {
                tier: None,
                input,
                output,
                cache: CacheCost::default(),
            }],
            limit: ModelLimits {
                context,
                output: 8192,
            },
            capabilities: Capabilities {
                tools: true,
                input: vec!["text".to_string()],
                output: vec!["text".to_string()],
            },
            reasoning: false,
            status: "active".to_string(),
            quality_override: quality,
            latency_override_ms: None,
        }
    }

    fn local_model(id: &str, input: f64, output: f64, context: u64) -> PoolModel {
        PoolModel {
            local: true,
            ..model(id, input, output, context, None)
        }
    }

    fn settings(policy: &str) -> Settings {
        Settings {
            policy: policy.to_string(),
            ..Settings::default()
        }
    }

    fn ctx<'a>(
        settings: &'a Settings,
        verdict: &'a Verdict,
        envelope: &'a Envelope,
        policy: &'a str,
    ) -> ScoreContext<'a> {
        ScoreContext {
            settings,
            verdict,
            envelope,
            pin: None,
            agent: None,
            parent: None,
            policy,
        }
    }

    fn verdict(complexity: u8) -> Verdict {
        Verdict {
            complexity,
            needs_tools: true,
            reasoning_need: "low".to_string(),
            ..Verdict::default()
        }
    }

    fn envelope() -> Envelope {
        crate::envelope::build(&TurnInfo {
            prompt_text: "do the thing".to_string(),
            last_context_tokens: 1000,
            ..TurnInfo::default()
        })
    }

    #[test]
    fn percentile_is_neutral_when_all_equal() {
        assert_eq!(percentile(5.0, &[5.0, 5.0, 5.0]), 0.5);
        assert_eq!(percentile(1.0, &[1.0, 2.0, 3.0]), 1.0 / 6.0);
        assert_eq!(percentile(3.0, &[1.0, 2.0, 3.0]), 5.0 / 6.0);
    }

    #[test]
    fn parses_parameter_sizes() {
        assert_eq!(param_billions("Qwen3.8-27B-MLX-4bit"), Some(27.0));
        assert_eq!(param_billions("Qwen3-4B-Instruct"), Some(4.0));
        assert_eq!(param_billions("gpt-6.1-sol"), None);
        assert_eq!(param_billions("llama-3.2-1.7b"), Some(1.7));
        assert_eq!(param_billions("Qwen3-30B-A3B"), Some(30.0));
    }

    #[test]
    fn required_quality_scales_with_complexity() {
        let low = required_quality(&verdict(1), "routine", 0.0);
        let high = required_quality(&verdict(5), "routine", 0.0);
        assert!(high > low);
        assert_eq!(required_quality(&verdict(1), "routine", 0.9), 0.9);
    }

    #[test]
    fn gates_drop_missing_tools_and_small_context() {
        let settings = settings("cost");
        let verdict = verdict(2);
        let envelope = envelope();
        let mut no_tools = model("no-tools", 1.0, 1.0, 100_000, None);
        no_tools.capabilities.tools = false;
        let small = model("small", 1.0, 1.0, 1_000, None);
        let ok = model("ok", 1.0, 1.0, 100_000, None);
        let result = evaluate(
            &[no_tools, small, ok],
            &ctx(&settings, &verdict, &envelope, "cost"),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].model.model_id, "ok");
    }

    #[test]
    fn cost_policy_prefers_cheap_adequate_models() {
        let settings = settings("cost");
        let verdict = verdict(2);
        let envelope = envelope();
        let cheap = model("cheap", 0.1, 0.2, 100_000, Some(0.6));
        let pricey = model("pricey", 5.0, 10.0, 200_000, Some(0.9));
        let result = evaluate(
            &[pricey, cheap],
            &ctx(&settings, &verdict, &envelope, "cost"),
        );
        assert_eq!(result[0].model.model_id, "cheap");
    }

    #[test]
    fn quality_policy_prefers_strong_models() {
        let settings = settings("quality");
        let verdict = verdict(4);
        let envelope = envelope();
        let cheap = model("cheap", 0.1, 0.2, 100_000, Some(0.6));
        let pricey = model("pricey", 5.0, 10.0, 200_000, Some(0.95));
        let result = evaluate(
            &[pricey, cheap],
            &ctx(&settings, &verdict, &envelope, "quality"),
        );
        assert_eq!(result[0].model.model_id, "pricey");
    }

    #[test]
    fn local_models_are_blocked_above_the_guard() {
        let settings = settings("cost");
        let verdict = verdict(4);
        let envelope = envelope();
        let mut local = model("local", 0.0, 0.0, 100_000, None);
        local.local = true;
        let cloud = model("cloud", 2.0, 4.0, 100_000, Some(0.8));
        let result = evaluate(
            &[local, cloud],
            &ctx(&settings, &verdict, &envelope, "cost"),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].model.model_id, "cloud");
    }

    #[test]
    fn parent_model_wins_an_exact_tie() {
        let settings = settings("cost");
        let verdict = verdict(2);
        let envelope = envelope();
        let first = model("a", 1.0, 1.0, 100_000, Some(0.6));
        let second = model("b", 1.0, 1.0, 100_000, Some(0.6));
        let parent = second.reference();
        let context = ScoreContext {
            settings: &settings,
            verdict: &verdict,
            envelope: &envelope,
            pin: None,
            agent: None,
            parent: Some(&parent),
            policy: "cost",
        };
        let result = evaluate(&[first, second], &context);
        assert_eq!(result[0].model.model_id, "b");
    }

    #[test]
    fn an_adequate_model_wins_over_a_near_miss() {
        let settings = settings("cost");
        let verdict = verdict(4);
        let envelope = envelope();
        let strong = model("strong", 5.0, 10.0, 100_000, Some(0.9));
        let cheap = model("cheap", 0.1, 0.2, 100_000, Some(0.7));
        let result = evaluate(
            &[cheap, strong],
            &ctx(&settings, &verdict, &envelope, "cost"),
        );
        assert_eq!(result[0].model.model_id, "strong");
    }

    #[test]
    fn shortfall_relaxes_instead_of_starving() {
        let settings = settings("cost");
        let verdict = verdict(5);
        let envelope = envelope();
        let weak = model("weak", 0.1, 0.1, 100_000, Some(0.2));
        let result = evaluate(&[weak], &ctx(&settings, &verdict, &envelope, "cost"));
        assert_eq!(result.len(), 1);
        assert!(result[0].required > result[0].quality);
    }

    #[test]
    fn custom_weights_override_the_preset() {
        let mut settings = settings("cost");
        settings.policy_weights = Some(WeightOverride {
            cost: Some(0.2),
            quality: Some(0.7),
            latency: Some(0.1),
        });
        let resolved = weights(&settings, "routine", "cost");
        assert!((resolved.cost - 0.2).abs() < 1e-9);
        assert!((resolved.quality - 0.7).abs() < 1e-9);
        assert!((resolved.latency - 0.1).abs() < 1e-9);
    }

    #[test]
    fn per_class_weights_win_over_global_overrides() {
        let mut settings = settings("cost");
        settings.policy_weights = Some(WeightOverride {
            cost: Some(0.2),
            quality: Some(0.7),
            latency: None,
        });
        settings.policy_by_class.insert(
            "planning".to_string(),
            WeightOverride {
                cost: Some(0.0),
                quality: Some(0.9),
                latency: Some(0.1),
            },
        );
        let planning = weights(&settings, "planning", "cost");
        assert!((planning.cost - 0.0).abs() < 1e-9);
        assert!((planning.quality - 0.9).abs() < 1e-9);
        let routine = weights(&settings, "routine", "cost");
        assert!((routine.cost - 0.2).abs() < 1e-9);
        assert!((routine.quality - 0.7).abs() < 1e-9);
    }

    #[test]
    fn zero_custom_weights_fall_back_to_the_preset() {
        let mut settings = settings("cost");
        settings.policy_weights = Some(WeightOverride {
            cost: Some(0.0),
            quality: Some(0.0),
            latency: Some(0.0),
        });
        let resolved = weights(&settings, "routine", "cost");
        let base = preset("cost");
        assert!((resolved.cost - base.cost).abs() < 1e-9);
        assert!((resolved.quality - base.quality).abs() < 1e-9);
        assert!((resolved.latency - base.latency).abs() < 1e-9);
    }

    #[test]
    fn free_local_quality_scales_with_model_size() {
        let settings = settings("cost");
        let verdict = verdict(2);
        let envelope = envelope();
        for (id, minimum) in [("tiny-1B", 0.30), ("Qwen3-4B", 0.40), ("Qwen3.8-27B", 0.55)] {
            let result = evaluate(
                &[local_model(id, 0.0, 0.0, 100_000)],
                &ctx(&settings, &verdict, &envelope, "cost"),
            );
            assert_eq!(result.len(), 1, "{id} should pass the gates");
            assert!(
                result[0].quality >= minimum,
                "{id} quality {} < {minimum}",
                result[0].quality
            );
        }
    }

    #[test]
    fn local_models_are_free_even_with_catalog_prices() {
        let verdict = verdict(2);
        let envelope = envelope();
        let free_settings = settings("cost");
        let free = evaluate(
            &[local_model("Qwen3.8-27B", 5.0, 10.0, 100_000)],
            &ctx(&free_settings, &verdict, &envelope, "cost"),
        );
        assert_eq!(free[0].cost_usd, 0.0);

        let mut metered = settings("cost");
        metered.pool.local_cost_zero = false;
        let priced = evaluate(
            &[local_model("Qwen3.8-27B", 5.0, 10.0, 100_000)],
            &ctx(&metered, &verdict, &envelope, "cost"),
        );
        assert!(priced[0].cost_usd > 0.0);
    }

    #[test]
    fn a_weak_local_model_is_gated_above_complexity_two() {
        let settings = settings("cost");
        let verdict = verdict(4);
        let envelope = envelope();
        let result = evaluate(
            &[local_model("Qwen3-4B", 0.0, 0.0, 100_000)],
            &ctx(&settings, &verdict, &envelope, "cost"),
        );
        assert!(result.is_empty());
    }

    fn cache_model(
        id: &str,
        input: f64,
        output: f64,
        read: f64,
        write: f64,
        context: u64,
    ) -> PoolModel {
        PoolModel {
            cost: vec![CostTier {
                tier: None,
                input,
                output,
                cache: CacheCost { read, write },
            }],
            ..model(id, input, output, context, None)
        }
    }

    fn growing_envelope(prompt_tokens: u64, last_context_tokens: u64) -> Envelope {
        crate::envelope::build(&TurnInfo {
            prompt_text: "work".to_string(),
            prompt_tokens: Some(prompt_tokens),
            last_context_tokens,
            ..TurnInfo::default()
        })
    }

    #[test]
    fn a_model_forced_to_compact_within_the_horizon_is_priced_at_its_compacted_economics() {
        let settings = settings("cost");
        let verdict = verdict(3);
        // estimated 10k, one prompt of growth per turn: projected 24k over 8.
        let envelope = growing_envelope(2_000, 8_000);
        let context = ctx(&settings, &verdict, &envelope, "cost");
        let small = cache_model("small", 1.0, 1.0, 0.1, 1.25, 12_000);
        let big = cache_model("big", 1.0, 1.0, 0.1, 1.25, 64_000);

        // small: budget 10.8k < projected 24k, so it compacts at 2.7k and pays
        // the cache-write premium on that prefix.
        let expected = (2_700.0 * 0.25 + 8.0 * (2_700.0 + 1_200.0)) / 1_000_000.0;
        assert!((projected_cost(&small, &context, 1_200) - expected / 8.0).abs() < 1e-9);

        // big keeps the growing context; its horizon average is the mean turn.
        let expected_big = ((10_000.0 + 24_000.0) / 2.0 + 1_200.0) / 1_000_000.0;
        assert!((projected_cost(&big, &context, 1_200) - expected_big).abs() < 1e-9);
    }

    #[test]
    fn the_pinned_incumbent_keeps_its_cache_discount_across_the_horizon() {
        let settings = settings("cost");
        let verdict = verdict(3);
        let envelope = growing_envelope(100, 20_000);
        let big = cache_model("big", 1.0, 1.0, 0.1, 1.25, 64_000);
        let pin = Pin {
            model: Some(big.reference()),
            ..Pin::default()
        };
        let warm = ScoreContext {
            settings: &settings,
            verdict: &verdict,
            envelope: &envelope,
            pin: Some(&pin),
            agent: None,
            parent: None,
            policy: "cost",
        };
        // Warm turns at the mean context (20,450) with the 0.8 cache ratio.
        let expected = (20_450.0 * (0.8 * 0.1 + 0.2 * 1.0) + 1_200.0) / 1_000_000.0;
        assert!((projected_cost(&big, &warm, 1_200) - expected).abs() < 1e-9);

        let cold = ScoreContext {
            settings: &settings,
            verdict: &verdict,
            envelope: &envelope,
            pin: None,
            agent: None,
            parent: None,
            policy: "cost",
        };
        assert!(projected_cost(&big, &cold, 1_200) > projected_cost(&big, &warm, 1_200) * 3.0);
    }

    #[test]
    fn a_tier_crossing_within_the_horizon_is_charged_at_the_projected_tier() {
        let settings = settings("cost");
        let verdict = verdict(3);
        let mut tiered = cache_model("tiered", 1.0, 1.0, 0.1, 1.0, 100_000);
        tiered.cost.push(CostTier {
            tier: Some(CostTierDef { size: 20_000 }),
            input: 4.0,
            output: 4.0,
            cache: CacheCost {
                read: 0.4,
                write: 4.0,
            },
        });
        let calm = growing_envelope(100, 19_000);
        let calm_context = ctx(&settings, &verdict, &calm, "cost");
        let cheap = projected_cost(&tiered, &calm_context, 1_200);
        let storm = growing_envelope(2_000, 18_000);
        let storm_context = ctx(&settings, &verdict, &storm, "cost");
        let dear = projected_cost(&tiered, &storm_context, 1_200);
        // Crossing the 20k tier within the horizon quadruples the input rate.
        assert!(dear > cheap * 4.0);
    }

    #[test]
    fn without_growth_the_projection_is_the_one_turn_price() {
        let settings = settings("cost");
        let verdict = verdict(3);
        let envelope = growing_envelope(0, 30_000);
        let context = ctx(&settings, &verdict, &envelope, "cost");
        let plain = cache_model("plain", 2.0, 3.0, 0.5, 2.0, 100_000);
        let expected = (30_000.0 * 2.0 + 1_200.0 * 3.0) / 1_000_000.0;
        assert!((projected_cost(&plain, &context, 1_200) - expected).abs() < 1e-9);
    }
}
