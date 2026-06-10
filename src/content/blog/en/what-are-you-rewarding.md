---
title: "What am I actually rewarding?"
description: "RL doesn't optimize what I want — it optimizes exactly what I wrote down. The gap between the two is reward hacking, and closing it is most of the real work. Verifiers vs reward models, and how a constraint reward earned its +12%."
date: 2026-06-10
order: 3
series: "post-training"
reading: "13 min read"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

Here is the physical law that governs every RL run I spin up: the policy optimizes exactly the number I defined, not one bit of what I meant by it. Every gap between "the reward I wrote" and "the behavior I wanted" gets found, and then exploited. Most of my work in RL post-training is not the optimizer itself. It's closing that gap.

This is Goodhart's law in its purest form — when a measure becomes a target, it ceases to be a good measure. [Categorizing Variants of Goodhart's Law (Manheim & Garrabrant, 2018)](https://arxiv.org/abs/1803.04585) provides a useful taxonomy for how this breaks down into regressional, extremal, and adversarial failures. The mechanism I observe is precise: my reward $r$ is a proxy for the true objective $r^*$ I can't write down, and the two are correlated over the region where I measured them. Optimization, by construction, hunts for the input that maximizes $r$, dragging the policy toward the edge of that region, exactly where the proxy and the true objective decorrelate. The more aggressively I optimize a fixed proxy, the further out I go. Reward hacking isn't a bug; it's the generic consequence of optimizing any imperfect proxy hard enough. So the engineering question I ask is never "is my reward perfect" (it isn't) but "how far can the policy travel before the proxy lies, and can I stop it before then." This matches DeepMind's findings on [specification gaming](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4), where agents optimize the letter of the reward against its spirit.

## Two kinds of reward, and when I use which

**Verifiers (RLVR).** A program checks the output. Does the plan stay under budget? Do the time windows actually fit? Is the final number correct? When correctness is programmatically checkable, this is my gold standard: exact, cheap, and it has no blind spots to exploit, as long as the check is complete.

**Reward models (RM).** A learned model scores quality when I have no program that can. "Is this plan reasonable and executable?", "is this answer helpful?" — judgments with no clean oracle. An RM gives me a signal where a verifier can't reach. But it is itself a model, which means it has blind spots, and the policy will find every one. Phase-transition-like jumps where a policy suddenly discovers a hack as capability increases are well documented, such as in [The Effects of Reward Misspecification (Pan et al., 2022)](https://arxiv.org/abs/2201.03544).

The tradeoff is sharp. A verifier's correlation with the true objective is flat in the optimization pressure I apply — it's a fixed program, so a plan that's actually under budget scores correct no matter how hard the policy pushes. An RM is the opposite: its correlation with the truth decays as the policy moves off-distribution. Every step of optimization is a step toward the inputs where the RM was never trained and is most likely wrong. This asymmetry is the whole reason my design pushes every checkable thing into the verifier and lets the RM cover only the irreducibly-fuzzy remainder.

The real reward for the planning agent was neither — it was a decomposition:

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

In my codebase, a verifier is a small `Protocol` in [`orbit/verifiers/base.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/orbit/verifiers/base.py) with one job — turn a trajectory into a structured reward. The contract is two pydantic models. The `VerifierSpec` holds the knobs; the `VerifierResult` holds the decomposed output. 

The reward is not a single scalar — it's decomposed across the trajectory. My implementation, `StaticTraceVerifier.verify` in [`orbit/verifiers/static.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/orbit/verifiers/static.py), builds a per-step process reward out of four weighted terms:

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

The first term is potential-based shaping — the change in a potential $\phi$ between steps. By Ng et al.'s classic result, this adds dense guidance without changing the optimal policy, which is my principled way to avoid one whole class of reward hacks. The verifier then discounts these into returns, subtracts a `trajectory_mean` baseline, and clips the resulting advantage weights to `±process_weight_max`. That clip is itself a guardrail: no single step's advantage can blow up and dominate the update.

## Over-optimization has a scaling law

Divergence isn't folklore; I measure it. As [Scaling Laws for Reward Model Overoptimization (Gao, Schulman & Hilton, 2022)](https://arxiv.org/abs/2210.10760) showed, as I spend KL budget, the proxy RM score rises monotonically while the gold score rises, peaks, and then falls. They fit the gold reward as a clean function of the KL distance $d = \sqrt{\mathbb{D}_{\mathrm{KL}}}$,

$$
R(d) \;=\; d\,(\alpha - \beta \log d),
$$

which captures exactly that rise-then-fall: early KL buys real improvement, and past a budget each additional nat of divergence buys proxy gains that cost true performance. Two operational consequences. First, there is an optimal KL distance — a point where the gold reward peaks — and training past it makes the model genuinely worse while my dashboard says it's improving. Second, the budget scales with RM quality: a bigger, better-trained RM pushes the peak further out, but no finite RM removes the peak.

## How I close the gap

I push checkable things into the verifier. Completeness of the verifier is the single highest-leverage thing I own.

I keep the KL leash on. A penalty toward the SFT reference bounds how far the policy can contort to exploit the reward. The KL-regularized objective has the closed-form optimum

$$
\pi^*(y\mid x) \;\propto\; \pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\,r(x,y)\Big).
$$

I read that as a thermostat. The reward doesn't write the policy from scratch; it tilts the reference, and $\beta$ sets how hard it's allowed to tilt. A response the reference considers absurdly unlikely needs an enormous reward to overcome the $\pi_{\mathrm{ref}}$ prior in front — which is precisely the brake on reward hacking. The cartoonish exploits are exactly the responses $\pi_{\mathrm{ref}}$ assigns near-zero mass. Lower $\beta$ lets the policy chase reward further off-distribution; higher $\beta$ keeps it honest but caps how much it can learn. 

As the policy improves, I refresh the RM on its new failures. The new hacks are exactly the cases the RM never saw. I periodically label the fresh failure modes and retrain the RM — otherwise it goes stale and the policy walks straight through it. 

The planning agent's complex-constraint satisfaction rose ~12% on my internal benchmark. The truth is dull: the gain came from making the constraint reward complete and trustworthy — closing verifier gaps, decomposing hard constraints out of the RM's reach, and chasing down each new hack the policy invented. The optimizer was the same the whole time. Debugging RL is mostly debugging the reward.
