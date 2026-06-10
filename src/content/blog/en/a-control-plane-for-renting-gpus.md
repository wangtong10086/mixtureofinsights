---
title: "A control plane for renting GPUs"
description: "The hard part of model iteration isn't the training code — it's the orchestration mess around ephemeral, rented GPUs. ORBIT's bet: make a run a reproducible artifact, not a shell session, by splitting the control plane from the execution plane."
date: 2026-06-16
order: 1
series: "orbit"
reading: "7 min read"
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
  shell,
- `train_v3_final_REAL.sh` and eleven cousins, each one a hidden branch of "what I ran that day,"
- a checkpoint you can't reproduce because the machine that made it is *deallocated*,
- logs and artifacts scattered on a box that no longer exists.

None of this is a modeling problem. It's an **orchestration** problem, and on ephemeral hardware
it's acute: the machine is the most disposable thing in the loop, so nothing durable can live on it.

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
selection, config validation, run inspection. The **execution plane** is the rented box: generic
bundles, placement backends, launch modes, artifact collection. Two more concerns glue them —
**task plugins** that shape training / eval / collection requests, and **sidecars** for remote
ops and monitoring.

## Two design choices that pay off

**1 · Explicit execution templates, not hidden runtime branching.** The thing that produces a
run is a *named template* — e.g. the documented default `targon-rental-host`, paired with
`local control → targon_rental → host_process`. The supported matrix is just
`{local, targon_rental} × {host_process, docker_image}`, all chosen explicitly. No `if
$ENV == ...` buried three layers into a launch script deciding your fate at runtime. What ran is
a value you can read, diff, and reuse.

**2 · The bundle is the unit of reproducibility.** A run is a *bundle* — validated config plus
what's needed to execute it — submitted to a target, with runtime audit logs and artifact
collection on the way back. The reproducible object isn't your memory of the command; it's the
bundle and the template. The validated path (`local control → targon_rental + host_process`) was
proven end-to-end on config-driven remote training, including native `ms-swift` SFT and GKD
configs submitted through `orbit control launch train`.

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
