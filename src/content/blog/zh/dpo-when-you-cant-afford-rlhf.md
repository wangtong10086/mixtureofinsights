---
title: "付不起 RLHF 时,就上 DPO"
description: "RLHF 强大而沉重——一个奖励模型、一个在线 rollout 循环、不稳定。可对偏好与人设对齐,你很少需要它。DPO 用一小部分机械就能走到八九分;而难点,一如既往,在数据。"
date: 2026-06-14
order: 4
series: "post-training"
reading: "8 分钟"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

前两篇用 GRPO 爬了一个可校验的奖励。当正确性可校验、又需要在线探索时,那套机械是对的工具。可很多
对齐根本不是那回事。"保持人设。""偏好这种语气。""别打破第四面墙。"——这里没有验证器,也不需要在线
RL,而在这种地方搬出完整 RLHF,是在为一台你不会去开的引擎付钱。**DPO** 才是更轻的工具,在一个角色
扮演模型上,它正合身。

## RLHF 到底为你买了什么——而 DPO 又省掉了什么

RLHF(PPO 式)有三个活动部件:从偏好里训一个**奖励模型(RM)**,再跑一个**在线 RL 循环**,从策略
采样、用 RM 打分、更新——还拴一条 KL 绳维稳。它很强,但那是一个要拟合的 RM、一个要看护的不稳定在线
循环,以及不小的算力。

DPO 删掉了其中两个部件。它不拟合 RM、也不对着它做 RL,而是**直接在偏好对** `(chosen, rejected)` 上
训练,用一个单一的 loss,抬高"被选中"相对"被拒绝"的似然——*并锚定到一个参考模型*(你的 SFT
检查点)。那个锚就是 KL 绳,被烤进了目标函数里。隐式奖励从未被物化成一个单独网络;它从数学里自己
掉出来。

<figure class="figure">
<svg viewBox="0 0 640 188" role="img" aria-label="DPO trains directly on chosen vs rejected pairs">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.ok{fill:#eef6f4;stroke:#0f766e;stroke-width:1.5}.no{fill:#faf3ec;stroke:#b4530a;stroke-width:1.5}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="d1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="74" width="120" height="40" rx="8"/><text x="38" y="99" class="t">prompt</text>
  <rect class="ok" x="200" y="26" width="200" height="40" rx="9"/><text x="216" y="51" class="t">chosen(在人设内)</text>
  <rect class="no" x="200" y="118" width="200" height="40" rx="9"/><text x="216" y="143" class="t">rejected(OOC 出戏)</text>
  <path class="a" d="M140 86 Q170 50 200 46" marker-end="url(#d1)"/>
  <path class="a" d="M140 102 Q170 140 200 138" marker-end="url(#d1)"/>
  <text x="430" y="44" class="up">↑ 似然</text>
  <text x="430" y="138" class="dn">↓ 似然</text>
  <text x="430" y="92" class="s">锚定到 SFT 参考</text>
  <text x="430" y="108" class="s">(内建 KL)</text>
</svg>
<figcaption>没有奖励模型,没有在线 rollout。一个离线 loss 跑在偏好对上,钉在 SFT 参考上,让模型在
学会偏好的同时漂不走。</figcaption>
</figure>

代价是真实的:你放弃了在线探索和细粒度的信用分配。但对"偏好 A 胜过 B"的风格与人设目标,你本来也
用不上它们。DPO 离线、稳定、单模型、便宜。

## 数据,仍然是全部的赛点

DPO 的简单只是把难度推回了它一直所在的地方:**偏好对。** 人工标够它们,恰恰是你想躲开的成本。所以
角色扮演模型的偏好对是半自动造的——就是[第 1 篇](/zh/blog/post-training-is-a-data-problem/)那台数据
引擎,瞄准偏好:

- **Constitutional-AI 式自我批评**,对照一套写下来的角色原则去起草并修订回复,
- **LLM-as-Judge** 把候选排成 chosen / rejected,
- **人工拒绝采样**只用在自动化定不下来的那点残差上。

这把人力成本压成了一条薄薄的顶层,盖在一条基本是合成的流水线之上。

## OOC 这一招

DPO 在这里最锋利的用法是有的放矢,而非泛泛。出戏(OOC)——模型崩人设、漏出自己是助手、丢了说话
风格——是会要了角色扮演产品命的失败。于是偏好对被刻意构造成*正瞄准它*:**rejected** 是一个貌似合理
但出戏的回复,**chosen** 是在人设内的那个。DPO 于是学到了一股对 OOC 行为的直接下压——一个精确的
惩罚信号,换作要一整套 RM + RL 循环才表达得出,这里仅靠构造偏好对就买到了。

叠在第一阶段 SFT(人设、风格、身份逻辑)之上,这套 `SFT → DPO` 配方,把角色一致性和多轮可控性提了
上去,比单纯 SFT 或完整 RLHF 流水线都更快、更稳。

## 一次服务很多角色

对齐不到上线就不算完。一个角色扮演产品是*许多*人设,而非一个,给每个角色加载一份完整微调根本不
scale。服务侧用了 **vLLM + S-LoRA**——许多轻量 LoRA 适配器在同一张 GPU 上复用一个 base——于是单个
部署能高吞吐地、同时以几十个角色应答。

## 要点

把方法配给目标。**DPO 用于偏好、风格、人设对齐**——它离线、稳定,大部分成本是好的偏好数据。把
GRPO/RLHF 那套机械,留给你真正需要"对着可校验奖励做在线探索"的时候,比如规划 Agent。在轻工具合身的
地方用重工具,本身就是一种 reward hacking——hack 的是你自己的时间。
