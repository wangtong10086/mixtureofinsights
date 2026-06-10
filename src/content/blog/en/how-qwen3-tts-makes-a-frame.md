---
title: "How Qwen3-TTS makes a frame of sound"
description: "A TTS model isn't one graph — it's a small pipeline of graphs with wildly different compute shapes. The key design move in porting Qwen3-TTS to OpenVINO is cutting it at the seams: a talker graph for long-context attention, a cached subcode graph for the rest of each multi-codebook frame, and a chunked streaming decoder."
date: 2026-06-10
order: 2
series: "openvino-tts"
reading: "14 min read"
tags: ["llm", "tts", "openvino", "codec", "architecture"]
---

The [overview](/blog/when-the-gpu-isnt-an-nvidia/) said a 12 Hz autoregressive TTS is an inference
*loop*, not a single forward pass. This post opens that loop. The thing most people treat as a
solved black box — "text goes in, audio comes out" — is actually a small pipeline of graphs with
very different compute shapes, and the whole art of porting it to OpenVINO is cutting it at the
seams where those shapes change.

## A frame is a stack, not a token

Start with what the model emits. At each **12 Hz** step it produces one audio *frame*, and a frame
is not a single token — it's a **multi-codebook codec frame**: a small stack of codebook tokens
that together describe one slice of sound. A separate codec turns a stream of these frames into a
waveform. So "generate speech" means: at 12 frames per second, produce a stack of codebook tokens,
then decode frames to PCM.

The reason a frame is a *stack* and not a single token is the codec. Neural audio codecs like
SoundStream and EnCodec quantize each frame with **residual vector quantization (RVQ)**: each
codebook quantizes the *residual* the previous ones left behind. Write the latent vector as $x$ and
let $q_j$ be the codeword chosen from codebook $j$; then codebook $i$ quantizes

$$
r_i \;=\; x \;-\; \sum_{j<i} q_j,
$$

