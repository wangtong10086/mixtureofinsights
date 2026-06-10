---
title: "Cold-start, then climb"
description: "Pure RL from a base model on a hard task mostly produces high-variance garbage — and the policy-gradient math says exactly why. The fix is a two-stage recipe: a small SFT cold-start to give the policy a shape, then GRPO to climb. The recipe, the math, and the failure modes that actually bite."
date: 2026-06-10
order: 2
series: "post-training"
reading: "13 min read"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

Reinforcement learning improves a policy you *already have*. Point it at a base model and a
hard task — long-horizon planning under hard constraints — and you discover the catch: if the
policy almost never stumbles onto a good trajectory, there's nothing for RL to amplify. You get
high variance, slow progress, and reward curves that look like noise. The fix is to not start
cold. This is the recipe I keep coming back to — with the math this time, because the math is
what tells you *when* the recipe is necessary.

## Why cold-start before RL: the gradient says so

Every policy-gradient method, from REINFORCE to GRPO, is some variant of

$$
\nabla_\theta J(\theta) \;=\; \mathbb{E}_{y \sim \pi_\theta}\big[\, A(y)\, \nabla_\theta \log \pi_\theta(y \mid x) \,\big],
$$

an expectation **over the policy's own samples**. Read it as a search budget: a behavior
contributes gradient only in proportion to how often the policy currently produces it. If a
good trajectory has probability $10^{-4}$ under the base model and you sample 8 rollouts per
prompt, you'll see one roughly every 1,250 prompts — and the other 9,999 gradient contributions
are noise pushing in arbitrary directions. RL doesn't *conjure* behavior; it *reweights*
behavior. Probability ≈ 0 means gradient ≈ 0, no matter how large the reward you attached to it.

There's a second, sneakier term: variance. With sparse 0/1 rewards, the variance of the
gradient estimate scales like $p(1-p)$ over your sample budget — worst exactly in the regime
where success is rare and you need signal most. That's why "pure RL from base" runs on hard
verticals show reward curves that are flat noise for thousands of steps: the signal exists, but
it's buried under sampling variance your batch size can't pay for.

A small, clean **SFT cold-start** fixes the starting point. You're not trying to teach the task
end-to-end; you're moving $p(\text{good trajectory})$ from $10^{-4}$ to, say, $10^{-1}$ — at
which point a group of 8 samples contains a usable contrast almost every prompt, and the same
GRPO loop that was spinning in noise suddenly climbs. The cold-start buys you *sample
efficiency*, not capability.

## The four-step recipe (R1-flavored)

This mirrors the DeepSeek-R1 cold-start idea, adapted to a vertical task:

1. **Explore on the base with GRPO.** Run GRPO directly on the base to push out long
   chain-of-thought planning — let it discover, under reward pressure, what reasoning paths
   reach valid plans. This stage is *expected* to be ugly; you're mining for rare good
   trajectories, not training a product.
2. **Rejection-sample the seed.** From that exploration, keep only the high-correctness
   `reasoning → plan` samples (your verifier decides — see
   [post 1](/blog/post-training-is-a-data-problem/)). This is your SFT seed: small (think
   thousands, not hundreds of thousands), clean, and — crucially — *in the model's own voice*,
   so SFT on it doesn't fight the model's distribution the way human-written demos do.
3. **SFT cold-start.** Fine-tune the base on the seed. One to two epochs; you want the format
   and the habit, not memorization. The model now reliably *produces* the shape you want.
4. **GRPO, for real.** Now run the main GRPO stage with a reward that scores the things you
   actually care about — constraint satisfaction, budget/time consistency, route feasibility —
   and let it climb.

Two stages, one sentence: **SFT gives the policy a shape; GRPO sharpens it against a reward.**

## How the two stages map to the code

Both stages are the *same* config object in Orbit — `SwiftConfig` in `orbit/training/config.py` —
with `train_type` flipped. The cold-start is `train_type="sft"`; the climb is `train_type="rlhf",
rlhf_type="grpo"`. `SwiftConfig.to_yaml_dict()` only emits the GRPO-specific knobs when that pair
is set:

