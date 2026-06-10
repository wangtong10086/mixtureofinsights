---
title: "Post-training is a data problem"
description: "Everyone argues PPO vs GRPO vs DPO. On real projects the win almost always came from the data engine — synthetic trajectories, self-play, rejection sampling and an LLM judge — not the optimizer."
date: 2026-06-10
order: 1
series: "post-training"
reading: "12 min read"
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

These aren't abstractions — in Orbit each one is a concrete module under `orbit/data/`, and
every engine writes the same canonical JSONL shape (`messages`, `env`, `score`, `task_id`) so a
single dataset builder can mix them.

**1 · Synthetic trajectories.** Build a simulator of the task's environment and let it emit
trajectories deterministically. The clearest example is `orbit/data/liveweb_teacher_gen.py`: a
`TeacherGenerator` replays cached web-tool data to produce composite multi-tool trajectories with
**no LLM calls at all** — purely deterministic from cached page data:

```python
gen = TeacherGenerator(cache_dir=cache_dir, include_plugins=include_plugins)
result = await gen.generate_composite_trajectory(
    seed=seed, num_subtasks=n_sub, templates=selected,
)
for record in result.records:
    record["env"] = "LIVEWEB"
    record["score"] = record.get("metadata", {}).get("score", 1.0)
```

Each record is a single decision step (`system → user → assistant` with a tool call). You're not
generating answers off a model's hot take; you're generating *situations* — seeded, reproducible,
dense with the structure you want the model to learn — and then deduping them against the
canonical store (`dedup_against_canonical`) so the seed stays clean.

**2 · Self-play.** When the task is a game, let a strong sampler play it out and keep the wins.
`orbit/data/game_gen.py` drives this over a registry of OpenSpiel games (`othello`, `leduc_poker`,
`liars_dice`, …); a per-game generator (MCTS search or a CFR/MCCFR policy snapshot) plays, and the
*winning* trajectories become the dataset. The whole machine — registry, outcome filter, the
oversample-until-you-have-enough-wins loop — is [post 5](/blog/self-play-and-the-games-models-teach-themselves/).
No human ever has to script a good line of play.

**3 · Rejection sampling.** Sample many times, keep only the outputs that pass a check, throw the
rest away. In Orbit this is `filter_quality` in `orbit/data/sft.py` — a score threshold plus a
keep-the-best dedup:

```python
filtered = [r for r in records if r.get("score", 0.0) >= min_score]
# ...
if dedup:
    best = {}
    for r in filtered:
        key = (r.get("env"), r.get("task_id"))
        if key not in best or r.get("score", 0) > best[key].get("score", 0):
            best[key] = r
    filtered = list(best.values())
```

That `score` is whatever the environment's verifier wrote (engine 4). The game generators do the
same thing at *generation* time — they only `append_jsonl_record` for trajectories that cleared the
win filter (`score < 0.5: return None`). Either way you've distilled the generator's best moments
into training data.

This is **best-of-N** wearing a training hat, and it's worth seeing why it works. If a single
sample passes the verifier with probability $p$, then the chance that *at least one* of $N$
samples passes is $1-(1-p)^N$ — so at $p=0.1$, drawing $N=20$ samples lands a survivor
$1-0.9^{20}\approx 88\%$ of the time. You're trading inference compute for data quality: the
filtered distribution is the base model's own output *conditioned on passing the check*, which
is strictly sharper than the unconditional model. There's a clean way to see how much sharper.
Keeping only the top fraction of samples is, in expectation, an implicit KL-regularized policy
improvement: the best-of-$N$ distribution sits at a KL distance of roughly
$\log N - \tfrac{N-1}{N}$ nats from the base — bounded, and growing only *logarithmically* in
$N$. Translation: rejection sampling gives you a better policy that hasn't wandered far from the
one you started with, which is exactly the well-behaved improvement you want to then SFT on. It's
the offline, training-free cousin of the KL-leashed RL objective the [later
posts](/blog/cold-start-then-climb/) climb — same shape, none of the rollout machinery.

