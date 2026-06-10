---
title: "自我博弈：让模型从游戏里捞数据"
description: "有些任务没有现成示范，但游戏至少告诉你谁赢了。让搜索器把局打完，再把赢下来的轨迹留下，数据就从环境里长出来了。"
date: 2026-06-10
order: 5
series: "post-training"
reading: "13 分钟"
tags: ["llm", "self-play", "game-playing", "openspiel", "rejection-sampling"]
---

在构建后训练的数据引擎时，我常常撞上一堵墙：很多复杂推理任务并非缺乏标注成本，而是人类根本无法写出具备最优性的示范。对于不完美信息博弈，要求标注者在极其庞大的状态空间中写出精确的策略转移方程，不仅低效而且极易出错。

既然监督信号难以由人工注入，我选择让数据直接从环境的物理法则中生长出来。游戏环境存在一个绝对的真理出口：胜负。利用 MCTS、CFR 或 MCCFR 等传统博弈算法进行对局演算，过滤出获胜轨迹作为训练语料。在 Orbit 项目中，`GAME` 环境的底层架构正是围绕这一思路，将 [OpenSpiel](https://github.com/google-deepmind/open_spiel) 的搜索树转化为大模型的训练流。

## OpenSpiel 策略生成矩阵

GAME 引擎没有采用让多个 LLM 盲目交互的玄学方案，而是严格绑定了 `pyspiel` 的数学求解器。在 [`orbit/data/game_trajectory_generators.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/data/game_trajectory_generators.py) 中，我定义了一张游戏注册表，将游戏划分为两大制式族群：

```python
SUPPORTED_GAMES = (
    "goofspiel", "leduc_poker", "liars_dice",
    "gin_rummy", "othello", "hex", "clobber",
)
```

每个游戏绑定到特定的策略生成族（family），决定状态空间的探索算法：

```python
"othello": GameTrajectoryGeneratorSpec(name="othello_mcts", family="mcts", ...),
"liars_dice": GameTrajectoryGeneratorSpec(name="liars_dice_mccfr", family="mccfr", ...),
"leduc_poker": GameTrajectoryGeneratorSpec(name="leduc_poker_cfr", family="cfr", ...),
```

*   对于完美信息博弈（如 `othello`），通过 [`orbit/data/game_generators/search_generators.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/data/game_generators/search_generators.py) 中的 `SearchTrajectoryGenerator` 注入 **MCTS** 进行深层蒙特卡洛树搜索。
*   对于不完美信息博弈（如 `leduc_poker`），则在 [`orbit/data/game_generators/policy_generators.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/data/game_generators/policy_generators.py) 中利用 **CFR/MCCFR** 算法提前解出纳什均衡的策略快照（参考 [*Counterfactual Regret Minimization* (Zinkevich et al., 2007)](https://papers.nips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html)）。

核心工程哲学在于：将极度消耗 CPU 算力的决策交给经典的树搜索或遗憾最小化求解器，再由 LLM 将这些近乎最优的决策轨迹吸收为自身的下一 token 预测先验。

## 零成本验证器与拒绝采样

游戏环境的物理意义在于，它免费附赠了一个不可欺骗的验证器。每一局都会坍缩为一个确定性的终局状态。在 `search_generators.py` 的处理流水线中，仅有真实获胜的轨迹会被落盘：

```python
returns = state.returns()
score = max(0.0, min(1.0, (returns[bot_player] + 1) / 2.0))
if score < 0.5:
    return None
```

这里的 `returns()` 是由程序逻辑硬编码的客观反馈，它免疫任何 reward hacking 攻击。以此为基础，构建了基于胜负过滤的自我对弈闭环：

```text
[ 采样器 (MCTS/CFR/旧策略) ]
          |
  生成 N 局对战轨迹
          |
          v
[ 终局胜负硬件过滤 ]  --- ( score >= 0.5 ) ---> [ 提取胜者轨迹 ]
          |                                        |
      ( 抛弃败局 )                             转化为对话 JSONL
                                                   |
                                                   v
[ 迭代策略池 ] <------ 训练更强的 LLM <-------- [ SFT 监督微调 ]
```

这种机制本质上是在轨迹维度进行**拒绝采样（Rejection Sampling）**。为了达成样本数量目标，我通过参数 `attempt_multiplier` 在 CLI 入口开启超采样模式。不断投喂随机数种子让生成器空转，直至积攒到足量的胜局：

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

但轨迹级采样带来了致命的**信用分配（Credit Assignment）**问题。一次终局的胜利由数十步决策共同决定，稀疏延迟的奖励会将劣势决策裹挟进训练集。为了切断这种噪声，我不让早期较弱的 LLM 介入对局生成，而是全部由 MCTS 和 CFR 这类强算力采样器主导。当搜索预算拉满时（如 `othello` 配置的 `{"sim": 300, "roll": 5}`），单步质量已逼近理论上限，从而将混入数据集的冗余操作压榨到物理极限。

## 平稳性破裂与种群防御

在自我博弈中，环境是动态的——你的对手也在不断发生梯度更新。这直接破坏了马尔可夫决策过程中的平稳性假设，极易导致策略出现“石头剪刀布”式的死循环，或是发生对旧策略的灾难性遗忘。

如同 [*Starcraft II / AlphaStar* (Vinyals et al., 2019)](https://www.nature.com/articles/s41586-019-1724-z) 所展示的那样，我引入了基于种群（Population-based）的联盟防御机制。策略不是在与它的当前镜像死磕，而是必须在历史策略池中随机抽样对手。

Orbit 在底层长跑架构中通过 `AFFINE_GAME_LONGRUN_TEACHER_GATE_INTERVAL` 为此留存了钩子。在 `cli_game.py` 中，执行 `game-selfplay-eval --opponent teacher` 能够周期性地将新策略抛入一个冻结的旧模型阵列中进行存活测试。强制模型在混合对抗分布中保持泛化，阻断其坍缩进特定把戏的狭窄均衡（参考 [*AlphaZero* (Silver et al., 2017)](https://arxiv.org/abs/1712.01815)）。

## 信号收敛与架构归宿

过滤后的胜局数据将直接灌入 SFT 管线。引擎的 `make_user_prompt` 方法将棋盘状态与合法动作序列化，将 MCTS 或 CFR 的决策转化为标准对话：

```python
messages.append({"role": "user", "content": make_user_prompt(state, current_player, legal, game_name)})
messages.append({"role": "assistant", "content": str(action)})
```

由于高质量的博弈策略数据极其稀缺，这批数据在 `merge_datasets` 环节会被赋予 3 倍的采样权重。LLM 在整个过程中没有耗费算力去推演树，它仅仅是在模仿一台完美推断机的截断面。这揭示了一个工程事实：模型早已在预训练阶段具备了逻辑推理的拓扑，而自我博弈和拒绝采样，只是按下了释放这些潜能的物理开关。

后训练的核心杠杆永远不在于调参，而在于你能否构建出一套精确校验并源源不断生产高质量数据的流水线引擎。
