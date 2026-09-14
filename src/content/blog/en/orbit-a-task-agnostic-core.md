---
title: "A task-agnostic core, and plugins that earn their keep"
description: "ORBIT puts request validation and result summaries in task plugins, while one execution core handles bundle staging, launch, monitoring, and artifact collection."
date: 2026-06-10
order: 2
series: "orbit"
reading: "12 min read"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

My separation of the local control plane from the remote execution plane relies on one critical invariant: the execution core has no concept of what a "training job" or an "eval job" is. The executor only understands generic bundles, physical placement, launch modes, and artifact collection.

## The Cost of Task-Awareness

When I first wrote the runner, I intuitively built `train`, `eval`, and `collect` paths. Adding a fourth task required editing the shared executor and frequently broke the first three.

This violated the Open-Closed Principle ([Meyer, 1988](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)). The executor was open for modification with every new extension. The test surface expanded combinatorially. I could no longer trust a change for one task to leave the others working.

Comparing the tasks showed where they differed: config shape, validation, and output summaries. Staging, launching, monitoring, and artifact collection stayed the same.

I used that distinction to split the code, following Parnas's rule on modularization ([Parnas, 1972](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf)): split on what varies, not on processing steps.

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

This separation takes more work to debug. A run may crash in the generic core because a plugin built a malformed bundle, so the stack trace and the cause lie on different sides of the boundary.

I also have to check new fields for task-specific assumptions. If I add a generic bundle field that only makes sense for training, the core has secretly learned about the task. I rigorously prevent the execution engine from growing `if` statements about bundle contents.

The plugin boundary isolates task changes, while SFT, RLHF, and evaluation sweeps exercise the same executor pipeline.
