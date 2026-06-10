---
title: "DPO when you can't afford RLHF"
description: "RLHF is powerful and heavy — a reward model, an online rollout loop, instability. DPO gets most of the way with a fraction of the machinery, and the reason it can is a single line of algebra that turns a reward model into a closed-form target. The derivation, the gradient that explains why it works, and the catch — which is always the data."
date: 2026-06-10
order: 4
series: "post-training"
reading: "12 min read"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

The previous two posts climbed a verifiable reward with GRPO. That machinery is the right tool
when correctness is checkable and you need online exploration. A lot of alignment isn't that.
"Stay in character." "Prefer this tone." "Don't break the fourth wall." There's no verifier and
no need for online RL — and reaching for full RLHF here is paying for an engine you won't drive.
**DPO** is the lighter tool, and on a role-play model it's the one that fit. It's also one of
the prettier results in post-training, because the reason it works is a derivation, not a
heuristic — so this time we'll actually do the algebra.

## What you're actually buying with RLHF — and skipping with DPO

RLHF (PPO-style) is three moving parts: train a **reward model** $r_\phi$ from preferences,
then run an **online RL loop** that samples from the policy, scores with the RM, and updates —
with a KL leash to keep it sane. The objective it's really maximizing is

$$
\max_{\pi_\theta}\; \mathbb{E}_{x,\,y\sim\pi_\theta}\big[\, r_\phi(x,y)\,\big]
\;-\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta(y\mid x)\,\|\,\pi_{\mathrm{ref}}(y\mid x)\right].
$$

It's strong, but it's a reward model to fit, an unstable online loop to babysit, and serious
compute. DPO's insight is that for *this exact objective*, you never needed the loop.

## The one derivation worth knowing

That KL-regularized objective has a known closed-form optimum. For any reward $r$, the policy
that maximizes it is

$$
\pi^*(y\mid x) \;=\; \frac{1}{Z(x)}\,\pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\, r(x,y)\Big),
$$

a reweighting of the reference by the exponentiated reward (this is the standard
reward-as-posterior result; $Z(x)$ is the intractable normalizer over all responses). Now invert
it — solve for the reward that would have produced a given policy:

$$
r(x,y) \;=\; \beta \,\log\frac{\pi^*(y\mid x)}{\pi_{\mathrm{ref}}(y\mid x)} \;+\; \beta\log Z(x).
$$

This is the trick. The reward is *implicit* in the policy — any policy already **is** a reward
model, read off as the log-ratio to the reference. Plug that expression into the Bradley-Terry
model of preferences, $P(y_w \succ y_l) = \sigma\!\big(r(x,y_w)-r(x,y_l)\big)$, and the
$\beta\log Z(x)$ terms — the intractable part — *cancel*, because they don't depend on the
response. What's left is a loss you can compute directly from two log-probabilities:

