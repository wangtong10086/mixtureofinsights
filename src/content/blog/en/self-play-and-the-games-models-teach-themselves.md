---
title: "Self-play, and the games models teach themselves"
description: "There's no dataset of good game-play. But in a game with a clear outcome, you can manufacture one — let a strong sampler play out games, filter by who won, and the transcripts become the strategy data. The series finale, where the data engine, the verifier, and emergent strategy all meet — grounded in Orbit's GAME pipeline."
date: 2026-06-10
order: 5
series: "post-training"
reading: "13 min read"
tags: ["llm", "self-play", "game-playing", "openspiel", "rejection-sampling"]
---

This series started with a thesis — [post-training is a data problem](/blog/post-training-is-a-data-problem/) —
and a question it left open: what do you do when the *target behavior* is so situated that no
human can write it down? You can describe a good travel plan. Can you write down the right move
in a five-card imperfect-information bluffing game, turn after turn, against an opponent who is
adapting? You can't script that. But you can let a **game-theoretic sampler** discover it, then
distill its play into the model — which is exactly what Orbit's `GAME` environment does.

## The setup: OpenSpiel games as a strategy generator

The shipped GAME engine doesn't run an LLM social-deduction tournament — it leans on
[OpenSpiel](https://github.com/google-deepmind/open_spiel) (`pyspiel`) and a small registry of
games chosen to cover two regimes. `orbit/data/game_trajectory_generators.py` is that registry:

```python
SUPPORTED_GAMES = (
    "goofspiel", "leduc_poker", "liars_dice",
    "gin_rummy", "othello", "hex", "clobber",
)
```

Each game is bound to a *family* of strategy generator, and the family is what decides how a
strong move is produced:

```python
"othello": GameTrajectoryGeneratorSpec(name="othello_mcts", family="mcts", ...),
"liars_dice": GameTrajectoryGeneratorSpec(name="liars_dice_mccfr", family="mccfr", ...),
"leduc_poker": GameTrajectoryGeneratorSpec(name="leduc_poker_cfr", family="cfr", ...),
```

- **Perfect-information board games** (`othello`, `hex`, `clobber`) use **MCTS** search at
  collection time — `SearchTrajectoryGenerator` in `orbit/data/game_generators/search_generators.py`.
- **Imperfect-information card games** (`leduc_poker`, `goofspiel`, `liars_dice`, `gin_rummy`)
  use a pre-solved **CFR / MCCFR** policy snapshot — `PolicySnapshotTrajectoryGenerator` in
  `orbit/data/game_generators/policy_generators.py`.

The design choice that mattered: the *expensive* strategist (tree search or a counterfactual-
regret solver) plays the game, and its moves are recorded as a chat trajectory the LLM later
learns from. The strategy lives in the search/solver; the LLM's job is to absorb it.

> A note on framing: an earlier draft of this post described an LLM-as-policy "AI Werewolf"
> setup. The code that actually shipped is the OpenSpiel pipeline above — board/card games with
> classical game-theoretic samplers — so this rewrite grounds every claim in `orbit/data/game_*`.
> The self-play *dynamics* below (free verifier, autocurriculum, non-stationarity) are general and
> apply to both; the concrete machinery is the GAME engine.

## Why self-play turns "no data" into "infinite data"

The reason this works is the reason it was worth doing: **the game hands you a free verifier.**
Every match ends with a terminal state, and OpenSpiel hands back the payoff. In
`search_generators.py` the trajectory is kept only if the recorded player actually won:

```python
returns = state.returns()
score = max(0.0, min(1.0, (returns[bot_player] + 1) / 2.0))
if score < 0.5:
    return None
```

That `returns()` payoff is an automatic, un-gameable label on the *entire trajectory* that
produced it — a normalized win is `1.0`, a loss `0.0`, and anything below the `0.5` midpoint is
simply dropped before it can become training data. This is the same
verifier-vs-RM distinction from the [reward post](/blog/what-are-you-rewarding/), and the win
condition lands on the good side of it: it's a *program* checking an objective fact (who won),
so it has no blind spot for the policy to exploit and it does not degrade as the agents get
stronger. A game with a crisp terminal outcome is the cheapest verifier in all of post-training
— you didn't write it, you didn't train it, and it can't be hacked because it *is* the thing you
care about, not a proxy for it. (This is exactly why so much RL progress clusters on domains with
free verifiers — math, code, games — and stalls where the objective is fuzzy.) So the loop is
just the data flywheel again, with the game as the verifier:

<figure class="figure">
<svg viewBox="0 0 620 210" role="img" aria-label="Self-play loop filtered by game outcome">
  <defs><marker id="sp" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="34" y="84" width="150" height="46" rx="9"/><text x="52" y="104" class="t">MCTS / CFR sampler</text><text x="52" y="120" class="s">pyspiel, ×N games</text>
  <rect class="n" x="240" y="20" width="150" height="46" rx="9"/><text x="258" y="40" class="t">Outcome filter</text><text x="258" y="56" class="s">returns() ≥ 0.5</text>
  <rect class="n" x="446" y="84" width="150" height="46" rx="9"/><text x="464" y="104" class="t">SFT on winners</text><text x="464" y="120" class="s">chat trajectories</text>
  <rect class="n" x="240" y="150" width="150" height="46" rx="9"/><text x="258" y="170" class="t">Stronger model</text><text x="258" y="186" class="s">= richer play</text>
  <path class="a" d="M184 96 Q220 64 240 50" marker-end="url(#sp)"/>
  <path class="a" d="M390 46 Q435 64 455 84" marker-end="url(#sp)"/>
  <path class="a" d="M520 130 Q500 165 390 174" marker-end="url(#sp)"/>
  <path class="a" d="M240 174 Q150 168 115 130" marker-end="url(#sp)"/>
</svg>
<figcaption>Agents play; the winner's trajectories survive the filter; you train on them; the
stronger agents play a richer game next round. The outcome is the verifier you didn't have to build.</figcaption>
</figure>

In practice the generation pipeline is **oversample-then-keep-the-wins**, run until the target
sample count is hit. Every generator's `generate_batch` budgets `sample_count * attempt_multiplier`
attempts and only appends the records that survived the `score < 0.5` filter:

```python
attempts = 0
max_attempts = max(sample_count * max(attempt_multiplier, 1), sample_count)
seed_rng = game_seed_rng(game_name, start_seed)

while count_jsonl_records(output) < sample_count and attempts < max_attempts:
    seed = seed_rng.randint(0, max(1, 2**31 - 2))
    record = _search_record(game_name=game_name, seed=seed, game_params=self.game_params)
    attempts += 1
    if record:
        append_jsonl_record(output, record)
```

The default `attempt_multiplier=4` (in `cli_game.py`'s `--attempt-multiplier` flag) is the
oversampling budget: keep drawing seeds until you've collected enough *winning* trajectories or
you've spent 4× the target in attempts. The transcripts *are* the dataset — no one ever scripts
a single move.

**Filtering by who won is rejection sampling on trajectories.** It's the exact mechanism from
[post 1](/blog/post-training-is-a-data-problem/), promoted from single outputs to whole games:
sample many trajectories, keep the ones that pass the check (here, "the recorded player won"),
train on the survivors. Same best-of-N logic, same KL-bounded improvement — you're conditioning
the sampler's distribution on success and SFT-ing on the result. But trajectory-level filtering
imports a problem that token-level rejection sampling doesn't have: **credit assignment.** The
terminal `returns()` labels the *whole* game, not the individual move, so a won game launders its
weak moves into your training set and a lost game buries good ones. Win/loss is a noisy,
*delayed*, *sparse* reward — and at the trajectory level you can't tell the brilliant line
from the lucky one it rode in with. This is why the strongest GAME generators don't rely on the
LLM's own play at all: the MCTS budget (`{"sim": 300, "roll": 5}` for othello, in
`SEARCH_BUDGETS`) and the CFR/MCCFR solver are *already* near-optimal per move, so most kept
trajectories are clean by construction. The cleaner you can make per-move quality — a stronger
search budget, a better-solved policy snapshot, or a judge scoring individual moves — the less
junk survives the terminal filter.

## Self-play is an automatic curriculum

The deeper reason self-play works isn't just the free label — it's that **your opponent is always
exactly as good as you are.** In supervised learning the difficulty of the data is fixed the
moment you collect it; in self-play it tracks the policy. Round $t$'s policy faces round $t$'s
policy, so the challenge auto-scales: as one side learns a stronger line, the other is forced to
answer it, which raises the bar both sides train against, and so on. You get a curriculum that
nobody designed and that never goes stale — the canonical engine behind AlphaGo/AlphaZero, and
the reason the registry keeps a *trained policy model* path (`PolicyModelTrajectoryGenerator`,
`--generator-source policy_model`) alongside the fixed search/CFR samplers: once a per-game policy
model is trained on its own winning trajectories, it can become the next round's sampler. The flip side is that
self-play against your *current* self can collapse into a narrow equilibrium: both sides
co-adapt to one strategy and the diversity of play implodes, which looks like the entropy
collapse from the [cold-start post](/blog/cold-start-then-climb/) but at the population level. The
standard fix is **population-based**: keep a pool of past checkpoints and varied opponents and
sample matchups from it, so the policy has to stay robust against a *distribution* of strategies
rather than overfitting to its mirror image. Orbit's long-run sidecar leaves hooks for exactly
this — `game-longrun launch` sets `AFFINE_GAME_LONGRUN_TEACHER_GATE_INTERVAL` and a separate
`game-selfplay-eval --opponent teacher` command (in `cli_game.py`) precisely so a fresh policy is
periodically gated against a frozen *teacher* opponent rather than only its mirror image. (The
long-run trainer body itself is stubbed out in the public checkout — `train_selfplay_policy_model`
raises `NotImplementedError` — but the registry, CLI surface, and evaluation gates are real.)
A frozen league of old selves is cheap insurance against the model teaching itself one clever
trick and forgetting how to play anyone else.

## Two things that bite: variance and non-stationarity

- **Variance.** Win/loss is a single bit at the end of a long game, so the learning signal per
  trajectory is tiny and brutally noisy — multi-agent RL's version of the sparse-reward problem.
  That one terminal bit is a Bernoulli draw, so an estimated win rate $\hat p$ over $n$ games has
  variance $p(1-p)/n$ and a standard error of $\sqrt{p(1-p)/n}$ — near $p=0.5$ that's
  $\approx 0.5/\sqrt{n}$. The arithmetic is sobering: $n=100$ games puts your error bar at
  $\pm5\%$, so a 2-point win-rate "improvement" is pure noise; pinning a delta down to $\pm1\%$
  takes on the order of $2{,}500$ games. Error shrinks only as $1/\sqrt{n}$, so every extra
  digit of confidence costs $100\times$ the games — which is why `game-selfplay-eval` defaults to
  `--games 200` and you still read *trends over many evaluations*, never a single one. Worse, in
  a self-play loop a single side's win is *confounded* by the opponent's play. The mitigations are
  the usual ones: average over many games before you trust a win-rate delta, randomize which seat
  the recorded player takes (`bot_player = random.randint(0, game.num_players() - 1)` in the
  generators) so a strong first-move advantage doesn't dominate the signal, and — most effective —
  push toward *denser* feedback (per-move quality, a search budget that's reliably strong) so
  you're not betting the whole gradient on one terminal bit.
- **Non-stationarity.** This is the one unique to self-play and the one that quietly ruins runs.
  From any single agent's perspective the environment is *other learning agents*, so the
  distribution it's training against **shifts every round** — the thing you optimized against
  last round no longer exists. It breaks the stationarity assumption underneath most RL
  convergence guarantees, and it shows up as cycling (rock-paper-scissors strategy loops that
  never settle) or as catastrophic forgetting of how to beat older opponents. The population pool
  is again the main defense: training against a *mixture* of frozen and current opponents
  smooths the moving target into something closer to stationary, which is the difference between
  a league that converges and one that chases its own tail forever.

## What you align, and what the records look like

The filtered trajectories then go into **SFT**. Each kept game is already a chat record — a
system prompt with the rules, then alternating `user` (board state + legal actions) / `assistant`
(the chosen action) turns, emitted by `make_user_prompt` and recorded verbatim:

```python
messages.append({"role": "user", "content": make_user_prompt(state, current_player, legal, game_name)})
messages.append({"role": "assistant", "content": str(action)})
```

That record carries `env: "GAME"`, a `score` (the normalized payoff), a `game` name, and a
deterministic `task_id` derived from `GAME_IDX[game_name]`. From there it flows through the same
canonical pipeline as every other environment — `build_ms_swift_dataset` packs the `messages` into
the ms-swift training format, and the GAME data gets a `3×` scheduling weight in `merge_datasets`
because strategic play is the scarce signal. So the LLM never *plays* the game during collection;
it learns to imitate a near-optimal move from a near-optimal sampler, at a fraction of the cost of
collecting human games.

The part that's genuinely useful: the LLM ends up reproducing strategy it was never explicitly
taught the *reasoning* for — it absorbs the CFR equilibrium's move distribution, or the MCTS
line, as plain next-token prediction over `(state → action)` pairs. It's the same lesson as the
planning agent's reasoning, turned to games — capability the base already latently had,
*elicited* by training on a stronger teacher's choices.

## Where the whole series lands

Five posts, one shape:

- **Data is the bottleneck** — so you build engines that manufacture it.
- **Cold-start, then GRPO** — give the policy a shape, then climb a reward.
- **The reward is the spec** — and closing its gaps is most of the work.
- **DPO when the goal is preference** — match the tool to the job.
- **Self-play when the task is a game** — the terminal payoff is a free verifier, and a strong
  sampler teaches the model the moves.

Across all of it the optimizer was rarely the hero. The data engine and the verifier were. The
trainer is mostly solved; the leverage is in *what you generate and how you check it.* That's the
thread, and it's where I spend my time.

## Further reading

- [OpenSpiel](https://github.com/google-deepmind/open_spiel) — the `pyspiel` framework behind the
  GAME engine: game definitions, MCTS bots, and the `cfr` / `external_sampling_mccfr` solvers the
  policy snapshots are built from.
- [AlphaZero](https://arxiv.org/abs/1712.01815) — self-play as automatic curriculum, the
  reference point for "your opponent is always your equal."
- [Counterfactual Regret Minimization](https://papers.nips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html)
  — the equilibrium-finding algorithm behind the imperfect-information (`leduc_poker`, `liars_dice`)
  teachers; MCCFR is its Monte-Carlo sampling variant.
- [Starcraft II / AlphaStar](https://www.nature.com/articles/s41586-019-1724-z) — league
  training, the population-based fix for non-stationarity and strategy cycling.
