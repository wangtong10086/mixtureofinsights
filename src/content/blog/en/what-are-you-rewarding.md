---
title: "Planning-agent rewards: verifiers, reward models and reward hacking"
description: "How a planning agent combines constraint verifiers and reward models, with process rewards, KL regularization, and checks for reward overoptimization."
date: 2026-06-10
updatedAt: 2026-09-15
order: 3
series: "post-training"
reading: "13 min read"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

A planning agent needs separate signals for hard constraints and soft judgments. This implementation checks budget and time-window constraints programmatically, leaves less explicit quality judgments to a reward model, and compares reward gains with held-out evaluation. The verifier code shows how scores are combined; it does not establish that the checks are complete or independently verify the reported internal benchmark gain.

This is an instance of Goodhart's law — when a measure becomes a target, it ceases to be a good measure. [Categorizing Variants of Goodhart's Law (Manheim & Garrabrant, 2018)](https://arxiv.org/abs/1803.04585) provides a useful taxonomy for how this breaks down into regressional, extremal, and adversarial failures.

My reward $r$ is a proxy for the true objective $r^*$ I can't write down. They are correlated over the region where I measured them. Optimization, by construction, hunts for the input that maximizes $r$, dragging the policy toward the edge of that region, exactly where the proxy and the true objective decorrelate. The more aggressively I optimize a fixed proxy, the further out I go. Optimizing any imperfect proxy hard enough leads to reward hacking. I therefore need to know how far the policy can move before the proxy stops reflecting the objective, and whether I can stop it in time.

 This matches DeepMind's findings on [specification gaming](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4), where agents optimize the letter of the reward against its spirit.

## Two kinds of reward, and when I use which

**Verifiers (RLVR).** A program checks the output. Does the plan stay under budget? Do the time windows actually fit? Is the final number correct? When correctness is programmatically checkable, this is my gold standard: exact, cheap, and it has no blind spots to exploit, as long as the check is complete.

**Reward models (RM).** A learned model scores quality when I have no program that can. "Is this plan reasonable and executable?", "is this answer helpful?" — judgments with no clean oracle. An RM gives me a signal where a verifier can't reach. But it is itself a model, which means it has blind spots, and the policy will find every one. Phase-transition-like jumps where a policy suddenly discovers a hack as capability increases are well documented, such as in [The Effects of Reward Misspecification (Pan et al., 2022)](https://arxiv.org/abs/2201.03544).

A verifier's correlation with the true objective is flat in the optimization pressure I apply — it's a fixed program, so a plan that's actually under budget scores correct no matter how hard the policy pushes. An RM is the opposite: its correlation with the truth decays as the policy moves off-distribution. Every step of optimization is a step toward the inputs where the RM was never trained and is most likely wrong. This asymmetry is the whole reason my design pushes every checkable thing into the verifier and lets the RM cover only the irreducibly-fuzzy remainder.

The planning agent combines both kinds of reward:

```text
           +-----------------+
           |     a plan      |
           +--------+--------+
                    |
      +-------------+-------------+
      |                           |
      v                           v
+-----+----------------+    +-----+----------------+
|  Verifier (exact)    |    |Reward model (learned)|
| budget, time windows,|    | "reasonable &        |
| feasibility          |    | executable?"         |
+-----+----------------+    +-----+----------------+
      |                           |
      +-------------+-------------+
                    |
                    v
           +--------+--------+
           |     reward      |
           +-----------------+
```

Hard, checkable constraints go to an exact verifier; soft quality goes to a reward model. I push everything I can check into the half that can't be hacked.

## What my verifier actually is in code

In my codebase, a verifier is a small `Protocol` in [`orbit/verifiers/base.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/verifiers/base.py) with one job — turn a trajectory into a structured reward. The contract is two pydantic models. The `VerifierSpec` holds the knobs; the `VerifierResult` holds the decomposed output.

The reward is not a single scalar — it's decomposed across the trajectory. My implementation, `StaticTraceVerifier.verify` in [`orbit/verifiers/static.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/verifiers/static.py), builds a per-step process reward out of four weighted terms:

```python
reward = (
    # potential-shaping weight, measuring progress made this step
    self.spec.lambda_delta * (phi_prefix[idx + 1] - phi_prefix[idx])
    # local (per-step) score weight
    + self.spec.lambda_g * local_scores[idx]
    # environment signal
    + self.spec.lambda_env * env_rewards[idx]
)
if idx == len(local_scores) - 1:
    # final outcome
    reward += self.spec.lambda_u * terminal_score
```

The first term is potential-based shaping — the change in a potential $\phi$ between steps. Policy-invariance results for potential shaping require their discount and boundary conditions. This implementation uses an un-discounted potential difference and discounts returns later; the excerpt alone does not justify an invariance or no-reward-hacking guarantee. The verifier then discounts these into returns, subtracts a `trajectory_mean` baseline, and clips the resulting advantage weights to `±process_weight_max`. That clip is itself a guardrail: no single step's advantage can blow up and dominate the update.

## Over-optimization has a scaling law

I measure this divergence in my runs. As [Scaling Laws for Reward Model Overoptimization (Gao, Schulman & Hilton, 2022)](https://arxiv.org/abs/2210.10760) showed, as I spend KL budget, the proxy RM score rises monotonically while the gold score rises, peaks, and then falls. They fit the gold reward as a clean function of the KL distance $d = \sqrt{\mathbb{D}_{\mathrm{KL}}}$,

$$
R(d) \;=\; d\,(\alpha - \beta \log d),
$$

which captures exactly that rise-then-fall: early KL buys real improvement, and past a budget each additional nat of divergence buys proxy gains that cost true performance. This has two consequences for training. First, there is an optimal KL distance — a point where the gold reward peaks — and training past it makes the model genuinely worse while my dashboard says it's improving. Second, the budget scales with RM quality: a bigger, better-trained RM pushes the peak further out, but no finite RM removes the peak.

<span id="how-i-close-the-gap" aria-hidden="true"></span>

## Held-out checks for reward overoptimization

I push checkable things into the verifier. Making the verifier complete matters more than any other change I can make.

I keep a KL penalty. A penalty toward the SFT reference bounds how far the policy can contort to exploit the reward. The KL-regularized objective has the closed-form optimum

$$
\pi^*(y\mid x) \;\propto\; \pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\,r(x,y)\Big).
$$

The reward reweights the reference policy, and $\beta$ controls the strength of that reweighting. A response the reference considers absurdly unlikely needs an enormous reward to overcome the $\pi_{\mathrm{ref}}$ prior in front — which is precisely the brake on reward hacking. The cartoonish exploits are exactly the responses $\pi_{\mathrm{ref}}$ assigns near-zero mass. Lower $\beta$ lets the policy chase reward further off-distribution; higher $\beta$ keeps it honest but caps how much it can learn.

As the policy improves, I refresh the RM on its new failures. The new hacks are exactly the cases the RM never saw. I periodically label the fresh failure modes and retrain the RM — otherwise the RM falls behind the policy.

The planning agent's complex-constraint satisfaction rose ~12% on my internal benchmark. The gain came from completing the constraint reward: closing verifier gaps, moving hard constraints out of the RM, and addressing each new exploit. The optimizer stayed the same.

The verifier also controls which examples survive in the [post-training data pipeline](/blog/post-training-is-a-data-problem/), so auditing reward gaps is part of dataset quality control.
