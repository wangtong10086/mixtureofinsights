---
title: "When the GPU isn't an NVIDIA"
description: "The whole LLM stack assumes CUDA. The GPU in front of you is often an Intel iGPU or a CPU. Getting a real, low-latency autoregressive TTS to stream there means rebuilding the parts you usually pip-install — the decode loop, the KV cache, the batching scheduler — on OpenVINO."
date: 2026-06-10
order: 1
series: "openvino-tts"
reading: "14 min read"
tags: ["llm", "inference", "openvino", "tts", "edge"]
---

Almost everything in the LLM world quietly assumes an NVIDIA card. vLLM, the kernels, the
tutorials — CUDA is the water we swim in. But the GPU actually in front of a user is just as often
an **Intel iGPU**, an Arc, or a plain CPU. Getting a modern autoregressive TTS model to run there —
fast, streaming, production-real — is a genuinely different kind of engineering, because the
comfortable stack simply isn't there. That's what `qwen3-tts-openvino` is.

## What the CUDA stack actually does for you

It's worth being precise about what you lose when you step off CUDA, because "it's just a different
backend" badly undersells it. The modern serving stack is a pile of CUDA-specific engineering, and
each piece is solving a real bottleneck:

- **Fused kernels.** FlashAttention computes attention without ever materializing the
  $n\times n$ score matrix in HBM — it tiles the computation in SRAM, turning an
  $O(n^2)$-memory operation into an $O(n)$-memory one. It's hand-written CUDA. Off CUDA you fall
  back to a generic attention that does materialize intermediates, and you eat the memory traffic.
