---
title: "后训练是个数据问题"
description: "大家都在争 PPO、GRPO 还是 DPO。可在真实项目里,拉动指标的几乎从来不是优化器,而是数据引擎——合成轨迹、自我博弈、拒绝采样,再加一个 LLM 裁判。"
date: 2026-06-11
order: 1
series: "post-training"
reading: "13 分钟"
tags: ["llm", "post-training", "synthetic-data", "rejection-sampling"]
---

只读论文的话,你会以为后训练是一场优化器之间的较量——PPO、GRPO、DPO,以及这个月的新缩写。可一旦
你真的交付过几个对齐模型,就会撞上那个不太舒服的真相:**真正拉动指标的,很少是优化器,而是数据
引擎。** 这篇就讲怎么把这台引擎造出来。

## 为什么是数据,而不是算法

一个有能力的 base 模型,需要的东西它大多已经见过。后训练主要做两件事:把一个 base 已经能近似的
潜在行为**唤起(elicit)**,以及在众多可能的行为里**塑形(shape)**模型最终承诺哪一个。这两件事,
对巧妙 loss 的需求,都远不如对*目标行为的忠实示范*——而这恰恰是你买不到的东西。

对一个垂直任务——比如一个必须满足硬约束(预算、时间窗、路线可行性、多意图请求)的规划 Agent——
根本没有一大份干净的标注语料可供微调。人工标注又慢又贵,在长链路、多约束的问题上本身就容易出错。
于是你不再试图*收集*数据,而是开始*制造*它。

## 四台制造数据的引擎

这些都不是抽象概念——在 Orbit 里,每一台都是 `orbit/data/` 下一个具体模块,而且每台引擎都写出
同一种规范化 JSONL(`messages`、`env`、`score`、`task_id`),好让同一个数据集构建器把它们混在一起。

**1 · 合成轨迹。** 给任务的环境造一个模拟器,让它确定性地吐出轨迹。最清楚的例子是
`orbit/data/liveweb_teacher_gen.py`:一个 `TeacherGenerator` 重放缓存好的 web 工具数据,产出
组合式多工具轨迹,**完全不调用任何 LLM**——纯粹由缓存页面数据确定性地生成:

```python
gen = TeacherGenerator(cache_dir=cache_dir, include_plugins=include_plugins)
result = await gen.generate_composite_trajectory(
    seed=seed, num_subtasks=n_sub, templates=selected,
)
for record in result.records:
    record["env"] = "LIVEWEB"
    record["score"] = record.get("metadata", {}).get("score", 1.0)
```

每条记录是一个决策步(`system → user → assistant`,带一次工具调用)。你生成的不是某个模型一时兴起
的答案,而是一个个*情境*——带种子、可复现、密集地嵌着你想让模型学会的结构——然后再用
`dedup_against_canonical` 对规范化存储去重,让种子保持干净。

**2 · 自我博弈。** 当任务是一局游戏,就让一个强采样器把它打完,只留下赢的那些。
`orbit/data/game_gen.py` 在一个 OpenSpiel 游戏注册表(`othello`、`leduc_poker`、`liars_dice`……)
上驱动这件事;每个游戏对应一个生成器(MCTS 搜索,或一份 CFR/MCCFR 策略快照)负责对弈,而*获胜*的
轨迹成为数据集。整套机器——注册表、结果过滤、「多采样直到攒够胜局」的循环——就是
[第五篇](/zh/blog/self-play-and-the-games-models-teach-themselves/)。没有任何人需要去手写一条漂亮的着法。

**3 · 拒绝采样。** 采样很多次,只留下通过检查的输出,其余丢弃。在 Orbit 里这是 `orbit/data/sft.py`
里的 `filter_quality`——一个分数阈值,加上一次「保留最优」去重:

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

这里的 `score` 是环境的验证器写进去的(第四台引擎)。游戏生成器在*生成*时做同样的事——它只对清过
胜局过滤的轨迹 `append_jsonl_record`(`score < 0.5: return None`)。无论哪条路,你都把生成器自己的
高光时刻蒸馏成了训练数据。

