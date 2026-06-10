---
title: "A task-agnostic core, and plugins that earn their keep"
description: "ORBIT's execution core flatly refuses to know whether it's running training, eval, or data collection. That one constraint — push every task-specific thing up into a plugin, keep the engine generic — is what stops a new task type from forking the executor. The design, and the trade-off it buys."
date: 2026-06-18
order: 2
series: "orbit"
reading: "8 min read"
tags: ["llm", "infrastructure", "architecture", "orbit", "design"]
---

The [first post](/blog/a-control-plane-for-renting-gpus/) drew the two planes — a durable local
control plane, a disposable remote execution plane. This one is about the single decision that
keeps both of them from rotting as you add task types: **the execution core is not allowed to know
what a "training job" is.** It knows bundles, placement, launch modes, and artifact collection —
nothing else. Training, evaluation, and data collection are not special runtime types to it.

## Why the executor must stay ignorant

The natural way to build a runner is to teach it about your tasks: a `train` path, an `eval`
path, a `collect` path, each with its own staging and launch logic. It works — until the fourth
task type, when you're editing the executor again, and the third one breaks because you touched
shared code. The executor becomes a junction box where every task's quirks meet, and every change
risks all of them.

Look at what actually *varies* between training, eval, and collection, and what doesn't:

- **Varies:** the shape of the request, what counts as a valid config, how you summarize the
  outputs afterward.
- **Invariant:** stage a bundle onto a target, launch it under a mode, watch it, collect logs and
  artifacts, report terminal state.

The invariant part is the whole executor. The varying part has *nothing to do with execution* —
it's request shaping and output reading. So you split exactly along that seam.

## The shape: a generic core, plugins above it

<figure class="figure">
<svg viewBox="0 0 640 232" role="img" aria-label="Task plugins build generic bundles for a task-agnostic execution core">
  <style>.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.p{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.e{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10.5px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="oa" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <text x="20" y="20" class="s">task plugins — know what a task is</text>
  <rect class="p" x="20" y="28" width="120" height="40" rx="7"/><text x="38" y="52" class="t">training</text>
  <rect class="p" x="150" y="28" width="120" height="40" rx="7"/><text x="168" y="52" class="t">evaluation</text>
  <rect class="p" x="280" y="28" width="120" height="40" rx="7"/><text x="298" y="52" class="t">collection</text>
  <rect class="c" x="20" y="96" width="380" height="44" rx="9"/>
  <text x="38" y="115" class="tb">control kernel</text><text x="38" y="131" class="s">registry · template + overrides → execution request</text>
  <rect class="e" x="20" y="168" width="380" height="44" rx="9"/>
  <text x="38" y="187" class="tb">execution core — task-agnostic</text><text x="38" y="203" class="s">bundle · placement · launch · collect</text>
  <path class="a" d="M80 68 V96" marker-end="url(#oa)"/><path class="a" d="M210 68 V96" marker-end="url(#oa)"/><path class="a" d="M340 68 V96" marker-end="url(#oa)"/>
  <path class="a" d="M210 140 V168" marker-end="url(#oa)"/><text x="220" y="158" class="s">generic bundle</text>
  <rect class="p" x="440" y="96" width="180" height="116" rx="9"/>
  <text x="458" y="120" class="tb">never imported</text>
  <text x="458" y="142" class="s">the core depends on</text>
  <text x="458" y="158" class="s">explicit plugin</text>
  <text x="458" y="174" class="s">registration — it does</text>
  <text x="458" y="190" class="s">not import task code</text>
  <path class="a" d="M440 154 H400" marker-end="url(#oa)"/>
</svg>
<figcaption>Plugins parse the task and build a generic bundle; the core executes bundles without
knowing what's inside. The dependency arrow only points up via a registry — the core never reaches
down into task code.</figcaption>
</figure>

Concretely, the task plugins (`orbit/tasks/{training,evaluation,collection}`) do three things and
only three: **parse and validate** a task-specific request, **build a generic execution bundle**
from it, and **summarize** the task's outputs after artifacts come back. The execution core
(`orbit/core/execution`) defines the bundle layout and the launch/placement backends, and runs
bundles — full stop.

The detail that makes this real, not aspirational: **the control kernel depends on explicit
plugin registration; it does not import task implementations directly.** That's dependency
inversion with teeth. The core declares a contract; plugins register against it; the core never
names `training` in its own imports. Add a task type and you add a plugin — you do not open the
engine.

## Templates and overrides, not hidden branching

The same instinct shows up one layer down, in how a run is specified. Control resolves
`template + overrides → execution request`. Submitting is `template_id + overrides` — an explicit,
*named* template (the documented `targon-rental-host`) plus a small diff, not a script that
decides your fate at runtime with an `if $ENV == ...` three frames deep.

The payoff is that "what ran" is a value you can read, diff against last week's, and resubmit
verbatim. The cost is honest: you maintain a set of templates instead of one clever
config-inheritance tree, and a genuinely new execution shape means a new template rather than
another conditional. On a workspace that iterates across many task and target combinations, the
predictability is worth more than the saved files. Hidden branching is cheap to write once and
expensive to trust forever.

## The trade-off, stated plainly

This shape isn't free. You pay:

- **a layer of indirection** — a plugin contract and a registry sit between "I want to train" and
  "a process runs," and you have to hold that boundary in your head;
- **upfront boundary design** — you have to get the generic bundle and execution contract right
  enough that three different task types really do fit through them.

What you buy is the property that **the blast radius of a new task type is one plugin.** The
executor that launches and collects is the same whether it's an SFT run, an eval sweep, or a data
collection batch — so it gets battle-tested across all of them instead of forking three ways. For
a system whose whole purpose is fast, safe iteration, that's the trade you want.

It's also the shape that *survived*. The architecture doc describes the boundaries "visible in the
codebase today" and pointedly declines to replay the refactor history — which is the polite way of
saying it didn't start this clean. It converged here, because the alternative (an executor that
knows your tasks) doesn't survive contact with the fourth task.

The principle generalizes past ORBIT: **separate what varies from what's invariant, and never let
the variant leak into the engine.** Next, the other half of that discipline — making the thing the
engine produces a self-describing artifact you can debug after the machine is gone:
[the bundle is the contract](/blog/orbit-the-bundle-is-the-contract/).