- **Paged attention.** vLLM's KV cache is paged like virtual memory so the cache can grow without
  pre-reserving the worst case and without fragmenting (the [PagedAttention
  paper](https://arxiv.org/abs/2309.06180)). That's a custom CUDA kernel reading a block table.
- **CUDA graphs.** Autoregressive decode launches dozens of tiny kernels *per token*. At one token
  every few milliseconds, kernel-launch overhead alone can dominate. CUDA graphs capture the whole
  per-step launch sequence once and replay it as a single submission, deleting that overhead.
- **Continuous batching.** vLLM's scheduler admits and evicts requests at the granularity of a
  single decode step, so a freshly arrived request joins the in-flight batch immediately instead of
  waiting for the current one to finish.
- **NCCL.** Multi-GPU tensor parallelism rides on NCCL for collectives like all-reduce. Off NVIDIA,
  even the low-level act of sharding a model across cards lacks that battle-tested primitive layer.

None of these are "nice to have." They're the difference between a model that streams and one that
stutters. On OpenVINO you get *none* of them for free.

## Why this is hard, not just "export to ONNX"

A 12 Hz autoregressive TTS is not a feed-forward classifier you trace once. To serve it you need
the whole inference loop, and on OpenVINO you have to build it:

- it **decodes autoregressively** — one step feeds the next — so there's a real loop with a **KV
  cache**, not a single forward pass;
- it ends in a **neural codec** that turns tokens into waveform, on the hot path;
- and "good" means **streaming**: first audio out the door fast, not a batch job.

CUDA users get all of that handed to them by vLLM and friends. On OpenVINO, you are the framework.

## What you actually have to build

<figure class="figure">
<svg viewBox="0 0 660 176" role="img" aria-label="PyTorch to OpenVINO IR to runtime to streamed audio">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.r{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.5;fill:none}</style>
  <defs><marker id="t1" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="14" y="66" width="96" height="44" rx="8"/><text x="28" y="84" class="t">PyTorch</text><text x="28" y="100" class="s">Qwen3-TTS</text>
  <rect class="n" x="146" y="66" width="96" height="44" rx="8"/><text x="160" y="84" class="t">export</text><text x="160" y="100" class="s">→ OpenVINO IR</text>
  <rect class="r" x="278" y="36" width="220" height="104" rx="10"/>
  <text x="294" y="58" class="tb">OpenVINO runtime</text>
  <text x="294" y="78" class="s">AR decode loop + paged-KV (U8)</text>
  <text x="294" y="96" class="s">vLLM-like online batcher</text>
  <text x="294" y="114" class="s">native C++ codec → PCM</text>
  <text x="294" y="132" class="s">device: CPU · iGPU · Arc</text>
  <rect class="n" x="534" y="66" width="112" height="44" rx="8"/><text x="548" y="84" class="t">streamed</text><text x="548" y="100" class="s">audio (WS PCM)</text>
  <path class="a" d="M110 88 H146" marker-end="url(#t1)"/>
  <path class="a" d="M242 88 H278" marker-end="url(#t1)"/>
  <path class="a" d="M498 88 H534" marker-end="url(#t1)"/>
</svg>
<figcaption>Everything in the rust box is what CUDA users never see because vLLM already did it.
On OpenVINO it's the project.</figcaption>
</figure>

- **Export with fidelity.** PyTorch → OpenVINO IR for an AR transformer *and* its codec, exported
  so the decode loop and cache behave, not just so a single forward runs.
- **A KV cache that fits.** The runtime uses **paged-KV attention with a U8 (8-bit) KV cache by
  default** — quantizing the cache is what keeps long, full-context generation inside an iGPU's
  memory budget. Concretely, the native backend runs OpenVINO's `SDPAToPagedAttention` graph pass
  over an exported no-cache *seed* graph, then `specialize_kv_cache_parameters` pins the U8 element
  type, head count, and block size (`native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp`).
- **A vLLM-like online batcher — on OpenVINO.** A scheduler for request admission and decode
  steps, so concurrent requests share the device efficiently. It's `OnlineBatchScheduler` in
  `qwen3_tts_ov/online_batch.py` — a daemon thread whose `_loop` drains arriving requests, runs one
  batched `online_batch_step`, and evicts finished sequences each pass. This is the part that
  doesn't exist off the shelf for non-CUDA; you build the continuous-batching serving loop yourself.
- **Stream, don't segment.** Generation is **full-context autoregressive** — the text is *not*
  chopped into chunks — yet audio streams out over WebSocket PCM under a `fastest` profile. Latency
  is a first-class target, not an afterthought.
- **A native C++ codec pipeline** for the token→waveform step on the hot path, instead of paying
  Python on every frame.
- **Operational reality.** Device selection (CPU/GPU), a first-compile cache that's slow exactly
  once, and **lazy per-mode residency** (`--runtime-residency lazy` is the default; the server
  evicts idle modes) so VoiceDesign, CustomVoice, and VoiceClone don't all sit in memory at the
  same time — three capabilities, one sidecar.

## What OpenVINO gives you, and what it doesn't

OpenVINO is not a CUDA clone; it's a graph compiler and runtime. What it *does* give you is real:
a stable IR, a graph compiler that fuses ops and picks layouts for the target, and one runtime that
runs that IR on CPU, integrated GPU, Arc, and NPU through a device plugin. That last part is the
whole reason it's worth using — it's the one mature path to a *non-NVIDIA* accelerator.

Concretely, the API surface you actually live on is small: an `ov.Core`, `core.compile_model(...)`
per graph, and a `create_infer_request()` you drive in the loop. The runtime's `compile_model`
helper (`qwen3_tts_ov/runtime.py`) is where the device handling lives — it sets the inference
precision hint, flips on `GPU_ENABLE_LARGE_ALLOCATIONS` when the device is a GPU, and falls back to
CPU if a GPU compile fails:

```python
config = {"INFERENCE_PRECISION_HINT": precision_hint}
# ...
if "GPU" in device:
    config["GPU_ENABLE_LARGE_ALLOCATIONS"] = "YES"
try:
    return core.compile_model(str(model_path), device, config)
except Exception as first_error:
    # ... retry without large allocations, then optionally fall back to CPU
    return core.compile_model(str(model_path), "CPU", fallback_config)
```

What it doesn't give you is the serving layer. There's no built-in continuous-batching scheduler,
no off-the-shelf paged-KV attention you can `pip install`, no equivalent to CUDA graphs handed to
you for an autoregressive loop. OpenVINO compiles and runs a *graph*; everything that turns a graph
into a low-latency streaming service — the decode loop, the cache, the batcher — is yours to build.
And there's a second tax: OpenVINO compiles graphs lazily on first use (it caches the compiled blob
via `CACHE_DIR`, but the *first* compile is unavoidable), so the first request pays a multi-second
cost unless you warm it ahead of time. That's why the runtime ships an explicit cache-warmup step
(more in [post 3](/blog/paged-kv-batching-without-vllm/)).

## The real adversary: decode is bandwidth-bound

Here is the fact that governs everything downstream. Autoregressive decode generates **one token at
a time**, and at each step it reads the *entire* model's weights (and the growing KV cache) out of
memory to produce a single token. The useful measure is **arithmetic intensity** — FLOPs performed
per byte moved:

$$
I \;=\; \frac{\text{FLOPs}}{\text{bytes read}}.
$$

For a single-token decode step, you do roughly $2N$ FLOPs (one multiply-add per parameter) while
reading roughly $N \cdot b$ bytes of weights, where $N$ is the parameter count and $b$ the bytes
per weight. So $I \approx 2/b$ — about **1 FLOP per byte for fp16**, independent of model size.
Put it the other way: decode is a string of GEMVs (matrix times *one* vector). At batch size $B$
each weight is still read once but reused for $\approx 2B$ FLOPs, so $I \approx 2B/b$ — order 1 at
batch 1, climbing only as you batch. Hardware, by contrast, offers tens to hundreds of FLOPs
per byte of bandwidth (the *ridge point* of its roofline). When $I$ sits far below that ridge, you
are **memory-bandwidth bound**: the compute units idle, waiting on memory. Decode is the textbook
case.

This flips the usual intuition. The relevant spec of an iGPU isn't its TFLOPs — it's its memory
**bandwidth**. The per-token time floor is

$$
t_{\text{token}} \;\gtrsim\; \frac{N \cdot b \;+\; \text{KV bytes read}}{\text{BW}},
$$

and two design choices fall straight out of it. **Quantize the weights** (INT8: $b=1$ instead of
2) and you roughly halve bytes-moved per token. **Quantize the KV cache** (U8) and you shrink the
second term, which grows with context. Both are bandwidth plays, not compute plays — which is
exactly why the runtime defaults to INT8 weights (the production seed graph variant is
`int8_sym_batch_fused_gqa`) and a U8 KV cache (`kv_precision: str = "u8"` in the scheduler config).
([Post 3](/blog/paged-kv-batching-without-vllm/) does the cache math.) It's also why **batching** is the
big lever: serving $B$ requests in one decode step reads the weights *once* and amortizes them over
$B$ tokens, pushing $I$ up toward the ridge and turning a bandwidth-bound problem into a
compute-bound one.

## The metric that decides if it ships: RTF

For streaming TTS there's one number that subsumes the rest — the **real-time factor**:

$$
\text{RTF} \;=\; \frac{\text{compute time}}{\text{duration of audio produced}}.
$$

$\text{RTF} < 1$ means you generate audio faster than it plays — the necessary condition for
glitch-free streaming. At $\text{RTF} = 0.5$ you produce two seconds of speech per second of
compute, leaving headroom for jitter; at $\text{RTF} > 1$ the buffer underruns and the audio
stutters. With a frame rate of 12 Hz, the budget per frame is $1/12 \approx 83\,\text{ms}$ of
wall-clock for $\text{RTF}=1$, and every frame is one talker AR step plus the subcode fill plus its
share of the streaming decoder. RTF is the constraint that ties the bandwidth math above to a
shippable product: it's not enough to be correct, you have to clear $1/12$ s per frame on the
device in front of you. (Two other numbers matter alongside it: **time-to-first-audio**, which the
chunked decoder is tuned for, and concurrency — how many streams you hold under RTF at once, which
is what the batcher buys.)

## The lesson: portability is a capability

It's tempting to file "runs on OpenVINO" under fallback — the thing you do when you can't get an
H100. I'd put it the other way. The ecosystem is CUDA-*shaped*, and being able to rebuild the
serving stack — paged-KV, an online batcher, streaming — on a different runtime is a real
capability, for two reasons.

First, it goes where CUDA can't: a consumer laptop's iGPU, an Intel edge box, anywhere there's no
NVIDIA and no datacenter. For something like TTS, that's most of the actual deployment surface.

Second — and this is the part I value — it forces you to *understand the inference loop you
usually `pip install` away*. Once you've hand-built the AR decode, sized a U8 KV cache against a
real memory budget, and written the admission scheduler, vLLM stops being magic and starts being a
set of decisions you could have made yourself. That understanding pays back everywhere, CUDA
included.

That's the overview. The rest of the series opens each box in that rust rectangle. Next: the part
people assume is a solved black box — [how Qwen3-TTS actually turns text into a frame of
sound](/blog/how-qwen3-tts-makes-a-frame/), and the two-graph split that makes a 12 Hz
multi-codebook decoder tractable on OpenVINO.

## Further reading

- [PagedAttention / vLLM](https://arxiv.org/abs/2309.06180) — what continuous batching and paged-KV buy you on CUDA, and why you have to rebuild them elsewhere.
- [FlashAttention](https://arxiv.org/abs/2205.14135) — the fused, IO-aware attention kernel you give up off CUDA; the paper is also the clearest statement of why attention is memory-bound.
- [OpenVINO documentation](https://docs.openvino.ai/) — the IR, the device plugins (CPU/GPU/NPU), and model optimization.
- [Roofline: an insightful visual performance model](https://dl.acm.org/doi/10.1145/1498765.1498785) — Williams, Waterman & Patterson; where arithmetic intensity and the ridge point come from.
