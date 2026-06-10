---
title: "自我博弈,与模型自学的游戏"
description: "没有一份「好诈唬」的数据集。但在一个有明确胜负的游戏里,你能造出来——让模型自己跟自己玩,按谁赢了来过滤,对局记录就成了策略数据。本系列收官,数据引擎、验证器与涌现策略在这里汇合。"
date: 2026-06-15
order: 5
series: "post-training"
reading: "9 分钟"
tags: ["llm", "self-play", "multi-agent", "werewolf", "rejection-sampling"]
---

本系列以一个论点开篇——[后训练是个数据问题](/zh/blog/post-training-is-a-data-problem/)——并留下一个
没答的问题:当*目标行为*情境化到没有人写得下来时,你怎么办?你能描述一个好的行程方案。可你写得出
一个好的诈唬吗?一个撑过六轮、还顶得住另外三名玩家盘问的、令人信服的谎?这你没法手写。但你能让模型
**自己发现**它——靠跟自己对弈。

## 舞台:AI 狼人杀

社交推理游戏是检验策略性语言最干净的压力测试。在一套 AI 狼人杀里,LLM Agent 反复对局,而整台机器必须
追踪单个 prompt 永远追不了的东西:

- **游戏状态**——谁还活着、谁声称了什么、投了什么票,
- **信念状态**——每个 Agent 对"谁是什么身份"的实时建模,
- **行动链**——一次投票或一次指控背后的多步计划,
- 跨许多轮公开发言的**对话状态**。

那个要紧的设计选择:**直接把 LLM 当作策略(policy)。** Meta 的 CICERO 把一个语言模型配了个单独的
策略规划器;这里 Agent 自己的上下文推理*就是*规划器——在一个模型里处理长周期策略、谎言构造、身份
隐藏、欺骗对话。活动部件更少,而策略仍清晰地留在模型自己的推理里。

## 为什么自我博弈把"没数据"变成"无限数据"

它之所以奏效,正是它值得做的原因:**游戏白送你一个验证器。** 每一局都以一个胜负结束——狼赢,或者
村民赢——而那个结果,是对产生它的*整条轨迹*的一个自动、无法被钻空子的标签。于是这个循环又是那台
数据飞轮,只不过验证器换成了游戏:

<figure class="figure">
<svg viewBox="0 0 620 210" role="img" aria-label="Self-play loop filtered by game outcome">
  <defs><marker id="sp" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#b4530a"/></marker></defs>
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.t{font:13px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#b4530a;stroke-width:1.6;fill:none}</style>
  <rect class="n" x="34" y="84" width="150" height="46" rx="9"/><text x="52" y="104" class="t">Agent 自我博弈</text><text x="52" y="120" class="s">LLM = 策略,×N 局</text>
  <rect class="n" x="240" y="20" width="150" height="46" rx="9"/><text x="258" y="40" class="t">胜负过滤</text><text x="258" y="56" class="s">谁赢 = 免费标签</text>
  <rect class="n" x="446" y="84" width="150" height="46" rx="9"/><text x="464" y="104" class="t">在胜者上 SFT</text><text x="464" y="120" class="s">人设 · 风格 · 逻辑</text>
  <rect class="n" x="240" y="150" width="150" height="46" rx="9"/><text x="258" y="170" class="t">更强的 Agent</text><text x="258" y="186" class="s">= 更丰富的对局</text>
  <path class="a" d="M184 96 Q220 64 240 50" marker-end="url(#sp)"/>
  <path class="a" d="M390 46 Q435 64 455 84" marker-end="url(#sp)"/>
  <path class="a" d="M520 130 Q500 165 390 174" marker-end="url(#sp)"/>
  <path class="a" d="M240 174 Q150 168 115 130" marker-end="url(#sp)"/>
</svg>
<figcaption>Agent 对弈;胜者的轨迹活过过滤;你在它们上训练;更强的 Agent 下一轮打一场更丰富的局。
胜负,就是那个你不必自己造的验证器。</figcaption>
</figure>

实际的生成流水线是 **自我博弈 + 人工拒绝采样 + 轻量人工干预**:让 Agent 反复磨局,留下高质量的对话
与策略样本,只用人去裁那些光靠胜负信号定不了的情况(一局赢了,里面仍可能有一步臭棋)。对局记录
*本身*就是数据集——没人手写过哪怕一个诈唬。

## 你对齐什么,又涌现出什么

过滤后的自我博弈数据接着进 **SFT**,对齐每个角色的人设、说话风格与身份逻辑——这正是你如何让对话真正
服务于角色目标和游戏策略,而成本只是采集人类对局的一小部分。

真正有意思的部分:你从没写下来的行为,照样冒了出来。在仅有的"求胜"压力下,Agent 开始协作、开始建模
别人相信什么、开始隐藏一个身份并在盘问下守住伪装。这和规划 Agent 的推理是同一条教训,只是转成了
社交——base 早已潜在拥有的能力,被一个奖励它的循环*唤起*了。

## 整个系列落在哪里

五篇,一个形状:

- **数据是瓶颈**——所以你造引擎去制造它。
- **冷启动,再 GRPO**——给策略一个形状,再爬一个奖励。
- **奖励就是规格**——而收拢它的缝隙,是大部分的活。
- **目标是偏好时上 DPO**——把工具配给活儿。
- **任务是游戏时上自我博弈**——胜负是免费验证器,模型自学招式。

贯穿始终,优化器很少是英雄。数据引擎和验证器才是。训练器基本是已解决的;杠杆在于*你生成什么、又怎么
校验它*。这就是那根主线,也是我花时间的地方。
