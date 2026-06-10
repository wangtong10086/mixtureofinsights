---
title: "Paged-KV, U8, and batching where vLLM isn't"
description: "You have the model graphs. Now serve them — long-context, concurrent, inside an iGPU's memory budget, with none of vLLM's machinery. Four decisions that compose: paged-KV over fixed buckets, a U8 cache, full-context generation, and online batching that lives in the scheduler so one IR set serves everyone."
date: 2026-06-21
order: 3
series: "openvino-tts"
reading: "9 min read"
tags: ["llm", "inference", "openvino", "kv-cache", "batching"]
---

The [last post](/blog/how-qwen3-tts-makes-a-frame/) cut the model into graphs. Having the graphs
is maybe half the job; the other half is *serving* them — long context, several requests at once,
inside the memory budget of an Intel iGPU, with none of the CUDA serving stack you'd normally lean
on. "vLLM" here is not an import. It's four decisions you have to make yourself, and the reason
they work is that they **compose**.

## Decision 1 — paged-KV, not fixed cache buckets

The cache the talker needs grows with context, and OpenVINO wants static shapes. The obvious route
is **fixed cache buckets**: export the model at a fixed set of cache lengths (say 96 buckets) and,
at runtime, pick the smallest bucket that fits. It works, and it's miserable: you compile and
package many graph variants, you waste memory rounding every request *up* to a bucket boundary, and
you inherit a hard ceiling on context length.

The runtime instead uses **OpenVINO paged-KV** — a paged attention cache in blocks, so generation
continues until EOS or the configured context/memory budget, with **no fixed buckets at all**. The
trade-off is honest: paged attention is more to wire up (block tables, allocation, a no-cache seed
graph) than a bucket lookup. What you get back is no bucket combinatorics, no length ceiling, and —
the README's own phrasing — *reduced compile and package complexity.* One seed graph instead of a
drawer full of bucket variants.

## Decision 2 — a U8 KV cache

Long context means the KV cache, not the weights, is what blows your memory budget. So the default
cache storage precision is **U8 — 8-bit.** Quantizing the cache is the single thing that keeps
long, full-context generation inside an iGPU's memory envelope. The trade is the usual one for
quantization — a small, validated quality cost for a large memory win — and it's the production
default: `kv_cache_profile=auto` currently resolves to exactly this, U8 paged-KV.

## Decision 3 — full context, no segmentation

With paged-KV and U8 making long context *affordable*, you can make the choice that actually
matters for quality: **don't chop the text up.** `full_context_text=true` — the model attends over
the entire input rather than generating segment by segment. Chunked text fractures prosody and
coherence across the seams; full-context keeps the delivery natural over long passages.

This is the payoff of decisions 1 and 2 being in place. You *can* keep full context only because
paged-KV removed the length ceiling and U8 removed the memory wall. The decisions aren't a
checklist — they're a chain, and full-context generation is what hangs off the end of it.

## Decision 4 — batching in the scheduler, not in a model file

Now concurrency. The CUDA answer is continuous batching, and vLLM hands it to you. On OpenVINO you
build it — but *where* you build it is the real decision. The batching logic lives in the
**scheduler/backend layer**, not baked into a separate batched IR (`online_batching=on`,
`online_batch_scheduler=layered`).

The consequence is the whole point: **single-user and multi-user requests reuse the same IR set.**
You do not export and ship a separate "batched model" alongside the single-stream one; you ship one
set of graphs, and a layered scheduler admits requests and steps their decodes together. The
trade-off is that you write the admission-and-decode-step scheduler yourself — the exact thing vLLM
gives CUDA for free — but you keep one model artifact and gain flexible concurrency over it.

<figure class="figure">
<svg viewBox="0 0 620 188" role="img" aria-label="Layered scheduler over one shared IR set">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.sc{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.ir{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="pa" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="16" y="26" width="96" height="24" rx="6"/><text x="30" y="43" class="s">request A</text>
  <rect class="n" x="16" y="80" width="96" height="24" rx="6"/><text x="30" y="97" class="s">request B</text>
  <rect class="n" x="16" y="134" width="96" height="24" rx="6"/><text x="30" y="151" class="s">request C</text>
  <rect class="sc" x="170" y="58" width="180" height="72" rx="9"/><text x="186" y="82" class="tb">layered scheduler</text><text x="186" y="102" class="s">admit + step decode</text><text x="186" y="118" class="s">online batching</text>
  <rect class="ir" x="410" y="58" width="190" height="72" rx="9"/><text x="426" y="82" class="tb">one IR set</text><text x="426" y="102" class="s">talker paged-KV (U8)</text><text x="426" y="118" class="s">+ subcode + decoder</text>
  <path class="a" d="M112 38 Q150 50 170 74" marker-end="url(#pa)"/>
  <path class="a" d="M112 92 H170" marker-end="url(#pa)"/>
  <path class="a" d="M112 146 Q150 134 170 114" marker-end="url(#pa)"/>
  <path class="a" d="M350 94 H410" marker-end="url(#pa)"/>
</svg>
<figcaption>Concurrency lives in the scheduler, so one shared IR set serves a single user and a
batch of users alike. No separate batched model to export, package, and keep in sync.</figcaption>
</figure>

## The supporting cast: INT8 weights, warmup, and the NPU

Two more details round it out. The production talker seed graph is weight-compressed —
`int8_sym_batch_fused_gqa`, i.e. **INT8 symmetric** weights with **fused grouped-query attention**
(the compress presets are `fastest` and `minimal-online-gqa`). And because OpenVINO compiles graphs
on first use, the runtime ships a **cache-warmup** step that triggers compilation ahead of time, so
your *user's* first request doesn't eat the compile cost. On Windows there's even heterogeneous
placement — `--npu-offload decoder` warms the streaming decoder onto an Intel **NPU** while the
talker stays on the GPU. The `/health` endpoint surfaces all of it: KV precision, preallocated
blocks, max token budget, batching status, device — observability for a serving loop you built by
hand.

## The lesson

"vLLM" is not a library you import on OpenVINO — it's a set of decisions: a paged cache instead of
buckets, a quantized cache to fit the budget, full context because the first two let you afford it,
and continuous batching pushed into the scheduler so one graph set serves everyone. Rebuilding them
yourself forces you to see each as a *decision with a trade-off* rather than a default — and to
notice that they compose into a chain, where each one is what makes the next one affordable. That
is the understanding you don't get from `pip install vllm`, and it's the real reason the project was
worth building.
