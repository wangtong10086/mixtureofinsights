---
title: "Qwen3-TTS 怎么造出一帧声音"
description: "一个 TTS 模型不是一张图,而是一条由计算形状迥异的图组成的小流水线。把 Qwen3-TTS 搬上 OpenVINO 的关键设计动作,是沿着缝去切:一张 talker 图做长上下文注意力,一张 cached subcode 图补齐多码本帧的其余部分,再加一个分块流式 decoder。"
date: 2026-06-20
order: 2
series: "openvino-tts"
reading: "9 分钟"
tags: ["llm", "tts", "openvino", "codec", "architecture"]
---

[概览](/zh/blog/when-the-gpu-isnt-an-nvidia/)说过,一个 12Hz 的自回归 TTS 是一条推理*循环*,不是
单次前向。这一篇把循环打开。大多数人当成已解决黑盒的东西——"文本进去,音频出来"——其实是一条由计算
形状非常不同的图组成的小流水线,而把它搬上 OpenVINO 的全部门道,就是沿着这些形状发生变化的缝去切。

## 一帧是一摞,不是一个 token

从模型吐出什么开始。在每个 **12Hz** 步,它产出一个音频*帧*,而一帧不是单个 token——它是一个**多码本
codec 帧**:一小摞码本 token,合起来描述一个声音切片。另有一个 codec 把这一串帧变成波形。所以"生成
语音"意思是:以每秒 12 帧的节奏,产出一摞码本 token,再把帧解码成 PCM。

运行时走的完整路径:

```text
请求
  → prompt builder
  → text_embedding / codec_embedding
  → 原生 codec 生成
        → paged-KV talker seed 图        (长上下文 AR 注意力)
        → subcode_greedy_cached          (补齐帧的其余部分)
  → speech_decoder_stream                (分块 → PCM)
  → PCM / WAV
```

## 要紧的那条缝:talker 对 subcode

生成一个多码本帧,把两种完全不同的计算模式摆到了一起,而核心设计决策就是**不**把它们放进一张图:

<figure class="figure">
<svg viewBox="0 0 640 220" role="img" aria-label="Per-frame loop: talker graph then cached subcode graph then streaming decoder">
  <style>.k{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.c{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="ha" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="k" x="16" y="40" width="200" height="80" rx="9"/>
  <text x="32" y="62" class="tb">talker seed(paged-KV)</text>
  <text x="32" y="82" class="s">长上下文 AR 注意力</text>
  <text x="32" y="100" class="s">→ 第一码本 + 隐状态</text>
  <rect class="c" x="252" y="40" width="200" height="80" rx="9"/>
  <text x="268" y="62" class="tb">subcode_greedy_cached</text>
  <text x="268" y="82" class="s">补齐其余码本</text>
  <text x="268" y="100" class="s">→ 下一帧 embedding</text>
  <rect class="n" x="488" y="40" width="136" height="80" rx="9"/>
  <text x="504" y="62" class="tb">decoder_stream</text>
  <text x="504" y="82" class="s">分块 + 左上下文</text>
  <text x="504" y="100" class="s">→ PCM</text>
  <path class="a" d="M216 80 H252" marker-end="url(#ha)"/>
  <path class="a" d="M452 80 H488" marker-end="url(#ha)"/>
  <path class="a" d="M352 120 V160 H116 V120" marker-end="url(#ha)"/>
  <text x="210" y="178" class="s">下一帧 embedding 喂回 talker —— 每个 12Hz 帧一个 AR 步</text>
</svg>
<figcaption>talker 每帧做一次昂贵的长上下文注意力,吐出第一码本加一个隐状态。cached subcode 图贪心地
补齐这一帧的其余部分。流式 decoder 把帧分块变成 PCM。</figcaption>
</figure>

**talker 图**做昂贵的部分:在迄今为止的整条序列上做长上下文自回归注意力,为这一帧产出**第一码本和
一个隐状态**。这是需要 KV 缓存的部分,因为它要回看之前的一切——每帧一个真正的 AR 步。

**`subcode_greedy_cached` 图**做便宜但量多的部分:以那个隐状态为条件,**补齐同一帧的其余码本**,并返回
下一帧 embedding。这是帧内的、贪心的、且*被缓存*的——一个跨码本的小内循环,根本不需要那套长上下文
注意力机器。

为什么在这儿切?因为两者在硬件层面毫无共同点。talker 是你*每帧跑一次*的长上下文注意力;subcode 补齐
是你*每帧跑好几次*、跨码本的小贪心步。把它们融进一张图,你要么在每个子码本步都拖着整套注意力装置,
要么把两种相反的计算模式打成一个 OpenVINO 和 GPU 都编译不好的结。沿缝切开,每张图就成了你能各自按
*自己的*形状去导出、编译、优化的东西——而 subcode 图得以是一个被缓存的小循环,而非一次完整前向。

## decoder 流式吐,而且第一块很特殊

最后一级 `speech_decoder_stream` 把 codec 帧变成 PCM——而且它**分块**做,好让音频在整句说完前就开始
流出来。导出的 decoder 把自己的调度写在名字里:`c25_t12` 和 `c25_t24` 保留 **25 帧左上下文**,分别吐
12 或 24 个 token 的块;`c0_t8` 是**第一块**——更小、无左上下文——专门调过,让*第一段音频*尽早离场。
(在 exporter 里它们是 `--stream-decoder-chunks 12,24`、`--stream-decoder-first-chunks 8,12`、
`--stream-decoder-left-context 25` 这几个旋钮。)

这就是用三个数表达的延迟设计:一个小而便宜的第一块,把首音延迟压到最低;然后是更大的稳态块,带足够的
左上下文,让音频在块边界处保持连贯。流式不是事后糊上去的包装——它是 decoder 被*导出成*拥有的性质。

## 教训

一个 TTS 模型不是"一个模型"。它是一条图的流水线——embedding、一个长上下文 talker、一个 cached subcode
补齐器、一个分块 decoder——每一个有不同的计算形状。工程上的胜利,是**找到形状变化的缝、在那儿切**,
好让每一块都编译成硬件真正喜欢的东西。这种切缝让模型变快;它*也*让模型可移植,因为每个干净的块都是
OpenVINO 接得住的东西。这就引出下一个问题:你有了图——现在你得把它们服务起来,并发、在一块核显的内存
预算里、且没有 vLLM 的任何机械。这就是
[没有 vLLM 时的 paged-KV、U8 与批处理](/zh/blog/paged-kv-batching-without-vllm/)。
