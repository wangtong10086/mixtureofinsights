---
title: "The bundle is the contract"
description: "On a rented machine that no longer exists, the only thing you have is what you collected. So the bundle has to be self-describing: layered log surfaces that each answer one question, dependency provenance baked in, and — for code you don't own — a pinned black-box discipline."
date: 2026-06-19
order: 3
series: "orbit"
reading: "12 min read"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

The [task-agnostic core](/blog/orbit-a-task-agnostic-core/) hands work to the runtime as a
**bundle**. The bundle is two things at once: the interface between the control plane and the
execution plane, and the only forensic evidence you'll have after the run. On an ephemeral rented
GPU there is no "ssh back in and look around" — the box is gone. So the bundle has to be
*self-describing*, and most of ORBIT's debugging value lives in how it's laid out.

"The bundle is the contract" is meant in the precise software-engineering sense of *contract* — an
interface that both sides agree to, where each side can be developed, tested, and reasoned about
against the interface alone. The control plane promises to produce a bundle with a known shape;
the execution plane promises to run anything of that shape and return artifacts in a known
layout. Because the contract is a concrete directory, not a function signature that evaporates at
runtime, it has a property most interfaces lack: **it outlives both parties.** The control plane
that built it has moved on to the next run; the execution plane that ran it no longer exists. The
bundle is the frozen interface, persisted — the one place the two sides ever actually met, still
readable after both are gone.

## A bundle is a fixed directory layout

The shape isn't documentation-only — it's created by `JobBundle.ensure_structure` in
`orbit/core/execution/bundle.py`, which makes exactly these subdirectories:

```python
def ensure_structure(self) -> None:
    for subdir in (self.path, self.inputs_dir, self.scripts_dir, self.artifacts_dir, self.runtime_dir):
        subdir.mkdir(parents=True, exist_ok=True)
```

So a bundle is `job.json` plus four directories, each with one job:

```text
bundle/
  job.json     the JobSpec — kind, inputs, expected_outputs, entrypoint, resources
  inputs/      staged dataset + resolved swift_config.yaml + staged model/adapters
  scripts/     generated entrypoint.sh + helpers (nvml audit, patches) — exactly what ran
  runtime/     execution-plane state — runtime.log, last_run.json, last_status.json, result.json
  artifacts/   task logs, precheck, checkpoints, nvml audit, manifest.json — what the workload did
```

Two corrections worth flagging against the earlier draft of this post, because they matter for
debugging: `inputs/` and `job.json` are part of the contract too (the staged dataset and the
resolved config live in `inputs/`), and `manifest.json` — the index of collected logs and
artifacts — lives under `artifacts/`, not `runtime/`. The split matters because the most common
debugging mistake is treating every log file as interchangeable. They aren't — each surface
answers a *different* question, and knowing which one to open is half the fix.

## Layered log surfaces, each with one question

| Surface | Produced by | The one question it answers |
| --- | --- | --- |
| `runtime/runtime.log` | execution plane (`bundle.append_runtime_log`) | Was the *worker* healthy — did it stage, launch, probe, collect? |
| `artifacts/stdout.log`, `artifacts/stderr.log` | remote run wrapper | What did the *workload* actually print to stdout/stderr? |
| `artifacts/runtime-precheck.log` | bundle entrypoint | Was the runtime *staged correctly* before the real command ran? |
| `artifacts/training.log` | training entrypoint (`tee`) | Where did the training process get to before it stopped? |
| `artifacts/checkpoints/*/logging.jsonl` | `ms-swift` trainer | Was training making *real progress* (metrics over steps)? |
| `artifacts/nvml-audit.jsonl` | NVML helper (`scripts/nvml_gpu_audit.py`) | What did *GPU memory/util* do over time? |

These aren't invented names — `runtime.log` is appended by every backend through
`bundle.append_runtime_log`; the remote wrappers run `entrypoint.sh > artifacts/stdout.log 2>
artifacts/stderr.log`; the training entrypoint pipes the `ms-swift` command through `tee
"${BUNDLE_ROOT}/artifacts/training.log"`; and the bundle declares all of them up front in its
`JobSpec.expected_outputs`.

