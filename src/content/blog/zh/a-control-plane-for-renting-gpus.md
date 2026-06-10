---
title: "租 GPU 的控制面"
description: "模型迭代真正难的不是训练代码,而是围着易逝的、租来的 GPU 转的那摊编排泥潭。ORBIT 的赌注:把一次运行做成可复现的产物,而非一个 shell 会话——靠把控制面和执行面分开。"
date: 2026-06-16
order: 1
series: "orbit"
reading: "11 分钟"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

[上一个系列](/zh/blog/post-training-is-a-data-problem/)里的后训练活儿——数据引擎、GRPO、奖励模型——
都得*在某处跑起来*。而这个某处,越来越是一台你不拥有、也留不住的租来的 GPU:一台 Targon 机器,为一个
任务而生,跑完即逝。这个现实悄悄吃掉的时间,比任何优化器都多,却是没人写的那一块。ORBIT 是我对它的
回答。

## 它解决的那摊泥潭

在租来的硬件上迭代,每次都退化成同一片沼泽:

- 一个 SSH 会话,你手改一份配置、跑一个脚本,而那条确切的命令随着 shell 一起死掉——「什么在跑」这个
  状态只活在一个 TTY 里,你笔记本一睡眠它就关掉,
- `train_v3_final_REAL.sh` 和它十一个表亲,每一个都是「我那天到底跑了啥」的一条隐藏分支,真正的 flag
  被你再也重建不出来的 shell history 覆盖掉了,
- 一个你复现不出来的 checkpoint,因为造出它的那台机器*已经被回收*——产出它的那个确切镜像、CUDA 构建、
  依赖树,都随宿主一起死了,
- 日志和产物散落在一台不复存在的机器上,所以在你意识到需要它之前,唯一的法医线索就已经没了。

这些没一个是建模问题。这是个**编排**问题,而在易逝硬件上尤其尖锐:机器是这个循环里最一次性的东西,
所以任何持久的东西都不能住在它上面。

这四条底下更深的失败其实是同一个:**一个 SSH 驱动的运行没有身份。** 它不是一个你能命名、存储、diff、
重新提交的值——它是一个只发生过一次的副作用,在一台如今已不存在的宿主上,没留下任何可归因的产物。
你没法重试一个你叫不出名字的东西。你没法复现一个没留下记录的东西。你没法审计一个只以击键形式存在过
的东西。下面的一切,都是给一次运行赋予身份所带来的后果。

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

**控制面**在本地、且持久:实验记录、任务编排、模板选择、配置校验、运行检查。在代码里它是
`orbit/core/control`——而整个东西就是一个类,`CoreControlService`,它的构造函数干脆把四个协作者
当参数收进来:

```python
class CoreControlService:
    def __init__(
        self,
        experiments: ExperimentStore | None = None,
        execution: ExecutionService | None = None,
        templates: ExecutionTemplateRegistry | None = None,
        task_registry: TaskRegistry | None = None,
        ...
```

**执行面**是那台租来的机器:`orbit/core/execution`——通用 bundle、放置后端、启动模式、产物收集,
都在 `ExecutionService` 背后。再有两个关注点把它们黏起来——塑形请求的**任务插件**
(`orbit/tasks/{training,evaluation,collection}`),以及做运维的 **sidecar**(`orbit/remote_ops`、
`orbit/monitoring`)。两个 CLI 家族干净地对应到两个面:`orbit control`(`orbit/cli_control.py`)
驱动控制面;`orbit worker`(`orbit/cli_worker.py`)直接对着一个 bundle 驱动执行面。

这条切分和 Kubernetes 在*声明式期望状态*与*达到它的命令式工作*之间画的那条是同一条——而这个区分值得
精确地借用,因为它解释了为什么这条切分是承重的、而非装饰性的。控制面持有一份**对你想要的运行的声明式
描述**:一份配置,校验过,针对一个*有名字的*模板,跑在某一类目标上。执行面做的是**命令式的工作**——
在一台具体的租来宿主上把它变成真的:provision、暂存、启动、收集,然后回报。而「回报」不是个比喻:执行
后端把一个 `RunHandle` 和一个 `RunStatus` *写进 bundle 的 `runtime/` 目录*,在远程租机上还会通过 SSH
读取机器上的一份 `result.json` 来重建实时状态。终态是一个显式的枚举,不是猜出来的:

```python
class RunState(str, Enum):
    PREPARED = "prepared"
    SUBMITTED = "submitted"
    PROVISIONING = "provisioning"
    STARTING = "starting"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TERMINATED = "terminated"
```

控制面记下期望状态和回来的 handle;它可以把那个 handle 再交回执行面来重新查询状态。「我要的」和
「状态探测回报的」之间的差,是一个它能检查的值,而不是一个你凭记忆重建的故事。它能在 worker 死掉时活
下来,因为期望状态从不住在 worker 上——它是本地存储里的一条 `Experiment` 记录。一个 SSH 会话什么都活
不过,因为期望状态和那份工作*本就是同一个动作*——根本没有一份描述可以退回去依靠。

## 两个回本的设计选择

**1 · 显式的执行模板,而非隐藏的运行时分支。** 产生一次运行的,是一个*有名字的模板*——一个放在
`execution_templates/` 下的 YAML 文件。文档里的默认是 `targon-rental-host.yaml`,它无聊得恰到好处:

```yaml
id: targon-rental-host
description: Run a bundle directly on a registered Targon rental machine host process.
placement:
  kind: targon_rental
launch_mode:
  kind: host_process
defaults:
  target: ""
  detach: true
  resources: { gpu_type: unknown, gpu_count: 1, cpu_count: 0, memory_gb: 0 }
allow_overrides: [target, resources, runtime_env, detach]
```