**4 · The judge / scorer.** You cannot human-grade a million generations, so the `score` that
gates the three engines above has to be produced programmatically. In Orbit that's the verifier
layer — `StaticTraceVerifier` in `orbit/verifiers/static.py` turns a trajectory into a
`terminal_score` and a `success` flag — plus rubric-style scorers like
`score_rubric_alignment` in `orbit/data/swe_collection/oracle.py`, which checks a candidate patch
against a hidden oracle of `likely_modules`, `forbidden_patterns`, and `required_constraints`. The
scorer is leverage; its rubric (or, for the fuzzy remainder, a learned reward model — see
[post 3](/blog/what-are-you-rewarding/)) is where you spend your care. (In this public checkout
the scorers are programmatic; a literal LLM-as-judge slots into the same `score` field.)

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

**The compounding, made literal.** Call $p_t$ the verifier-pass rate (the *yield*) at round $t$
— the fraction of generations that survive the filter. The survivors become the SFT seed, the
model trained on them produces a generator with a higher pass rate, and the loop repeats. Model
the per-round lift as a multiplier $g>1$ on the *odds* of passing — a reasonable first-order
model, since SFT on cleaner data shifts the log-odds roughly additively — and the dynamics are

$$
\frac{p_{t+1}}{1-p_{t+1}} \;=\; g\cdot\frac{p_t}{1-p_t},
\qquad\text{so}\qquad
\frac{p_t}{1-p_t} \;=\; g^{\,t}\cdot\frac{p_0}{1-p_0}.
$$

The odds grow *geometrically* in the number of rounds. Start at a grim $p_0 = 0.05$ (odds
$1{:}19$) with a modest per-round lift $g = 2$, and after four rounds the odds are
$16\times$ — pass rate $\approx 0.46$. That's the flywheel's whole thesis in one line: yield
that crawls early can compound into yield that flies, *if* each round's survivors genuinely
teach the next generator something. The catch hides in $g$. A noisy verifier that lets bad
samples through doesn't just add noise — it drives $g$ toward 1, and a flywheel with $g \le 1$
doesn't spin, it grinds. The single highest-leverage thing you own is whatever keeps $g$
comfortably above 1, which is almost always the verifier, not the model.

## What this changed about how I work

- **I budget engineering on the generator and the verifier, not the trainer.** The trainer is
  mostly solved code — Orbit's whole training side is `SwiftConfig.to_yaml()` emitting an ms-swift
  config and `build_ms_swift_dataset` packing the canonical JSONL into `{"messages": [...]}` rows;
  the generator and the verifier's rubric are where the task-specific value is, and where a week of
  work actually moves the number.
- **A verifier you trust is worth more than a bigger model.** Rejection sampling, RL rewards,
  and judge-filtering all collapse the moment the check is wrong. Most of my debugging time goes
  into the thing that decides "is this output actually good?"
- **Yield is a metric — and a budget.** "What fraction of generations survive the filter?"
  tells you whether the flywheel will spin or stall, long before any eval number does. It's also
  literal cost accounting: to assemble a seed of $M$ clean examples at yield $p$ you must
  generate $\approx M/p$ samples, so yield *is* your compute bill. At $p = 0.05$ a 10k-example
  seed costs 200k generations; double the yield and you've halved the bill or doubled the seed
  for free. I track yield per round the way you'd track a funnel conversion rate — its trend (is
  $g>1$?) predicts the next eval before the eval exists.

On the planning agent, this engine — synthetic constraint-rich trajectories, rejection-sampled
into a clean `reasoning → plan` SFT seed — is what made the later RL stage *have something to
climb from*. Which is the next post: [cold-start, then climb](/blog/cold-start-then-climb/).

## Further reading

- [STaR: Self-Taught Reasoner](https://arxiv.org/abs/2203.14465) — the canonical generate →
  filter-by-correctness → fine-tune loop; the flywheel in its earliest clean form.
- [Constitutional AI](https://arxiv.org/abs/2212.08073) — self-critique and AI feedback as a
  data engine, the backbone of the LLM-as-judge pipeline.
- [Llama 2](https://arxiv.org/abs/2307.09288) — §3 documents rejection sampling at production
  scale: best-of-N against a reward model, iterated over rounds.
- [WebSailor](https://arxiv.org/abs/2507.02592) — synthetic high-uncertainty trajectories for
  training web agents; the simulator-as-data-source idea borrowed above.
