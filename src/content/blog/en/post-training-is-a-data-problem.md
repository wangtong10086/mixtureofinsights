---
title: "Post-training is a data problem"
description: "Everyone argues PPO vs GRPO vs DPO. On real projects the win almost always came from the data engine — synthetic trajectories, self-play, rejection sampling and an LLM judge — not the optimizer."
date: 2026-06-11
order: 1
series: "post-training"
reading: "8 min read"
tags: ["llm", "post-training", "synthetic-data", "rejection-sampling"]
---

If you read the literature you'd think post-training is a contest between optimizers —
PPO, GRPO, DPO, this month's acronym. Ship a few aligned models and you learn the
uncomfortable truth: **the optimizer is rarely what moves the metric. The data engine is.**
This post is about building that engine.

## Why the data, not the algorithm

A capable base model has already seen most of what it needs. Post-training mostly does two
things: it **elicits** a latent behavior the base can already approximate, and it **shapes**
which of many possible behaviors the model commits to. Neither needs a clever loss as much as
it needs *faithful demonstrations of the target behavior* — and that is exactly the thing you
can't buy.

For a vertical task — say a planning agent that has to satisfy hard constraints (budget, time
windows, route feasibility, multi-intent requests) — there is no large, clean annotated corpus
to fine-tune on. Human labeling is slow, expensive, and itself error-prone on long-horizon,
multi-constraint problems. So you stop trying to *collect* the data and start trying to
*manufacture* it.

## Four engines that manufacture data

**1 · Synthetic trajectories.** Build a simulator of the task's environment and let a model
walk through it. For the planning agent I borrowed the WebSailor idea: simulate the full
`user query → search engine → crawler → multi-turn reasoning` loop, and generate planning
problems that deliberately cover multiple intents, conflicting constraints, and complex
dependencies. You're not generating answers; you're generating *situations* dense with the
structure you want the model to learn.

**2 · Self-play.** When the task is interactive, let copies of the model generate the data by
playing against each other. In an AI Werewolf setup, LLM agents play repeated games — tracking
state, hiding identity, constructing lies — and the transcripts *are* the strategy dataset. No
human ever has to script a good bluff.

**3 · Rejection sampling.** Sample the model many times, keep only the outputs that pass a
check, throw the rest away. This is the cheapest way to turn a mediocre generator into a clean
SFT seed: sample long chains of reasoning, keep the ones that reach a verified-correct plan,
and you've distilled the model's own best moments into training data.

**4 · LLM-as-judge.** You cannot human-grade a million generations. A capable model, given a
sharp rubric, can rank, filter, and label at scale — producing both the *filter* for the three
engines above and the *preference pairs* that later feed DPO. The judge is leverage; its rubric
is where you spend your care.

## The flywheel

None of these is a one-shot. They compose into a loop, and the loop is the whole point:

<figure class="figure">
<svg viewBox="0 0 640 230" role="img" aria-label="The data flywheel: generate, verify, train, repeat">
  <defs><marker id="fw" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="40" y="92" width="150" height="46" rx="9"/><text x="62" y="112" class="t">Generator</text><text x="62" y="128" class="s">synthetic · self-play</text>
  <rect class="n" x="245" y="24" width="150" height="46" rx="9"/><text x="267" y="44" class="t">Verifier / Judge</text><text x="267" y="60" class="s">filter · rank · label</text>
  <rect class="n" x="450" y="92" width="150" height="46" rx="9"/><text x="472" y="112" class="t">Train</text><text x="472" y="128" class="s">SFT · GRPO · DPO</text>
  <rect class="n" x="245" y="160" width="150" height="46" rx="9"/><text x="267" y="180" class="t">Better model</text><text x="267" y="196" class="s">= better generator</text>
  <path class="a" d="M190 104 Q230 70 245 56" marker-end="url(#fw)"/>
  <path class="a" d="M395 50 Q440 70 460 92" marker-end="url(#fw)"/>
  <path class="a" d="M525 138 Q500 175 395 184" marker-end="url(#fw)"/>
  <path class="a" d="M245 184 Q150 178 115 138" marker-end="url(#fw)"/>
</svg>
<figcaption>Generate data → verify/filter it → train on the survivors → the improved model
generates better data. Each turn raises the floor of what the generator can produce.</figcaption>
</figure>

The first turn is the hardest and the worst: a weak generator, a noisy judge, low yield. But
each pass tightens it. The model you train this round becomes next round's generator, and the
verified data it can produce is strictly better than last round's. The compounding is the
product.

## What this changed about how I work

- **I budget engineering on the generator and the verifier, not the trainer.** The trainer is
  mostly solved code (ms-swift, a GRPO loop); the generator and the judge's rubric are where the
  task-specific value is, and where a week of work actually moves the number.
- **A verifier you trust is worth more than a bigger model.** Rejection sampling, RL rewards,
  and judge-filtering all collapse the moment the check is wrong. Most of my debugging time goes
  into the thing that decides "is this output actually good?"
- **Yield is a metric.** "What fraction of generations survive the filter?" tells you whether
  the flywheel will spin or stall, long before any eval number does.

On the planning agent, this engine — synthetic constraint-rich trajectories, rejection-sampled
into a clean `reasoning → plan` SFT seed — is what made the later RL stage *have something to
climb from*. Which is the next post: [cold-start, then climb](/blog/cold-start-then-climb/).