There's a designed reading order, documented in `docs/debugging.md`, and it's a decision tree, not
a ritual: `runtime.log → runtime-precheck.log → training.log → logging.jsonl → nvml-audit`. Each
step rules out a whole class of failure before you look deeper. Was the execution plane even
healthy — did it stage, launch, probe? If not, stop, it's operational, not a model bug. It was
healthy but the job died before training began? `runtime-precheck.log`. Training started then
crashed? `training.log`. Ran but learned nothing? `logging.jsonl`. Ran but OOM'd? `nvml-audit`.
This is observability *designed into the artifact*, so that "what happened on that machine?" has a
fixed answer path instead of a hunch.

## Dependency provenance: which package actually ran

One surface deserves singling out, because it catches a failure unique to rented hardware. You
launch onto a box with some base image you didn't build. Did your training run import the
`ms-swift` you *staged into the bundle*, or some other `swift` that happened to be installed in the
image? On a normal laptop you'd never ask. On a random rental it's a real and silent failure mode.

So the training entrypoint writes a `runtime-precheck.log` that imports the package and prints
*which* one it bound — version and resolved filesystem path:

```python
import swift
print(f'swift runtime import ok: version={getattr(swift, "__version__", "unknown")} '
      f'path={pathlib.Path(swift.__file__).resolve()}')
```

It goes further when ORBIT's own `ms-swift` fork is in play: it reads the fork's distribution
version (`affine-ms-swift-fork`) and, if the fork root is set, its `FORK_MANIFEST.json` —
`upstream`, `fork`, `patch_source`. The same precheck conditionally imports `vllm` when a rollout
server or native GKD run requires it, and `pynvml` on GPU bundles. So the answer to "which `swift`
actually ran, and was it the staged fork or some image package?" becomes a line in a log instead
of a three-hour mystery. The matching idea on the GPU side is the NVML audit: a background
`pynvml` helper (`scripts/nvml_gpu_audit.py`) launched from the entrypoint, writing structured
JSONL snapshots of memory and utilization at a one-second interval, because you can't lean over and
watch `nvidia-smi` on a machine in someone else's datacenter.

Why this is *provenance* and not merely a sanity check: a result is only reproducible if you can
say which code produced it, and on a rented box the code that ran is not the code you wrote — it's
whatever the import resolver actually bound, out of a `PYTHONPATH` you only half-control on an
image you didn't build. Two checkpoints with identical configs but different resolved `swift`
versions are different experiments wearing the same name, and the difference is invisible until it
quietly explains a regression you'll otherwise blame on a hyperparameter. Recording the resolved
path turns "which `ms-swift` ran?" from an unanswerable question — the host is deallocated, you
*can't* go check — into a recorded fact. The general principle is the one the reproducibility
literature keeps rediscovering: capture the environment as observed at runtime, not as declared,
because the gap between the two is exactly where silent irreproducibility lives. On a machine that
no longer exists, the runtime observation is the *only* environment record you will ever get.

## Code you don't own: the black-box discipline

The hardest reproducibility problem isn't your own code — it's depending on someone else's. Your
own code you can pin trivially: it's in your repo at a commit. Upstream code you don't own moves on
its own schedule, can change behavior under a version range you thought was safe, and is exactly
the dependency most likely to be silently different between the run that worked and the run that
didn't. ORBIT's SWE-INFINITE support is a thin integration over the upstream
`AffineFoundation/affinetes` environment (`orbit/integrations/affinetes_swe`), and the rules it
follows are a discipline worth stealing:

