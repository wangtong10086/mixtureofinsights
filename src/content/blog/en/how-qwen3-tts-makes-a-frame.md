---
title: "How Qwen3-TTS makes a frame of sound"
description: "A TTS model isn't one graph — it's a small pipeline of graphs with wildly different compute shapes. The key design move in porting Qwen3-TTS to OpenVINO is cutting it at the seams: a talker graph for long-context attention, a cached subcode graph for the rest of each multi-codebook frame, and a chunked streaming decoder."
date: 2026-06-10
order: 2
series: "openvino-tts"
reading: "14 min read"
tags: ["llm", "tts", "openvino", "codec", "architecture"]
---

The overview stated a 12 Hz autoregressive TTS is an inference loop, not a single forward pass. This post breaks down that loop. The typical abstraction of "text goes in, audio comes out" hides a pipeline of isolated graphs with completely divergent compute shapes. When I ported Qwen3-TTS to OpenVINO, the primary architectural decision was slicing the model at exactly the seams where these compute shapes change.

## A frame is a stack, not a token

At a 12 Hz cadence, the model emits an audio frame. This frame is not a scalar token. It is a multi-codebook codec frame: a vertical stack of discrete codebook tokens that collectively represent a time-slice of acoustic waveform. A downstream vocoder/codec translates this stream into raw PCM audio.

Neural audio codecs rely on residual vector quantization (RVQ), a concept introduced in [SoundStream (Zeghidour et al., 2021)](https://arxiv.org/abs/2107.03312) which iteratively quantizes the residual signal, forming the basis of multi-codebook frames. Let the latent vector be $x$, and $q_j$ be the codeword from codebook $j$. Codebook $i$ quantizes the residual:

$$
r_i \;=\; x \;-\; \sum_{j<i} q_j,
$$

The first codebook ($r_1 = x$) captures the coarse structure. The subsequent codebooks refine the error. Reconstruction is the sum $\hat{x} = \sum_{i} q_i$. With $Q$ codebooks of $V$ entries, a frame holds $Q \log_2 V$ bits. This rigid ordering dictates the compute distribution: I spend heavy autoregressive machinery on the primary first codebook, and a cheap, cached greedy loop on the remaining refinements. The coarse-then-fine token modeling was heavily validated by [AudioLM (Borsos et al., 2022)](https://arxiv.org/abs/2209.03143), confirming that the first token is load-bearing. 

## The seam that matters: talker vs subcode

Fusing these disparate operations into a single computational graph is a mistake. I split the generation into three stages.

```text
+-----------------------+       +-----------------------+       +-----------------------+
|  Talker Seed Graph    |       | Cached Subcode Graph  |       |   Decoder Stream      |
|  (Paged-KV Attention) |------>| (Greedy Fill)         |------>|   (Chunked Context)   |
|  O(n^2 d)             |       | O(Q d)                |       |   O(1) continuous     |
+-----------------------+       +-----------------------+       +-----------------------+
           |                               ^                               |
           v                               |                               v
  1st Codebook + Hidden State   Rest of the codebooks               PCM Waveform
```

**The talker graph** executes long-context autoregressive attention over the entire sequence history to produce the first codebook and a hidden state. This is the $O(n^2)$ component. At frame $n$, it attends over $n$ prior positions. The total cost is $O(n^2 d)$. This graph intrinsically requires a KV cache to collapse the recompute to $O(n)$. I exported this as the seed graph in [`qwen3_tts_ov/native_paged_kv.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/native_paged_kv.py), leaving KV-cache parameters dynamic so the OpenVINO C++ backend can inject PagedAttention operations via AST rewrites. 

```python
# Exporting the grouped-query attention seed
input_shapes = [
    ov.PartialShape([-1, 1, config.hidden_size]),
    ov.PartialShape([3, -1, 1]),
    ov.PartialShape([-1, 1, 1, -1]),
    ov.PartialShape([-1]),
    # GQA: exporting the fewer KV heads to shrink cache size
    *[ov.PartialShape([1, kv_heads, -1, head_dim]) for _ in range(config.num_hidden_layers * 2)],
]
ov_model = ov.convert_model(wrapper.eval(), example_input=example_inputs, input=input_shapes)
```

**The `subcode_greedy_cached` graph** fills the remaining codebooks $2 \dots Q$. Conditioned strictly on the talker's hidden state, it executes a greedy loop. There is no historical attention. Its cost is $O(Q \cdot d)$, strictly constant in $n$. In the exporter, I wired a loop over `int(config.num_code_groups) - 1` heads. Splitting this out prevents dragging the heavy $O(n)$ KV-cache machinery through a loop that is fundamentally $O(1)$ in temporal context. 

**The streaming decoder** is a convolutional/transformer hybrid that ingests chunks of completed frames to emit PCM audio. It maintains a bounded left-context window, ignoring distant history. 

By cutting the model precisely at the boundaries where the computational shape changes, each subgraph compiles into an intermediate representation (IR) that the hardware scheduler can map optimally. OpenVINO allocates block tables for the talker, a static loop for the subcode, and a rolling buffer for the decoder.

## Streaming chunk sizes

The decoder exports embed their chunking schedule directly into their filenames:

```python
path = out_dir / f"speech_decoder_stream_c{left_context_frames}_t{chunk_frames}.xml"
```

A profile like `c25_t12` enforces 25 frames of left-context and emits chunks of 12 tokens. The vital detail is the first chunk: `c0_t8`. I export a distinct, smaller graph with zero left-context and an 8-token width to minimize the time-to-first-audio (TTFA). The production build configures these precisely in [`qwen3_tts_ov/build_fastest.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/build_fastest.py). 

This split architecture means the engine is not a single monolith, but a coordinated sequence of graphs trading memory bandwidth for latency limits.
