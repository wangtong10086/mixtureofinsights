---
title: "ORBIT 的内核为什么不懂任务"
description: "执行器越懂业务，越容易被业务拖进分支地狱。ORBIT 的内核只认 bundle、放置和产物收集，把训练、评测、采集都留给插件。"
date: 2026-06-10
order: 2
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

ORBIT 里最容易被写坏的地方，不是远程启动，而是“顺手支持一下新任务”。先有训练，再有评测，再有数据采集。
每加一种任务，最自然的写法都是往 runner 里塞一条新分支。它一开始很快，后来会把执行器变成所有业务怪癖
的汇合点。

所以后来我给执行核定了一条有点反直觉的规矩：它不许知道“训练任务”是什么。它只认 bundle、放置、启动
模式和产物收集；训练、评测、采集都由插件解释。`TaskPlugin`、`TaskRegistry` 和 `TrainingPlugin` 这套
东西，不是为了显得架构漂亮，而是为了让执行器保持无聊。

## 为什么执行器必须保持无知

搭一个 runner 的自然做法,是把你的任务教给它:一条 `train` 路径、一条 `eval` 路径、一条 `collect`
路径,各有各的暂存和启动逻辑。它能用——直到第四种任务类型,你又在改执行器,而第三种因为你动了共享
代码而坏掉。执行器变成了一个所有任务的怪癖都汇合的接线盒,每一次改动都危及全部。

这是[开闭原则](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)在慢动作里失效:一个模块
应当*对扩展开放、对修改封闭*,而一个 task-aware 的执行器恰恰相反——每一次扩展(一种新任务类型)都是
一次修改(你去改执行器)。这个代价并不抽象。你往共享启动路径里加的每一个 `if task ==` 分支,都是依赖
图里一条新边,连起了本不该互相知道的任务;而你每次改动都得重新验证的测试面,会组合式地膨胀:$N$ 种
任务类型 × 它们共同碰到的那些共享路径。第四种任务不只是加活;它让*前三种*变得更不可信,因为它们如今
和一个陌生人共享着可变代码。「新任务类型分叉执行器」不是个比喻——它是那个字面上的 pull request,和
三周后那个字面上的回归。

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

具体说,插件边界就是一个 `Protocol`,`TaskPlugin`,在 `orbit/core/control/registry.py` 里。它正好
是四个方法加两个类属性:

```python
class TaskPlugin(Protocol):
    task_type: str
    job_kind: JobKind

    def parse_request(self, raw: dict | Any) -> Any: ...
    def validate_request(self, request: Any) -> list[str]: ...
    def build_bundle(self, *, bundle_dir: str, submission: TaskSubmission) -> JobBundle: ...
    def summarize_result(self, *, submission, bundle, status, manifest) -> TaskSummary: ...
```

这就是核所依赖的全部契约。注意*没有*的东西:没有 SFT、没有 benchmark、没有数据集。`parse_request` 和
`validate_request` 塑形并校验一个任务特有的请求;`build_bundle` 把它变成一个通用的 `JobBundle`;
`summarize_result` 在收集后把通用产物读回成一个 `TaskSummary`。插件唯一会被核触及的返回类型就是
`JobBundle` 和 `TaskSummary`——两者都是 task-agnostic 的。执行核(`orbit/core/execution`)定义 bundle
布局和启动/放置后端,并运行 bundle——到此为止。

值得精确说清楚什么穿过这条边界、什么不穿过。`TrainingPlugin`(`orbit/tasks/training/plugin.py`)知道
一个 SFT 请求是一个带 `dataset_path` 和 `output_dir` 的 `TrainingSpec`,校验的就正是这些,再把 bundle
的构建委托给一个 `TrainBundleBuilder`:

```python
class TrainingPlugin:
    task_type = "training"
    job_kind = JobKind.TRAIN

    def validate_request(self, request: TrainingSpec) -> list[str]:
        issues: list[str] = []
        if not request.dataset_path:
            issues.append("dataset_path is required")
        if not request.output_dir:
            issues.append("output_dir is required")
        return issues
```

`EvaluationPlugin` 改为校验一个 `EvalTaskSpec` 有 `model` 和 `environments`;`CollectionPlugin` 校验
一个 `CollectTaskSpec` 有 `output_filename`。三种不同的词汇——`dataset_path`、`environments`、
`output_filename`——**没有一个会越界进入核。** 越界的只是一个 `JobBundle`:一份目录布局、一种启动模式、
一个放置目标、一份关于日志和产物落在哪里的契约。核没法告诉你它刚跑的那个 bundle 是训了一个模型还是评了
一个模型——而那份无知,就是这个特性。

让这件事成真、而非停在口号的关键细节是:**控制内核依赖显式的插件注册;它不直接 import 任务实现。**
这是带牙齿的依赖倒置,而且它作为一条架构规则被强制——`orbit/core/*` 不 import `orbit/tasks/*`。接线发生
在一个单一的组合根 `build_default_task_registry` 里:

```python
def build_default_task_registry() -> TaskRegistry:
    from orbit.tasks.collection.plugin import CollectionPlugin
    from orbit.tasks.evaluation.plugin import EvaluationPlugin
    from orbit.tasks.training.plugin import TrainingPlugin

    registry = TaskRegistry()
    registry.register(TrainingPlugin())
    registry.register(EvaluationPlugin())
    registry.register(CollectionPlugin())
    return registry
```

那些 import *在函数体内部*是刻意的——没有 import 副作用,没有在模块加载时被填充的全局注册表。CLI 调用它
一次,把注册表交给 `CoreControlService`,内核再按字符串查插件:`self.task_registry.get(submission.task_type)`。
核声明契约;插件朝它注册;核从不在自己的 import 里点 `training` 的名。加一种任务类型,你加一个插件、再加
这个函数里的一行——你不打开引擎。

## 模板加 overrides,而非隐藏分支

同样的直觉在下一层、在「一次运行如何被指定」里再次出现。控制内核通过
`ExecutionTemplateRegistry.resolve` 把 `template + overrides → ExecutionRequest` 解析出来。提交就是
`template_id + overrides`,两者都挂在插件已经见过的同一个 `TaskSubmission` 上——一个显式、*有名字*的
模板(文档里的 `targon-rental-host`)加一个小的、白名单内的 diff,而不是一个在运行时用三层深处的
`if $ENV == ...` 替你定生死的脚本。模板的 `allow_overrides` 列表就是「你被允许变什么」的全部 API 表面;
放置和启动模式本身由你选的那个模板钉死。

回报是,「跑了什么」成了一个你能读、能和上周 diff、能原样重新提交的值。代价也诚实:你维护一组模板,
而不是一棵聪明的配置继承树;而一种真正全新的执行形状,意味着一个新模板,而不是又一个条件分支。在一个
要跨许多任务和目标组合迭代的工作空间里,这份可预测性比省下的那几个文件更值。隐藏分支写一次很便宜,
永远信任它很贵。

## 把 trade-off 说清楚

这个形状不是免费的。你付出:

- **一层间接** —— 一份插件契约和一个注册表横在「我想训练」和「一个进程跑起来」之间,你得把这条边界
  装在脑子里。运行失败时,栈回溯会跨过这条缝:症状出现在通用核里,但成因往往住在某个插件如何塑形
  bundle 里。调试意味着跨着一层抽象去推理,而不是读一条直来直去的脚本。
- **前期的边界设计** —— 你得把通用 bundle 和执行契约设计得足够对,让三种不同任务类型真能穿过它们。
  设计错了,你得到的就是一个**漏抽象**(leaky abstraction):一个「通用」bundle 字段其实只对训练
  讲得通,或者一种启动模式,某个插件不偷偷塞进任务特有假设就表达不了——而那个字段本应是不透明的。每
  一处泄漏,都是核又悄悄开始知道某个任务的地方——正是这套设计存在要防的那件事——而泄漏之所以诱人,
  是因为每一处单独看都是阻力最小的那条路。

诚实版的 trade-off:这层抽象只有在不变的那部分*真的*不变时才回本。一个「task-agnostic」的核一旦长出
它关于 bundle 里装了什么的第二个 `if`,你就既付了间接的钱、*又*丢了它本该买来的隔离——两种设计里最
糟的那一面。难的不是搭起这条边界;难的是日后当一个条件分支能快那么多的时候,拒绝去戳破它。

你买到的,是**一种新任务类型的爆炸半径只有一个插件**这一性质。那个负责启动和收集的执行器,无论跑的
是一次 SFT、一轮评测 sweep,还是一批数据采集,都是同一个——所以它在三者之间被反复实战检验,而不是
分叉成三份。对一个全部目的就是快速、安全迭代的系统,这正是你想要的那笔交易。

它也是那个*活下来*的形状。架构文档描述的是「今天代码里可见的」边界,并刻意不重放重构史——那是「它一开始
没这么干净」的客气说法。它收敛到了这里,因为另一条路(一个知道你任务的执行器)撑不过第四种任务。

这个原则越过 ORBIT 也成立:**把在变的和不变的分开,永远别让在变的渗进引擎。** 下一篇,是这套纪律的
另一半——把引擎产出的东西做成一个在机器消失后仍能调试的自描述产物:
[bundle 即契约](/zh/blog/orbit-the-bundle-is-the-contract/)。

## 延伸阅读

- [《On the Criteria To Be Used in Decomposing Systems into Modules》,David Parnas(1972)](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf) —— 按*什么在变*而非按处理步骤来切分系统的原始论证。这里的一切都是它的脚注。
- [开闭原则](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle) —— Meyer 的表述,以及为什么「对扩展开放、对修改封闭」正是一个插件注册表买来的那个性质。
- [《The Law of Leaky Abstractions》,Joel Spolsky](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/) —— 那个从内部蚕食 task-agnostic 核的失败模式。