这两个维度在契约里被刻意保持正交,是两个独立的枚举——`PlacementKind`(`local`、`targon_rental`)
和 `LaunchModeKind`(`host_process`、`docker_image`)——所以支持的矩阵就是
`{local, targon_rental} × {host_process, docker_image}`,四条都作为显式后端接进 `ExecutionService`。
后端是由这两个枚举拼出的字符串 key 选出来的:

```python
def backend_key_for_request(request: ExecutionRequest) -> str:
    return f"{request.placement.kind.value}_{request.launch_mode.kind.value}"
```

没有埋在启动脚本三层深处的 `if $ENV == ...` 在运行时替你定生死——路径就是你能从模板上读出来的两个有名
字段。`allow_overrides` 是唯一的逃生口,而它是一个白名单。

**2 · bundle 是复现的单位。** 一次运行就是一个 *bundle*——经校验的配置加执行它所需之物——提交到一个
目标,回程带着运行时审计日志和产物收集。提交就是 `template_id + overrides`,封装在一个冻结的
`TaskSubmission` 里:

```python
class TaskSubmission(FrozenModel):
    experiment_id: str
    task_type: str
    task_request: dict[str, JsonValue]
    template_id: str
    overrides: ExecutionOverrides = Field(default_factory=ExecutionOverrides)
    ...
```

可复现的对象不是你对那条命令的记忆,而是 bundle 加模板,而且控制核在提交那一刻就把两者都快照进实验的
运行记录里(`template_snapshot`、`execution_request`)。那条验证过的路径(`本地 control →
targon_rental + host_process`)是文档推荐的 GPU 路径,在配置驱动的远程训练上跑过原生 `ms-swift` SFT 和
GKD 配置,通过 `orbit control submit train` 以及配置文件启动器 `orbit control launch train` 提交。

值得跟着一次 `submit_task` 走一遍代码,因为这个控制流*本身*就是论据。`CoreControlService.submit_task`
按顺序做五件事:调用 `prepare_task`(在 `TaskRegistry` 里查到插件、校验请求、让插件构建 bundle);
通过 `ExecutionTemplateRegistry` 把 `template_id + overrides` 解析成 `ExecutionRequest`;把请求交给
`ExecutionService`,后者按上面那个后端 key 路由;把回来的 `RunHandle` 记进实验;再写一条审计事件。
之后,`refresh_run_status`、`collect_run_artifacts`、`terminate_run` 都从运行记录里取出*同一个 handle*
交回执行面——控制面从不需要对机器保持一条活连接,只需要那个 handle。这就是整个 reconciler,装在一个类
里,而且没有一点住在 worker 上。

这一步,就是把「一次运行」从一个 shell 会话变成一个**可复现产物**,而它换来三个会话不可能拥有的具体
性质:

- **你能推理的幂等性。** 把同一个 bundle 重新提交到一台全新目标,是一个有定义、有定义结果的操作,而
  不是一次依赖宿主残留状态的重演。bundle 携带运行所需之物;目标是可互换的。
- **真正有意义的重试。** 当一台租来宿主在运行中途死掉——它会死——恢复动作是「再提交一次 bundle」,而
  不是「试着回忆我敲过的那十七个 flag,并祈祷新机器配得和旧的一样」。重试便宜,因为期望状态是一条持久的
  `Experiment` 记录、worker 一开始就是一次性的。远程后端每次还会暂存一份*干净*快照——`create_bundle_archive`
  会排除本地的 `runtime/` 状态和过期产物,所以一次重新提交是从 bundle 开始,而不是从上一次运行的残留开始。
- **构造即来路(provenance)。** 每个 checkpoint 都回溯到产出它的那个确切 bundle 和模板,所以「是什么
  配置造出了这个?」是一次查表,而不是一场考古。在易逝硬件上,这是*唯一*可得的来路形式——产出它的机器
  没了,所以记录必须是那个产物本身,而不是宿主。

一条刻意的边界:ORBIT 不重造训练。它直接用上游 `ms-swift`。它的活是**校验配置、构建 bundle、provision
目标、提交运行**——是编排,不是优化器。训练代码保持标准;变得可重复的,是*操作*它这件事。

## 教训

复现的单位应该是一个**产物**,而不是一段记忆。在易逝的租来 GPU 上,这不再是锦上添花,而是承重的:
机器是循环里最一次性的东西,所以持久记录——配置、模板、bundle、审计日志——必须住在那个能活下来的一侧。
把这条切分做对,「原样重跑出这个 checkpoint 的东西」就从一句祈祷,变成一条命令。

这一篇是地图。系列接下来的篇章都钻进它内部——先从那个让上面一切成立的设计选择开始:一个执行核,
彻底*拒绝知道*自己跑的是训练、评测,还是数据采集。下一篇:
[一个 task-agnostic 的核,与值回票价的插件](/zh/blog/orbit-a-task-agnostic-core/)。

## 延伸阅读

- [Kubernetes 设计:reconciler 模式](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/architecture/architecture.md) —— 经典的控制面/执行面切分,以及 ORBIT 借来的那个 level-triggered 调和循环。
- [Site Reliability Engineering,第 1 章(Google)](https://sre.google/sre-book/introduction/) —— 当底座不可靠时,为什么声明式期望状态胜过命令式过程。
- [《Hints for Computer System Design》,Butler Lampson](https://www.microsoft.com/en-us/research/publication/hints-for-computer-system-design/) —— 「让它可复现」与「区分正常情况和最坏情况」作为系统设计纪律,早在它流行之前几十年。
