---
title: "Self-play, and the games models teach themselves"
description: "There's no dataset of good bluffs. But in a game with a clear outcome, you can manufacture one — let the model play itself, filter by who won, and the transcripts become the strategy data. The series finale, where the data engine, the verifier, and emergent strategy all meet."
date: 2026-06-15
order: 5
series: "post-training"
reading: "9 min read"
tags: ["llm", "self-play", "multi-agent", "werewolf", "rejection-sampling"]
---

This series started with a thesis — [post-training is a data problem](/blog/post-training-is-a-data-problem/) —
and a question it left open: what do you do when the *target behavior* is so situated that no
human can write it down? You can describe a good travel plan. Can you write a good bluff? A
convincing lie that holds up across six turns while three other players probe it? You can't
script that. But you can let the model **discover** it, by playing against itself.

## The setup: AI Werewolf

Social-deduction games are the cleanest stress test for strategic language. In an AI Werewolf
setup, LLM agents play repeated games, and the whole machine has to track things a single prompt
never does:

- **game state** — who's alive, what's been claimed, what's been voted,
- **belief state** — each agent's running model of who is what,
- **action chains** — the multi-step plan behind a vote or an accusation,
- **dialogue state** across many turns of public talk.

The design choice that mattered: use the **LLM directly as the policy.** Meta's CICERO paired a
language model with a separate strategic planner; here the agent's own in-context reasoning *is*
the planner — handling long-horizon strategy, lie construction, identity hiding, and deceptive
dialogue in one model. Fewer moving parts, and the strategy stays legible in the model's own
reasoning.

## Why self-play turns "no data" into "infinite data"

The reason this works is the reason it was worth doing: **the game hands you a free verifier.**
Every match ends with an outcome — werewolves win or the village does — and that outcome is an
automatic, un-gameable label on the *entire trajectory* that produced it. So the loop is just the
data flywheel again, with the game as the verifier:

<figure class="figure">
<svg viewBox="0 0 620 210" role="img" aria-label="Self-play loop filtered by game outcome">
  <defs><marker id="sp" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="34" y="84" width="150" height="46" rx="9"/><text x="52" y="104" class="t">Agents self-play</text><text x="52" y="120" class="s">LLM = policy, ×N games</text>
  <rect class="n" x="240" y="20" width="150" height="46" rx="9"/><text x="258" y="40" class="t">Outcome filter</text><text x="258" y="56" class="s">who won = free label</text>
  <rect class="n" x="446" y="84" width="150" height="46" rx="9"/><text x="464" y="104" class="t">SFT on winners</text><text x="464" y="120" class="s">persona · style · logic</text>
  <rect class="n" x="240" y="150" width="150" height="46" rx="9"/><text x="258" y="170" class="t">Stronger agents</text><text x="258" y="186" class="s">= richer play</text>
  <path class="a" d="M184 96 Q220 64 240 50" marker-end="url(#sp)"/>
  <path class="a" d="M390 46 Q435 64 455 84" marker-end="url(#sp)"/>
  <path class="a" d="M520 130 Q500 165 390 174" marker-end="url(#sp)"/>
  <path class="a" d="M240 174 Q150 168 115 130" marker-end="url(#sp)"/>
</svg>
<figcaption>Agents play; the winner's trajectories survive the filter; you train on them; the
stronger agents play a richer game next round. The outcome is the verifier you didn't have to build.</figcaption>
</figure>

In practice the generation pipeline was **self-play + human rejection sampling + light human
intervention**: let the agents grind out games, keep the high-quality dialogue and strategy
samples, and use a human only to settle the cases the outcome signal alone couldn't grade
(a won game can still contain a bad turn). The transcripts *are* the dataset — no one ever scripts
a single bluff.

## What you align, and what emerges

The filtered self-play data then goes into **SFT** to align persona, speech style, and the
identity logic of each role — which is how you get dialogue that actually serves the character's
goal and the game's strategy, at a fraction of the cost of collecting human games.

The part that's genuinely fun: behavior you never wrote down shows up anyway. Under nothing but
pressure to win, agents start to coordinate, to model what others believe, to hide an identity
and defend the cover under questioning. It's the same lesson as the planning agent's reasoning,
turned social — capability the base already latently had, *elicited* by a loop that rewards it.

## Where the whole series lands

Five posts, one shape:

- **Data is the bottleneck** — so you build engines that manufacture it.
- **Cold-start, then GRPO** — give the policy a shape, then climb a reward.
- **The reward is the spec** — and closing its gaps is most of the work.
- **DPO when the goal is preference** — match the tool to the job.
- **Self-play when the task is a game** — the outcome is a free verifier, and the model teaches
  itself the moves.

Across all of it the optimizer was rarely the hero. The data engine and the verifier were. The
trainer is mostly solved; the leverage is in *what you generate and how you check it.* That's the
thread, and it's where I spend my time.
