---
title: "Paged-KV, U8, and batching where vLLM isn't"
description: "You have the model graphs. Now serve them — long-context, concurrent, inside an iGPU's memory budget, with none of vLLM's machinery. Four decisions that compose: paged-KV over fixed buckets, a U8 cache, full-context generation, and online batching that lives in the scheduler so one IR set serves everyone."
date: 2026-06-21
order: 3
series: "openvino-tts"
reading: "14 min read"
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
continues until EOS or the configured context/memory budget, with **no fixed buckets at all**. And
the key thing is that paged-KV is not hand-rolled CUDA here: it's an OpenVINO graph pass. The native
backend reads the exported *seed* graph (a talker with no cache wired in) and runs OpenVINO's own
`SDPAToPagedAttention` over it, rewriting every scaled-dot-product-attention into a paged-attention
op before compiling — in `native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp`:

```cpp
auto model = core.read_model(seed_xml);
add_readvalue_initializers(model);
const bool allow_score_aggregation = enabled_env("QWEN3_TTS_OV_NATIVE_PAGED_KV_SCORE_AGGREGATION", true);
try {
    ov::pass::SDPAToPagedAttention(
        false, false, allow_score_aggregation, false, false, false)
        .run_on_model(model);
} catch (const std::exception& exc) { /* ... */ }
const size_t restored_parameters = restore_unregistered_parameters(model);
specialize_kv_cache_parameters(model, heads, block_size, head_dim, cache_element_type);
```

The trade-off is honest: paged attention is more to wire up (block tables, allocation, that no-cache
seed graph) than a bucket lookup. What you get back is no bucket combinatorics, no length ceiling,
and — the README's own phrasing — *reduced compile and package complexity.* One seed graph
(`talker_stateful_batch_gqa`) instead of a drawer full of bucket variants.

The deeper win is memory, and it's worth doing the arithmetic. **Bucketing rounds every request up
to a bucket boundary** — classic internal fragmentation. If a request needs $\ell$ tokens of cache
and the smallest fitting bucket is $L$, you waste $L-\ell$ tokens of cache. With buckets spaced
geometrically you can over-allocate by up to the bucket ratio: round $\ell=1{,}100$ up to a
$2{,}048$ bucket and **46%** of that request's cache is dead weight. **Paging** instead allocates in
small fixed blocks of $B$ tokens (the PagedAttention design; vLLM uses $B=16$, and so does the
online-batch path here — `block_size: int = 16` in `OnlineBatchConfig`), so the only waste is
the slack in the last partial block:

$$
\text{waste}_{\text{paged}} \;=\; B\left\lceil \tfrac{\ell}{B} \right\rceil - \ell \;<\; B,
\qquad\text{vs.}\qquad
\text{waste}_{\text{bucket}} \;=\; L - \ell,
$$

i.e. *at most one block* (under 16 tokens) lost per sequence regardless of length, versus up to a
whole bucket's worth. That bounded-fragmentation property is what lets paged-KV pack many concurrent
sequences into the same iGPU memory pool — fragmentation that would otherwise scale with sequence
length collapses to a per-sequence constant. (PagedAttention reports near-zero KV waste against the
60–80% typical of pre-allocation; the mechanism is exactly this.)

## Decision 2 — a U8 KV cache

Long context means the KV cache, not the weights, is what blows your memory budget — and the
formula tells you why. For a transformer, the KV cache holds one key and one value vector per layer,
per attention head, per token, per sequence in the batch:

$$
\text{KV bytes} \;=\; 2 \cdot L \cdot H \cdot d_{\text{head}} \cdot s \cdot B \cdot \text{bytes}_{\text{dtype}},
$$

where the leading $2$ is keys-and-values, $L$ is layers, $H$ the number of **KV heads** (not query
heads — with grouped-query attention several query heads share one KV head, which is exactly where
$H$ shrinks), $d_{\text{head}}$ the per-head dimension, $s$ the sequence length, and $B$ the batch.
Two things to notice. First, it's **linear in both $s$ and $B$** — long context *and* concurrency push on the same number, which is the whole
tension of this post. Second, the only term you can move at runtime without retraining is
$\text{bytes}_{\text{dtype}}$.

