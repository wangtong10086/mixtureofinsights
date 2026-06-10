---
title: "租 GPU 的控制面"
description: "模型迭代真正难的不是训练代码,而是围着易逝的、租来的 GPU 转的那摊编排泥潭。ORBIT 的赌注:把一次运行做成可复现的产物,而非一个 shell 会话——靠把控制面和执行面分开。"
date: 2026-06-16
order: 1
series: "orbit"
reading: "7 分钟"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

[上一个系列](/zh/blog/post-training-is-a-data-problem/)里的后训练活儿——数据引擎、GRPO、奖励模型——
都得*在某处跑起来*。而这个某处,越来越是一台你不拥有、也留不住的租来的 GPU:一台 Targon 机器,为一个
任务而生,跑完即逝。这个现实悄悄吃掉的时间,比任何优化器都多,却是没人写的那一块。ORBIT 是我对它的
回答。

## 它解决的那摊泥潭

在租来的硬件上迭代,每次都退化成同一片沼泽:

- 一个 SSH 会话,你手改一份配置、跑一个脚本,而那条确切的命令随着 shell 一起死掉,
- `train_v3_final_REAL.sh` 和它十一个表亲,每一个都是"我那天到底跑了啥"的一条隐藏分支,
- 一个你复现不出来的 checkpoint,因为造出它的那台机器*已经被回收*,
- 日志和产物散落在一台不复存在的机器上。

这些没一个是建模问题。这是个**编排**问题,而在易逝硬件上尤其尖锐:机器是这个循环里最一次性的东西,
所以任何持久的东西都不能住在它上面。

## 赌注:把规划和执行分开

ORBIT 的组织思想,是两个面之间一条干净的切分:

<figure class="figure">
<svg viewBox="0 0 640 210" role="img" aria-label="ORBIT control plane and execution plane">
  <style>.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.e{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.3}.t{font:12.5px sans-serif;fill:#1c1b19}.tb{font:13px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10.5px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.5;fill:none}</style>
  <defs><marker id="o1" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="c" x="16" y="20" width="250" height="170" rx="10"/>
  <text x="34" y="44" class="tb">控制面 · 本地</text>
  <rect class="n" x="34" y="58" width="214" height="26" rx="6"/><text x="46" y="76" class="t">实验记录</text>
  <rect class="n" x="34" y="92" width="214" height="26" rx="6"/><text x="46" y="110" class="t">模板选择</text>
  <rect class="n" x="34" y="126" width="214" height="26" rx="6"/><text x="46" y="144" class="t">配置校验 → bundle</text>
  <rect class="n" x="34" y="160" width="214" height="22" rx="6"/><text x="46" y="176" class="s">运行检查 · 审计</text>
  <rect class="e" x="374" y="20" width="250" height="170" rx="10"/>
  <text x="392" y="44" class="tb">执行面 · 租来的 GPU</text>
  <rect class="n" x="392" y="58" width="214" height="26" rx="6"/><text x="404" y="76" class="t">放置(Targon)</text>
  <rect class="n" x="392" y="92" width="214" height="26" rx="6"/><text x="404" y="110" class="t">启动模式(host / docker)</text>
  <rect class="n" x="392" y="126" width="214" height="26" rx="6"/><text x="404" y="144" class="t">ms-swift 运行(SFT / RLHF)</text>
  <rect class="n" x="392" y="160" width="214" height="22" rx="6"/><text x="404" y="176" class="s">运行时审计日志</text>
  <path class="a" d="M266 88 H374" marker-end="url(#o1)"/><text x="284" y="80" class="s">bundle →</text>
  <path class="a" d="M374 150 H266" marker-end="url(#o1)"/><text x="284" y="168" class="s">← 产物 · 日志</text>
</svg>
<figcaption>控制面住在你的笔记本上,从不移动。执行面是一次性的。一个 bundle 往右走,产物和审计日志
回来。机器可以凭空消失。</figcaption>
</figure>

**控制面**在本地、且持久:实验记录、任务编排、模板选择、配置校验、运行检查。**执行面**是那台租来的
机器:通用 bundle、放置后端、启动模式、产物收集。再有两个关注点把它们黏起来——塑形训练/评测/采集
请求的**任务插件**,以及做远程运维和监控的**sidecar**。

## 两个回本的设计选择

**1 · 显式的执行模板,而非隐藏的运行时分支。** 产生一次运行的,是一个*有名字的模板*——比如文档里
默认的 `targon-rental-host`,配上 `本地 control → targon_rental → host_process`。支持的矩阵就是
`{local, targon_rental} × {host_process, docker_image}`,全部显式选定。没有埋在启动脚本三层深处的
`if $ENV == ...` 在运行时替你定生死。跑了什么,是一个你能读、能 diff、能复用的值。

**2 · bundle 是复现的单位。** 一次运行就是一个 *bundle*——经校验的配置加执行它所需之物——提交到一个
目标,回程带着运行时审计日志和产物收集。可复现的对象不是你对那条命令的记忆,而是 bundle 和模板。
那条验证过的路径(`本地 control → targon_rental + host_process`)在配置驱动的远程训练上做过端到端
验证,包括通过 `orbit control launch train` 提交的原生 `ms-swift` SFT 和 GKD 配置。

一条刻意的边界:ORBIT 不重造训练。它直接用上游 `ms-swift`。它的活是**校验配置、构建 bundle、provision
目标、提交运行**——是编排,不是优化器。训练代码保持标准;变得可重复的,是*操作*它这件事。

## 教训

复现的单位应该是一个**产物**,而不是一段记忆。在易逝的租来 GPU 上,这不再是锦上添花,而是承重的:
机器是循环里最一次性的东西,所以持久记录——配置、模板、bundle、审计日志——必须住在那个能活下来的一侧。
把这条切分做对,"原样重跑出这个 checkpoint 的东西"就从一句祈祷,变成一条命令。

这一篇是地图。系列接下来的篇章都钻进它内部——先从那个让上面一切成立的设计选择开始:一个执行核,
彻底*拒绝知道*自己跑的是训练、评测,还是数据采集。下一篇:
[一个 task-agnostic 的核,与值回票价的插件](/zh/blog/orbit-a-task-agnostic-core/)。