<figure class="figure">
<svg viewBox="0 0 640 176" role="img" aria-label="Pinned black-box integration with thin manifests">
  <style>.o{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.u{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.3}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="ba" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="o" x="16" y="40" width="200" height="96" rx="9"/>
  <text x="34" y="62" class="tb">ORBIT — thin wrapper</text>
  <text x="34" y="84" class="s">pin upstream by exact commit</text>
  <text x="34" y="102" class="s">fail fast if dirty / wrong ref</text>
  <text x="34" y="120" class="s">write only thin manifests</text>
  <rect class="u" x="300" y="40" width="200" height="96" rx="9"/>
  <text x="318" y="62" class="tb">upstream env (black box)</text>
  <text x="318" y="84" class="s">InfiniteActor.evaluate()</text>
  <text x="318" y="102" class="s">OpenEnv reset/step/restore</text>
  <text x="318" y="120" class="s">semantics never rewritten</text>
  <rect class="n" x="540" y="62" width="86" height="52" rx="8"/><text x="556" y="84" class="t">raw</text><text x="556" y="102" class="s">artifacts</text>
  <path class="a" d="M216 88 H300" marker-end="url(#ba)"/><text x="232" y="80" class="s">call as-is</text>
  <path class="a" d="M500 88 H540" marker-end="url(#ba)"/>
</svg>
<figcaption>Pin the upstream by exact git commit, fail fast if it's missing or dirty, call it as a
black box, and persist only thin ORBIT manifests beside the raw upstream artifacts.</figcaption>
</figure>

- **Pin by exact commit, fail fast.** The ref must be a full 40-character commit hash — a regex
  enforces it, so a branch name or a version range can't even be passed in:

  ```python
  _COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

  def _require_exact_ref(ref: str) -> str:
      normalized = str(ref or "").strip().lower()
      if not _COMMIT_RE.fullmatch(normalized):
          raise RuntimeError("upstream_ref must be an exact 40-character git commit")
      return normalized
  ```

  And "dirty" matters as much as "wrong commit": `_ensure_clean` runs `git status --porcelain`
  and refuses to proceed if the checkout has uncommitted edits (`raise RuntimeError(f"upstream
  checkout is dirty: {repo_root}")`), after first scrubbing stray `__pycache__`/`.pyc` so they
  don't masquerade as drift. A result you can't attribute to a known upstream state isn't a
  result, and the cheapest moment to discover the pin is wrong is *before* the run.
- **Call it as a black box.** The integration runs the upstream actor in a *subprocess* with the
  upstream repo on `PYTHONPATH`, imports its `Actor` class as-is, and `await`s `actor.evaluate(...)`
  — ORBIT's own architecture doc calls this "call upstream `InfiniteActor.evaluate()` as a
  black-box execution." For interactive synthesis it bridges OpenEnv's
  `reset / state / checkpoint / restore / step / stop` through a thin stateful server over a Unix
  socket — without rewriting any upstream semantics.
- **Don't rebuild what you can share.** For large batches it reuses a shared *immutable* runtime
  cache keyed on `{ref, python_version, requirements_sha256}` under `~/.cache/orbit/affinetes_swe_runtime`,
  instead of building a full per-task venv every time.
- **Write thin.** Persist only small ORBIT manifests (a `schema_version: affinetes_swe_blackbox_run.v1`
  run manifest recording `upstream_ref`, `upstream_python`, task results) next to the raw upstream
  artifacts. Your metadata describes; it doesn't reinterpret.

The trade-off is real: wrapping thin means you inherit the upstream's quirks and can't optimize
across the boundary. The temptation in the other direction is just as real — to fork the upstream
and "fix" it locally — and it's a trap, because a fork is a pin you now have to maintain forever,
and the moment you rewrite upstream semantics your numbers stop being comparable to anyone else's,
including your own past runs. The payoff of staying thin is that you can *track* upstream as it
moves, and every number you report stays attributable to an exact commit. When you depend on code
you don't control, **pin it hard, wrap it thin, and never fork its meaning.**

## The lesson

Make the run a self-describing artifact and the integration a pinned black box, and the scariest
question in remote training — *"what happened on that machine that no longer exists?"* — becomes
answerable entirely from what you collected. The bundle isn't packaging around the run. The bundle
**is** the run, in the only form that outlives the hardware.

## Further reading

- ["Design by Contract," Bertrand Meyer](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf) — the interface-as-contract idea this post borrows, stated in its original form.
- [Reproducibility and the ML reproducibility checklist (Pineau et al., NeurIPS)](https://www.cs.mcgill.ca/~jpineau/ReproducibilityChecklist.pdf) — what "report the environment, not just the hyperparameters" means in practice.
- ["Hidden Technical Debt in Machine Learning Systems," Sculley et al. (NeurIPS 2015)](https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf) — undeclared dependencies and "pipeline jungles" as the debt this discipline pays down.