Make it concrete with round numbers for a mid-size talker — say $L=28$ layers, $H=8$ KV heads (GQA
already cuts $H$ here — the seed graph that the online path selects is the GQA variant, and the
scheduler sets `heads = 8 if paged_kv_seed_uses_gqa(seed_key) else 16`), $d_{\text{head}}=128$ (the
real `head_dim` default in both `OnlineBatchConfig` and the native backend). Per token per sequence
that's
$2 \cdot 28 \cdot 8 \cdot 128 = 57{,}344$ elements. At **fp16** ($\text{bytes}=2$) that's
$\approx 112\,\text{KB}$ per token; over an $8{,}000$-token full-context passage,
$\approx 0.9\,\text{GB}$ for a *single* stream. Hold four concurrent streams and you're at
$\approx 3.6\,\text{GB}$ of cache alone — on an iGPU that shares system RAM, that's the budget gone
before you've counted weights.

Switch the cache to **U8 (8-bit)** and $\text{bytes}=1$: every number above **halves**. The same
8k-token stream drops from $0.9$ to $0.45\,\text{GB}$; four streams from $3.6$ to $1.8\,\text{GB}$.
That is the single thing that keeps long, full-context generation inside an iGPU's memory envelope,
and it compounds with the bandwidth argument from [post
1](/blog/when-the-gpu-isnt-an-nvidia/) — half the cache bytes is also half the cache *traffic* read
on every bandwidth-bound decode step. The trade is the usual one for quantization: per-token,
per-channel quantization of K and V introduces a bounded error
$|x - \hat{x}| \le \tfrac{1}{2}\,\text{scale}$, a small, validated quality cost for a 2× memory and
bandwidth win. It's the production default, and the CLI flag spells it out — `--kv-cache-profile`
in `qwen3_tts_ov/cli.py`:

```python
parser.add_argument(
    "--kv-cache-profile",
    default="auto",
    choices=KV_CACHE_PROFILE_CHOICES,
    help="Paged-KV cache memory profile. Default auto uses the fastest default, currently u8.",
)
```

The scheduler config agrees: `OnlineBatchConfig` carries `kv_precision: str = "u8"`, which is handed
straight to the native runner as `kv_cache_precision`. So `--kv-cache-profile auto` resolves to
exactly this — U8 paged-KV.

## Decision 3 — full context, no segmentation

With paged-KV and U8 making long context *affordable*, you can make the choice that actually
matters for quality: **don't chop the text up.** The request carries a `full_context_text` boolean
(the long-text full-AR path), and the production sidecar treats segmentation as a debug-only
fallback — the API exposes `allow_auto_segment_text` / `auto_segment_text` but documents them as
"Debug fallback only; production long text is full-AR." With `full_context_text=true` the model
attends over the entire input rather than generating segment by segment. Chunked text fractures
prosody and coherence across the seams; full-context keeps the delivery natural over long passages.

This is the payoff of decisions 1 and 2 being in place. You *can* keep full context only because
paged-KV removed the length ceiling and U8 removed the memory wall. The decisions aren't a
checklist — they're a chain, and full-context generation is what hangs off the end of it.

## Decision 4 — batching in the scheduler, not in a model file

Now concurrency. The CUDA answer is continuous batching, and vLLM hands it to you. On OpenVINO you
build it — but *where* you build it is the real decision. The batching logic lives in the
**scheduler/backend layer**, not baked into a separate batched IR. The sidecar turns it on by
default; the two flags are `--online-batching on` and `--online-batch-scheduler layered` in
`qwen3_tts_ov/cli.py`:

```python
serve_parser.add_argument(
    "--online-batching", default="on", choices=["auto", "on"],
    help="Native online continuous batching. Default on uses the vLLM-like production backend.",
)
serve_parser.add_argument(
    "--online-batch-scheduler", default="layered", choices=["layered"],
    help="Native online batching scheduler. Production sidecar is fixed to layered vLLM-like scheduling.",
)
```

That `scheduler` is the only choice on purpose — the Python `OnlineBatchScheduler` refuses anything
else (`if scheduler != "layered": raise ValueError`), and the underlying native continuous-batch
policy is `layered_vllm`.

The consequence is the whole point: **single-user and multi-user requests reuse the same IR set.**
You do not export and ship a separate "batched model" alongside the single-stream one; you ship one
set of graphs, and a layered scheduler admits requests and steps their decodes together. The
trade-off is that you write the admission-and-decode-step scheduler yourself — the exact thing vLLM
gives CUDA for free — but you keep one model artifact and gain flexible concurrency over it.

Why batch at all? Go back to the bandwidth argument. A single-stream decode step reads the whole
model's weights to emit *one* token — arithmetic intensity around 1 FLOP/byte, deep in the
memory-bound regime, compute units mostly idle. Batch $B$ streams into one step and you read the
weights **once** and reuse them across $B$ tokens: the weight traffic is amortized, arithmetic
intensity rises ~$B\times$, and throughput climbs almost linearly until either (a) you saturate
compute and hit the roofline ridge, or (b) the KV cache for $B$ streams exhausts memory — the
$s \cdot B$ term from Decision 2. That second ceiling is precisely the one paged-KV and U8 raise.

