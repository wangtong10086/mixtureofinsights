---
title: "一个 task-agnostic 的核,与值回票价的插件"
description: "ORBIT 的执行核彻底拒绝知道自己跑的是训练、评测还是数据采集。正是这一条约束——把一切任务特有的东西上推到插件、让引擎保持通用——挡住了新任务类型分叉整个执行器。讲设计,以及它换来的 trade-off。"
date: 2026-06-18
order: 2
series: "orbit"
reading: "8 分钟"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

[第一篇](/zh/blog/a-control-plane-for-renting-gpus/)画了两个平面——持久的本地控制面,一次性的远程
执行面。这一篇讲的是那个让两者在你不断加任务类型时都不腐烂的单一决策:**执行核不被允许知道一个
"训练任务"是什么。** 它只知道 bundle、放置、启动模式、产物收集——别的不知道。对它而言,训练、评测、
数据采集不是特殊的运行时类型。

## 为什么执行器必须保持无知

搭一个 runner 的自然做法,是把你的任务教给它:一条 `train` 路径、一条 `eval` 路径、一条 `collect`
路径,各有各的暂存和启动逻辑。它能用——直到第四种任务类型,你又在改执行器,而第三种因为你动了共享
代码而坏掉。执行器变成了一个所有任务的怪癖都汇合的接线盒,每一次改动都危及全部。

看看训练、评测、采集之间究竟什么*在变*、什么不变:

- **在变的:** 请求的形状、什么算合法配置、事后怎么汇总产物。
- **不变的:** 把 bundle 暂存到目标、以某模式启动、盯着它、收集日志和产物、报告终态。

不变的那部分,就是整个执行器。在变的那部分*和执行毫无关系*——它是请求塑形和产物读取。于是你恰好
沿着这条缝切开。

## 形状:一个通用核,插件在它之上

<figure class="figure">
<svg viewBox="0 0 640 232" role="img" aria-label="Task plugins build generic bundles for a task-agnostic execution core">
  <style>.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.p{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.e{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10.5px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="oa" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <text x="20" y="20" class="s">任务插件 —— 知道任务是什么</text>
  <rect class="p" x="20" y="28" width="120" height="40" rx="7"/><text x="48" y="52" class="t">训练</text>
  <rect class="p" x="150" y="28" width="120" height="40" rx="7"/><text x="178" y="52" class="t">评测</text>
  <rect class="p" x="280" y="28" width="120" height="40" rx="7"/><text x="308" y="52" class="t">采集</text>
  <rect class="c" x="20" y="96" width="380" height="44" rx="9"/>
  <text x="38" y="115" class="tb">控制内核</text><text x="38" y="131" class="s">注册表 · template + overrides → execution request</text>
  <rect class="e" x="20" y="168" width="380" height="44" rx="9"/>
  <text x="38" y="187" class="tb">执行核 —— task-agnostic</text><text x="38" y="203" class="s">bundle · 放置 · 启动 · 收集</text>
  <path class="a" d="M80 68 V96" marker-end="url(#oa)"/><path class="a" d="M210 68 V96" marker-end="url(#oa)"/><path class="a" d="M340 68 V96" marker-end="url(#oa)"/>
  <path class="a" d="M210 140 V168" marker-end="url(#oa)"/><text x="220" y="158" class="s">通用 bundle</text>
  <rect class="p" x="440" y="96" width="180" height="116" rx="9"/>
  <text x="458" y="120" class="tb">从不被 import</text>
  <text x="458" y="142" class="s">核依赖显式的插件</text>
  <text x="458" y="158" class="s">注册——它不</text>
  <text x="458" y="174" class="s">直接 import 任务代码</text>
  <path class="a" d="M440 154 H400" marker-end="url(#oa)"/>
</svg>
<figcaption>插件解析任务、构建通用 bundle;核执行 bundle,却不知道里面是什么。依赖箭头只经由注册表
朝上指——核从不向下伸进任务代码。</figcaption>
</figure>

具体说,任务插件(`orbit/tasks/{training,evaluation,collection}`)只做三件事:**解析并校验**一个
任务特有的请求、从中**构建一个通用执行 bundle**、在产物回来后**汇总**任务输出。执行核
(`orbit/core/execution`)定义 bundle 布局和启动/放置后端,并运行 bundle——到此为止。

让这件事成真、而非停在口号的关键细节是:**控制内核依赖显式的插件注册;它不直接 import 任务实现。**
这是带牙齿的依赖倒置。核声明一份契约;插件朝它注册;核从不在自己的 import 里点 `training` 的名。加
一种任务类型,你加一个插件——你不打开引擎。

## 模板加 overrides,而非隐藏分支

同样的直觉在下一层、在"一次运行如何被指定"里再次出现。控制把 `template + overrides → execution
request` 解析出来。提交就是 `template_id + overrides`——一个显式、*有名字*的模板(文档里的
`targon-rental-host`)加一个小 diff,而不是一个在运行时用三层深处的 `if $ENV == ...` 替你定生死的
脚本。

回报是,"跑了什么"成了一个你能读、能和上周 diff、能原样重新提交的值。代价也诚实:你维护一组模板,
而不是一棵聪明的配置继承树;而一种真正全新的执行形状,意味着一个新模板,而不是又一个条件分支。在一个
要跨许多任务和目标组合迭代的工作空间里,这份可预测性比省下的那几个文件更值。隐藏分支写一次很便宜,
永远信任它很贵。

## 把 trade-off 说清楚

这个形状不是免费的。你付出:

- **一层间接** —— 一份插件契约和一个注册表横在"我想训练"和"一个进程跑起来"之间,你得把这条边界
  装在脑子里;
- **前期的边界设计** —— 你得把通用 bundle 和执行契约设计得足够对,让三种不同任务类型真能穿过它们。

你买到的,是**一种新任务类型的爆炸半径只有一个插件**这一性质。那个负责启动和收集的执行器,无论跑的
是一次 SFT、一轮评测 sweep,还是一批数据采集,都是同一个——所以它在三者之间被反复实战检验,而不是
分叉成三份。对一个全部目的就是快速、安全迭代的系统,这正是你想要的那笔交易。

它也是那个*活下来*的形状。架构文档描述的是"今天代码里可见的"边界,并刻意不重放重构史——那是"它一开始
没这么干净"的客气说法。它收敛到了这里,因为另一条路(一个知道你任务的执行器)撑不过第四种任务。

这个原则越过 ORBIT 也成立:**把在变的和不变的分开,永远别让在变的渗进引擎。** 下一篇,是这套纪律的
另一半——把引擎产出的东西做成一个在机器消失后仍能调试的自描述产物:
[bundle 即契约](/zh/blog/orbit-the-bundle-is-the-contract/)。
