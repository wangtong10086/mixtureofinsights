---
title: "A task-agnostic core, and plugins that earn their keep"
description: "ORBIT's execution core flatly refuses to know whether it's running training, eval, or data collection. That one constraint — push every task-specific thing up into a plugin, keep the engine generic — is what stops a new task type from forking the executor. The design, and the trade-off it buys."
date: 2026-06-18
order: 2
series: "orbit"
reading: "12 min read"
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

This is the [open/closed principle](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)
failing in slow motion: a module should be *open for extension but closed for modification*, and
the task-aware executor is exactly the opposite — every extension (a new task type) is a
modification (you edit the executor). The cost of that isn't abstract. Each `if task ==` branch
you add to a shared launch path is a new edge in the dependency graph between tasks that have no
business knowing about each other, and the test surface you must re-verify on every change grows
combinatorially: $N$ task types × the shared paths they all touch. The fourth task doesn't just
add work; it makes the *first three* less trustworthy, because they now share mutable code with a
stranger. A "new task type forks the executor" isn't a metaphor — it's the literal pull request,
and the literal regression three weeks later.

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

Concretely, the plugin boundary is one `Protocol`, `TaskPlugin`, in
`orbit/core/control/registry.py`. It's exactly four methods plus two class attributes:

```python
class TaskPlugin(Protocol):
    task_type: str
    job_kind: JobKind

    def parse_request(self, raw: dict | Any) -> Any: ...
    def validate_request(self, request: Any) -> list[str]: ...
    def build_bundle(self, *, bundle_dir: str, submission: TaskSubmission) -> JobBundle: ...
    def summarize_result(self, *, submission, bundle, status, manifest) -> TaskSummary: ...
```

That's the entire contract the core depends on. Notice what's *not* there: nothing about SFT,
nothing about benchmarks, nothing about datasets. `parse_request` and `validate_request` shape and
check a task-specific request; `build_bundle` turns it into a generic `JobBundle`; `summarize_result`
reads generic artifacts back into a `TaskSummary` after collection. A plugin's only return type the
core touches is `JobBundle` and `TaskSummary` — both task-agnostic. The execution core
(`orbit/core/execution`) defines the bundle layout and the launch/placement backends, and runs
bundles — full stop.

It's worth naming exactly what crosses the boundary and what doesn't. The `TrainingPlugin`
(`orbit/tasks/training/plugin.py`) knows an SFT request is a `TrainingSpec` with a `dataset_path`
and an `output_dir`, validates exactly that, and delegates bundle construction to a
`TrainBundleBuilder`:

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

The `EvaluationPlugin` instead validates that an `EvalTaskSpec` has a `model` and `environments`;
the `CollectionPlugin` validates a `CollectTaskSpec` has an `output_filename`. Three different
vocabularies — `dataset_path`, `environments`, `output_filename` — and **none of them crosses into
the core.** What crosses is a `JobBundle`: a directory layout, a launch mode, a placement target,
a contract for where logs and artifacts land. The core could not tell you whether the bundle it
just ran trained a model or evaluated one, and that ignorance is the feature.

The detail that makes this real, not aspirational: **the control kernel depends on explicit
plugin registration; it does not import task implementations directly.** That's dependency
inversion with teeth, and it's enforced as an architecture rule — `orbit/core/*` does not import
`orbit/tasks/*`. The wiring happens in a single composition root, `build_default_task_registry`:

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

The imports are *inside the function* on purpose — there is no import side effect, no global
registry populated at module load. The CLI calls this once, hands the registry to
`CoreControlService`, and the kernel looks plugins up by string: `self.task_registry.get(submission.task_type)`.
The core declares the contract; plugins register against it; the core never names `training` in its
own imports. Add a task type and you add a plugin plus one line in this function — you do not open
the engine.

## Templates and overrides, not hidden branching

The same instinct shows up one layer down, in how a run is specified. The control kernel resolves
`template + overrides → ExecutionRequest` via `ExecutionTemplateRegistry.resolve`. Submitting is
`template_id + overrides`, both carried on the same `TaskSubmission` the plugin already saw — an
explicit, *named* template (the documented `targon-rental-host`) plus a small whitelisted diff,
not a script that decides your fate at runtime with an `if $ENV == ...` three frames deep. The
template's `allow_overrides` list is the whole API surface for "what you're allowed to vary"; the
placement and launch mode themselves are fixed by the template you picked.

The payoff is that "what ran" is a value you can read, diff against last week's, and resubmit
verbatim. The cost is honest: you maintain a set of templates instead of one clever
config-inheritance tree, and a genuinely new execution shape means a new template rather than
another conditional. On a workspace that iterates across many task and target combinations, the
predictability is worth more than the saved files. Hidden branching is cheap to write once and
expensive to trust forever.

## The trade-off, stated plainly

This shape isn't free. You pay:

- **a layer of indirection** — a plugin contract and a registry sit between "I want to train" and
  "a process runs," and you have to hold that boundary in your head. When a run fails, the stack
  trace crosses the seam: the symptom shows up in the generic core, but the cause often lives in
  how a plugin shaped the bundle. Debugging means reasoning across an abstraction instead of
  reading one straight-line script.
- **upfront boundary design** — you have to get the generic bundle and execution contract right
  enough that three different task types really do fit through them. Get it wrong and you get a
  **leaky abstraction**: a "generic" bundle field that secretly only makes sense for training, or
  a launch mode a plugin can't express without smuggling task-specific assumptions through a
  field that was supposed to be opaque. Every leak is a place the core has quietly started to
  know about a task again — the exact thing the design exists to prevent — and leaks are seductive
  because each one is individually the path of least resistance.

The honest version of the trade-off: the abstraction earns its keep only if the invariant part
really is invariant. The moment a "task-agnostic" core grows its second `if` about what's inside
the bundle, you've paid for the indirection *and* lost the isolation it bought — the worst of both
designs. The discipline isn't building the boundary; it's refusing to puncture it later when a
single conditional would be so much faster.

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

## Further reading

- ["On the Criteria To Be Used in Decomposing Systems into Modules," David Parnas (1972)](https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf) — the original argument for splitting on *what varies*, not on processing steps. Everything here is a footnote to it.
- [The open/closed principle](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle) — Meyer's formulation, and why "open for extension, closed for modification" is exactly the property a plugin registry buys.
- ["The Law of Leaky Abstractions," Joel Spolsky](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/) — the failure mode that eats task-agnostic cores from the inside.