这其实就是戴上训练帽子的 **best-of-N**,值得看清它为什么有效。如果单条样本通过验证器的概率是 $p$,
那么 $N$ 条样本里*至少一条*通过的概率是 $1-(1-p)^N$——于是 $p=0.1$ 时,采 $N=20$ 条就有
$1-0.9^{20}\approx 88\%$ 的概率落到一个幸存者。你在用推理算力换数据质量:被过滤出来的分布,正是
base 模型自己的输出*在「通过检查」条件下*的样子,它严格比无条件的模型更尖锐。还有个干净的方式
看清它到底尖锐了多少。只保留样本里靠前的一小撮,在期望意义上就是一次隐式的、带 KL 正则的策略
改进:best-of-$N$ 分布距 base 大约 $\log N - \tfrac{N-1}{N}$ nats 的 KL——有界,而且只随 $N$
*对数式*增长。翻译过来:拒绝采样给你一个更好的策略,而它并没有从起点游离太远——这正是你接下来想拿去
SFT 的那种乖巧的改进。它是[后面几篇](/zh/blog/cold-start-then-climb/)所爬的那个带 KL 绳的 RL 目标的
离线、免训练的表亲——同一个形状,却没有任何 rollout 机器。

**4 · 裁判 / 打分器。** 你没法人工评一百万条生成,所以给上面三台引擎把关的那个 `score`,必须由程序
产出。在 Orbit 里那是验证器层——`orbit/verifiers/static.py` 里的 `StaticTraceVerifier` 把一条轨迹
变成 `terminal_score` 和一个 `success` 标志——再加上像 `orbit/data/swe_collection/oracle.py` 里
`score_rubric_alignment` 这样的准则式打分器,它拿候选补丁去对照一份隐藏 oracle 的 `likely_modules`、
`forbidden_patterns` 和 `required_constraints`。打分器是杠杆;它的准则(对于无法约简的模糊部分,
则是一个学习出来的奖励模型——见[第三篇](/zh/blog/what-are-you-rewarding/))才是你该花心思的地方。
(在这份公开的代码里,打分器都是程序化的;一个字面意义的 LLM-as-Judge 会接到同一个 `score` 字段上。)

## 飞轮

这些没有一个是一次性的。它们组合成一个循环,而这个循环才是全部要点:

<figure class="figure">
<svg viewBox="0 0 640 230" role="img" aria-label="The data flywheel: generate, verify, train, repeat">
  <defs><marker id="fw" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="40" y="92" width="150" height="46" rx="9"/><text x="62" y="112" class="t">生成器</text><text x="62" y="128" class="s">合成 · 自我博弈</text>
  <rect class="n" x="245" y="24" width="150" height="46" rx="9"/><text x="267" y="44" class="t">验证器 / 裁判</text><text x="267" y="60" class="s">过滤 · 排序 · 打标</text>
  <rect class="n" x="450" y="92" width="150" height="46" rx="9"/><text x="472" y="112" class="t">训练</text><text x="472" y="128" class="s">SFT · GRPO · DPO</text>
  <rect class="n" x="245" y="160" width="150" height="46" rx="9"/><text x="267" y="180" class="t">更好的模型</text><text x="267" y="196" class="s">= 更好的生成器</text>
  <path class="a" d="M190 104 Q230 70 245 56" marker-end="url(#fw)"/>
  <path class="a" d="M395 50 Q440 70 460 92" marker-end="url(#fw)"/>
  <path class="a" d="M525 138 Q500 175 395 184" marker-end="url(#fw)"/>
  <path class="a" d="M245 184 Q150 178 115 138" marker-end="url(#fw)"/>
</svg>
<figcaption>生成数据 → 验证/过滤 → 在幸存者上训练 → 变强的模型生成更好的数据。每转一圈,都抬高了
生成器能产出的下限。</figcaption>
</figure>

第一圈最难也最差:孱弱的生成器、嘈杂的裁判、低良率。但每过一遍,它都收紧一点。这一轮训出来的模型
成了下一轮的生成器,而它能产出的「已验证」数据,严格优于上一轮。这种复利,就是产品本身。

