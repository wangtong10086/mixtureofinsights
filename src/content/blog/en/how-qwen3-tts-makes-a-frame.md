---
title: "How Qwen3-TTS makes a frame of sound"
description: "A TTS model isn't one graph — it's a small pipeline of graphs with wildly different compute shapes. The key design move in porting Qwen3-TTS to OpenVINO is cutting it at the seams: a talker graph for long-context attention, a cached subcode graph for the rest of each multi-codebook frame, and a chunked streaming decoder."
date: 2026-06-20
order: 2
series: "openvino-tts"
reading: "9 min read"
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

**The `subcode_greedy_cached` graph** does the cheap-but-numerous part: conditioned on that hidden
state, it **fills the remaining codebooks** of the same frame and returns the next frame embedding.
This is intra-frame, greedy, and *cached* — a tiny inner loop across codebooks that does not need
the long-context attention machinery at all.

Why cut here? Because the two have nothing in common at the hardware level. The talker is
long-context attention you run *once per frame*; the subcode fill is a small greedy step you run
*several times per frame*, across codebooks. Fuse them into one graph and you either drag the
full attention apparatus through every sub-codebook step, or knot two opposite compute patterns
into a shape neither OpenVINO nor the GPU can compile well. Split at the seam, and each graph
becomes something you can export, compile, and optimize for its *own* shape — and the subcode
graph gets to be a cached mini-loop instead of a full forward.

## The decoder streams, and the first chunk is special

The last stage, `speech_decoder_stream`, turns codec frames into PCM — and it does it in
**chunks**, so audio starts flowing before the utterance is finished. The exported decoders carry
their schedule in their names: `c25_t12` and `c25_t24` keep **25 frames of left-context** and emit
chunks of 12 or 24 tokens; `c0_t8` is the **first** chunk — smaller, no left-context — tuned so the
*first audio* leaves as early as possible. (In the exporter these are the `--stream-decoder-chunks
12,24`, `--stream-decoder-first-chunks 8,12`, and `--stream-decoder-left-context 25` knobs.)

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
