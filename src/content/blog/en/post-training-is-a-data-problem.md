---
title: "Post-training is a data problem"
description: "PPO, GRPO, and DPO are commoditized. In my engineering iterations, the only variable that structurally improved alignment was the synthetic data engine."
date: 2026-06-10
order: 1
series: "post-training"
reading: "12 min read"
tags: ["llm", "post-training", "synthetic-data", "rejection-sampling"]
---

I used to spend days tuning PPO hyperparameters. I eventually realized that the loss function is mostly irrelevant. Eliciting latent behaviors and shaping specific trajectories requires a massive volume of highly constrained, faithful demonstrations. You cannot crowd-source this. You have to synthesize it.

## The Generation Engines

I built four discrete data-manufacturing modules under [`orbit/data/`](https://github.com/wangtong10086/orbit/tree/main/orbit/data/). They all output a uniform JSONL schema (`messages`, `env`, `score`, `task_id`).

**1. Deterministic Synthetic Trajectories.** I bypass the LLM entirely for scaffolding. In [`orbit/data/liveweb_teacher_gen.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/data/liveweb_teacher_gen.py), my `TeacherGenerator` replays cached web topologies:

```python
gen = TeacherGenerator(cache_dir=cache_dir, include_plugins=include_plugins)
result = await gen.generate_composite_trajectory(
    seed=seed, num_subtasks=n_sub, templates=selected,
)
for record in result.records:
    record["env"] = "LIVEWEB"
    record["score"] = record.get("metadata", {}).get("score", 1.0)
```

I generate rigid, multi-tool trajectories deterministically. This seeds the model with structural syntax before it ever attempts to hallucinate reasoning.

**2. Self-Play.** For well-defined environments, I implemented an OpenSpiel registry in [`orbit/data/game_gen.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/data/game_gen.py). MCTS search or CFR policy snapshots play out matches. The generators only keep the winning trajectories.

**3. Rejection Sampling.** The core pipeline mechanism. I sample massively, enforce a strict verifier, and discard the failures. In `orbit/data/sft.py`, `filter_quality` executes the dedup logic:

```python
filtered = [r for r in records if r.get("score", 0.0) >= min_score]
if dedup:
    best = {}
    for r in filtered:
        key = (r.get("env"), r.get("task_id"))
        if key not in best or r.get("score", 0) > best[key].get("score", 0):
            best[key] = r
    filtered = list(best.values())
```

Rejection sampling implicitly executes a KL-regularized policy improvement. If the pass rate is $p$, best-of-$N$ guarantees at least one success with probability $1-(1-p)^N$. The resulting distribution is bounded at a KL divergence of roughly $\log N$. I get the policy improvement of RL without the rollout volatility, mirroring the dataset distillation mechanics proven in LLM alignment pipelines ([Touvron et al., 2023](https://arxiv.org/abs/2307.09288)).

**4. The Verifier.** Human grading is geometrically impossible at scale. I rely entirely on programmatic constraints. `StaticTraceVerifier` in [`orbit/verifiers/static.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/verifiers/static.py) maps trajectories to terminal scores. 

## The Yield Flywheel

The components form an aggressive compounding loop.

```text
+-------------------+        +--------------------+        +--------------------+
| Generator         |        | Verifier / Judge   |        | Train              |
| (synthetic,       | -----> | (filter, rank,     | -----> | (SFT, GRPO, DPO)   |
|  self-play)       |        |  label)            |        |                    |
+-------------------+        +--------------------+        +--------------------+
         ^                                                           |
         |                                                           |
         +-----------------------------------------------------------+
                              Better Model
```

I treat the pass rate $p_t$ as the fundamental metric of my system. When I train the survivors, the model improves, and the generator yield for round $t+1$ increases. If I model the per-round improvement as a multiplier $g > 1$ on the odds ratio, the growth is geometric:

$$
\frac{p_t}{1-p_t} = g^t \cdot \frac{p_0}{1-p_0}
$$

If I start with a $5\%$ yield ($p_0=0.05$) and $g=2$, four passes push the yield to $46\%$. But if the verifier is noisy, $g$ collapses to $1$. 

I dedicate zero engineering time to the training code; `build_ms_swift_dataset` is a static mapping function. I spend 90% of my compute and engineering budget aggressively optimizing the verifier rubric. Yield directly dictates compute cost. At a 5% pass rate, extracting 10,000 clean trajectories costs 200,000 generation passes. Tuning the verifier to halve that ratio is significantly more impactful than optimizing GPU utilization.