$$
\mathcal{L}_{\mathrm{DPO}} \;=\; -\,\mathbb{E}_{(x,\,y_w,\,y_l)}\left[\log\sigma\!\left(
\beta\log\frac{\pi_\theta(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}
\;-\;
\beta\log\frac{\pi_\theta(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}
\right)\right].
$$

No reward model. No sampling. No online loop. Four forward passes per pair (policy and reference,
on chosen and rejected) and a logistic loss. The KL leash didn't disappear — it's *baked into the
loss* through $\pi_{\mathrm{ref}}$ and $\beta$.

That maps almost line-for-line onto the training script. `generate_dpo_script` in
`orbit/training/dpo_config.py` is a code generator — it emits a standalone Python script that wires
up a `trl` `DPOConfig` + `DPOTrainer`, every field of which is one of the knobs above. The $\beta$
from the derivation is a literal constant, and `max_prompt_length` is just half the sequence
budget:

```python
DPO_BETA = 0.1
training_args = DPOConfig(
    output_dir=OUTPUT_DIR,
    learning_rate=5e-6,
    beta=DPO_BETA,
    max_prompt_length={config.max_seq_length // 2},
    gradient_checkpointing=True,
    ...
)
trainer = DPOTrainer(model=model, train_dataset=dataset, peft_config=peft_config, ...)
```

A few decisions read straight off the code. `DPO_BETA = 0.1` is the hard-coded KL leash — small
enough to let the persona move, tight enough to anchor it. The training is **QLoRA**: the base
loads in 4-bit (`BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4")`) and only a LoRA
adapter trains, which is what makes the per-character serving story below cheap; there's even an
optional `PeftModel.from_pretrained(...).merge_and_unload()` block to start DPO from a prior SFT
adapter. And the dataset is loaded as plain JSONL — `load_dataset("json", data_files=DATASET_PATH,
split="train")` over rows of `prompt` / `chosen` / `rejected`, the format the docstring spells out:
*"Path to DPO JSONL (prompt/chosen/rejected format)."* That JSONL is the entire interface between
the data engine and the trainer — which is why the next section is about the pairs, not the loss.

(One honest caveat: this generator is a self-contained template that hard-codes `DPO_BETA`,
`learning_rate`, and the LoRA target modules rather than threading them through `SwiftConfig` the
way the SFT/GRPO path does — so treat the numbers above as *this script's* defaults, not a tunable
config surface.)

<figure class="figure">
<svg viewBox="0 0 640 188" role="img" aria-label="DPO trains directly on chosen vs rejected pairs">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.ok{fill:#eef6f4;stroke:#0f766e;stroke-width:1.5}.no{fill:#faf3ec;stroke:#b4530a;stroke-width:1.5}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="d1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="74" width="120" height="40" rx="8"/><text x="38" y="99" class="t">prompt</text>
  <rect class="ok" x="200" y="26" width="200" height="40" rx="9"/><text x="216" y="51" class="t">chosen (in-character)</text>
  <rect class="no" x="200" y="118" width="200" height="40" rx="9"/><text x="216" y="143" class="t">rejected (OOC)</text>
  <path class="a" d="M140 86 Q170 50 200 46" marker-end="url(#d1)"/>
  <path class="a" d="M140 102 Q170 140 200 138" marker-end="url(#d1)"/>
  <text x="430" y="44" class="up">↑ likelihood</text>
  <text x="430" y="138" class="dn">↓ likelihood</text>
  <text x="430" y="92" class="s">anchored to the SFT</text>
  <text x="430" y="108" class="s">reference (built-in KL)</text>
</svg>
<figcaption>No reward model, no online rollouts. One offline loss over preference pairs, pinned
to the SFT reference so the model can't drift while it learns to prefer.</figcaption>
</figure>

## What the gradient is actually doing

The intuition "push chosen up, push rejected down" is right but incomplete. Differentiate the
loss and the per-example gradient is

$$
\nabla_\theta \mathcal{L}_{\mathrm{DPO}} \;=\; -\beta\,\underbrace{\sigma\!\big(\hat r_\theta(y_l) - \hat r_\theta(y_w)\big)}_{\text{weight: how wrong we are}}
\Big[\nabla_\theta\log\pi_\theta(y_w\mid x) - \nabla_\theta\log\pi_\theta(y_l\mid x)\Big],
$$

where $\hat r_\theta$ is the implicit reward $\beta\log\frac{\pi_\theta}{\pi_{\mathrm{ref}}}$.
The bracket is the expected "raise chosen, lower rejected" direction. The scalar in front is the
part that matters: it's *large when the model currently ranks the pair wrong* (rejected scored
higher than chosen) and *near zero once the model already prefers chosen*. DPO automatically
spends gradient on the pairs it's getting wrong and ignores the ones it's already right about —
a built-in hard-example weighting, with no curriculum to tune.

That same mechanism is the source of DPO's main failure mode, and it's worth seeing plainly. The
loss only constrains the *difference* of log-ratios. Nothing pins the absolute levels — so a
common, slightly alarming observation is that the log-probability of the *chosen* responses goes
**down** during training, just slower than the rejected ones. The margin widens, the loss falls,
and the model is technically optimizing exactly what you asked — while becoming less likely to
produce the very answers you preferred. (This is the gap that motivated variants like IPO, which
bounds the objective, and the conservative/cDPO family. Watch the chosen logprob, not just the
loss.)

## The data is still the whole game

DPO's simplicity just moves the difficulty back to where it always lives: **the preference
pairs.** The trainer doesn't care *how* you produced the JSONL — it just reads `prompt` / `chosen`
/ `rejected` rows — so the entire engineering problem is upstream of `generate_dpo_script`.
Hand-labeling enough pairs is exactly the cost you're trying to avoid, so the pattern that fits is
the data engine from [post 1](/blog/post-training-is-a-data-problem/) pointed at preferences:

- **self-critique** to draft and revise responses against a written set of character principles,
- **a judge / scorer** (the verifier-or-RM `score` from post 1) to rank candidates into
  chosen/rejected,
- **human review** only on the residual the automation couldn't settle.

That collapses the human cost to a thin top layer over a mostly-synthetic pipeline. One detail
the derivation makes non-negotiable: the pairs should come from a model *close to your reference*
(ideally the SFT checkpoint's own samples). DPO's math assumes the preference data lives in the
reference's distribution; pairs drawn from some other model create a train/serve distribution
gap that quietly weakens the result. "On-policy-ish" preference data isn't a nicety — it's an
assumption of the objective.

## The OOC trick

The sharpest use of DPO here was targeted, not generic. Out-of-character (OOC) slips — the model
breaking persona, leaking that it's an assistant, dropping the speech style — are the failure
that kills a role-play product. So the preference pairs were constructed to *aim at exactly
that*: the **rejected** sample is a plausible-but-OOC response, the **chosen** is the in-character
one, **matched** so the only salient difference is the thing you want penalized. That last part
is what makes the gradient clean — if chosen and rejected differ in length, topic, *and*
character, DPO can lower the margin by exploiting any of those, and you've taught it the wrong
lesson. A well-constructed pair isolates one axis, and then DPO learns a precise downward
pressure on OOC behavior — a penalty signal that would have cost a full RM + RL loop to express,
bought here with pair construction alone.

Stacked on a first-stage SFT (persona, style, identity logic), this `SFT → DPO` recipe lifted
character consistency and multi-turn controllability, faster and more stably than either plain
SFT or a full RLHF pipeline.

## Serving many characters at once

Alignment isn't done until it's deployed. A role-play product is *many* personas, not one, and
loading a full fine-tune per character doesn't scale — at, say, 14B parameters in fp16 that's
~28 GB of weights *per character*, and you'd serve a handful before a GPU is full. The serving
side used **vLLM + S-LoRA** instead: the personas are LoRA adapters (rank-16 on a 14B model is
on the order of tens of MB each, ~1000× smaller than the base), many of them multiplexed over
*one* shared base on the same GPU. S-LoRA keeps the adapters in a unified pool and batches
requests that hit *different* adapters together, so a single deployment answers as dozens of
characters concurrently at high throughput — the difference between "one model per character"
and "one base, characters as cheap deltas."

## The takeaway

Match the method to the goal. **DPO for preference, style, and persona alignment** — it's
offline, stable, and most of the cost is good preference data. It earns that simplicity honestly,
through a derivation that collapses a reward model into a log-ratio. But the same derivation tells
you its limits: it optimizes a margin, not an absolute, and it assumes near-on-policy data —
ignore either and the loss will happily go down while the model gets worse. Save the GRPO/RLHF
machinery for when you genuinely need online exploration against a verifiable reward, like the
planning agent. Using the heavy tool where the light one fits is its own kind of reward hacking —
on your time.

## Further reading

- [Direct Preference Optimization](https://arxiv.org/abs/2305.18290) — the original derivation; §4 is the part worth reading slowly.
- [IPO / "A General Theoretical Paradigm…"](https://arxiv.org/abs/2310.12036) — why the unbounded DPO objective can overfit, and a bounded alternative.
- [S-LoRA](https://arxiv.org/abs/2311.03285) — serving thousands of LoRA adapters over one base.
