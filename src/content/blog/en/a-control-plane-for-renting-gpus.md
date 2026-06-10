---
title: "A control plane for renting GPUs"
description: "The hard part of model iteration isn't the training code — it's the orchestration mess around ephemeral, rented GPUs. ORBIT's bet: make a run a reproducible artifact, not a shell session, by splitting the control plane from the execution plane."
date: 2026-06-10
order: 1
series: "orbit"
reading: "11 min read"
tags: ["llm", "infrastructure", "training", "orbit", "reproducibility"]
---

The post-training work in the [last series](/blog/post-training-is-a-data-problem/) — data
engines, GRPO, reward models — all has to *run somewhere*. Increasingly that somewhere is a
rented GPU you don't own and won't keep: a Targon machine, alive for a job, gone after. That
reality quietly eats more time than any optimizer, and it's the part nobody writes about. ORBIT
is my answer to it.

## The mess this solves

Iterating on rented hardware degenerates into the same swamp every time:

- an SSH session where you hand-edit a config, run a script, and the exact command dies with the
  shell — the state of "what is running" lives only in a TTY that closes when your laptop sleeps,
- `train_v3_final_REAL.sh` and eleven cousins, each one a hidden branch of "what I ran that day,"
  with the actual flags overridden by shell history you can no longer reconstruct,
- a checkpoint you can't reproduce because the machine that made it is *deallocated* — the exact
  image, CUDA build, and dependency tree that produced it died with the host,
- logs and artifacts scattered on a box that no longer exists, so the only forensic trail is gone
  before you knew you needed it.

None of this is a modeling problem. It's an **orchestration** problem, and on ephemeral hardware
it's acute: the machine is the most disposable thing in the loop, so nothing durable can live on it.

The deeper failure underneath all four bullets is a single one: **an SSH-driven run has no
identity.** It isn't a value you can name, store, diff, or re-submit — it's a side effect that
happened once, on a host that's now gone, with no artifact left to attribute it to. You can't
retry what you can't name. You can't reproduce what left no record. You can't audit what only
ever existed as keystrokes. Everything below is a consequence of giving a run an identity.

## The bet: separate planning from execution

ORBIT's organizing idea is a clean split between two planes:

