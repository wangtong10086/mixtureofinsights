---
title: "自我博弈：让模型从游戏里捞数据"
description: "有些任务没有现成示范，但游戏至少告诉你谁赢了。让搜索器把局打完，再把赢下来的轨迹留下，数据就从环境里长出来了。"
date: 2026-06-10
order: 5
series: "post-training"
reading: "13 分钟"
tags: ["llm", "self-play", "game-playing", "openspiel", "rejection-sampling"]
---

写到后训练的数据引擎时，总会绕回一个麻烦：很多任务不是“缺标注”，而是人根本很难写出好标注。你可以说
“这局牌应该打得更聪明”，但让人逐步写出一局不完美信息游戏里的好策略，就不现实了。

游戏给了一个很干净的出口：它至少告诉你谁赢了。于是数据不必由人手写，可以从环境里捞出来。让 MCTS、CFR
或 MCCFR 把局打完，只留下赢下来的轨迹，再把这些轨迹并进训练数据。ORBIT 里的 `GAME` 环境最后走的是
OpenSpiel 路径，注册表、生成器、胜局过滤和 `merge_datasets` 都围绕这件事展开。

## 舞台:用 OpenSpiel 游戏当策略生成器

已经落地的 GAME 引擎并不跑一场 LLM 社交推理锦标赛——它依托
[OpenSpiel](https://github.com/google-deepmind/open_spiel)(`pyspiel`)和一个小小的游戏注册表,
游戏的挑选刻意覆盖两种制式。`orbit/data/game_trajectory_generators.py` 就是那张注册表:

```python
SUPPORTED_GAMES = (
    "goofspiel", "leduc_poker", "liars_dice",
    "gin_rummy", "othello", "hex", "clobber",
)
```

每个游戏绑定到一个策略生成器的*家族(family)*,而家族决定了一步强棋是怎么产生的:

```python
"othello": GameTrajectoryGeneratorSpec(name="othello_mcts", family="mcts", ...),
"liars_dice": GameTrajectoryGeneratorSpec(name="liars_dice_mccfr", family="mccfr", ...),
"leduc_poker": GameTrajectoryGeneratorSpec(name="leduc_poker_cfr", family="cfr", ...),
```

- **完美信息棋类**(`othello`、`hex`、`clobber`)在采集时用 **MCTS** 搜索——
  `orbit/data/game_generators/search_generators.py` 里的 `SearchTrajectoryGenerator`。
- **不完美信息牌类**(`leduc_poker`、`goofspiel`、`liars_dice`、`gin_rummy`)用一份预先解出的
  **CFR / MCCFR** 策略快照——`orbit/data/game_generators/policy_generators.py` 里的
  `PolicySnapshotTrajectoryGenerator`。

那个要紧的设计选择:让*昂贵*的策略家(树搜索,或一个反事实遗憾求解器)去把局打完,把它的着法记成一条
LLM 之后要学的对话轨迹。策略活在搜索/求解器里;LLM 的活儿是把它吸收进来。

> 我一开始想得更花：让 LLM 在一套社交推理游戏里互相博弈。真正落到代码里以后，先收敛成了这台
> OpenSpiel 流水线——用经典博弈论采样器去打棋类和牌类游戏。这个选择不够戏剧化，但好处是边界干净：
> 胜负是程序给的，轨迹来自可复现的生成器，文章里的每条论断都能落到 `orbit/data/game_*`。

## 为什么自我博弈把"没数据"变成"无限数据"

它之所以奏效,正是它值得做的原因:**游戏白送你一个验证器。** 每一局都以一个终局状态结束,而
OpenSpiel 把收益(payoff)交回来。在 `search_generators.py` 里,只有当记录的那名玩家真的赢了,
轨迹才会被保留:

```python
returns = state.returns()
score = max(0.0, min(1.0, (returns[bot_player] + 1) / 2.0))
if score < 0.5:
    return None
```

那个 `returns()` 收益,是对产生它的*整条轨迹*的一个自动、无法被钻空子的标签——一场标准化的胜局是
`1.0`,负局是 `0.0`,任何低于 `0.5` 中点的都在变成训练数据之前就被直接丢掉。这正是[奖励那篇](/zh/blog/what-are-you-rewarding/)里
那个验证器 vs RM 的区分,而胜负条件落在它好的一侧:它是一段*程序*在校验一个客观事实(谁赢了),
所以它没有可供策略利用的盲点,也不随 Agent 变强而退化。一个有清脆终局的游戏,是整个后训练里最便宜的
验证器——你没写它,你没训它,而它无法被 hack,因为它*就是*你在意的那个东西,不是它的代理。(这正是
为什么这么多 RL 进展都聚集在有免费验证器的领域——数学、代码、游戏——而在目标模糊的地方停滞。)于是
这个循环又是那台数据飞轮,只不过验证器换成了游戏:

<figure class="figure">
<svg viewBox="0 0 620 210" role="img" aria-label="Self-play loop filtered by game outcome">
  <defs><marker id="sp" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="34" y="84" width="150" height="46" rx="9"/><text x="52" y="104" class="t">MCTS / CFR 采样器</text><text x="52" y="120" class="s">pyspiel,×N 局</text>
  <rect class="n" x="240" y="20" width="150" height="46" rx="9"/><text x="258" y="40" class="t">胜负过滤</text><text x="258" y="56" class="s">returns() ≥ 0.5</text>
  <rect class="n" x="446" y="84" width="150" height="46" rx="9"/><text x="464" y="104" class="t">在胜者上 SFT</text><text x="464" y="120" class="s">对话轨迹</text>
  <rect class="n" x="240" y="150" width="150" height="46" rx="9"/><text x="258" y="170" class="t">更强的模型</text><text x="258" y="186" class="s">= 更丰富的对局</text>
  <path class="a" d="M184 96 Q220 64 240 50" marker-end="url(#sp)"/>
  <path class="a" d="M390 46 Q435 64 455 84" marker-end="url(#sp)"/>
  <path class="a" d="M520 130 Q500 165 390 174" marker-end="url(#sp)"/>
  <path class="a" d="M240 174 Q150 168 115 130" marker-end="url(#sp)"/>
</svg>
<figcaption>Agent 对弈;胜者的轨迹活过过滤;你在它们上训练;更强的 Agent 下一轮打一场更丰富的局。
胜负,就是那个你不必自己造的验证器。</figcaption>
</figure>

实际的生成流水线是 **先超采样、再留下胜局**,一直跑到攒够目标样本数。每个生成器的 `generate_batch`
都给 `sample_count * attempt_multiplier` 次尝试做预算,只追加那些活过 `score < 0.5` 过滤的记录:

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

默认的 `attempt_multiplier=4`(`cli_game.py` 里的 `--attempt-multiplier` 旗标)就是超采样预算:
不断抽种子,直到攒够*获胜*的轨迹,或者尝试次数花到了目标的 4 倍。对局记录*本身*就是数据集——
没人手写过哪怕一步着法。

**按谁赢了来过滤,就是在轨迹上做拒绝采样。** 这正是[第一篇](/zh/blog/post-training-is-a-data-problem/)
里那个机制,从单条输出升级到整局游戏:采样许多条轨迹,留下通过检查的(这里是「记录的那名玩家赢了」),
在幸存者上训练。同样的 best-of-N 逻辑,同样的带 KL 界的改进——你在把采样器的分布条件在「成功」上,
再对结果做 SFT。但轨迹级的过滤引入了一个 token 级拒绝采样没有的问题:**信用分配(credit assignment)。**
终局 `returns()` 标注的是*整局*游戏,不是单步,所以一局赢的游戏会把它的弱棋洗进你的训练集,一局输的
游戏又埋掉它的好棋。胜负是一个嘈杂、*延迟*、*稀疏*的奖励——而在轨迹层面,你分不清那条精妙的线,和搭着
它便车的那步走运。这正是为什么最强的 GAME 生成器根本不依赖 LLM 自己的对局:MCTS 预算(othello 用
`{"sim": 300, "roll": 5}`,见 `SEARCH_BUDGETS`)和 CFR/MCCFR 求解器*本就*在每一步近乎最优,所以多数
被保留的轨迹天生就是干净的。你越能把每步的质量做高(更强的搜索预算、一份解得更好的策略快照,或一个
给单步打分的裁判),活过终局过滤的垃圾就越少。

## 自我博弈是一套自动课程

自我博弈奏效更深的原因,不只是那个免费标签——而是**你的对手永远和你一样强。** 在监督学习里,数据
的难度在你采集它的那一刻就固定了;在自我博弈里,它跟着策略走。第 $t$ 轮的策略面对第 $t$ 轮的策略,
所以挑战自动缩放:一边学到更强的一条线,另一边就被逼着去应对它,这又抬高了两边训练所对的水位,如此
循环。你得到一套没人设计、也永不过时的课程——AlphaGo/AlphaZero 背后那台经典引擎,也正是注册表为何在
固定的搜索/CFR 采样器之外还留了一条*训练出来的策略模型*路径(`PolicyModelTrajectoryGenerator`、
`--generator-source policy_model`):一旦某个游戏的策略模型在自己的胜局轨迹上训好,它就能成为下一轮
的采样器。反面是,对着你*当前*的自己博弈,可能塌进一个狭窄均衡:两边共同适应到一种策略,对局的多样性
内爆,看起来像[冷启动那篇](/zh/blog/cold-start-then-climb/)里的熵坍缩,只是发生在种群层面。标准的修法
是**基于种群(population-based)**:保留一池过去的 checkpoint 和各式对手,从中采样对阵,逼策略对一个
策略*分布*保持鲁棒,而不是过拟合到它的镜像。Orbit 的长跑 sidecar 正好为此留了钩子——
`game-longrun launch` 设置 `AFFINE_GAME_LONGRUN_TEACHER_GATE_INTERVAL`,还有一个单独的
`game-selfplay-eval --opponent teacher` 命令(在 `cli_game.py` 里),正是为了让新策略周期性地对着一个
冻结的*教师*对手过关,而不只是它的镜像。(长跑训练器的主体在公开 checkout 里被裁掉了——
`train_selfplay_policy_model` 抛 `NotImplementedError`——但注册表、CLI 表面与评估关卡都是真的。)一个
冻结的旧自己联盟,是一份便宜的保险,防止模型只教会自己一个聪明把戏,却忘了怎么打别人。

## 两件咬人的事:方差与非平稳

- **方差。** 胜负是一局长游戏末尾的单个比特,所以每条轨迹的学习信号微小且粗暴地嘈杂——多智能体 RL
  版本的稀疏奖励问题。那一个终局比特是一次伯努利抽样,所以在 $n$ 局上估出来的胜率 $\hat p$ 方差为
  $p(1-p)/n$,标准误为 $\sqrt{p(1-p)/n}$——在 $p=0.5$ 附近约是 $0.5/\sqrt{n}$。这笔账令人清醒:
  $n=100$ 局把你的误差棒钉在 $\pm5\%$,所以一个 2 个点的胜率「提升」纯属噪声;要把一个 delta 压到
  $\pm1\%$,得要 $2{,}500$ 局上下。误差只随 $1/\sqrt{n}$ 收缩,所以每多一位置信度都要 $100\times$ 的
  对局——这就是为什么 `game-selfplay-eval` 默认 `--games 200`,而你读的仍然是*许多次评估上的趋势*,
  绝不是单独一次。更糟的是,在自我博弈循环里,单边的赢被对手的打法*混淆*了。缓解手段是常规那套:
  在信一个胜率 delta 之前先在许多局上平均、随机化记录玩家所坐的座位
  (生成器里的 `bot_player = random.randint(0, game.num_players() - 1)`)让先手优势不主导信号、
  以及——最有效的——把反馈推向*更稠密*(每步质量、一个可靠强的搜索预算),这样你就不是把整个梯度押在
  一个终局比特上。
- **非平稳。** 这是自我博弈独有、也是悄悄毁掉训练的那一个。从任何单个 Agent 的视角看,环境是*别的
  正在学习的 Agent*,所以它训练所对的分布**每轮都在变**——你上一轮所优化对抗的那个东西,已经不存在
  了。它打破了大多数 RL 收敛保证底下的平稳性假设,表现为循环(永远停不下来的石头剪刀布式策略环),
  或对如何击败更老对手的灾难性遗忘。种群池又是主要的防线:对着一个*混合*的冻结与当前对手训练,把那个
  移动的靶子抹平成更接近平稳的东西——这就是一个会收敛的联盟,和一个永远追自己尾巴的联盟之间的差别。

## 你对齐什么,记录又长什么样

过滤后的轨迹接着进 **SFT**。每一局被保留的游戏本身就是一条对话记录——一个写着规则的 system prompt,
然后是交替的 `user`(棋面 + 合法着法)/ `assistant`(选定的着法)轮次,由 `make_user_prompt` 发出
并逐字记下:

```python
messages.append({"role": "user", "content": make_user_prompt(state, current_player, legal, game_name)})
messages.append({"role": "assistant", "content": str(action)})
```

这条记录带着 `env: "GAME"`、一个 `score`(标准化收益)、一个 `game` 名,和一个由
`GAME_IDX[game_name]` 推出的确定性 `task_id`。从那之后,它走的是和所有其他环境一样的规范化流水线——
`build_ms_swift_dataset` 把 `messages` 打包成 ms-swift 训练格式,而 GAME 数据在 `merge_datasets` 里
拿到 `3×` 的调度权重,因为策略性对局是稀缺信号。所以 LLM 在采集时从不*亲自下*这盘棋;它学的是从一个
近乎最优的采样器那里模仿一步近乎最优的着法,而成本只是采集人类对局的一小部分。

真正有用的部分:LLM 最终复现出了它从没被显式教过*为什么*的策略——它把 CFR 均衡的着法分布,或那条
MCTS 的线,当成对 `(state → action)` 对的纯粹下一 token 预测吸收了进来。这和规划 Agent 的推理是同一条
教训,只是转向了游戏——base 早已潜在拥有的能力,被在一个更强教师的选择上训练*唤起*了。

## 整个系列落在哪里

五篇,一个形状:

- **数据是瓶颈**——所以你造引擎去制造它。
- **冷启动,再 GRPO**——给策略一个形状,再爬一个奖励。
- **奖励就是规格**——而收拢它的缝隙,是大部分的活。
- **目标是偏好时上 DPO**——把工具配给活儿。
- **任务是游戏时上自我博弈**——终局收益是免费验证器,一个强采样器教会模型招式。

贯穿始终,优化器很少是英雄。数据引擎和验证器才是。训练器基本是已解决的;杠杆在于*你生成什么、又怎么
校验它*。这就是那根主线,也是我花时间的地方。

## 延伸阅读

- [OpenSpiel](https://github.com/google-deepmind/open_spiel)——GAME 引擎背后的 `pyspiel` 框架:
  游戏定义、MCTS bot,以及策略快照所基于的 `cfr` / `external_sampling_mccfr` 求解器。
- [AlphaZero](https://arxiv.org/abs/1712.01815)——自我博弈作为自动课程,「你的对手永远和你旗鼓相当」
  的参照点。
- [Counterfactual Regret Minimization](https://papers.nips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html)
  ——不完美信息(`leduc_poker`、`liars_dice`)教师背后的求均衡算法;MCCFR 是它的蒙特卡洛采样变体。
- [Starcraft II / AlphaStar](https://www.nature.com/articles/s41586-019-1724-z)——联盟训练,
  针对非平稳与策略循环的基于种群的修法。
