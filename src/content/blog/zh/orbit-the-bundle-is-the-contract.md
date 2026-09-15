---
title: "ORBIT 任务 bundle：日志、产物与依赖来源"
description: "ORBIT bundle 的目录约定、分层日志和依赖来源记录，以及接入上游项目时保留原有语义的做法。"
date: 2026-06-10
updatedAt: 2026-09-15
order: 3
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

可用的实验 bundle 应记录提交了什么、实际运行了什么，以及收回了哪些产物。ORBIT 将 job.json、输入、脚本、运行状态和产物分开，并记录实际导入的依赖路径与固定版本。这些记录帮助排查运行；数值级精确复现还取决于数据、随机性和执行环境。

这些记录需要在宿主机回收后仍然可用。只有“运行成功”这个状态不够：还需要 `job.json`、`runtime-precheck.log`、`stdout/stderr`，以及精确到 Git SHA 的依赖来源，才能还原当时运行了什么。

## 瓶颈：薛定谔的依赖环境

外部依赖往往是复现困难的来源。租用服务器上实际加载的 `ms-swift`，可能是刚打包进去的版本，也可能是宿主镜像里已有的版本。仅看提交时的配置，无法判断运行时用了哪一个。

这也是 [Sculley 等人 (2015) 在《Hidden Technical Debt in Machine Learning Systems》](https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf) 中讨论的“未声明的依赖与流水线丛林”债务。为减少这类不确定性，我约定了目录结构和依赖检查方式。

## 架构重组：固定目录拓扑与分层日志

bundle 的目录结构固定在代码中。在 [`orbit/core/execution/bundle.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/core/execution/bundle.py) 的 `JobBundle.ensure_structure` 中，各目录的职责如下：

```text
bundle_root/
 |-- job.json      (JobSpec: 强类型的输入输出契约)
 |-- inputs/       (挂载数据集、解析后的配置 yaml)
 |-- scripts/      (entrypoint.sh, nvml 探针脚本)
 |-- runtime/      (执行面心跳：runtime.log, status.json)
 `-- artifacts/    (负载产物：训练 log, checkpoint, manifest.json)
```

输入配置与运行记录分开存放。排查时可以按日志层级定位：如果 `runtime.log` 异常，是宿主级别的启动失败；如果 `artifacts/runtime-precheck.log` 报错，说明环境暂存时依赖拉取出了问题；只有到了 `artifacts/training.log`，才是真正的模型崩溃。目录本身就提供了查找日志的顺序。

## 原理推演：精准的来路记录 (Provenance)

入口脚本会先检查依赖。负载运行前，它必须输出实际导入的包路径：

```python
import swift
import pathlib
print(f'swift runtime import ok: version={getattr(swift, "__version__", "unknown")} '
      f'path={pathlib.Path(swift.__file__).resolve()}')
```

接入 `affinetes` 这类外部环境时，我另加了一层很薄的集成代码。在 [`orbit/integrations/affinetes_swe`](https://github.com/wangtong10086/orbit/tree/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/integrations/affinetes_swe) 中，我要求上游代码必须按完整的 40 字符 Git commit hash 钉死：

```text
[ORBIT: Thin Wrapper]                    [Upstream Environment (Blackbox)]
+---------------------------+            +---------------------------------+
| Enforce 40-char SHA1      |            | Actor.evaluate()                |
| Fast-fail on dirty tree   | ===Call==> | Unmodified semantics            |
| Persist minimal manifest  |            | OpenEnv restore/step            |
+---------------------------+            +---------------------------------+
```

如果代码树处于 dirty 状态，运行时直接拒绝启动。在隔离层面，子进程完全把上游视为黑盒，不去劫持任何语义。这也是 [Bertrand Meyer 在《Design by Contract》](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf) 里定义的严格接口契约。不仅如此，就像 [Pineau 等人提出的 ML Reproducibility Checklist](https://www.cs.mcgill.ca/~jpineau/ReproducibilityChecklist.pdf) 所倡导的，我记录的是**运行时实际观测到的状态**，而不是期望状态。观测与期望之间的偏差，是排查不可复现问题的线索。

## 硬核落地：放弃修改的权力

把外部依赖当作黑盒，就得接受上游的行为和限制，不能随手修改内部逻辑。这样可以继续跟进上游的安全更新，也能将每次运行的 metric 追溯到具体的 git commit。集成层只负责调用和记录，保持上游语义不变。

[任务插件边界](/zh/blog/orbit-a-task-agnostic-core/)说明了谁负责构建 bundle，以及谁解释其中的结果。
