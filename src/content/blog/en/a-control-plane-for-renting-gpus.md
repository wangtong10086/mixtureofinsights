---
title: "A control plane for renting GPUs"
description: "The orchestration mess around ephemeral, rented GPUs is the actual bottleneck of model iteration. Here is my bet with ORBIT: treat a run as a reproducible artifact, splitting control from execution."
date: 2026-06-10
order: 1
series: "orbit"
reading: "11 min read"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

The post-training work I did in my data engine builds—GRPO, synthetic pipelines, reward modeling—all had to execute somewhere. I found myself repeatedly targeting Targon machines: rented GPUs that stay alive exactly for the lifespan of a job, then evaporate. The orchestration around this ephemeral hardware silently consumed more time than optimizer tuning. ORBIT is my physical implementation to solve this.

## The Ephemeral Hardware Swamp

When I iterated on rented hardware, the workflow degraded predictably:

- An SSH session where I manually mutated a config and ran a script. The command state died with the TTY session.
- Countless variations of `train_v3_final_REAL.sh`, with critical flags overridden by forgotten shell history.
- Checkpoints that became irreproducible because the host machine—and its specific CUDA build and dependency tree—was deallocated.
- Logs and artifacts scattered on a nonexistent box. The forensic trail evaporated before I even knew I needed it.

This is an orchestration problem rooted in a deeper architectural failure: an SSH-driven run lacks identity. It is a side effect on a host that vanishes, leaving no artifact to attribute the run to. I cannot retry, diff, or audit keystrokes.

## Decoupling Planning from Execution

ORBIT is built on a strict bifurcation:

```text
+-------------------------------------------+       +-------------------------------------------+
| Control plane (local)                     |       | Execution plane (rented GPU)              |
|                                           |       |                                           |
|  [ experiment records ]                   |       |  [ placement (Targon) ]                   |
|  [ template selection ]                   | bundle|  [ launch mode (host / docker) ]          |
|  [ config validation -> bundle ]  --------|------>|  [ ms-swift run (SFT / RLHF) ]            |
|  [ run inspection / audit ]       <-------|-------|  [ runtime audit logs ]                   |
|                                           |       |                                           |
+-------------------------------------------+       +-------------------------------------------+
```

The **control plane** is localized and durable on my laptop. It handles experiment records, orchestration, templates, and validation. In the codebase, this is handled by [`orbit/core/control/service.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/core/control/service.py), specifically `CoreControlService`. The constructor requires the exact collaborators:

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

The **execution plane** lives entirely on the rented box: generic bundles, placement backends, and artifact collection managed by `ExecutionService` in [`orbit/core/execution/service.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/core/execution/service.py). Task plugins shape requests, and sidecars handle ops.

This maps to the declarative design paradigm ([Borg, Verma et al., 2015](https://dl.acm.org/doi/10.1145/2741948.2741964)) differentiating desired state from imperative reconciliation. The control plane holds the declarative description—a validated config, a named template, a target kind. The execution plane performs the imperative execution: provision, stage, launch, collect. The backend writes a `RunHandle` and a `RunStatus` directly into the bundle's `runtime/` directory. On a remote rental, it reconstructs live state by pulling `result.json` via SSH.

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

The control plane only records the desired state and the returned handle. I can query status later. The execution state outlives the worker's death because the desired state resides in my local `Experiment` store, completely decoupling the run's identity from the physical hardware.

## Concrete Immutability

I enforced two rigid design parameters to guarantee reproducibility.

**Explicit Execution Templates.** I eliminated hidden runtime branching. A run strictly requires a named template. I use `targon-rental-host.yaml` in `execution_templates/`:

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

I kept `PlacementKind` and `LaunchModeKind` orthogonal. The backend string key is explicitly constructed:

```python
def backend_key_for_request(request: ExecutionRequest) -> str:
    return f"{request.placement.kind.value}_{request.launch_mode.kind.value}"
```

There are no nested conditionals hijacking the launch path. `allow_overrides` acts as a strict whitelist.

**The Bundle as the Artifact.** The bundle encapsulates the validated config and everything required to execute it. A submission is `template_id + overrides`, frozen into `TaskSubmission`:

```python
class TaskSubmission(FrozenModel):
    experiment_id: str
    task_type: str
    task_request: dict[str, JsonValue]
    template_id: str
    overrides: ExecutionOverrides = Field(default_factory=ExecutionOverrides)
```

In `CoreControlService.submit_task`, I built a five-step rigid pipeline: validate and shape via plugin, resolve template, route through execution service, record the `RunHandle`, and emit an audit event. Future interactions—`refresh_run_status`, `collect_run_artifacts`—take this exact handle. I never persist a live SSH connection.

This architecture buys me three properties:

1. **Idempotency.** Resubmitting a bundle to a new target is completely deterministic.
2. **Stateless Retry.** When a Targon host dies (a frequent hardware reality), I just push the bundle again. The execution backend creates a clean snapshot via `create_bundle_archive`, stripping stale artifacts.
3. **Provenance.** Every checkpoint trivially maps back to its bundle and template.

On ephemeral hardware, the system's memory must outlive the hardware.
