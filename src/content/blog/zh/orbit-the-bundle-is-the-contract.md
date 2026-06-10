---
title: "bundle 即契约"
description: "远程机器跑完就没了，留下来的 bundle 必须能替它作证。目录结构、日志分层、依赖来源和黑盒边界，都应该写进这份契约。"
date: 2026-06-10
order: 3
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

远程机器最残酷的一点，是它不会等你想起还需要一份日志。等训练挂了、机器回收了，你拥有的只有当时带回来
的那点东西。于是 bundle 在 ORBIT 里不只是“打包格式”，它更像一次运行留下的黑匣子。

这个黑匣子必须比运行本身活得久。控制面已经去提交下一次任务，执行面可能已经不存在；真正留在你手里的，
是 `job.json`、`runtime-precheck.log`、stdout/stderr、ms-swift 的 `logging.jsonl`，以及依赖从哪里来的
记录。bundle 如果只告诉你“跑过”，那等于什么都没说。它必须能回答：当时到底跑了什么，在哪跑的，用的是
哪份代码，失败时第一条线索在哪里。

## 一个 bundle 是一份固定的目录布局

这个形状不是只写在文档里——它由 `orbit/core/execution/bundle.py` 里的 `JobBundle.ensure_structure`
创建,后者恰好造出这些子目录:

```python
def ensure_structure(self) -> None:
    for subdir in (self.path, self.inputs_dir, self.scripts_dir, self.artifacts_dir, self.runtime_dir):
        subdir.mkdir(parents=True, exist_ok=True)
```

所以一个 bundle 是 `job.json` 加四个目录,每个一份职责:

```text
bundle/
  job.json     JobSpec —— kind、inputs、expected_outputs、entrypoint、resources
  inputs/      暂存的数据集 + 解析后的 swift_config.yaml + 暂存的模型/adapter
  scripts/     生成的 entrypoint.sh + 辅助脚本(nvml 审计、补丁)—— 究竟跑了什么
  runtime/     执行面状态 —— runtime.log、last_run.json、last_status.json、result.json
  artifacts/   任务日志、precheck、checkpoint、nvml 审计、manifest.json —— 工作负载做了什么
```

这里最容易看错两件事,而它们对调试要紧:`inputs/` 和 `job.json` 也是契约的一部分(暂存的数据集和
解析后的配置都住在 `inputs/`),而 `manifest.json`——收集回来的日志与产物的索引——住在 `artifacts/`
下,不是 `runtime/`。这条切分要紧,因为最常见的调试错误,就是把每个日志文件当成可互换的。
它们不是——每个面回答*不同*的问题,而知道该打开哪一个,就是修复的一半。

## 分层的日志面,每个只回答一个问题

| 日志面 | 产出者 | 它回答的那一个问题 |
| --- | --- | --- |
| `runtime/runtime.log` | 执行面(`bundle.append_runtime_log`) | *worker* 健康吗——暂存、启动、探测、收集做了没? |
| `artifacts/stdout.log`、`artifacts/stderr.log` | 远程运行 wrapper | *工作负载*往 stdout/stderr 实际打印了什么? |
| `artifacts/runtime-precheck.log` | bundle 入口 | 真正的命令跑之前,运行时*暂存对了*吗? |
| `artifacts/training.log` | 训练入口(`tee`) | 训练进程在停下前走到了哪? |
| `artifacts/checkpoints/*/logging.jsonl` | `ms-swift` trainer | 训练在*真有进展*吗(逐步的指标)? |
| `artifacts/nvml-audit.jsonl` | NVML 辅助进程(`scripts/nvml_gpu_audit.py`) | *GPU 显存/利用率*随时间怎么走的? |

这些都不是编出来的名字——`runtime.log` 由每个后端通过 `bundle.append_runtime_log` 追加;远程 wrapper
跑的是 `entrypoint.sh > artifacts/stdout.log 2> artifacts/stderr.log`;训练入口把 `ms-swift` 命令通过
`tee "${BUNDLE_ROOT}/artifacts/training.log"` 接出来;而 bundle 在它的 `JobSpec.expected_outputs` 里
把这些全都预先声明了。