```python
if self.train_type == "rlhf":
    d["rlhf_type"] = self.rlhf_type
    if self.beta is not None:
        d["beta"] = self.beta
    if self.reference_model:
        d["ref_model"] = self.reference_model
    if self.rlhf_type in ("grpo", "ppo"):
        d["max_completion_length"] = self.max_completion_length
    if self.rlhf_type == "grpo":
        d["num_generations"] = self.num_generations
        if self.reward_funcs:
            d["reward_funcs"] = self.reward_funcs
```

Three fields carry the whole GRPO story below. `num_generations` is the group size $K$ — its
default is `8`, which is the "sample 8 rollouts per prompt" from the gradient argument above.
`beta` is the KL-penalty coefficient $\beta$. `reward_funcs` is how the verifier feeds RL: the
reward functions named here are the program that scores each rollout — the same verifier role from
[post 1](/blog/post-training-is-a-data-problem/), now producing the per-rollout reward $r_i$ that
GRPO standardizes into an advantage. `SwiftBackend.validate_config` (in `orbit/training/sft.py`)
gates the combination, rejecting any `rlhf_type` outside the known set
(`{"dpo", "grpo", "kto", "cpo", "simpo", "orpo", "ppo", "gkd"}`) before a job is ever launched.

The cold-start *seed itself* is built by the rejection-sampling path from post 1 —
`filter_quality(records, min_score=...)` keeps only the high-`score` `reasoning → plan` samples,
and `build_ms_swift_dataset` packs them into the `{"messages": [...]}` rows the SFT stage consumes.
Same dataset format, same builder, for both stages.

## GRPO, with the actual math

PPO needs a separate *critic* network to estimate a per-token value baseline — for LLMs that's
a second model the size of the policy: its memory, its forward passes, its own training
instabilities. GRPO (introduced in DeepSeekMath) deletes it with a trick that's almost
embarrassingly simple for tasks with a checkable reward.

For each prompt $x$, sample a **group** of $K$ responses $y_1,\dots,y_K$ from the current
policy and score each with your reward. The advantage of response $i$ is its score standardized
against its own group:

$$
\hat{A}_i \;=\; \frac{r_i - \operatorname{mean}(r_1,\dots,r_K)}{\operatorname{std}(r_1,\dots,r_K)}
$$

and that $\hat{A}_i$ is plugged into the familiar PPO-style clipped surrogate, plus an explicit
KL penalty to a reference model:

$$
\mathcal{L} \;=\; -\,\mathbb{E}\!\left[\min\!\big(\rho_t \hat{A}_i,\;
\operatorname{clip}(\rho_t,\, 1-\varepsilon,\, 1+\varepsilon)\, \hat{A}_i\big)\right]
\;+\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta \,\|\, \pi_{\mathrm{ref}}\right],
\qquad
\rho_t = \frac{\pi_\theta(y_t \mid x, y_{<t})}{\pi_{\theta_{\mathrm{old}}}(y_t \mid x, y_{<t})}.
$$

<figure class="figure">
<svg viewBox="0 0 620 196" role="img" aria-label="GRPO group-relative advantage">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="g1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="78" width="120" height="40" rx="8"/><text x="36" y="103" class="t">prompt</text>
  <text x="170" y="30" class="s">sample K = 4</text>
  <rect class="n" x="170" y="22" width="150" height="26" rx="6"/><text x="184" y="40" class="t">answer · score 0.9</text>
  <rect class="n" x="170" y="56" width="150" height="26" rx="6"/><text x="184" y="74" class="t">answer · score 0.6</text>
  <rect class="n" x="170" y="90" width="150" height="26" rx="6"/><text x="184" y="108" class="t">answer · score 0.4</text>
  <rect class="n" x="170" y="124" width="150" height="26" rx="6"/><text x="184" y="142" class="t">answer · score 0.1</text>
  <path class="a" d="M140 98 H170" marker-end="url(#g1)"/>
  <text x="350" y="86" class="s">mean = 0.5</text>
  <text x="350" y="40" class="up">+0.4 ↑</text>
  <text x="350" y="74" class="up">+0.1 ↑</text>
  <text x="350" y="108" class="dn">−0.1 ↓</text>
  <text x="350" y="142" class="dn">−0.4 ↓</text>
  <text x="445" y="92" class="s">advantage = score − mean</text>
  <text x="445" y="110" class="s">no critic network</text>
