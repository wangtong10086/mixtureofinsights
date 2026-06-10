---
title: "DPO when I can't afford RLHF"
description: "RLHF is powerful and heavy — a reward model, an online rollout loop, instability. DPO gets most of the way with a fraction of the machinery. The derivation, the gradient that explains why I use it, and the catch — which is always the data."
date: 2026-06-10
order: 4
series: "post-training"
reading: "12 min read"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

The previous posts climbed a verifiable reward with GRPO. That machinery is my go-to when correctness is checkable and I need online exploration. But alignment isn't always that. "Stay in character." "Prefer this tone." There's no verifier and no need for online RL. Reaching for full RLHF here means I'm paying for an engine I won't drive. 

I use **DPO** instead. It's the lighter tool, and on my role-play models, it fit perfectly. It works due to a strict mathematical derivation rather than a heuristic, as outlined in the original [Direct Preference Optimization (Rafailov et al., 2023)](https://arxiv.org/abs/2305.18290) paper. 

## What I bypass with DPO

PPO-style RLHF involves training a reward model $r_\phi$, running an online RL loop that samples from the policy, scoring with the RM, and updating — with a KL leash to keep it sane. 

$$
\max_{\pi_\theta}\; \mathbb{E}_{x,\,y\sim\pi_\theta}\big[\, r_\phi(x,y)\,\big]
\;-\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta(y\mid x)\,\|\,\pi_{\mathrm{ref}}(y\mid x)\right].
$$

It's strong, but I have to fit a reward model, babysit an unstable online loop, and burn serious compute. DPO's insight is that for this exact objective, I never needed the loop.

## The derivation I rely on

That KL-regularized objective has a closed-form optimum. For any reward $r$, the policy that maximizes it is

$$
\pi^*(y\mid x) \;=\; \frac{1}{Z(x)}\,\pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\, r(x,y)\Big),
$$

a reweighting of the reference by the exponentiated reward. I invert it to solve for the reward that would have produced a given policy:

$$
r(x,y) \;=\; \beta \,\log\frac{\pi^*(y\mid x)}{\pi_{\mathrm{ref}}(y\mid x)} \;+\; \beta\log Z(x).
$$

The reward is implicit in the policy. Any policy already is a reward model, read off as the log-ratio to the reference. I plug that into the Bradley-Terry model of preferences, $P(y_w \succ y_l) = \sigma\!\big(r(x,y_w)-r(x,y_l)\big)$. The $\beta\log Z(x)$ terms cancel because they don't depend on the response. What's left is a loss I compute directly from two log-probabilities:

$$
\mathcal{L}_{\mathrm{DPO}} \;=\; -\,\mathbb{E}_{(x,\,y_w,\,y_l)}\left[\log\sigma\!\left(
\beta\log\frac{\pi_\theta(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}
\;-\;
\beta\log\frac{\pi_\theta(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}
\right)\right].
$$

No reward model. No sampling. No online loop. Four forward passes per pair (policy and reference, on chosen and rejected) and a logistic loss. The KL leash is baked into the loss through $\pi_{\mathrm{ref}}$ and $\beta$.

This maps to my training script. `generate_dpo_script` in [`orbit/training/dpo_config.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/orbit/training/dpo_config.py) wires up a `trl` `DPOConfig` + `DPOTrainer`. The $\beta$ from the derivation is a literal constant:

```python
DPO_BETA = 0.1
training_args = DPOConfig(
    output_dir=OUTPUT_DIR,
    learning_rate=5e-6,
    beta=DPO_BETA,
    # Implicit memory limit bounds
    max_prompt_length={config.max_seq_length // 2},
    gradient_checkpointing=True,
)
```

I hard-code `DPO_BETA = 0.1` — small enough to let the persona move, tight enough to anchor it. I train using QLoRA: the base loads in 4-bit and only a LoRA adapter trains. The dataset is loaded as plain JSONL.

```text
          [ prompt ]
               |
      +--------+--------+
      |                 |
[ chosen (in-char) ]   [ rejected (OOC) ]
      |                 |
  ↑ likelihood      ↓ likelihood

(anchored to the SFT reference)
```

## What my gradient is doing

Differentiate the loss and the per-example gradient is:

$$
\nabla_\theta \mathcal{L}_{\mathrm{DPO}} \;=\; -\beta\,\underbrace{\sigma\!\big(\hat r_\theta(y_l) - \hat r_\theta(y_w)\big)}_{\text{weight: how wrong I am}}
\Big[\nabla_\theta\log\pi_\theta(y_w\mid x) - \nabla_\theta\log\pi_\theta(y_l\mid x)\Big],
$$

where $\hat r_\theta$ is the implicit reward $\beta\log\frac{\pi_\theta}{\pi_{\mathrm{ref}}}$. The scalar in front is large when the model currently ranks the pair wrong and near zero once the model already prefers chosen. DPO automatically spends gradient on the pairs it's getting wrong.

This same mechanism is the source of a failure mode detailed in [A General Theoretical Paradigm to Understand Learning from Human Preferences (Azar et al., 2023)](https://arxiv.org/abs/2310.12036). The loss only constrains the difference of log-ratios. I often observe the log-probability of the chosen responses going down during training, just slower than the rejected ones. The model optimizes exactly what I asked, while becoming less likely to produce the exact answers I preferred.

## The OOC trick I use

I target out-of-character (OOC) slips — the model breaking persona. My preference pairs aim exactly at that: the rejected sample is a plausible-but-OOC response, the chosen is the in-character one, matched so the only difference is the penalty target. If chosen and rejected differ in length or topic, DPO exploits that and learns the wrong lesson. A well-constructed pair isolates one axis, and DPO learns a precise downward pressure on OOC behavior.

## Serving many characters at once

At 14B parameters in fp16, loading a full fine-tune per character takes ~28 GB of weights. I'd max out a GPU immediately. Instead, I deploy using vLLM + [S-LoRA (Sheng et al., 2023)](https://arxiv.org/abs/2311.03285). The personas are LoRA adapters (rank-16 is tens of MBs), multiplexed over one shared base on the same GPU. S-LoRA batches requests hitting different adapters together, so my deployment answers as dozens of characters concurrently at high throughput.

DPO is my offline, stable hammer for preference and style. I let the math collapse the reward model into a log-ratio, keep my data near on-policy, and serve the weights as cheap deltas.
