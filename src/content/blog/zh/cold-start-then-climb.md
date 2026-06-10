---
title: "冷启动,再往上爬"
description: "在一个难任务上、从 base 模型直接做纯 RL,产出的多半是高方差的垃圾。解法是一套两阶段配方——先用小规模 SFT 冷启动给策略一个形状,再用 GRPO 往上爬。这篇讲清为什么,以及 GRPO 到底怎么工作。"
date: 2026-06-12
order: 2
series: "post-training"
reading: "9 分钟"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

强化学习改进的是一个你*已经拥有*的策略。把它指向一个 base 模型加一个难任务——硬约束下的长链路
规划——你就会撞上那个坑:如果策略几乎从不偶然走出一条好轨迹,RL 就没有东西可放大。你得到的是高
方差、缓慢的进展,以及看起来像噪声的奖励曲线。解法是别从冷的开始。这是我一再回到的配方。

## 为什么 RL 之前要冷启动

把 RL 想成给模型已经偶尔能产出的行为"调大音量"。如果某个行为从不出现在模型的采样里,它的概率
约等于 0,梯度也约等于 0——RL 没法无中生有。一个 base 模型*能*推理、*能*规划,但在一个受约束的
垂直任务上,它的好轨迹稀有到学习信号被埋进了方差里。

一次小而干净的 **SFT 冷启动**修好了起点。你不是想端到端地教会任务;你是给策略一个*形状*——正确
的格式、在落定方案前先把约束摊开的习惯、一个不再微不足道的好轨迹基线率。现在 RL 有了一个可以往上
爬的地板。

## 四步配方(R1 味)

这复刻了 DeepSeek-R1 的冷启动思路,改造到一个垂直任务上:

1. **在 base 上用 GRPO 探索。** 直接在 base 上跑 GRPO,逼出长思维链规划——让它在奖励压力下,去
   发现哪些推理路径能抵达有效方案。
2. **拒绝采样出种子。** 从那次探索里,只留下高正确率的 `推理 → 规划` 样本(由你的验证器判定——见
   [第 1 篇](/zh/blog/post-training-is-a-data-problem/))。这就是你的 SFT 种子:小、干净、且是模型
   自己的语气。
3. **SFT 冷启动。** 在种子上微调 base。模型现在能稳定地*产出*你想要的形状。
4. **正式上 GRPO。** 现在跑主 GRPO 阶段,用一个对你真正在意的东西打分的奖励模型——约束满足、
   预算/时间一致性、路线可行性——让它往上爬。

两个阶段,一句话:**SFT 给策略一个形状,GRPO 拿奖励把它磨锋利。**

## GRPO 到底怎么工作(简短而诚实的版本)

PPO 需要一个单独的 *critic* 网络去估计每个状态有多好——又一个要训练、要调、要维稳的模型。GRPO 把
critic 扔了,改用一个对"有可校验奖励"的任务几乎简单到让人不好意思的把戏:

> 对每个 prompt,采样一**组** K 个答案。给全部 K 个打分。每个答案的**优势(advantage)**就是
> *它的分数减去这一组的平均分。* 把高于平均的推上去,把低于平均的压下来。

<figure class="figure">
<svg viewBox="0 0 620 196" role="img" aria-label="GRPO group-relative advantage">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="g1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="78" width="120" height="40" rx="8"/><text x="36" y="103" class="t">prompt</text>
  <text x="170" y="30" class="s">采样 K = 4</text>
  <rect class="n" x="170" y="22" width="150" height="26" rx="6"/><text x="184" y="40" class="t">答案 · 得分 0.9</text>
  <rect class="n" x="170" y="56" width="150" height="26" rx="6"/><text x="184" y="74" class="t">答案 · 得分 0.6</text>
  <rect class="n" x="170" y="90" width="150" height="26" rx="6"/><text x="184" y="108" class="t">答案 · 得分 0.4</text>
  <rect class="n" x="170" y="124" width="150" height="26" rx="6"/><text x="184" y="142" class="t">答案 · 得分 0.1</text>
  <path class="a" d="M140 98 H170" marker-end="url(#g1)"/>
  <text x="350" y="86" class="s">均值 = 0.5</text>
  <text x="350" y="40" class="up">+0.4 ↑</text>
  <text x="350" y="74" class="up">+0.1 ↑</text>
  <text x="350" y="108" class="dn">−0.1 ↓</text>
  <text x="350" y="142" class="dn">−0.4 ↓</text>
  <text x="445" y="92" class="s">优势 = 得分 − 均值</text>
  <text x="445" y="110" class="s">无 critic 网络</text>
</svg>
<figcaption>GRPO 的优势纯粹相对于同一 prompt 的其他采样。这一组就是它自己的基线——这正是它在奖励
可校验时既便宜又稳定的原因。</figcaption>
</figure>

整个直觉就这些。组是它自己的基线,所以你永远不训练价值函数;代价是每个 prompt 要 K 倍采样,而对
可校验奖励来说,这是笔划算的买卖。

## 真正会咬人的几件事

- **拴一条到参考模型的 KL 绳。** 没有它,策略会漂走,滑进被 reward-hack 的退化文本。一条到 SFT
  模型的 KL 惩罚,让它继续说你冷启动时教它的那门语言。
- **你的奖励就是你的验证器——而它会被钻空子。** 每一处奖励错配都会被找到并利用。(多到足以成为
  [下一篇](/zh/blog/what-are-you-rewarding/)。)
- **显式地给长 CoT 塑形。** 长度和格式奖励,能拦住模型——既不塌缩成不推理的简短,也不为了长度奖励
  而啰嗦。
- **组大小是个旋钮,不是常数。** 太小,优势估计噪声大;太大,烧采样预算。像调学习率一样调它。

在规划 Agent 上,这套 `SFT 冷启动 → GRPO` 两阶段流水线——由一个约束感知的奖励模型对齐——在内部
Benchmark 上把复杂约束满足率提升了约 12%,并明显减少了臆造方案,而且*没有*用大规模人工标注集。
那个结果背后真正的功臣不是 GRPO,是奖励。我们下一篇就去那儿。