有一个被设计好的阅读顺序,记在 `docs/debugging.md` 里,而且它是一棵决策树,不是仪式:
`runtime.log → runtime-precheck.log → training.log → logging.jsonl → nvml-audit`。每一步在你往深看
之前,先排除一整类失败。执行面到底健康吗——暂存、启动、探测做了没?不健康就停,这是运维问题,不是模型
bug。健康但任务在训练开始前就死了?`runtime-precheck.log`。训练起来了又崩了?`training.log`。跑了却什么
都没学到?`logging.jsonl`。跑了却 OOM?`nvml-audit`。这是把可观测性*设计进产物*,让「那台机器上发生了
什么」有一条固定的答案路径,而不是靠猜。

## 依赖来路:到底是哪个包在跑

有一个面值得单拎出来,因为它逮的是租来硬件特有的一种失败。你把任务启动到一台用着某个你没构建过的
base 镜像的机器上。你的训练运行 import 的,是你*暂存进 bundle* 的那个 `ms-swift`,还是镜像里碰巧装着
的另一个 `swift`?在自己笔记本上你永远不会问。在一台随机租机上,这是个真实而无声的失败模式。

所以训练入口写出一个 `runtime-precheck.log`,它 import 这个包,并打印*哪一个*被绑定了——版本和解析出
的文件系统路径:

```python
import swift
print(f'swift runtime import ok: version={getattr(swift, "__version__", "unknown")} '
      f'path={pathlib.Path(swift.__file__).resolve()}')
```

当 ORBIT 自己的 `ms-swift` fork 在场时它走得更远:它读出 fork 的发行版版本(`affine-ms-swift-fork`),
若 fork 根目录被设置,还读它的 `FORK_MANIFEST.json`——`upstream`、`fork`、`patch_source`。同一个
precheck 在 rollout server 或原生 GKD 运行需要时有条件地 import `vllm`,在 GPU bundle 上 import
`pynvml`。于是「到底是哪个 `swift` 在跑,它是暂存的 fork 还是某个镜像里的包?」就成了日志里的一行,而
不是三小时的悬案。GPU 侧对应的思路是 NVML 审计:一个从入口启动的后台 `pynvml` 辅助进程
(`scripts/nvml_gpu_audit.py`),以一秒的间隔写出结构化 JSONL 的显存与利用率快照——因为你没法探身去盯一台
在别人数据中心里的机器的 `nvidia-smi`。

为什么这是*来路*、而不只是一次完整性检查:一个结果只有在你能说出是哪段代码产出它时才可复现,而在一台
租来机器上,跑的那段代码并不是你写的那段——它是 import 解析器实际绑定的那个,出自一个你只半控制的
`PYTHONPATH`、一个你没构建过的镜像。两个配置完全相同、但解析出的 `swift` 版本不同的 checkpoint,是
顶着同一个名字的两个不同实验,而这个差别一直是不可见的,直到它悄悄解释了一个你本会怪到某个超参头上的
回归。把解析出的路径记下来,就把「跑的是哪个 `ms-swift`?」从一个无法回答的问题——宿主被回收了,你
*没法*回去查——变成一个被记录的事实。这背后的通则,正是复现性文献反复重新发现的那一条:把环境捕获成
运行时所*观测到*的样子,而不是所*声明*的样子,因为两者之间的差,恰恰是无声不可复现性藏身之处。在一台
不复存在的机器上,那次运行时的观测,是你唯一会得到的环境记录。

## 你不拥有的代码:黑盒纪律

