---
title: "A task-agnostic core, and plugins that earn their keep"
description: "I designed ORBIT's execution core to be completely oblivious to the tasks it runs. By pushing task-specific logic up into plugins, I prevented new tasks from mutating and breaking the executor."
date: 2026-06-10
order: 2
series: "orbit"
reading: "12 min read"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

My separation of the local control plane from the remote execution plane relies on one critical invariant: the execution core has no concept of what a "training job" or an "eval job" is. The executor only understands generic bundles, physical placement, launch modes, and artifact collection. 

## The Cost of Task-Awareness

When I first wrote the runner, I intuitively built `train`, `eval`, and `collect` paths. This degraded immediately. Adding a fourth task required editing the shared executor, frequently breaking the first three tasks. The executor devolved into a monolithic junction box.

This is a textbook violation of the Open-Closed Principle ([Meyer, 1988](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)). The executor was open for modification with every new extension. The test surface expanded combinatorially. Sharing mutable code across disparate tasks destroyed my trust in the system.

I profiled the variance across tasks. The shape of the config, validation, and output summaries vary wildly. Staging a bundle, launching it, monitoring it, and collecting artifacts remain perfectly invariant. 

I cleaved the system precisely along this seam. This aligns perfectly with Parnas's fundamental rule on modularization ([Parnas, 1972](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf)): split on what varies, not on processing steps.

## The Plugin Boundary

```text
       [ Task Plugins ]
   (knows what a task is)
  +----------+ +----------+ +----------+
  | training | |   eval   | | collect  |
  +----+-----+ +----+-----+ +----+-----+
       |            |            |
       v            v            v
  +------------------------------------+
  | Control Kernel                     |
  | (registry, templates -> request)   |
  +------------------------------------+
                   | (generic bundle)
                   v
  +------------------------------------+
  | Execution Core (task-agnostic)     |
  | (placement, launch, collection)    |
  +------------------------------------+
```

The boundary is codified in `TaskPlugin`, defined in [`orbit/core/control/registry.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/core/control/registry.py):

```python
class TaskPlugin(Protocol):
    task_type: str
    job_kind: JobKind

    def parse_request(self, raw: dict | Any) -> Any: ...
    def validate_request(self, request: Any) -> list[str]: ...
    def build_bundle(self, *, bundle_dir: str, submission: TaskSubmission) -> JobBundle: ...
    def summarize_result(self, *, submission, bundle, status, manifest) -> TaskSummary: ...
```

There are no SFT or dataset references here. `parse_request` and `validate_request` handle task-specific ingestion. `build_bundle` maps it to a uniform `JobBundle`. The execution core at [`orbit/core/execution`](https://github.com/wangtong10086/orbit/tree/main/orbit/core/execution) processes the bundle opaquely.

The `TrainingPlugin` in [`orbit/tasks/training/plugin.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/tasks/training/plugin.py) enforces specific keys:

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

Conversely, `EvaluationPlugin` enforces `model` and `environments`. The core engine ignores these vocabularies completely. 

I strictly enforce dependency inversion. The control kernel never imports task implementations directly. The wiring happens entirely within `build_default_task_registry`:

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

The imports are intentionally buried inside the function. There is no global registry mutated at load time. The core resolves plugins purely by string lookup.

## The Abstraction Cost

I pay a latency cost in debugging. When a run panics, the stack trace tears across the boundary: the crash happens in the generic core, but the root cause is usually a plugin malforming the bundle. 

I also have to continuously defend against leaky abstractions. If I add a generic bundle field that only makes sense for training, the core has secretly learned about the task. I rigorously prevent the execution engine from growing `if` statements about bundle contents. 

This plugin architecture isolates the blast radius. I battle-test a single executor pipeline across SFT, RLHF, and eval sweeps. A system built for iteration speed requires exactly this isolation.
