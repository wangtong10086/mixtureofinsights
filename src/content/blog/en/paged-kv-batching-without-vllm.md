---
title: "Paged-KV, U8, and batching where vLLM isn't"
description: "You have the model graphs. Now serve them — long-context, concurrent, inside an iGPU's memory budget, with none of vLLM's machinery. Four decisions that compose: paged-KV over fixed buckets, a U8 cache, full-context generation, and online batching that lives in the scheduler so one IR set serves everyone."
date: 2026-06-10
order: 3
series: "openvino-tts"
reading: "14 min read"
tags: ["llm", "inference", "openvino", "kv-cache", "batching"]
---

Once the graphs are isolated, serving them concurrently within an Intel iGPU's memory bandwidth without relying on CUDA or vLLM requires explicit lower-level intervention. I implemented a continuous batching runtime layered directly over OpenVINO. This relies on four architectural constraints that strictly compose.

## 1. Paged-KV over fixed buckets

Static shapes compel you toward fixed cache buckets (e.g., 96 discrete context lengths). Bucketing induces internal fragmentation. If a request needs $\ell=1{,}100$ tokens and the closest bucket is $L=2{,}048$, $46\%$ of the allocated VRAM is dead weight.

I replaced buckets with OpenVINO Paged-KV. In `native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp`, the runtime intercepts the exported talker seed graph and injects a `SDPAToPagedAttention` pass. This is an AST rewrite replacing standard scaled-dot-product attention with block-table lookups. 

```cpp
auto model = core.read_model(seed_xml);
add_readvalue_initializers(model);
const bool allow_score_aggregation = enabled_env("QWEN3_TTS_OV_NATIVE_PAGED_KV_SCORE_AGGREGATION", true);
// Inject paged attention natively
ov::pass::SDPAToPagedAttention(
    false, false, allow_score_aggregation, false, false, false)
    .run_on_model(model);
```

By allocating memory in blocks of $B=16$ tokens, akin to the original [PagedAttention (Kwon et al., 2023)](https://arxiv.org/abs/2309.06180) OS-level virtual memory mapping, fragmentation waste is bounded to $B \lceil \ell/B \rceil - \ell < B$. The memory waste per sequence collapses from gigabytes to under 16 tokens. 

## 2. U8 KV Cache quantization

At an arithmetic intensity of $I=2/b$, autoregressive decode is aggressively memory-bandwidth bound. For $L$ layers, $H$ KV heads, dimension $d_{\text{head}}$, sequence length $s$, and batch $B$, the capacity formula is:

$$
\text{KV bytes} \;=\; 2 \cdot L \cdot H \cdot d_{\text{head}} \cdot s \cdot B \cdot \text{bytes}_{\text{dtype}}
$$

For an $8{,}000$-token context on a mid-size talker at fp16 ($\text{bytes}=2$), a single stream consumes $\approx 0.9\,\text{GB}$. Four concurrent streams demand $3.6\,\text{GB}$, saturating the iGPU shared RAM before weights are even loaded.

I forced the cache to U8 (8-bit, $\text{bytes}=1$), halving the memory footprint and the bandwidth tax per decode step. This per-channel quantization introduces bounded error $|x - \hat{x}| \le \tfrac{1}{2}\,\text{scale}$ but yields a massive $2\times$ throughput increase. This is enforced via `--kv-cache-profile auto` in [`qwen3_tts_ov/cli.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/cli.py).

## 3. Full-context execution

Because Paged-KV eliminates length fragmentation and U8 halves the cache size, I can afford full-context autoregression without text segmentation. The model attends over the complete acoustic and text history (`full_context_text=true`). Chopping input sequences fractures prosody. True streaming requires unbroken attention across the temporal axis, a feat impossible without the prior memory optimizations.

## 4. Online batching in the scheduler

Concurrency is implemented as continuous batching within the Python scheduler, not baked into a static batched IR. The layered scheduler in [`qwen3_tts_ov/online_batch.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/online_batch.py) intercepts incoming requests and injects them into the running inference loop at the granularity of a single decode step.

```text
[Request A] --+
              v
[Request B] ----> [ Layered Scheduler ] ----> [ Single OpenVINO IR Set ]
              ^   (Admit / Evict Step)        (Paged-KV + U8 Talker)
[Request C] --+
```

A static batching logic waits to fill a batch and stalls until the longest sequence completes. Here, the `_loop` thread drains newly arrived sequences into the in-flight block table, executes exactly one decode step, and immediately evicts finished sequences.

```python
result = runner.online_batch_step(
    max_decode_batch=self.config.max_batch_size,
    max_events=self.config.max_events,
    num_code_groups=self.runtime.num_code_groups,
)
# Check output conditions, evict if finished
if kind in {2, 3}:
    request.output.put(None)
    with self._lock:
        self._requests.pop(int(native_id), None)
```

Batching pushes arithmetic intensity up. At batch $B$, weights are fetched once and amortized across $B$ tokens, shifting the operation from bandwidth saturation toward the compute roofline. The same base graph handles single-user isolation and multi-user concurrency without recompilation.

To squeeze the final latency metrics, I aggressively compressed the talker seed graph using INT8 symmetric quantization and fused grouped-query attention (`int8_sym_batch_fused_gqa`) via [`scripts/compress_openvino_weights.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/scripts/compress_openvino_weights.py), and bound the streaming decoder to the Intel NPU. The entire pipeline sits exactly at the physical limits of the bus.