最难的复现问题不是你自己的代码,而是依赖别人的。你自己的代码,你能轻松钉死:它在你的 repo 里、在
某个 commit 上。你不拥有的上游代码,按自己的节奏前进,可能在一个你以为安全的版本区间下悄悄改了行为,
而它恰恰是那个最可能在「跑通的那次」和「没跑通的那次」之间无声地不一样的依赖。ORBIT 的 SWE-INFINITE
支持,是对上游 `AffineFoundation/affinetes` 环境(`orbit/integrations/affinetes_swe`)的一层薄集成,
而它遵循的规则,是一套值得偷学的纪律:

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

- **按精确 commit 钉死,快失败。** ref 必须是一个完整的 40 字符 commit 哈希——一个正则强制这一点,所以
  连分支名或版本区间都传不进来:

  ```python
  _COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

  def _require_exact_ref(ref: str) -> str:
      normalized = str(ref or "").strip().lower()
      if not _COMMIT_RE.fullmatch(normalized):
          raise RuntimeError("upstream_ref must be an exact 40-character git commit")
      return normalized
  ```

  而「脏」和「错 commit」一样要紧:`_ensure_clean` 跑 `git status --porcelain`,若 checkout 有未提交改动
  就拒绝继续(`raise RuntimeError(f"upstream checkout is dirty: {repo_root}")`),并且会先清掉散落的
  `__pycache__`/`.pyc` 免得它们假装成 drift。一个你无法归因到已知上游状态的结果,根本不是结果;而发现钉
  错了最便宜的时刻,是*在运行之前*。
- **当黑盒调用。** 这层集成在一个*子进程*里跑上游 actor,把上游 repo 放上 `PYTHONPATH`,原样 import 它的
  `Actor` 类,再 `await actor.evaluate(...)`——ORBIT 自己的架构文档把这件事称作「把上游
  `InfiniteActor.evaluate()` 当黑盒执行」。对交互式合成,它通过一个跨 Unix socket 的薄的有状态 server 桥接
  OpenEnv 的 `reset / state / checkpoint / restore / step / stop`——不改写任何上游语义。
- **能共享的别重建。** 对大批量,它复用一份共享的*不可变*运行时缓存,以 `{ref, python_version,
  requirements_sha256}` 为 key,放在 `~/.cache/orbit/affinetes_swe_runtime` 下,而不是每次都建一整套
  per-task venv。
- **写得薄。** 只在原始上游产物旁边持久化小小的 ORBIT manifest(一个 `schema_version:
  affinetes_swe_blackbox_run.v1` 的运行 manifest,记下 `upstream_ref`、`upstream_python`、任务结果)。
  你的元数据描述,而不重新解读。

trade-off 是真实的:包得薄,意味着你继承上游的怪癖、没法跨边界优化。反方向的诱惑同样真实——把上游
分叉出来、在本地「修好」它——而那是个陷阱,因为一个分叉就是一个你从此得永远维护的钉死点,而你一旦改写
了上游语义,你的数字就不再能和任何人的可比,包括你自己过去的运行。保持薄的回报是,你能随上游移动而
*跟踪*它,而你报告的每一个数字,都仍能归因到一个精确 commit。当你依赖你不控制的代码,**钉死它、包薄
它,永远别分叉它的含义。**

## 教训

把运行做成自描述的产物,把集成做成钉死的黑盒,远程训练里最吓人的那个问题——*「那台不复存在的机器上
到底发生了什么?」*——就完全能从你收集回来的东西里得到回答。bundle 不是裹在运行外面的包装。bundle
**就是**那次运行,以它唯一能比硬件活得更久的形态存在。

## 延伸阅读

- [《Design by Contract》,Bertrand Meyer](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf) —— 这篇借来的「接口即契约」思想,以其原始形态陈述。
- [复现性与 ML 复现性清单(Pineau 等,NeurIPS)](https://www.cs.mcgill.ca/~jpineau/ReproducibilityChecklist.pdf) —— 「报告环境,而不只是超参」在实践中意味着什么。
- [《Hidden Technical Debt in Machine Learning Systems》,Sculley 等(NeurIPS 2015)](https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf) —— 未声明的依赖和「pipeline 丛林」,正是这套纪律在偿还的那笔债。
