---
title: "Self-play, and the games my models teach themselves"
description: "There's no dataset of good game-play. But in a game with a clear outcome, I manufacture one — I let a strong sampler play out games, filter by who won, and the transcripts become the strategy data. How the data engine, the verifier, and emergent strategy all meet, grounded in my GAME pipeline."
date: 2026-06-10
order: 5
series: "post-training"
reading: "13 min read"
tags: ["llm", "self-play", "game-playing", "openspiel", "rejection-sampling"]
---

What do I do when the target behavior is so situated that I can't write it down? I can't script the right move in a five-card imperfect-information bluffing game, turn after turn, against an adapting opponent. But I can let a game-theoretic sampler discover it, then distill its play into the model — which is exactly what my `GAME` environment does.

## My setup: OpenSpiel games as a strategy generator

My shipped GAME engine leans on [OpenSpiel](https://github.com/google-deepmind/open_spiel), the deep reinforcement learning framework from DeepMind. I use a small registry of games in [`orbit/data/game_trajectory_generators.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/orbit/data/game_trajectory_generators.py):

```python
SUPPORTED_GAMES = (
    "goofspiel", "leduc_poker", "liars_dice",
    "gin_rummy", "othello", "hex", "clobber",
)
```

Each game is bound to a family of strategy generator that decides how a strong move is produced:

```python
"othello": GameTrajectoryGeneratorSpec(name="othello_mcts", family="mcts", ...),
"liars_dice": GameTrajectoryGeneratorSpec(name="liars_dice_mccfr", family="mccfr", ...),
"leduc_poker": GameTrajectoryGeneratorSpec(name="leduc_poker_cfr", family="cfr", ...),
```

Perfect-information board games (`othello`, `hex`) use MCTS search at collection time. Imperfect-information card games (`leduc_poker`, `liars_dice`) use a pre-solved CFR / MCCFR policy snapshot. MCCFR is a Monte-Carlo sampling variant of the [Counterfactual Regret Minimization (Zinkevich et al., 2007)](https://papers.nips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html) equilibrium-finding algorithm. The expensive strategist plays the game, and its moves are recorded as a chat trajectory my LLM later learns from.

## Why self-play hands me infinite data

The reason I build this is that the game hands me a free verifier. Every match ends with a terminal state, and OpenSpiel returns the payoff. In `search_generators.py` I keep the trajectory only if the recorded player actually won:

```python
returns = state.returns()
score = max(0.0, min(1.0, (returns[bot_player] + 1) / 2.0))
# Hard filter, reject losing games
if score < 0.5:
    return None
```

That `returns()` payoff is an automatic, un-gameable label on the entire trajectory. A game with a crisp terminal outcome is the cheapest verifier in all of post-training.

```text
+-------------------+      +-------------------+
| MCTS/CFR sampler  |      | Outcome filter    |
| pyspiel, N games  | ---> | returns() >= 0.5  |
+-------------------+      +-------------------+
          ^                          |
          |                          v
+-------------------+      +-------------------+
| Stronger model    |      | SFT on winners    |
| = richer play     | <--- | chat trajectories |
+-------------------+      +-------------------+
```

In my generation pipeline, I oversample and keep the wins. Every generator's `generate_batch` budgets `sample_count * attempt_multiplier` attempts. The transcripts are the dataset — I never script a single move. Filtering by who won is rejection sampling on trajectories. It has a credit assignment problem — a won game launders its weak moves into my training set. Win/loss is a noisy, delayed, sparse reward. By utilizing MCTS budgets or CFR solvers that are already near-optimal per move, I ensure most kept trajectories are clean by construction.

## Self-play is my automatic curriculum

As noted in the [AlphaZero (Silver et al., 2017)](https://arxiv.org/abs/1712.01815) research, self-play works because the opponent is always exactly as good as the agent. The difficulty auto-scales: as one side learns a stronger line, the other is forced to answer it. To prevent the policy from collapsing into a narrow equilibrium where both sides co-adapt to a single trick, I keep a population of past checkpoints. [AlphaStar (Vinyals et al., 2019)](https://www.nature.com/articles/s41586-019-1724-z) demonstrated that league training against a mixture of frozen and current opponents prevents catastrophic forgetting. My long-run sidecar leaves hooks for this — `game-longrun launch` sets a `AFFINE_GAME_LONGRUN_TEACHER_GATE_INTERVAL` and a separate `game-selfplay-eval --opponent teacher` command, gating my fresh policy against a frozen teacher.

## What I align

The filtered trajectories go into SFT. Each kept game is a chat record — a system prompt with the rules, then alternating `user` (board state + legal actions) and `assistant` (the chosen action) turns, emitted by `make_user_prompt`:

```python
messages.append({"role": "user", "content": make_user_prompt(state, current_player, legal, game_name)})
messages.append({"role": "assistant", "content": str(action)})
```

The record carries `env: "GAME"` and a normalized payoff `score`. From there it flows through the `build_ms_swift_dataset` pipeline. My LLM never plays the game during collection; it learns to imitate a near-optimal move from a near-optimal sampler. It absorbs the CFR equilibrium's move distribution as plain next-token prediction over state-to-action pairs.
