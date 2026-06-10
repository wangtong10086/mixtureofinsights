---
title: "bundle 即契约"
description: "远程机器跑完就没了，留下来的 bundle 必须能替它作证。目录结构、日志分层、依赖来源和黑盒边界，都应该写进这份契约。"
date: 2026-06-10
order: 3
series: "orbit"
reading: "12 分钟"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

在云端跑计算最残酷的物理现实是：机器不会等你回过神来收集日志。当显存 OOM 触发、进程崩溃、抢占式实例被回收，你手里剩下的就只有系统抓回来的那点残渣。我意识到，在 ORBIT 里，bundle 绝对不能只是个“打包格式”，它必须是运行生命周期的黑匣子。

这个黑匣子的寿命必须超越它所运行的物理宿主。控制面下发了指令，执行面随时可能湮灭；最后能用来还原案发现场的，只有 `job.json`、`runtime-precheck.log`、标准的 `stdout/stderr`，以及精确到 Git SHA 的依赖来路。一份只写着“运行成功”的 bundle 就是一堆废纸。它必须在物理层面上自证清白。

## 瓶颈：薛定谔的依赖环境

最难以复现的问题往往来源于那些你不拥有的外部代码。一台干净的租用服务器上，你跑的到底是刚才打包进去的 `ms-swift`，还是宿主镜像里残留的脏版本？在本地开发机上你绝不会问这个问题，但在分布式调度下，这就成了随时引爆的幽灵 Bug。

这也是 [Sculley 等人 (2015) 在《Hidden Technical Debt in Machine Learning Systems》](https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf) 中痛陈的“未声明的依赖与流水线丛林”债务。为了斩断这种不确定性，我引入了极度苛刻的黑盒纪律。

## 架构重组：固定目录拓扑与分层日志

我通过代码固化了 bundle 的空间拓扑结构。在 [`orbit/core/execution/bundle.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/core/execution/bundle.py) 的 `JobBundle.ensure_structure` 中，文件系统被切割成职责极度分明的部分：

```text
bundle_root/
 |-- job.json      (JobSpec: 强类型的输入输出契约)
 |-- inputs/       (挂载数据集、解析后的配置 yaml)
 |-- scripts/      (entrypoint.sh, nvml 探针脚本)
 |-- runtime/      (执行面心跳：runtime.log, status.json)
 `-- artifacts/    (负载产物：训练 log, checkpoint, manifest.json)
```

这条切割线将“我叫它做什么”和“它实际做了什么”进行了物理隔离。调试是一套确定性的决策树：如果 `runtime.log` 异常，是宿主级别的启动失败；如果 `artifacts/runtime-precheck.log` 报错，说明环境暂存时依赖拉取出了问题；只有到了 `artifacts/training.log`，才是真正的模型崩溃。通过把可观测性编码进文件目录，我建立了一套硬核的法医学系统。

## 原理推演：精准的来路记录 (Provenance)

为了解决依赖环境被篡改的问题，我让入口脚本执行严格的预检。在真正的载荷运行前，它必须输出自己绑定了内存中哪个具体的包路径：

```python
import swift
import pathlib
print(f'swift runtime import ok: version={getattr(swift, "__version__", "unknown")} '
      f'path={pathlib.Path(swift.__file__).resolve()}')
```

但这还不够。面对诸如 `affinetes` 等不受控的外部环境时，我做了一层极薄的隔离集成。在 [`orbit/integrations/affinetes_swe`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/integrations/affinetes_swe) 中，我要求上游代码必须按完整的 40 字符 Git commit hash 钉死：

```text
[ORBIT: Thin Wrapper]                    [Upstream Environment (Blackbox)]
+---------------------------+            +---------------------------------+
| Enforce 40-char SHA1      |            | Actor.evaluate()                |
| Fast-fail on dirty tree   | ===Call==> | Unmodified semantics            |
| Persist minimal manifest  |            | OpenEnv restore/step            |
+---------------------------+            +---------------------------------+
```

如果代码树处于 dirty 状态，运行时直接拒绝启动。在隔离层面，子进程完全把上游视为黑盒，不去劫持任何语义。这也是 [Bertrand Meyer 在《Design by Contract》](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf) 里定义的严格接口契约。不仅如此，就像 [Pineau 等人提出的 ML Reproducibility Checklist](https://www.cs.mcgill.ca/~jpineau/ReproducibilityChecklist.pdf) 所倡导的，我记录的是**运行时实际观测到的状态**，而不是期望状态。因为观测与期望之间的微小偏差，正是所有不可复现性的温床。

## 硬核落地：放弃修改的权力

这种将外部依赖当成黑盒处理的代价是：你无法轻易魔改它，你继承了上游所有的丑陋与怪癖。但收益更为致命：你可以伴随上游的安全演进随时跟进，且所有跑出来的 metric 都能追溯到一条无可辩驳的 git commit。钉死它，薄薄地包覆它，但绝不分叉它的含义，这是让数据真正具备科学价值的唯一途径。
