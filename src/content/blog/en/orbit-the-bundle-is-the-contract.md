---
title: "ORBIT job bundles: logs, artifacts and dependency provenance"
description: "The ORBIT bundle layout: where run state, prechecks, logs, and artifacts live, and how pinned dependencies make a completed run easier to inspect."
date: 2026-06-10
updatedAt: 2026-09-15
order: 3
series: "orbit"
reading: "12 min read"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

A useful experiment bundle records what was requested, what actually ran and what was collected. ORBIT separates job.json, inputs, scripts, runtime state and artifacts, then records imported dependency paths and pinned revisions. These records help diagnose a run; exact numerical reproduction also depends on data, randomness and the execution environment.

The control plane generates a bundle. The execution plane consumes it and populates output. Because the contract is mapped to a physical directory layout, it outlives both the control process and the execution host.

## The Directory Layout

In [`orbit/core/execution/bundle.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/core/execution/bundle.py), the directory structure is defined in code:

```python
def ensure_structure(self) -> None:
    for subdir in (self.path, self.inputs_dir, self.scripts_dir, self.artifacts_dir, self.runtime_dir):
        subdir.mkdir(parents=True, exist_ok=True)
```

This enforces a five-part structure:

```text
bundle/
 |-- job.json      (JobSpec: resources, entrypoint)
 |-- inputs/       (staged datasets, resolved configs)
 |-- scripts/      (generated bash entrypoints, NVML trackers)
 |-- runtime/      (execution plane state, last_run.json)
 `-- artifacts/    (task logs, checkpoints, NVML snapshots)
```

`manifest.json` lives under `artifacts/`, isolating remote workload outputs from local control metadata in `runtime/`.

## Layered Observability

I designed the log surfaces to form a decision tree.

1. `runtime/runtime.log`: Did the worker stage and probe correctly?
2. `artifacts/runtime-precheck.log`: Did the bundle stage dependencies prior to execution?
3. `artifacts/training.log`: When did the training process crash?
4. `artifacts/checkpoints/*/logging.jsonl`: Did the optimizer actually make progress?
5. `artifacts/nvml-audit.jsonl`: Did memory spike before an OOM?

The `nvml_gpu_audit.py` script running in the background snapshots utilization every second. I can't look at `nvidia-smi` retroactively, so the bundle records it continuously.

## Dependency Provenance

I don't control the Python environment on rented machines. Before the workload runs, `runtime-precheck.log` records the resolved path and version of its critical dependency:

```python
import swift
print(f'swift runtime import ok: version={getattr(swift, "__version__", "unknown")} '
      f'path={pathlib.Path(swift.__file__).resolve()}')
```

If I am injecting my fork, the precheck parses `FORK_MANIFEST.json`. This proves whether the execution environment actually loaded the staged fork or an old system package. A discrepancy here silently invalidates an experiment. This aligns directly with the reproducibility principles of [Pineau et al. (2020)](https://arxiv.org/abs/2003.12206), capturing the observed runtime environment rather than relying on declared intent.

## The Black-Box Integration

For upstream components such as `affinetes`, I keep the integration separate from the upstream implementation. `orbit/integrations/affinetes_swe` follows these rules:

```text
+-------------------------+             +-----------------------------+
| ORBIT (thin wrapper)    |             | Upstream Env (black box)    |
|                         |             |                             |
| - pin exact git commit  |  call as-is | - InfiniteActor.evaluate()  |
| - abort if tree is dirty|------------>| - OpenEnv state machine     |
| - write thin manifests  |<------------| - upstream semantics intact |
|                         |  artifacts  |                             |
+-------------------------+             +-----------------------------+
```

I enforce a 40-character commit hash via regex.

```python
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

def _require_exact_ref(ref: str) -> str:
    normalized = str(ref or "").strip().lower()
    if not _COMMIT_RE.fullmatch(normalized):
        raise RuntimeError("upstream_ref must be an exact 40-character git commit")
    return normalized
```

I also run `git status --porcelain` and kill the execution if the tree is dirty. This avoids the pipeline-jungle problem in unstructured orchestration ([Sculley et al., 2015](https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf)).

I interact with the upstream `InfiniteActor.evaluate()` purely as a black box. If I need a bridge for interactive synthesis, I spin up a Unix socket server without mutating upstream semantics. Any attempt to fork and "fix" the upstream logic permanently severs comparability with external benchmarks.

I persist only a thin ORBIT manifest (`schema_version: affinetes_swe_blackbox_run.v1`) alongside the raw upstream artifacts. Together, the manifest and artifacts preserve the run for later inspection.

The [task-plugin boundary](/blog/orbit-a-task-agnostic-core/) explains who constructs this bundle and who interprets its results.
