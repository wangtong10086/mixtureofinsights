---
title: "Cold-start, then climb"
description: "Pure RL from a base model on a hard task mostly produces high-variance garbage — and the policy-gradient math says exactly why. The fix I use is a two-stage recipe: a small SFT cold-start to give the policy a shape, then GRPO to climb. The recipe, the math, and the failure modes that actually bite."
date: 2026-06-10
order: 2
series: "post-training"
reading: "13 min read"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

Reinforcement learning improves a policy I already have. When I point it at a base model and a hard task — long-horizon planning under hard constraints — I hit the physical limit: if the policy almost never stumbles onto a good trajectory, there's nothing for RL to amplify. I get high variance, slow progress, and reward curves that look like noise. The fix is to not start cold. I rely on this recipe, driven by the underlying math, which tells me exactly when it is necessary.

## Why I cold-start before RL: the gradient dictates it

Every policy-gradient method I implement, from REINFORCE to GRPO, is a variant of

$$
\nabla_\theta J(\theta) \;=\; \mathbb{E}_{y \sim \pi_\theta}\big[\, A(y)\, \nabla_\theta \log \pi_\theta(y \mid x) \,\big],
$$

an expectation over the policy's own samples. I read it as a search budget: a behavior contributes gradient only in proportion to how often the policy currently produces it. If a good trajectory has probability $10^{-4}$ under the base model and I sample 8 rollouts per prompt, I see one roughly every 1,250 prompts. The other 9,999 gradient contributions are noise pushing in arbitrary directions. Probability ≈ 0 means gradient ≈ 0, no matter how large the reward I attached to it.

With sparse 0/1 rewards, the variance of the gradient estimate scales like $p(1-p)$ over my sample budget — worst exactly in the regime where success is rare and I need signal most. A small, clean SFT cold-start fixes my starting point. I'm moving $p(\text{good trajectory})$ from $10^{-4}$ to $10^{-1}$. At that point, a group of 8 samples contains a usable contrast almost every prompt. The cold-start buys sample efficiency, not capability.

## My four-step recipe

This mirrors the frontier-scale recipe detailed in [DeepSeek-R1 (DeepSeek-AI, 2025)](https://arxiv.org/abs/2501.12948), where R1-Zero acted as an ablation showing the chaos of pure RL from a base model. I adapted it to a vertical task:

1. **Explore on the base with GRPO.** I run GRPO directly on the base to push out long chain-of-thought planning — letting it discover what reasoning paths reach valid plans. I expect this stage to be ugly; I'm mining for rare good trajectories.
2. **Rejection-sample the seed.** I keep only the high-correctness `reasoning → plan` samples verified by my code. This is my SFT seed: small (thousands, not hundreds of thousands), clean, and in the model's own voice.
3. **SFT cold-start.** I fine-tune the base on the seed for one to two epochs. The model now reliably produces the shape I want.
4. **GRPO, for real.** I run the main GRPO stage with a reward that scores constraint satisfaction and feasibility, letting it climb.

SFT gives the policy a shape; GRPO sharpens it against a reward.

## How the two stages map to my code

Both stages are the same config object — `SwiftConfig` in [`orbit/training/config.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/orbit/training/config.py) — with `train_type` flipped. The cold-start is `train_type="sft"`; the climb is `train_type="rlhf", rlhf_type="grpo"`. `SwiftConfig.to_yaml_dict()` emits the GRPO-specific knobs:

```python
if self.train_type == "rlhf":
    d["rlhf_type"] = self.rlhf_type
    if self.beta is not None:
        d["beta"] = self.beta
    # ...
    if self.rlhf_type == "grpo":
        # Group size K, mapping to the 8 rollouts per prompt
        d["num_generations"] = self.num_generations 
        if self.reward_funcs:
            # The verifier program feeding RL
            d["reward_funcs"] = self.reward_funcs
```

`num_generations` is the group size $K$ (default `8`), determining my sampling budget. `beta` is the KL-penalty coefficient $\beta$. `reward_funcs` is my verifier producing the per-rollout reward $r_i$ that GRPO standardizes into an advantage.

## GRPO math in practice

PPO needs a separate critic network to estimate a per-token value baseline. GRPO, introduced in [DeepSeekMath (Shao et al., 2024)](https://arxiv.org/abs/2402.03300), deletes it. For each prompt $x$, I sample a group of $K$ responses $y_1,\dots,y_K$ from the current policy and score each with my reward. The advantage of response $i$ is its score standardized against its own group:

$$
\hat{A}_i \;=\; \frac{r_i - \operatorname{mean}(r_1,\dots,r_K)}{\operatorname{std}(r_1,\dots,r_K)}
$$

I plug that $\hat{A}_i$ into the clipped surrogate, plus an explicit KL penalty to a reference model:

$$
\mathcal{L} \;=\; -\,\mathbb{E}\!\left[\min\!\big(\rho_t \hat{A}_i,\;
\operatorname{clip}(\rho_t,\, 1-\varepsilon,\, 1+\varepsilon)\, \hat{A}_i\big)\right]
\;+\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta \,\|\, \pi_{\mathrm{ref}}\right]
$$

```text
      [ prompt ]
          | sample K = 4
  +-------+-------+
  |               |
[ans: 0.9]    [ans: 0.1]
[ans: 0.6]    [ans: 0.4]

mean = 0.5
advantage = score - mean

[ans: 0.9] -> +0.4 (up)
[ans: 0.6] -> +0.1 (up)
[ans: 0.4] -> -0.1 (down)
[ans: 0.1] -> -0.4 (down)
```

The group mean does the job of PPO's critic. I trade a second model for $K\times$ sampling per prompt. For a verifiable reward, scoring is practically free and sampling is the dominant cost (eating 70–90% of my wall-clock time in vLLM). The policy update is the cheap part.

I know before I tune that the $\operatorname{std}$ in the denominator is a bias source. As analyzed in [Dr. GRPO (2025)](https://arxiv.org/abs/2503.20783), dividing by the group's std up-weights prompts where the policy is consistent, making long wrong answers cheaper per token than short wrong ones.

## The things that bite my runs

**The dead-group problem.** If all $K$ samples fail, $r_i - \operatorname{mean}(r) = 0$. The group contributes zero gradient and I pay the full sampling cost. This is why practitioners introduced dynamic sampling in [DAPO (2025)](https://arxiv.org/abs/2503.14476), to resample or skip degenerate groups. 

**Group size is a knob.** $K$ controls the variance of $\operatorname{mean}(r)$ as a baseline estimate. Too small (2–4), the advantage is noisy; too large, I burn rollout budget. At pass rate $p=0.05$ and $K=8$, the chance a group is live is ~34%. At $K=16$, it's ~56%. My cold-start's job is quantified: I raise $p$ until a modest $K$ keeps most groups alive. 

By running this `SFT cold-start → GRPO` pipeline aligned with a constraint-aware reward, I lifted complex-constraint satisfaction ~12% on my internal benchmark and cut hallucinated plans without requiring a massive human-labeled dataset. The optimizer did the climbing, but the cold start built the ladder.