so the first codebook ($r_1 = x$) takes the whole vector and captures the coarse structure, the
second cleans up what it missed, the third cleans up *that*, and the reconstruction is the running
sum $\hat{x} = \sum_{i} q_i$. With $Q$ codebooks of $V$ entries each, one frame carries
$Q \log_2 V$ bits — and the codebooks are **ordered by importance** by construction: the first is
load-bearing (lose it and the frame is unintelligible — you've lost $x$ itself), the later ones are
refinements (lose them and the residual just stays coarser, so the audio gets grainier). That
ordering is not a footnote. It's the architectural reason the model can afford to spend its
expensive machinery on the *first* codebook and a cheap, cached step on the rest — which is exactly
the seam this post is about.

The full path the runtime walks:

```text
request
  → prompt builder
  → text_embedding / codec_embedding
  → native codec generation
        → paged-KV talker seed graph     (long-context AR attention)
        → subcode_greedy_cached          (fills the rest of the frame)
  → speech_decoder_stream                (chunked → PCM)
  → PCM / WAV
```

## The seam that matters: talker vs subcode

Generating a multi-codebook frame puts two completely different compute patterns next to each
other, and the central design decision is to **not** run them in one graph:

<figure class="figure">
<svg viewBox="0 0 640 220" role="img" aria-label="Per-frame loop: talker graph then cached subcode graph then streaming decoder">
  <style>.k{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="ha" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="k" x="16" y="40" width="200" height="80" rx="9"/>
  <text x="32" y="62" class="tb">talker seed (paged-KV)</text>
  <text x="32" y="82" class="s">long-context AR attention</text>
  <text x="32" y="100" class="s">→ 1st codebook + hidden state</text>
  <rect class="c" x="252" y="40" width="200" height="80" rx="9"/>
  <text x="268" y="62" class="tb">subcode_greedy_cached</text>
  <text x="268" y="82" class="s">fills remaining codebooks</text>
  <text x="268" y="100" class="s">→ next frame embedding</text>
  <rect class="n" x="488" y="40" width="136" height="80" rx="9"/>
  <text x="504" y="62" class="tb">decoder_stream</text>
  <text x="504" y="82" class="s">chunked + left-context</text>
  <text x="504" y="100" class="s">→ PCM</text>
  <path class="a" d="M216 80 H252" marker-end="url(#ha)"/>
  <path class="a" d="M452 80 H488" marker-end="url(#ha)"/>
  <path class="a" d="M352 120 V160 H116 V120" marker-end="url(#ha)"/>
  <text x="210" y="178" class="s">next frame embedding feeds the talker — one AR step per 12 Hz frame</text>
</svg>
<figcaption>The talker does the expensive long-context attention once per frame and emits the first
codebook plus a hidden state. The cached subcode graph fills the rest of that frame greedily. The
streaming decoder turns frames into PCM in chunks.</figcaption>
</figure>

**The talker graph** does the expensive part: long-context autoregressive attention over the whole
sequence so far, producing the **first codebook and a hidden state** for this frame. This is the
part that needs a KV cache, because it attends back over everything — one real AR step per frame.
In the exporter this is the *seed* graph; the manifest keys it as `talker_stateful_batch_gqa`
(saved as `talker_stateful_batch_sdpa_paged_gqa_seed.xml`), and it's a talker exported with the
KV-cache parameters left dynamic so the native backend can rewrite them into paged attention:

```python
input_shapes = [
    ov.PartialShape([-1, 1, config.hidden_size]),
    ov.PartialShape([3, -1, 1]),
    ov.PartialShape([-1, 1, 1, -1]),
    ov.PartialShape([-1]),
    *[ov.PartialShape([1, kv_heads, -1, head_dim]) for _ in range(config.num_hidden_layers * 2)],
]
ov_model = ov.convert_model(wrapper.eval(), example_input=example_inputs, input=input_shapes)
```

where `kv_heads = config.num_key_value_heads if gqa_cache else config.num_attention_heads` — i.e.
the GQA seed exports the *grouped* (fewer) KV heads, the shrink that post 3's cache math leans on.

**The `subcode_greedy_cached` graph** does the cheap-but-numerous part: conditioned on that hidden
state, it **fills the remaining codebooks** of the same frame and returns the next frame embedding.
It's a separate exported wrapper built from the talker's `code_predictor` (its own small transformer
plus an `lm_head` per codebook head), not the full talker — so it carries none of the long-context
attention machinery. The manifest keys it plainly as `"subcode_greedy_cached": "subcode_greedy_cached.xml"`.
This is intra-frame, greedy, and *cached* — a tiny inner loop across codebooks.

Why cut here? Because the two have nothing in common at the hardware level — and the compute shapes
say so quantitatively. Let $n$ be the number of frames generated so far, $Q$ the number of
codebooks per frame, $d$ the model dimension.

**The talker is the $O(n^2)$ part.** It's full-context autoregressive attention: at frame $n$ it
attends over all $n$ prior positions, so the work for a single frame scales like $O(n \cdot d)$ to
attend, and the cost of generating the whole utterance is $\sum_{i=1}^{n} O(i \cdot d) = O(n^2 d)$.
This is the quadratic that every transformer pays, and it's why the talker is the one stage that
*needs* a KV cache: caching past keys and values turns each step's recompute from $O(n^2)$ back
into $O(n)$. It runs **once per frame**, and it's the stage whose cost grows without bound as the
passage gets longer.

**The subcode fill is the cheap, bounded part.** Conditioned on the talker's hidden state, it emits
codebooks $2 \dots Q$ for the *current* frame only. There's no attention back over history — it's a
short greedy loop of length $Q-1$ over a fixed-size hidden state, so its cost per frame is $O(Q
\cdot d)$, **constant in $n$**. That $Q-1$ is literal: in the exporter the subcode wrapper iterates
`subcode_groups = int(config.num_code_groups) - 1` heads, and the runtime everywhere reshapes the
output as `codes.reshape(-1, self.num_code_groups)` — one row per frame, $Q$ codebooks wide. Each
step is tiny and the whole thing is cached. Where the talker's cost balloons with context, the
subcode fill's cost is flat.

**The streaming decoder is different again** — a (mostly) convolutional/transformer stack that
consumes a *chunk* of finished frames and emits PCM, with a bounded left-context window rather than
the whole history.

Three stages, three compute shapes: $O(n^2 d)$ and KV-cached; $O(Q d)$ and constant; chunked with
bounded context. Fuse them into one graph and you'd either drag the full long-context attention
apparatus through every one of the $Q-1$ sub-codebook steps — paying $O(n)$ attention for work
that's intrinsically $O(1)$ in context — or knot opposite compute patterns into a single shape that
neither OpenVINO's graph compiler nor the GPU can lay out well (one wants a growing KV cache and a
block table; the other wants a tiny static loop with no cache at all). Split at the seam, and each
graph becomes something you can export, compile, and optimize for its *own* shape — the talker gets
its paged-KV cache, and the subcode graph gets to be a cached mini-loop instead of a full forward.
That's the payoff of cutting "at the seams": the seams are exactly where the compute shape changes.

## The decoder streams, and the first chunk is special

The last stage, `speech_decoder_stream`, turns codec frames into PCM — and it does it in
**chunks**, so audio starts flowing before the utterance is finished. The exported decoders carry
their schedule in their *filenames*, built straight from the two numbers:

```python
path = out_dir / f"speech_decoder_stream_c{left_context_frames}_t{chunk_frames}.xml"
```

So `c25_t12` and `c25_t24` keep **25 frames of left-context** and emit chunks of 12 or 24 tokens;
`c0_t8` is the **first** chunk — smaller, no left-context — tuned so the *first audio* leaves as
early as possible. The production build path (`qwen3_tts_ov/build_fastest.py`) pins exactly these
numbers: `--stream-decoder-chunks 12,24`, `--stream-decoder-first-chunks 8,12`, and
`--stream-decoder-left-context 25`.

That's the latency design in three numbers: a small, cheap first chunk to minimize time-to-first-
audio, then larger steady-state chunks with enough left-context to keep the audio coherent across
chunk boundaries. Streaming isn't a wrapper bolted on top — it's a property the decoder was
*exported* to have.

## The lesson

A TTS model is not "one model." It's a pipeline of graphs — embeddings, a long-context talker, a
cached subcode filler, a chunked decoder — each with a different compute shape. The engineering win
is **finding the seams where the shape changes and cutting there**, so every piece compiles to
something the hardware actually likes. That seam-cutting is what makes the model fast; it's *also*
what makes it portable, because each clean piece is something OpenVINO can take. Which is the next
problem: you have the graphs — now you have to serve them, concurrently, inside an iGPU's memory
budget, with none of vLLM's machinery. That's
[paged-KV, U8, and batching where vLLM isn't](/blog/paged-kv-batching-without-vllm/).

## Further reading

- [SoundStream](https://arxiv.org/abs/2107.03312) — the neural codec that introduced residual vector quantization (RVQ); the source of the multi-codebook frame structure.
- [EnCoder / EnCodec](https://arxiv.org/abs/2210.13438) — Meta's RVQ-based neural audio codec; a clear reference for ordered-codebook quantization.
- [AudioLM](https://arxiv.org/abs/2209.03143) — the coarse-then-fine acoustic-token modeling pattern (a load-bearing first codebook, then refinements) that the talker/subcode split mirrors.
- [OpenVINO model conversion & optimization](https://docs.openvino.ai/2024/openvino-workflow/model-preparation.html) — how exported subgraphs become IR you can compile per shape.
