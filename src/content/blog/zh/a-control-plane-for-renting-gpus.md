---
title: "ORBIT：租用 GPU 上的实验控制面"
description: "ORBIT 在本地保存实验记录，通过执行模板和 bundle 向租用的 GPU 提交任务，并用 RunHandle 跟踪运行与产物。"
date: 2026-06-10
updatedAt: 2026-09-15
order: 1
series: "orbit"
reading: "11 分钟"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

ORBIT 用本地实验记录、解析后的执行模板、任务 bundle 和返回的 RunHandle，为 GPU 实验建立独立于租用节点的身份。提交后可以据此查询状态、收集产物。恢复仍依赖于保留 bundle，并在节点回收前取回远程输出；仅保存提交记录无法找回已经删除的 checkpoint。

一次实验需要独立于宿主机的身份和记录。为此，我把训练、评测和数据采集表示成不可变的数据结构，让任务可以命名、重试和审计。

<span id="瓶颈剖析没有身份的副作用" aria-hidden="true"></span>

## 临时 GPU 作业为什么需要稳定身份

在易逝硬件（ephemeral hardware）上，宿主机是整个控制循环里生命周期最短的组件。如果运行状态只保存在宿主机上，机器关机时这些状态就会丢失。这个场景打破了 [Butler Lampson (1983) 在《Hints for Computer System Design》](https://www.microsoft.com/en-us/research/publication/hints-for-computer-system-design/) 中强调的“可复现性”设计纪律：重试需要能标识原来的任务，审计需要保留当时的操作记录。

因此需要分开编排与执行。如果底层硬件是不可靠的，如 [Google SRE Book](https://sre.google/sre-book/introduction/) 所指出的，系统必须保存声明式的期望状态，再通过命令式操作执行它。

<span id="架构重组剥离规划与执行" aria-hidden="true"></span>

## 分离实验规划与远程执行

ORBIT 的控制面留在本地，执行面部署到远程算力集群。

```text
[ Control Plane (Local / Persistent) ]        [ Execution Plane (Remote / Ephemeral) ]
+------------------------------------+        +--------------------------------------+
| - Experiment History               |        | - Targon Placement Node              |
| - Template Resolution              | =====> | - Provisioning & Launch              |
| - Validation & Bundle Gen          | <===== | - Workload Run (SFT/RLHF)            |
| - State Reconciliation             |        | - Artifact Collection                |
+------------------------------------+        +--------------------------------------+
```

在这个拓扑下，控制面持有着一份不可变的期望状态声明。在代码层面，它表现为 [`orbit/core/control`](https://github.com/wangtong10086/orbit/tree/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/core/control) 下的 `CoreControlService`。另一端的执行面接收 `JobBundle`，执行节点可以替换。

这和 [Kubernetes 架构中的 Reconciler 模式](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/architecture/architecture.md) 遵循相同的原理。控制面把打包好的任务交出去，换回一个 `RunHandle`；随后它拿着这个凭证去对齐实际状态（比如 `SUBMITTED`, `PROVISIONING`, `RUNNING`, `FAILED`）。这些运行状态由有限枚举表示。

<span id="硬核落地消除隐藏分支的模板化执行" aria-hidden="true"></span>

## 模板、执行包与可回收产物

启动时必须使用显式模板，取代环境变量驱动的深层控制流分支。一个启动动作仅由两项正交的枚举唯一确定：`PlacementKind` (本地或云端) 和 `LaunchModeKind` (宿主进程或 Docker)。组合后的后端键如下：

```python
def backend_key_for_request(request: ExecutionRequest) -> str:
    # 例如： targon_rental_host_process
    return f"{request.placement.kind.value}_{request.launch_mode.kind.value}"
```

没有 `if $ENV == ...`。一切运行时变动只能通过 `TaskSubmission` 中的白名单覆盖（overrides）注入。提交的瞬间，控制平面就会将 `template_snapshot` 和 `execution_request` 持久化到实验记录中。

GPU 节点 OOM 或掉线后，我可以重新提交已保存的 bundle，无需从 bash 历史中拼回启动参数。环境依赖和启动预检随 bundle 一起送达；节点被回收后，实验记录仍保存在本地控制面。

这些记录最终落在具体文件上：[bundle 目录和运行时来源记录](/zh/blog/orbit-the-bundle-is-the-contract/)说明了哪些内容需要在租用结束后保留下来。
