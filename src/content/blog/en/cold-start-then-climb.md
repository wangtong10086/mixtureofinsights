---
title: "Cold-start, then climb"
description: "Pure RL from a base model on a hard task mostly produces high-variance garbage. The fix is a two-stage recipe — a small SFT cold-start to give the policy a shape, then GRPO to climb. Here's why, and how GRPO actually works."
date: 2026-06-12
order: 2
series: "post-training"
reading: "9 min read"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

Reinforcement learning improves a policy you *already have*. Point it at a base model and a
hard task — long-horizon planning under hard constraints — and you discover the catch: if the
policy almost never stumbles onto a good trajectory, there's nothing for RL to amplify. You get
high variance, slow progress, and reward curves that look like noise. The fix is to not start
cold. This is the recipe I keep coming back to.

## Why cold-start before RL

Think of RL as turning up the volume on behaviors the model can already occasionally produce.
If a behavior never appears in the model's samples, its probability is ~0 and its gradient is
~0 — RL can't conjure it from nothing. A base model *can* reason and *can* plan, but on a
constrained vertical task its good trajectories are rare enough that the learning signal is
buried in variance.

A small, clean **SFT cold-start** fixes the starting point. You're not trying to teach the task
end-to-end; you're giving the policy a *shape* — the right format, the habit of laying out
constraints before committing to a plan, a non-trivial baseline rate of good trajectories. Now
RL has a floor to climb from.

## The four-step recipe (R1-flavored)

This mirrors the DeepSeek-R1 cold-start idea, adapted to a vertical task:

1. **Explore on the base with GRPO.** Run GRPO directly on the base to push out long
   chain-of-thought planning — let it discover, under reward pressure, what reasoning paths
   reach valid plans.
2. **Rejection-sample the seed.** From that exploration, keep only the high-correctness
   `reasoning → plan` samples (your verifier decides — see
   [post 1](/blog/post-training-is-a-data-problem/)). This is your SFT seed: small, clean, and
   in the model's own voice.
3. **SFT cold-start.** Fine-tune the base on the seed. The model now reliably *produces* the
   shape you want.
4. **GRPO, for real.** Now run the main GRPO stage with a reward model that scores the things
   you actually care about — constraint satisfaction, budget/time consistency, route
   feasibility — and let it climb.

Two stages, one sentence: **SFT gives the policy a shape; GRPO sharpens it against a reward.**

## How GRPO actually works (the short, honest version)

PPO needs a separate *critic* network to estimate how good each state is — another model to
train, tune, and keep stable. GRPO throws the critic away and uses a trick that's almost
embarrassingly simple for tasks with a checkable reward:

> For each prompt, sample a **group** of K answers. Score all K. Each answer's **advantage** is
> just *its score minus the group's mean score.* Push up the above-average answers, push down
> the below-average ones.

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

That's the whole intuition. The group is its own baseline, so you never train a value function;
the cost is K× sampling per prompt, which for a verifiable reward is a good trade.

## The things that actually bite

- **Keep a KL leash to the reference.** Without it, the policy drifts off into reward-hacked,
  degenerate text. A KL penalty to the SFT model keeps it speaking the language you cold-started.
- **Your reward is your verifier — and it will be gamed.** Every reward mis-specification gets
  found and exploited. (Enough that it's the [next post](/blog/what-are-you-rewarding/).)
- **Shape the long CoT explicitly.** Length and format rewards stop the model from either
  collapsing to terse non-reasoning or rambling for the length bonus.
- **Group size is a knob, not a constant.** Too small and the advantage estimate is noisy; too
  large and you burn sampling budget. Tune it like a learning rate.

On the planning agent, this two-stage `SFT cold-start → GRPO` pipeline — aligned by a
constraint-aware reward model — lifted complex-constraint satisfaction ~12% on an internal
benchmark and cut hallucinated plans noticeably, *without* a large human-labeled set. The
quiet hero of that result isn't GRPO. It's the reward. Which is where we go next.