</svg>
<figcaption>GRPO's advantage is purely relative to the other samples for the same prompt. The
group is its own baseline — which is why it's cheap and stable when the reward is verifiable.</figcaption>
</figure>

The group mean is doing exactly the job PPO's critic does — providing a baseline that turns raw
reward into "better or worse *than expected*" — except it's estimated from $K$ siblings instead
of predicted by a trained network. You trade a second model for $K\times$ sampling per prompt.
For a verifiable reward, where scoring is nearly free and sampling is the dominant cost anyway,
that trade is excellent: in practice the rollout stage (a vLLM instance generating $K$ samples
per prompt) eats 70–90% of wall-clock time, and the actual policy update is the cheap part.

Worth knowing before you tune: that innocuous-looking $\operatorname{std}$ in the denominator
is a known bias source. Dividing by the group's std systematically up-weights prompts where the
policy is *consistent* (low spread) and the original token-level normalization makes long wrong
answers cheaper per token than short wrong ones — both documented in the "Dr. GRPO" analysis,
and part of why several follow-ups (DAPO among them) drop or modify the normalization. You
don't need to memorize the variants; you need to know the default has thumbs on the scale.

## The things that actually bite

- **The dead-group problem.** If all $K$ samples get the same reward — all fail, or all pass —
  then $r_i - \operatorname{mean}(r) = 0$ for every $i$: the group contributes *zero gradient*
  and you paid full sampling cost for it. Early in training on a hard task, most groups are
  all-fail. This is the cold-start argument restated in GRPO's own terms, and it's why DAPO-style
  **dynamic sampling** (resample or skip degenerate groups) exists. Track the fraction of live
  groups per batch; it's the most honest progress meter you have.
- **Keep the KL leash on, and know what $\beta$ trades.** Without the KL term the policy drifts
  into reward-hacked degenerate text. Too tight and it can't leave the SFT basin — reward
  plateaus early. There's no universal number (typical published values run $10^{-3}$ to
  $10^{-1}$); the observable that matters is the KL trajectory itself. Slow growth is learning;
  a sudden spike is usually the policy discovering an exploit.
- **Watch entropy, not just reward.** Policy entropy collapsing early means exploration died
  and the run is converging on whatever it found first; entropy *rising* late often means
  degeneration. Either way, reward alone won't tell you — log both.
- **Shape the long CoT explicitly.** Length and format rewards stop the model from either
  collapsing to terse non-reasoning or rambling for the length bonus. But remember every shaping
  term is a new hackable surface — the length bonus is the classic self-inflicted reward hack
  (the [next post](/blog/what-are-you-rewarding/) is entirely about this).
- **Group size is a knob, not a constant.** $K$ controls the variance of
  $\operatorname{mean}(r)$ as a baseline estimate: too small (2–4) and the advantage is noisy;
  too large and you burn rollout budget for diminishing returns. Published recipes mostly live
  in $K = 8$–$64$. The right question is "at my current pass rate, how big must $K$ be for a
  typical group to contain both a success and a failure?" — for pass rate $p$, the chance a
  group is *live* is $1-p^K-(1-p)^K$. At $p=0.05$ and $K=8$ that's ~34%; at $K=16$, ~56%. Now
  the cold-start's job is quantified: raise $p$ until modest $K$ keeps most groups alive.

On the planning agent, this two-stage `SFT cold-start → GRPO` pipeline — aligned by a
constraint-aware reward — lifted complex-constraint satisfaction ~12% on an internal benchmark
and cut hallucinated plans noticeably, *without* a large human-labeled set. The quiet hero of
that result isn't GRPO. It's the reward. Which is where we go next.

## Further reading

- [DeepSeekMath](https://arxiv.org/abs/2402.03300) — where GRPO was introduced (§4).
- [DeepSeek-R1](https://arxiv.org/abs/2501.12948) — the cold-start → RL recipe at frontier scale; R1-Zero is the ablation showing what pure RL from base does.
- [DAPO](https://arxiv.org/abs/2503.14476) — dynamic sampling for dead groups, clip-higher, token-level loss; a practitioner's patch list for GRPO.
- [Dr. GRPO](https://arxiv.org/abs/2503.20783) — the std-normalization and length-bias analysis mentioned above.
