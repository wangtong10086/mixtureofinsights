---
title: "ORBIT 的内核为什么不懂任务"
description: "执行器越懂业务，越容易被业务拖进分支地狱。ORBIT 的内核只认 bundle、放置和产物收集，把训练、评测、采集都留给插件。"
date: 2026-06-10
order: 2
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

在构建 ORBIT 时，最容易写烂的地方并不是远程实例启动，而是“顺手支持一下新任务”。起初只有训练，接着加了评测，后来又上了数据采集。每加一种任务，本能的做法就是往 runner 里塞一条新分支。起初它跑得飞快，但很快，执行器就成了一座收容所有业务怪癖的疯人院。

于是我给执行核定下一条物理上的死规矩：它绝对不许知道“训练任务”是什么。它只能看见 bundle、放置策略、启动模式和产物收集；至于什么是训练、评测还是采集，全交给插件去解释。这套 `TaskPlugin` 体系不是为了图纸上的架构洁癖，而是为了让执行器保持极度的无聊与稳定。

## 瓶颈剖析：执行器的认知诅咒

把任务细节硬编码进 runner 是典型的慢性自杀。今天写一条 `train` 路径、明天写一条 `eval` 路径，各有各的暂存逻辑。当第四种任务接入时，你修改了共享的执行代码，结果第三种任务莫名挂了。执行器成了一个极其脆弱的接线盒，这是[开闭原则 (Meyer, 1988)](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle) 在慢动作中崩溃的现场：每一次扩展（新任务）都在强制进行修改（改核心执行器）。

这个代价可以用数学量化。如果在共享启动路径里加 `if task ==` 分支，测试表面积就会呈组合级数膨胀：$N$ 种任务类型 $\times$ 共享代码路径的条件复杂度。这违背了 [David Parnas (1972) 在《On the Criteria To Be Used in Decomposing Systems into Modules》](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf) 中提出的基本原则：按“什么在变”而非按处理步骤来切分系统。

剖析业务，我发现：
- **在变的（高熵区域）**：请求的形状、合法配置的定义、事后产物的汇总逻辑。
- **不变的（低熵区域）**：把 bundle 暂存到目标机器、以某模式启动、监控进程、收集日志和产物。

不变的这部分，就是执行器的物理极限。在变的那部分则与执行无关，它们只是请求的塑形和结果的读取。我沿着这条物理缝隙，精准地切了一刀。

## 架构重组：任务不可知的通用核

为了实现彻底的隔离，我设计了如下的控制拓扑：

```text
+-------------------+      +-------------------+      +-------------------+
| Training Plugin   |      | Evaluation Plugin |      | Collection Plugin |
| (Knows dataset)   |      | (Knows models)    |      | (Knows targets)   |
+--------+----------+      +--------+----------+      +--------+----------+
         |                          |                          |
         v                          v                          v
+-------------------------------------------------------------------------+
| Control Core (Task-Agnostic)                                            |
| [Template + Overrides] -> Execution Request -> Generic Bundle           |
+-------------------------------------------------------------------------+
         |
         v
+-------------------------------------------------------------------------+
| Execution Core                                                          |
| Provision -> Placement -> Launch -> Collect (Blind to inner payload)    |
+-------------------------------------------------------------------------+
```

这条边界被定义在一个硬性契约里。在 [`orbit/core/control/registry.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/core/control/registry.py) 中，`TaskPlugin` 协议只有四个方法：

```python
class TaskPlugin(Protocol):
    task_type: str
    job_kind: JobKind

    def parse_request(self, raw: dict | Any) -> Any: ...
    def validate_request(self, request: Any) -> list[str]: ...
    def build_bundle(self, *, bundle_dir: str, submission: TaskSubmission) -> JobBundle: ...
    def summarize_result(self, *, submission, bundle, status, manifest) -> TaskSummary: ...
```

执行核只认识 `JobBundle` 和 `TaskSummary`。在 [`orbit/tasks/training/plugin.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/tasks/training/plugin.py) 中，`TrainingPlugin` 校验 `dataset_path` 和 `output_dir`；而在评测插件里校验的则是 `environments`。这三种完全不同的词汇领域，没有任何一个会越界渗透进核。

控制内核严格依赖显式的插件注册，**从不直接 import 任务代码**。接线被限制在唯一的组合根 `build_default_task_registry` 中，局部 import 避免了任何全局副作用。

## 结果证明：用模板镇压分支地狱

为了消灭隐藏的条件分支，我将运行时的一切变更限制在“模板加覆盖 (overrides)”的范畴内。控制核通过 `ExecutionTemplateRegistry.resolve` 将提交解析为带有白名单 diff 的 `ExecutionRequest`。

如果设计出错，就会遭遇 [Joel Spolsky 提出的“漏抽象”定律 (The Law of Leaky Abstractions, 2002)](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/)：一个所谓的通用字段其实暗含了特定任务的假设。为了防止这种腐败，我坚持不在内核中写哪怕一个 `if`。当你想要增加一种全新的任务时，爆炸半径被严格限制在单个插件内部。执行器无需分裂，而是继续在所有的任务间共用同一套经过千锤百炼的监控和产物回收逻辑。

把在变的和不变的彻底撕开，绝不让业务逻辑渗进引擎底层。这是系统在高压下唯一能活下去的形状。