**把复利写成式子。** 记 $p_t$ 为第 $t$ 轮的验证器通过率(即*良率*)——生成里活过过滤的那一份额。
幸存者成为 SFT 种子,在它们上训出来的模型给出一个通过率更高的生成器,循环重复。把每轮的提升建模为
作用在通过*几率(odds)*上的一个乘子 $g>1$——这是个合理的一阶模型,因为在更干净数据上做 SFT 大致是
把对数几率加性地往上推——于是动力学是

$$
\frac{p_{t+1}}{1-p_{t+1}} \;=\; g\cdot\frac{p_t}{1-p_t},
\qquad\text{所以}\qquad
\frac{p_t}{1-p_t} \;=\; g^{\,t}\cdot\frac{p_0}{1-p_0}.
$$

几率随轮数*几何式*增长。从一个惨淡的 $p_0 = 0.05$(几率 $1{:}19$)起步,每轮只有一个不大的提升
$g = 2$,四轮之后几率就是 $16\times$——通过率 $\approx 0.46$。这一行就是飞轮的全部论点:早期爬得慢的
良率,可以复利成飞起来的良率——*前提是*每轮的幸存者真能教给下一个生成器一点东西。陷阱藏在 $g$ 里。
一个会放坏样本过关的嘈杂验证器,不只是添噪声——它把 $g$ 往 1 推,而一个 $g \le 1$ 的飞轮不会转,
只会磨。你手里杠杆最高的那一件事,就是把 $g$ 稳稳保持在 1 以上的东西,而那几乎总是验证器,不是模型。

## 这改变了我做事的方式

- **我把工程预算花在生成器和验证器上,而不是训练器。** 训练器基本是已解决的代码——Orbit 整个训练侧
  就是 `SwiftConfig.to_yaml()` 吐出一份 ms-swift 配置,加上 `build_ms_swift_dataset` 把规范化 JSONL
  打包成 `{"messages": [...]}` 行;生成器和验证器的准则,才是任务特有的价值所在,也是一周工作真能
  拉动数字的地方。
- **一个你信得过的验证器,比一个更大的模型更值钱。** 拒绝采样、RL 奖励、裁判过滤,在检查出错的那
  一刻全部崩塌。我大部分调试时间,都花在那个判定「这条输出到底好不好」的东西上。
- **良率是一个指标——也是一笔预算。** 「有多大比例的生成能活过过滤?」——它远在任何评测数字之前,
  就告诉你这个飞轮会转起来,还是会卡死。它也是字面意义上的成本核算:要在良率 $p$ 下凑出一个 $M$ 条
  干净样本的种子,你必须生成 $\approx M/p$ 条,所以良率*就是*你的算力账单。在 $p = 0.05$ 时,一个
  1 万条的种子要 20 万次生成;把良率翻一倍,账单就砍半,或者种子白白翻倍。我像跟踪漏斗转化率一样
  逐轮跟踪良率——它的趋势(是否 $g>1$?)在评测出现之前就预言了下一个评测。

在规划 Agent 上,正是这台引擎——富含约束的合成轨迹,被拒绝采样成干净的 `推理 → 规划` SFT 种子——
让后面的 RL 阶段*有了一个可以往上爬的起点*。这就是下一篇:[冷启动,再往上爬](/zh/blog/cold-start-then-climb/)。

## 延伸阅读

- [STaR: Self-Taught Reasoner](https://arxiv.org/abs/2203.14465)——经典的「生成 → 按正确性过滤
  → 微调」循环;飞轮最早的干净形态。
- [Constitutional AI](https://arxiv.org/abs/2212.08073)——把自我批评与 AI 反馈当成数据引擎,是
  LLM-as-Judge 流水线的骨架。
- [Llama 2](https://arxiv.org/abs/2307.09288)——§3 记录了生产规模的拒绝采样:对着一个奖励模型做
  best-of-N,逐轮迭代。
- [WebSailor](https://arxiv.org/abs/2507.02592)——为训练 web agent 而合成的高不确定性轨迹;上面
  借用的「模拟器即数据源」思路。