<figure class="figure">
<svg viewBox="0 0 640 210" role="img" aria-label="ORBIT control plane and execution plane">
  <style>.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.e{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.3}.t{font:12.5px sans-serif;fill:#1c1b19}.tb{font:13px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10.5px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.5;fill:none}</style>
  <defs><marker id="o1" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="c" x="16" y="20" width="250" height="170" rx="10"/>
  <text x="34" y="44" class="tb">Control plane · local</text>
  <rect class="n" x="34" y="58" width="214" height="26" rx="6"/><text x="46" y="76" class="t">experiment records</text>
  <rect class="n" x="34" y="92" width="214" height="26" rx="6"/><text x="46" y="110" class="t">template selection</text>
  <rect class="n" x="34" y="126" width="214" height="26" rx="6"/><text x="46" y="144" class="t">config validation → bundle</text>
  <rect class="n" x="34" y="160" width="214" height="22" rx="6"/><text x="46" y="176" class="s">run inspection · audit</text>
  <rect class="e" x="374" y="20" width="250" height="170" rx="10"/>
  <text x="392" y="44" class="tb">Execution plane · rented GPU</text>
  <rect class="n" x="392" y="58" width="214" height="26" rx="6"/><text x="404" y="76" class="t">placement (Targon)</text>
  <rect class="n" x="392" y="92" width="214" height="26" rx="6"/><text x="404" y="110" class="t">launch mode (host / docker)</text>
  <rect class="n" x="392" y="126" width="214" height="26" rx="6"/><text x="404" y="144" class="t">ms-swift run (SFT / RLHF)</text>
  <rect class="n" x="392" y="160" width="214" height="22" rx="6"/><text x="404" y="176" class="s">runtime audit logs</text>
  <path class="a" d="M266 88 H374" marker-end="url(#o1)"/><text x="284" y="80" class="s">bundle →</text>
  <path class="a" d="M374 150 H266" marker-end="url(#o1)"/><text x="284" y="168" class="s">← artifacts · logs</text>
</svg>
<figcaption>The control plane lives on your laptop and never moves. The execution plane is
disposable. A bundle goes right; artifacts and audit logs come back. The machine can vanish.</figcaption>
</figure>

The **control plane** is local and durable: experiment records, task orchestration, template
selection, config validation, run inspection. In the code it's `orbit/core/control` — and the
whole thing is one class, `CoreControlService`, whose constructor literally takes the four
collaborators as arguments:

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

The **execution plane** is the rented box: `orbit/core/execution` — generic bundles, placement
backends, launch modes, artifact collection, behind `ExecutionService`. Two more concerns glue
them — **task plugins** (`orbit/tasks/{training,evaluation,collection}`) that shape requests, and
**sidecars** (`orbit/remote_ops`, `orbit/monitoring`) for ops. The two CLI families map cleanly
onto the two planes: `orbit control` (`orbit/cli_control.py`) drives the control plane; `orbit
worker` (`orbit/cli_worker.py`) drives the execution plane directly against a bundle.

The split is the same one Kubernetes draws between a *declarative desired state* and the
*imperative work* of reaching it — and it's worth borrowing the distinction precisely, because it
explains why the split is load-bearing rather than cosmetic. The control plane holds a
**declarative description of the run you want**: a config, validated, against a *named* template,
on a kind of target. The execution plane does the **imperative work** of making it true on a
specific rented host — provision, stage, launch, collect — and then reports back. And the
"reports back" is not a metaphor: the execution backend writes a `RunHandle` and a `RunStatus`
*into the bundle's `runtime/` directory* and, on a remote rental, reconstructs the live state by
reading a `result.json` off the box over SSH. The terminal states are an explicit enum, not a
guess:

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

The control plane records the desired state and the returned handle; it can re-query status by
handing that handle back to the execution plane. The gap between "what I asked for" and "what the
status probe reports" is a value it can inspect rather than a story you reconstruct from memory.
This survives a worker dying because the desired state never lived on the worker — it's an
`Experiment` record in the local store. An SSH session can't survive anything, because the
desired state and the work *were the same act* — there was no description to fall back to.

## Two design choices that pay off

**1 · Explicit execution templates, not hidden runtime branching.** The thing that produces a
run is a *named template* — a YAML file under `execution_templates/`. The documented default is
`targon-rental-host.yaml`, and it's exactly as boring as it should be:

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

The two dimensions are kept deliberately orthogonal as separate enums in the contract —
`PlacementKind` (`local`, `targon_rental`) and `LaunchModeKind` (`host_process`, `docker_image`)
— so the supported matrix is just `{local, targon_rental} × {host_process, docker_image}`, all
four wired as explicit backends in `ExecutionService`. The backend is selected by a string key
built from the two enums:

```python
def backend_key_for_request(request: ExecutionRequest) -> str:
    return f"{request.placement.kind.value}_{request.launch_mode.kind.value}"
```

No `if $ENV == ...` buried three layers into a launch script deciding your fate at runtime — the
path is two named fields you can read off the template. `allow_overrides` is the only escape
hatch, and it's a whitelist.

**2 · The bundle is the unit of reproducibility.** A run is a *bundle* — validated config plus
what's needed to execute it — submitted to a target, with runtime audit logs and artifact
collection on the way back. Submitting is `template_id + overrides`, captured in a single frozen
`TaskSubmission`:

```python
class TaskSubmission(FrozenModel):
    experiment_id: str
    task_type: str
    task_request: dict[str, JsonValue]
    template_id: str
    overrides: ExecutionOverrides = Field(default_factory=ExecutionOverrides)
    ...
```

The reproducible object isn't your memory of the command; it's the bundle plus the template, and
the control kernel snapshots both into the experiment's run record (`template_snapshot`,
`execution_request`) the moment it submits. The validated path (`local control → targon_rental +
host_process`) is the documented, recommended GPU path, exercised on config-driven remote
training of native `ms-swift` SFT and GKD configs through `orbit control submit train` and the
config-file launcher `orbit control launch train`.

