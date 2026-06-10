---
title: "The bundle is the contract"
description: "On a rented machine that no longer exists, the only thing you have is what you collected. So the bundle has to be self-describing: layered log surfaces that each answer one question, dependency provenance baked in, and — for code you don't own — a pinned black-box discipline."
date: 2026-06-19
order: 3
series: "orbit"
reading: "9 min read"
tags: ["llm", "infrastructure", "observability", "orbit", "reproducibility"]
---

The [task-agnostic core](/blog/orbit-a-task-agnostic-core/) hands work to the runtime as a
**bundle**. The bundle is two things at once: the interface between the control plane and the
execution plane, and the only forensic evidence you'll have after the run. On an ephemeral rented
GPU there is no "ssh back in and look around" — the box is gone. So the bundle has to be
*self-describing*, and most of ORBIT's debugging value lives in how it's laid out.

## A bundle is three directories with three jobs

```text
bundle/
  scripts/    generated entrypoint + helpers — exactly what ran
  runtime/    execution-plane state + audit logs — what the worker did
  artifacts/  task logs, precheck, checkpoints, audit — what the workload did
```

The split matters because the most common debugging mistake is treating every log file as
interchangeable. They aren't — each surface answers a *different* question, and knowing which one
to open is half the fix.

## Layered log surfaces, each with one question

| Surface | Produced by | The one question it answers |
| --- | --- | --- |
| `runtime/runtime.log` | execution plane | Was the *worker* healthy — did it stage, launch, probe, collect? |
| `artifacts/*.log` | task runtime | What did the *workload* actually print and do? |
| `artifacts/runtime-precheck.log` | bundle entrypoint | Was the runtime *staged correctly* before the real command ran? |
| `artifacts/checkpoints/*/logging.jsonl` | training runtime | Was training making *real progress* (metrics over steps)? |
| `artifacts/nvml-audit.jsonl` | NVML helper | What did *GPU memory/util* do over time? |

There's a designed reading order, and it's a decision tree, not a ritual:
`runtime.log → task logs → precheck → logging.jsonl → nvml-audit`. Each step rules out a whole
class of failure before you look deeper. Was the execution plane even healthy? If not, stop — it's
operational, not a model bug. It was healthy but the job died early? Go to precheck. Job ran but
learned nothing? `logging.jsonl`. Ran but OOM'd? `nvml-audit`. This is observability *designed into
the artifact*, so that "what happened on that machine?" has a fixed answer path instead of a hunch.

## Dependency provenance: which package actually ran

One surface deserves singling out, because it catches a failure unique to rented hardware. You
launch onto a box with some base image you didn't build. Did your training run import the
`ms-swift` you *staged into the bundle*, or some other `swift` that happened to be installed in the
image? On a normal laptop you'd never ask. On a random rental it's a real and silent failure mode.

So `runtime-precheck.log` records it explicitly: can the runtime import `swift`, is `vllm`
available when required, can GPU bundles import `pynvml` — and crucially, **is it using the staged
in-repo `ms-swift` fork rather than an unexpected image-installed package.** Provenance becomes a
line in a log instead of a three-hour mystery. The matching idea on the GPU side is the NVML audit:
a background `pynvml` helper writing structured JSONL snapshots of memory and utilization, because
you can't lean over and watch `nvidia-smi` on a machine in someone else's datacenter.

## Code you don't own: the black-box discipline

The hardest reproducibility problem isn't your own code — it's depending on someone else's. ORBIT's
SWE-INFINITE support is a thin integration over the upstream `affinetes` environment, and the rules
it follows are a discipline worth stealing:

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

- **Pin by exact commit, fail fast.** Resolve the external checkout by a precise git ref; if it's
  missing, dirty, or at the wrong commit, refuse to run. A result you can't attribute to a known
  upstream state isn't a result.
- **Call it as a black box.** Invoke `InfiniteActor.evaluate()` and bridge OpenEnv's
  `reset/state/checkpoint/restore/step/stop` through a thin stateful shim — without rewriting any
  upstream semantics.
- **Don't rebuild what you can share.** For large eval batches, reuse a shared *immutable* upstream
  runtime cache instead of building a full per-task venv every time.
- **Write thin.** Persist only small ORBIT manifests next to the raw upstream artifacts. Your
  metadata describes; it doesn't reinterpret.

The trade-off is real: wrapping thin means you inherit the upstream's quirks and can't optimize
across the boundary. The payoff is that you can *track* upstream as it moves, and every number you
report stays attributable to an exact commit. When you depend on code you don't control, **pin it
hard, wrap it thin, and never fork its meaning.**

## The lesson

Make the run a self-describing artifact and the integration a pinned black box, and the scariest
question in remote training — *"what happened on that machine that no longer exists?"* — becomes
answerable entirely from what you collected. The bundle isn't packaging around the run. The bundle
**is** the run, in the only form that outlives the hardware.