**Continuous (online) batching** is the scheduling discipline that makes this real. Naïve *static*
batching waits to fill a batch, then runs all sequences to completion together — so a short request
stuck behind a long one waits for the long one to finish, and a half-empty batch wastes the device.
Continuous batching schedules at the granularity of a *single decode step*: it admits a new request
into the in-flight batch on the very next step and evicts a finished one immediately, keeping the
batch as full as the memory budget allows at all times. The win is occupancy — the device stays near
its efficient batch size instead of draining and refilling — which is why it's the design vLLM is
built around, and the one the layered scheduler reimplements here.

You can see exactly that discipline in `OnlineBatchScheduler._loop`: each pass drains newly arrived
requests into the in-flight set, cancels any that are dead, runs *one* batched decode step, and
evicts finished sequences immediately — admission and eviction at the granularity of a single step,
not a whole utterance:

```python
result = runner.online_batch_step(
    max_decode_batch=self.config.max_batch_size,
    max_events=self.config.max_events,
    num_code_groups=self.runtime.num_code_groups,
)
# ... per row: kind 1/3 -> emit a frame; kind 2/3 -> finished, evict
if kind in {2, 3}:
    request.output.put(None)
    with self._lock:
        self._requests.pop(int(native_id), None)
```

Prompt construction and speech decoding stay *per request*; only the codec autoregressive steps are
batched — which is the whole reason VoiceDesign, CustomVoice, and VoiceClone can share this one
path once they've produced prompt embeddings.

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

Two more details round it out. The production talker seed graph is weight-compressed — the
scheduler's default `graph_variant` is `int8_sym_batch_fused_gqa`, i.e. **INT8 symmetric** weights
with **fused grouped-query attention**. That variant is produced by `scripts/compress_openvino_weights.py`;
the relevant preset is `minimal-online-gqa`, which sets exactly that variant and compresses *only*
the low-memory production batch seed graph:

```python
elif args.preset == "minimal-online-gqa":
    if args.variant == parser.get_default("variant"):
        args.variant = "int8_sym_batch_fused_gqa"
    if args.mode == parser.get_default("mode"):
        args.mode = "int8_sym"
    # ... include_paged_kv_seed = True
    args.paged_kv_seed_keys = "talker_stateful_batch_gqa"
```

(the `fastest` preset is the broader production compression; `minimal-online-gqa` is the trimmed
online-batch one). And because OpenVINO compiles graphs on first use, the runtime ships a
**cache-warmup** step that triggers compilation ahead of time, so your *user's* first request
doesn't eat the compile cost. There's also heterogeneous placement — `--npu-offload decoder` is a
real choice (`NPU_OFFLOAD_CHOICES = ("off", "auto", "decoder", "audio", "all", "require")`) that
sets `decoder_device = "NPU"`, warming the streaming decoder onto an Intel **NPU** while the talker
stays on the GPU. The `/health` endpoint surfaces all of it — `kv_cache_profile`,
`native_paged_kv_precision`, `native_paged_kv_block_size`, `kv_cache_preallocation`, the
`online_batching` block, and the device map — observability for a serving loop you built by hand.

## The lesson

"vLLM" is not a library you import on OpenVINO — it's a set of decisions: a paged cache instead of
buckets, a quantized cache to fit the budget, full context because the first two let you afford it,
and continuous batching pushed into the scheduler so one graph set serves everyone. Rebuilding them
yourself forces you to see each as a *decision with a trade-off* rather than a default — and to
notice that they compose into a chain, where each one is what makes the next one affordable. That
is the understanding you don't get from `pip install vllm`, and it's the real reason the project was
worth building.

## Further reading

- [PagedAttention / vLLM](https://arxiv.org/abs/2309.06180) — the paged-KV design and the fragmentation numbers; §3–4 are the block-table and continuous-batching mechanics rebuilt here.
- [Orca: a distributed serving system for transformers](https://www.usenix.org/conference/osdi22/presentation/yu) — iteration-level (continuous) batching, the scheduling idea that makes online batching pay off.
- [OpenVINO: optimizing inference & KV-cache](https://docs.openvino.ai/) — device plugins, weight compression (INT8), and the model-caching that the warmup step front-runs.
- [LLM.int8() / weight quantization](https://arxiv.org/abs/2208.07339) — the precision-vs-quality trade behind both the INT8 weights and the U8 cache.
