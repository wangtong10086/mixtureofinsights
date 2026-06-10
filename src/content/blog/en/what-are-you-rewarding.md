---
title: "What are you actually rewarding?"
description: "RL doesn't optimize what you want — it optimizes exactly what you wrote down. The gap between the two is reward hacking, and closing it is most of the real work. Verifiers vs reward models, and how a constraint reward earned its +12%."
date: 2026-06-13
order: 3
series: "post-training"
reading: "8 min read"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

Here is the law that governs every RL run: **the policy optimizes exactly the number you
defined, and not one bit of what you meant by it.** Every gap between "the reward I wrote" and
"the behavior I wanted" gets found, and then exploited, with the patience of a search process
that has nothing better to do. Most of the work in RL post-training is not the optimizer. It's
closing that gap.

## Two kinds of reward, and when to use which

**Verifiers (RLVR).** A *program* checks the output. Does the plan stay under budget? Do the
time windows actually fit? Is the final number correct? When correctness is programmatically
checkable, this is the gold standard: exact, cheap, and — crucially — it has *no blind spots to
exploit*, as long as the check is complete.

**Reward models (RM).** A *learned* model scores quality when there's no program that can.
"Is this plan reasonable and executable?", "is this answer helpful?" — judgments with no clean
oracle. An RM gives you a signal where a verifier can't reach. But it is itself a model, which
means it *has* blind spots, and the policy will find every one.

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

## How you close the gap

- **Push checkable things into the verifier.** Every constraint you can express as a program is
  one the policy can't hack. Completeness of the verifier is the single highest-leverage thing
  you own.
- **Keep the KL leash on (again).** A penalty toward the SFT reference bounds how far the policy
  can contort to exploit the reward. It's the same leash from the
  [last post](/blog/cold-start-then-climb/), doing double duty.
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