It's worth following one `submit_task` through the code, because the control flow *is* the
argument. `CoreControlService.submit_task` does five things in order: it calls `prepare_task` (which
looks up the plugin in the `TaskRegistry`, validates the request, and has the plugin build the
bundle); it resolves `template_id + overrides → ExecutionRequest` through the
`ExecutionTemplateRegistry`; it runs the request through the `ExecutionService`, which routes by the
backend key above; it records the returned `RunHandle` into the experiment; and it writes an audit
event. Later, `refresh_run_status`, `collect_run_artifacts`, and `terminate_run` all take the
*same handle* back out of the run record and hand it to the execution plane — the control plane
never needs to keep a live connection to the box, only the handle. That's the whole reconciler in
one class, and none of it lives on the worker.

This is the move that turns "a run" from a shell session into a **reproducible artifact**, and it
buys three concrete properties that a session can't have:

- **Idempotency you can reason about.** Re-submitting the same bundle to a fresh target is a
  defined operation with a defined result, not a re-enactment that depends on a host's leftover
  state. The bundle carries everything the run needs; the target is interchangeable.
- **Retry that actually means something.** When a rented host dies mid-run — and it will — the
  recovery action is "submit the bundle again," not "try to remember the seventeen flags I typed
  and hope the new box is configured like the old one." Retry is cheap because the desired state
  is a durable `Experiment` record and the worker was always disposable. The remote backend even
  stages a *clean* snapshot each time — `create_bundle_archive` excludes the local `runtime/`
  state and stale artifacts, so a resubmit starts from the bundle, not from a previous run's
  leftovers.
- **Provenance by construction.** Every checkpoint traces back to the exact bundle and template
  that produced it, so "what config made this?" is a lookup, not an archaeology project. On
  ephemeral hardware this is the *only* form of provenance available — the producing machine is
  gone, so the record has to be the artifact, not the host.

A deliberate boundary: ORBIT doesn't reinvent training. It uses upstream `ms-swift` directly. Its
job is to **validate config, build bundles, provision targets, and submit runs** — the
orchestration, not the optimizer. The training code stays standard; the *operating* of it becomes
repeatable.

## The lesson

The unit of reproducibility should be an **artifact**, not a memory. On ephemeral rented GPUs that
stops being a nicety and becomes load-bearing: the machine is the most disposable thing in the
loop, so the durable record — config, template, bundle, audit log — has to live on the side that
survives. Get that split right and "rerun exactly what produced this checkpoint" turns from a
prayer into a command.

This post is the map. The rest of the series goes inside it — starting with the design choice
that makes everything above possible: an execution core that flatly *refuses to know* whether
it's running training, eval, or data collection. Next:
[a task-agnostic core, and plugins that earn their keep](/blog/orbit-a-task-agnostic-core/).

## Further reading

- [Kubernetes design: the reconciler pattern](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/architecture/architecture.md) — the canonical control-plane/execution-plane split and the level-triggered reconciliation loop ORBIT borrows from.
- [Site Reliability Engineering, ch. 1 (Google)](https://sre.google/sre-book/introduction/) — why declarative desired-state beats imperative procedure when the substrate is unreliable.
- ["Hints for Computer System Design," Butler Lampson](https://www.microsoft.com/en-us/research/publication/hints-for-computer-system-design/) — "make it reproducible" and "separate normal and worst case" as system-design discipline, decades before it was fashionable.
