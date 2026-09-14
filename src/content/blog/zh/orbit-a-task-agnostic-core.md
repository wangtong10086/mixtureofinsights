---
title: "ORBIT 的内核为什么不懂任务"
description: "ORBIT 用任务插件处理请求校验和结果汇总，由同一个执行核负责 bundle 暂存、启动、监控和产物收集。"
date: 2026-06-10
order: 2
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

ORBIT 起初只跑训练，后来加入评测和数据采集。每加一种任务，我就往 runner 里加一条分支。这样接入很快，但任务各自的配置和处理逻辑也都堆进了执行器。

我随后限制了执行核的职责：只处理 bundle、放置策略、启动模式和产物收集。训练、评测和采集的具体含义由 `TaskPlugin` 解释，以减少新增任务对执行器的影响。

## 瓶颈剖析：执行器的认知诅咒

如果 `train` 和 `eval` 各有自己的暂存路径，接入第四种任务时就得修改共享的执行代码，原来的任务也可能因此出错。这违反了[开闭原则 (Meyer, 1988)](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)：每次扩展新任务，都需要修改核心执行器。

这个代价可以用数学量化。如果在共享启动路径里加 `if task ==` 分支，测试表面积就会呈组合级数膨胀：$N$ 种任务类型 $\times$ 共享代码路径的条件复杂度。这违背了 [David Parnas (1972) 在《On the Criteria To Be Used in Decomposing Systems into Modules》](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf) 中提出的基本原则：按“什么在变”而非按处理步骤来切分系统。

比较这些任务后，我把职责分成两组：

- 各任务不同的部分：请求的形状、合法配置的定义、产物汇总逻辑。
- 各任务共用的部分：暂存 bundle、启动、监控进程、收集日志和产物。

前一组负责整理请求和读取结果，交给插件；后一组保留在执行器中。

## 架构重组：任务不可知的通用核

插件、控制核和执行核的关系如下：

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

插件接口定义在 [`orbit/core/control/registry.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/core/control/registry.py) 中的 `TaskPlugin` 协议，共有四个方法：

```python
class TaskPlugin(Protocol):
    task_type: str
    job_kind: JobKind

    def parse_request(self, raw: dict | Any) -> Any: ...
    def validate_request(self, request: Any) -> list[str]: ...
    def build_bundle(self, *, bundle_dir: str, submission: TaskSubmission) -> JobBundle: ...
    def summarize_result(self, *, submission, bundle, status, manifest) -> TaskSummary: ...
```

执行核只认识 `JobBundle` 和 `TaskSummary`。在 [`orbit/tasks/training/plugin.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/tasks/training/plugin.py) 中，`TrainingPlugin` 校验 `dataset_path` 和 `output_dir`；而在评测插件里校验的则是 `environments`。这些任务字段不会进入执行核。

控制内核严格依赖显式的插件注册，**从不直接 import 任务代码**。接线被限制在唯一的组合根 `build_default_task_registry` 中，局部 import 避免了任何全局副作用。

## 结果证明：用模板镇压分支地狱

为了消灭隐藏的条件分支，我将运行时的一切变更限制在“模板加覆盖 (overrides)”的范畴内。控制核通过 `ExecutionTemplateRegistry.resolve` 将提交解析为带有白名单 diff 的 `ExecutionRequest`。

如果设计出错，就会遭遇 [Joel Spolsky 提出的“漏抽象”定律 (The Law of Leaky Abstractions, 2002)](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/)：一个所谓的通用字段其实暗含了特定任务的假设。为避免这类问题，我坚持不在内核中写任何 `if`。新增任务的修改范围被限制在单个插件内部，各任务继续共用执行器的监控和产物回收逻辑。
