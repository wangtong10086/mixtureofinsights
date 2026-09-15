---
title: "ORBIT: a control plane for experiments on rented GPUs"
description: "How ORBIT records experiments locally, submits bundles to rented GPUs, and uses execution templates and run handles to track work after a host is gone."
date: 2026-06-10
updatedAt: 2026-09-15
order: 1
series: "orbit"
reading: "11 min read"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

ORBIT gives a GPU experiment an identity outside the rental host: a local experiment record, a resolved execution template, a job bundle and a returned RunHandle. That record supports status checks and artifact collection after submission. Recovery still depends on retaining the bundle and collecting remote outputs before the host disappears; a saved submission alone cannot recover deleted checkpoints.

<span id="the-ephemeral-hardware-swamp" aria-hidden="true"></span>

## Why rented GPU jobs need persistent identities

When I iterated on rented hardware, the workflow degraded predictably:

- An SSH session where I manually mutated a config and ran a script. The command state died with the TTY session.
- Countless variations of `train_v3_final_REAL.sh`, with critical flags overridden by forgotten shell history.
- Checkpoints that became irreproducible because the host machine—and its specific CUDA build and dependency tree—was deallocated.
- Logs and artifacts left on a deallocated box, gone by the time I needed to inspect them.

These SSH-driven runs had no identity independent of the host. Once it was gone, I had no complete record to retry, compare, or audit.

<span id="decoupling-planning-from-execution" aria-hidden="true"></span>

## Separate experiment planning from remote execution

ORBIT separates local control from remote execution:

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

The **control plane** keeps its records on my laptop. It handles experiment records, orchestration, templates, and validation. In the codebase, this is handled by [`orbit/core/control/service.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/core/control/service.py), specifically `CoreControlService`. The constructor requires the exact collaborators:

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

The **execution plane** lives entirely on the rented box: generic bundles, placement backends, and artifact collection managed by `ExecutionService` in [`orbit/core/execution/service.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/core/execution/service.py). Task plugins shape requests, and sidecars handle ops.

This follows the declarative approach ([Borg, Verma et al., 2015](https://dl.acm.org/doi/10.1145/2741948.2741964)) differentiating desired state from imperative reconciliation. The control plane holds the declarative description—a validated config, a named template, a target kind. The execution plane performs the imperative execution: provision, stage, launch, collect. The backend writes a `RunHandle` and a `RunStatus` directly into the bundle's `runtime/` directory. On a remote rental, it reconstructs live state by pulling `result.json` via SSH.

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

<span id="concrete-immutability" aria-hidden="true"></span>

## Templates, bundles and collected artifacts

I used two requirements to guarantee reproducibility.

Every run requires a named execution template, replacing hidden runtime branches. I use `targon-rental-host.yaml` in `execution_templates/`:

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

The launch path has no nested conditionals. `allow_overrides` acts as a strict whitelist.

The bundle contains the validated config and everything required to execute it. A submission is `template_id + overrides`, frozen into `TaskSubmission`:

```python
class TaskSubmission(FrozenModel):
    experiment_id: str
    task_type: str
    task_request: dict[str, JsonValue]
    template_id: str
    overrides: ExecutionOverrides = Field(default_factory=ExecutionOverrides)
```

In `CoreControlService.submit_task`, submission follows five steps: validate and shape via plugin, resolve template, route through execution service, record the `RunHandle`, and emit an audit event. Future interactions—`refresh_run_status`, `collect_run_artifacts`—take this exact handle. I never persist a live SSH connection.

This gives the run the following properties:

1. **Idempotency.** Resubmitting a bundle to a new target is completely deterministic.
2. **Stateless Retry.** When a Targon host dies (a frequent hardware reality), I just push the bundle again. The execution backend creates a clean snapshot via `create_bundle_archive`, stripping stale artifacts.
3. **Provenance.** Every checkpoint trivially maps back to its bundle and template.

The durable record is concrete: [the bundle layout and runtime provenance](/blog/orbit-the-bundle-is-the-contract/) show which files must survive a rental.
