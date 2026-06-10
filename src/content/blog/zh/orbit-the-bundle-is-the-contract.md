---
title: "bundle 即契约"
description: "在一台不复存在的租来机器上,你拥有的只有你收集回来的东西。所以 bundle 必须自描述:分层的日志面,每一层只回答一个问题;把依赖来路烤进去;而对你不拥有的代码,用一套钉死的黑盒纪律。"
date: 2026-06-19
order: 3
series: "orbit"
reading: "9 分钟"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

[task-agnostic 的核](/zh/blog/orbit-a-task-agnostic-core/)以一个 **bundle** 把活交给运行时。bundle
同时是两样东西:控制面与执行面之间的接口,以及运行结束后你唯一会有的法医证据。在一台易逝的租来
GPU 上,没有"ssh 回去看看"——机器没了。所以 bundle 必须*自描述*,而 ORBIT 大部分的调试价值,就活在
它的布局里。

## 一个 bundle 是三个目录、三份职责

```text
bundle/
  scripts/    生成的入口 + 辅助脚本 —— 究竟跑了什么
  runtime/    执行面状态 + 审计日志 —— worker 做了什么
  artifacts/  任务日志、precheck、checkpoint、审计 —— 工作负载做了什么
```

这条切分要紧,因为最常见的调试错误,就是把每个日志文件当成可互换的。它们不是——每个面回答*不同*的
问题,而知道该打开哪一个,就是修复的一半。

## 分层的日志面,每个只回答一个问题

| 日志面 | 产出者 | 它回答的那一个问题 |
| --- | --- | --- |
| `runtime/runtime.log` | 执行面 | *worker* 健康吗——暂存、启动、探测、收集做了没? |
| `artifacts/*.log` | 任务运行时 | *工作负载*实际打印和做了什么? |
| `artifacts/runtime-precheck.log` | bundle 入口 | 真正的命令跑之前,运行时*暂存对了*吗? |
| `artifacts/checkpoints/*/logging.jsonl` | 训练运行时 | 训练在*真有进展*吗(逐步的指标)? |
| `artifacts/nvml-audit.jsonl` | NVML 辅助进程 | *GPU 显存/利用率*随时间怎么走的? |

有一个被设计好的阅读顺序,而且它是一棵决策树,不是仪式:
`runtime.log → 任务日志 → precheck → logging.jsonl → nvml-audit`。每一步在你往深看之前,先排除一整
类失败。执行面到底健康吗?不健康就停——这是运维问题,不是模型 bug。健康但任务早早就死了?去看
precheck。跑了却什么都没学到?`logging.jsonl`。跑了却 OOM?`nvml-audit`。这是把可观测性*设计进产物*,
让"那台机器上发生了什么"有一条固定的答案路径,而不是靠猜。

## 依赖来路:到底是哪个包在跑

有一个面值得单拎出来,因为它逮的是租来硬件特有的一种失败。你把任务启动到一台用着某个你没构建过的
base 镜像的机器上。你的训练运行 import 的,是你*暂存进 bundle* 的那个 `ms-swift`,还是镜像里碰巧装着
的另一个 `swift`?在自己笔记本上你永远不会问。在一台随机租机上,这是个真实而无声的失败模式。

所以 `runtime-precheck.log` 把它显式记下:运行时能否 import `swift`、需要时 `vllm` 在不在、GPU
bundle 能否 import `pynvml`——关键是,**它用的是暂存的 in-repo `ms-swift` fork,而不是镜像里意外装着
的包。** 来路成了日志里的一行,而不是三小时的悬案。GPU 侧对应的思路是 NVML 审计:一个后台 `pynvml`
辅助进程,写出结构化 JSONL 的显存与利用率快照——因为你没法探身去盯一台在别人数据中心里的机器的
`nvidia-smi`。

## 你不拥有的代码:黑盒纪律

最难的复现问题不是你自己的代码,而是依赖别人的。ORBIT 的 SWE-INFINITE 支持,是对上游 `affinetes`
环境的一层薄集成,而它遵循的规则,是一套值得偷学的纪律:

<figure class="figure">
<svg viewBox="0 0 640 176" role="img" aria-label="Pinned black-box integration with thin manifests">
  <style>.o{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.u{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.3}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="ba" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="o" x="16" y="40" width="200" height="96" rx="9"/>
  <text x="34" y="62" class="tb">ORBIT —— 薄包装</text>
  <text x="34" y="84" class="s">按精确 commit 钉死上游</text>
  <text x="34" y="102" class="s">脏 / 错 ref 则快失败</text>
  <text x="34" y="120" class="s">只写薄 manifest</text>
  <rect class="u" x="300" y="40" width="200" height="96" rx="9"/>
  <text x="318" y="62" class="tb">上游环境(黑盒)</text>
  <text x="318" y="84" class="s">InfiniteActor.evaluate()</text>
  <text x="318" y="102" class="s">OpenEnv reset/step/restore</text>
  <text x="318" y="120" class="s">语义从不被改写</text>
  <rect class="n" x="540" y="62" width="86" height="52" rx="8"/><text x="556" y="84" class="t">原始</text><text x="556" y="102" class="s">产物</text>
  <path class="a" d="M216 88 H300" marker-end="url(#ba)"/><text x="232" y="80" class="s">原样调用</text>
  <path class="a" d="M500 88 H540" marker-end="url(#ba)"/>
</svg>
<figcaption>按精确 git commit 钉死上游,缺失或脏就快失败,把它当黑盒调用,只在原始上游产物旁边持久化
薄薄的 ORBIT manifest。</figcaption>
</figure>

- **按精确 commit 钉死,快失败。** 按一个精确 git ref 解析外部 checkout;若缺失、脏、或在错的 commit,
  就拒绝运行。一个你无法归因到已知上游状态的结果,根本不是结果。
- **当黑盒调用。** 调 `InfiniteActor.evaluate()`,用一层薄的有状态 shim 桥接 OpenEnv 的
  `reset/state/checkpoint/restore/step/stop`——不改写任何上游语义。
- **能共享的别重建。** 对大批量评测,复用一份共享的*不可变*上游运行时缓存,而不是每次都建一整套
  per-task venv。
- **写得薄。** 只在原始上游产物旁边持久化小小的 ORBIT manifest。你的元数据描述,而不重新解读。

trade-off 是真实的:包得薄,意味着你继承上游的怪癖、没法跨边界优化。回报是你能随上游移动而*跟踪*它,
而你报告的每一个数字,都仍能归因到一个精确 commit。当你依赖你不控制的代码,**钉死它、包薄它,永远
别分叉它的含义。**

## 教训

把运行做成自描述的产物,把集成做成钉死的黑盒,远程训练里最吓人的那个问题——*"那台不复存在的机器上
到底发生了什么?"*——就完全能从你收集回来的东西里得到回答。bundle 不是裹在运行外面的包装。bundle
**就是**那次运行,以它唯一能比硬件活得更久的形态存在。
