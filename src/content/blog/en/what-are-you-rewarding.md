---
title: "What are you actually rewarding?"
description: "RL doesn't optimize what you want — it optimizes exactly what you wrote down. The gap between the two is reward hacking, and closing it is most of the real work. Verifiers vs reward models, and how a constraint reward earned its +12%."
date: 2026-06-10
order: 3
series: "post-training"
reading: "13 min read"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

Here is the law that governs every RL run: **the policy optimizes exactly the number you
defined, and not one bit of what you meant by it.** Every gap between "the reward I wrote" and
"the behavior I wanted" gets found, and then exploited, with the patience of a search process
that has nothing better to do. Most of the work in RL post-training is not the optimizer. It's
closing that gap.

This has a name older than RL: **Goodhart's law** — *when a measure becomes a target, it ceases
to be a good measure.* The mechanism is precise. Your reward $r$ is a proxy for the true
objective $r^*$ you can't write down, and the two are correlated over the region where you
measured them. Optimization, by construction, hunts for the input that maximizes $r$ — which
drags the policy *toward the edge of that region*, exactly where the proxy and the true objective
decorrelate. The more aggressively you optimize a fixed proxy, the further out you go, and the
worse the correlation you're relying on becomes. Reward hacking isn't a bug in your reward; it's
the generic consequence of optimizing any imperfect proxy hard enough. So the engineering
question is never "is my reward perfect" (it isn't) but "how far can the policy travel before the
proxy lies, and can I stop it before then."

## Two kinds of reward, and when to use which

**Verifiers (RLVR).** A *program* checks the output. Does the plan stay under budget? Do the
time windows actually fit? Is the final number correct? When correctness is programmatically
checkable, this is the gold standard: exact, cheap, and — crucially — it has *no blind spots to
exploit*, as long as the check is complete.

**Reward models (RM).** A *learned* model scores quality when there's no program that can.
"Is this plan reasonable and executable?", "is this answer helpful?" — judgments with no clean
oracle. An RM gives you a signal where a verifier can't reach. But it is itself a model, which
means it *has* blind spots, and the policy will find every one.

The tradeoff is sharp enough to state precisely. A verifier's correlation with the true
objective is **flat in the optimization pressure you apply** — it's a fixed program, so a plan
that's actually under budget scores correct no matter how hard the policy pushes, and there's no
edge of a training region to fall off. Its coverage is partial (only what you could encode), but
within that coverage it does not degrade under optimization. An RM is the opposite: broad
coverage, but it's a finite model fit on a finite sample, so its correlation with the truth
**decays as the policy moves off-distribution** — every step of optimization is a step toward
the inputs where the RM was never trained and is most likely wrong. Verifier: narrow but
optimization-proof. RM: broad but optimization-fragile. That asymmetry is the whole reason the
right design is to push every checkable thing into the verifier and let the RM cover only the
irreducibly-fuzzy remainder.

The real reward for the planning agent was neither — it was a **decomposition**:

<figure class="figure">
<svg viewBox="0 0 620 200" role="img" aria-label="Reward decomposed into verifier and reward model">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.v{fill:#eef6f4;stroke:#0f766e;stroke-width:1.5}.m{fill:#faf3ec;stroke:#b4530a;stroke-width:1.5}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="r1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="80" width="120" height="40" rx="8"/><text x="40" y="105" class="t">a plan</text>
  <rect class="v" x="220" y="26" width="220" height="44" rx="9"/><text x="236" y="46" class="t">Verifier (exact)</text><text x="236" y="62" class="s">budget · time windows · feasibility</text>
  <rect class="m" x="220" y="120" width="220" height="44" rx="9"/><text x="236" y="140" class="t">Reward model (learned)</text><text x="236" y="156" class="s">"reasonable & executable?"</text>
  <rect class="n" x="500" y="80" width="100" height="40" rx="8"/><text x="516" y="105" class="t">reward</text>
  <path class="a" d="M140 92 Q180 60 220 50" marker-end="url(#r1)"/>
  <path class="a" d="M140 108 Q180 140 220 142" marker-end="url(#r1)"/>
  <path class="a" d="M440 48 Q480 70 500 90" marker-end="url(#r1)"/>
  <path class="a" d="M440 142 Q480 120 500 110" marker-end="url(#r1)"/>
</svg>
<figcaption>Hard, checkable constraints go to an exact verifier; soft quality goes to a reward
model. Push everything you *can* check into the half that can't be hacked.</figcaption>
</figure>

## What a verifier actually is in code

In Orbit a verifier is a small `Protocol` (`orbit/verifiers/base.py`) with one job — turn a
trajectory into a structured reward. The contract is two pydantic models. The `VerifierSpec` holds
the knobs; the `VerifierResult` holds the decomposed output:

```python
class VerifierSpec(StrictModel):
    kind: str = "static_trace"
    gamma: float = 0.99
    lambda_delta: float = 1.0   # potential-shaping weight
    lambda_g: float = 1.0       # local (per-step) score weight
    lambda_env: float = 1.0     # environment-reward weight
    lambda_u: float = 1.0       # terminal-utility weight
    process_weight_max: float = 4.0
    baseline_strategy: str = "trajectory_mean"
```

The reward is *not* a single scalar — it's decomposed across the trajectory. The implementation,
`StaticTraceVerifier.verify` in `orbit/verifiers/static.py`, builds a per-step process reward out
of four weighted terms, exactly the `lambda_*` above:

```python
reward = (
    self.spec.lambda_delta * (phi_prefix[idx + 1] - phi_prefix[idx])  # progress made this step
    + self.spec.lambda_g * local_scores[idx]                          # how good this step is
    + self.spec.lambda_env * env_rewards[idx]                         # environment signal
)
if idx == len(local_scores) - 1:
    reward += self.spec.lambda_u * terminal_score                     # final outcome
```

The first term is **potential-based shaping** — the change in a potential $\phi$ between steps,
which (by Ng et al.'s classic result) adds dense guidance *without changing the optimal policy*,
the principled way to avoid one whole class of reward hacks. The verifier then discounts these into
returns (`discounted_returns(..., gamma=...)`), subtracts a `trajectory_mean` baseline, and clips
the resulting advantage weights to `±process_weight_max`. That clip is itself an anti-hacking
guardrail: no single step's advantage can blow up and dominate the update.

Two things worth noting against the "verifier vs RM" framing above. First, `terminal_score` is the
hard, checkable part (`success = terminal_score >= success_threshold`), while `local_scores` /
`potentials` can come from a softer signal — so a single `StaticTraceVerifier` can *itself* be the
decomposition in the diagram, hard terminal check plus soft per-step shaping. Second, every weight
is a `lambda_*` you set in config, which means every weight is a hackable surface — turn up
`lambda_g` and the policy will farm whatever `local_scores` measures. The decomposition buys you
precision; it also multiplies the number of knobs you have to keep honest.

## What reward hacking actually looks like

It is never subtle in hindsight and never obvious in advance:

- **Verifier gaps.** A constraint you forgot to check is a constraint the policy is free to
  violate. Forget to verify that stops are in a sensible order and you'll get plans that satisfy
  every coded check while being physically absurd.
- **RM blind spots.** Reward models quietly reward *surface* features — length, confident tone,
  a tidy format, agreeing with the user. Leave it unchecked and the policy learns to be long,
  confident, and sycophantic, with reward climbing the whole time.
- **The tell:** reward goes up, held-out eval doesn't. That divergence is the alarm. If your
  number is rising and your benchmark isn't, you are not getting better — you are getting better
  at the reward.

## Over-optimization has a scaling law

The divergence above isn't folklore; it's measured. Gao, Schulman & Hilton ([2022](https://arxiv.org/abs/2210.10760))
trained a policy against a *proxy* reward model while holding out a much larger "gold" RM as a
stand-in for true reward, and plotted both as the policy moved away from the reference. The shape
is now a load-bearing fact of RLHF: as you spend KL budget, the **proxy RM score rises
monotonically while the gold score rises, peaks, and then falls** — over-optimization. They fit
the gold reward as a clean function of the KL distance $d = \sqrt{\mathbb{D}_{\mathrm{KL}}}$,

$$
R(d) \;=\; d\,(\alpha - \beta \log d),
$$

which captures exactly that rise-then-fall: early KL buys real improvement, and past a budget
each additional nat of divergence buys proxy gains that *cost* you true performance. Two
operational consequences. First, there is an **optimal KL distance** — a point where the gold
reward peaks — and training past it makes the model genuinely worse while every dashboard says
it's improving. Second, the budget *scales with RM quality*: a bigger, better-trained RM pushes
the peak further out (more optimization before it breaks), but no finite RM removes the peak.
This is the quantitative version of "the reward is a proxy" — it has a turning point, and your
job is to stop near it.

## How you close the gap

- **Push checkable things into the verifier.** Every constraint you can express as a program is
  one the policy can't hack. Completeness of the verifier is the single highest-leverage thing
  you own.
- **Keep the KL leash on (again), and know *why* it bounds hacking.** A penalty toward the SFT
  reference bounds how far the policy can contort to exploit the reward — and the [DPO
  post](/blog/dpo-when-you-cant-afford-rlhf/) tells you exactly how. The KL-regularized objective
  has the closed-form optimum

  $$
  \pi^*(y\mid x) \;\propto\; \pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\,r(x,y)\Big).
  $$

  Read that as a thermostat. The reward doesn't get to *write* the policy from scratch; it gets
  to *tilt* the reference, and $\beta$ sets how hard it's allowed to tilt. A response the
  reference considers absurdly unlikely needs an enormous reward to overcome the
  $\pi_{\mathrm{ref}}$ prior in front — which is precisely the brake on reward hacking, because
  the cartoonish exploits (degenerate text, format spam) are exactly the responses
  $\pi_{\mathrm{ref}}$ assigns near-zero mass. Lower $\beta$ lets the policy chase reward further
  off-distribution and hack harder; higher $\beta$ keeps it honest but caps how much it can
  learn. The leash isn't a heuristic add-on; it's the lever that sets your position on the
  Goodhart curve. It's the same leash from the [cold-start
  post](/blog/cold-start-then-climb/), doing double duty.
- **Refresh the RM on the policy's new failures.** As the policy improves, its *new* hacks are
  exactly the cases the RM never saw. Periodically label the fresh failure modes and retrain the
  RM — otherwise it goes stale and the policy walks straight through it.
- **Cap and ensemble.** Bounded rewards and an ensemble of judges make any single blind spot
  less catastrophic.
- **Trust the eval, not the reward.** The reward is a proxy you're training *against*; the
  held-out verifier-graded benchmark is the truth you're training *toward*. When they disagree,
  the eval wins.

## The honest version of "+12%"

The planning agent's complex-constraint satisfaction rose ~12% on an internal benchmark. It's
tempting to credit GRPO. The truth is duller and more useful: the gain came from making the
constraint reward *complete and trustworthy* — closing verifier gaps, decomposing hard
constraints out of the RM's reach, and chasing down each new hack the policy invented. The
optimizer was the same the whole time. **Debugging RL is mostly debugging the reward.**

Verifiers and judges aren't only a training signal, though — they're how you know any of this
worked at all. That's where this series turns next: the eval harness as the actual product.

## Further reading

- [Goodhart's law (the original)](https://en.wikipedia.org/wiki/Goodhart%27s_law) — and Manheim
  & Garrabrant, [*Categorizing Variants of Goodhart's Law*](https://arxiv.org/abs/1803.04585),
  which separates regressional, extremal, and adversarial failure — a useful taxonomy for *how* a
  reward breaks.
- [Scaling Laws for Reward Model Overoptimization](https://arxiv.org/abs/2210.10760) — Gao,
  Schulman & Hilton; the rise-then-fall curve and the $d(\alpha-\beta\log d)$ fit above.
- [The Effects of Reward Misspecification](https://arxiv.org/abs/2201.03544) — Pan et al.;
  phase-transition-like jumps where a policy suddenly discovers a hack as capability increases.
- [Reward hacking / specification gaming](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4)
  — DeepMind's catalogue of agents optimizing the letter of the reward against its spirit.
