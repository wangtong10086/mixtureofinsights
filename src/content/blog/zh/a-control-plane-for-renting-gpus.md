---
title: "租 GPU 的控制面"
description: "租来的 GPU 很快会消失，但一次训练不能只活在 SSH 会话里。ORBIT 的核心想法，是把运行变成可复现的产物。"
date: 2026-06-10
order: 1
series: "orbit"
reading: "11 分钟"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

在算力租赁平台上跑后训练任务，常常会退化为一场狼狈的运维灾难。你打开一个 SSH 会话，徒手修改一份 YAML 配置，敲下一段起停脚本；如果笔记本休眠或者网络断开，那条确切的命令以及终端里稍纵即逝的 `stdout` 就会随着 shell history 彻底灰飞烟灭。当你需要重新验证昨天的那个 checkpoint 时，当初造出它的那台物理宿主已经被回收得一干二净。

这不是洁癖，这是严重的系统性缺陷。一次实验如果不具备独立的身份标识，它就仅仅是一次物理环境下的副作用。为了根治这个问题，我决定把训练、评测与数据采集从 SSH 会话的幽灵，变成具备可命名、可重试、可严格审计的不可变数据结构。

## 瓶颈剖析：没有身份的副作用

在易逝硬件（ephemeral hardware）上，宿主机是整个控制循环里生命周期最短的组件。如果你把运行状态依赖于它，那么系统会在机器关机的那一刻遭遇脑死亡。这个场景打破了 [Butler Lampson (1983) 在《Hints for Computer System Design》](https://www.microsoft.com/en-us/research/publication/hints-for-computer-system-design/) 中强调的“可复现性”设计纪律：你无法重试一个你连名字都叫不出来的东西，也无法审计一段连记录都没留下的按键操作。

必须将编排与执行物理切分。如果底层硬件是不可靠的，如 [Google SRE Book](https://sre.google/sre-book/introduction/) 所指出的，系统必须要用声明式的期望状态来战胜命令式的执行过程。

## 架构重组：剥离规划与执行

我将 ORBIT 的心脏一刀切成了两半：驻留在本地环境的**控制面**，与投射到异地算力集群的**执行面**。

```text
[ Control Plane (Local / Persistent) ]        [ Execution Plane (Remote / Ephemeral) ]
+------------------------------------+        +--------------------------------------+
| - Experiment History               |        | - Targon Placement Node              |
| - Template Resolution              | =====> | - Provisioning & Launch              |
| - Validation & Bundle Gen          | <===== | - Workload Run (SFT/RLHF)            |
| - State Reconciliation             |        | - Artifact Collection                |
+------------------------------------+        +--------------------------------------+
```

在这个拓扑下，控制面持有着一份不可变的期望状态声明。在代码层面，它表现为 [`orbit/core/control`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/core/control) 下的 `CoreControlService`。另一端的执行面，仅仅是一个用来接收 `JobBundle` 的无情消耗品。

这和 [Kubernetes 架构中的 Reconciler 模式](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/architecture/architecture.md) 在深层原理上完全一致。控制面把打包好的任务交出去，换回一个 `RunHandle`；随后它拿着这个凭证去对齐实际状态（比如 `SUBMITTED`, `PROVISIONING`, `RUNNING`, `FAILED`）。状态机是有限且严谨的枚举，不存在任何“大概在跑”的模糊地带。

## 硬核落地：消除隐藏分支的模板化执行

让这一切真正起效的关键，是彻底废除了由环境变量驱动的深层控制流分支，改为强制使用显示模板。一个启动动作仅由两项正交的枚举唯一确定：`PlacementKind` (本地或云端) 和 `LaunchModeKind` (宿主进程或 Docker)。组合后产生的计算图非常直白：

```python
def backend_key_for_request(request: ExecutionRequest) -> str:
    # 例如： targon_rental_host_process
    return f"{request.placement.kind.value}_{request.launch_mode.kind.value}"
```

没有 `if $ENV == ...`。一切运行时变动只能通过 `TaskSubmission` 中的白名单覆盖（overrides）注入。提交的瞬间，控制平面就会将 `template_snapshot` 和 `execution_request` 永久凝固进实验记录。

当云端的某个 GPU 节点无声地 OOM 或者掉线时，我的恢复动作不再是“去 bash 历史里扒拉之前手敲了哪些 flags”，而是直接把持久化的 bundle 重新扔给集群。因为所有的环境依赖、启动预检都已经通过不可变的 bundle 送达，节点是可以随时被屠宰的牲畜，而实验则是永远活在控制面的不灭幽灵。
