---
title: "没有 vLLM 时的 paged-KV、U8 与批处理"
description: "你有了模型的图,现在要把它们服务起来——长上下文、并发、在一块核显的内存预算里,且没有 vLLM 的任何机械。四个会彼此叠加的决策:用 paged-KV 取代 fixed bucket、一个 U8 缓存、全上下文生成,以及把在线批处理放进调度层、让同一套 IR 服务所有人。"
date: 2026-06-21
order: 3
series: "openvino-tts"
reading: "9 分钟"
tags: ["llm", "inference", "openvino", "kv-cache", "batching"]
---

[上一篇](/zh/blog/how-qwen3-tts-makes-a-frame/)把模型切成了图。有了图也许是一半的活;另一半是把它们
*服务*起来——长上下文、一次好几个请求、在一块 Intel 核显的内存预算里,且没有你平时倚仗的那套 CUDA
服务栈。这里的"vLLM"不是一句 import,而是你得自己做的四个决策——而它们之所以奏效,是因为它们会
**彼此叠加**。

## 决策一 —— paged-KV,而非 fixed cache bucket

talker 需要的缓存随上下文增长,而 OpenVINO 想要静态形状。最显然的路是 **fixed bucket**:把模型在一组
固定缓存长度上导出(比如 96 个 bucket),运行时挑能装下的最小那个。它能用,但很难受:你要编译并打包
许多图变体,每个请求往上取整到一个 bucket 边界都在浪费内存,而且你继承了一个上下文长度的硬上限。

运行时改用 **OpenVINO paged-KV**——一个分块(block)的分页注意力缓存,于是生成持续到 EOS 或配置的
上下文/内存预算为止,**完全没有 fixed bucket**。trade-off 很诚实:分页注意力要接的东西(block table、
分配、一个 no-cache seed 图)比一次 bucket 查表多。换回来的是没有 bucket 组合爆炸、没有长度天花板,
以及——用 README 自己的话——*降低的编译与打包复杂度*。一张 seed 图,而不是一抽屉的 bucket 变体。

## 决策二 —— 一个 U8 KV 缓存

长上下文意味着,炸掉你内存预算的是 KV 缓存,而不是权重。所以缓存的默认存储精度是 **U8——8 比特**。
把缓存量化,是那个让长的、全上下文生成塞进核显内存信封的唯一关键。代价是量化的老一套——一点点经过
验证的质量成本,换一大块内存收益——而且它是生产默认:`kv_cache_profile=auto` 当前正解析成这个,U8
paged-KV。

## 决策三 —— 全上下文,不切段

有了 paged-KV 和 U8 让长上下文*负担得起*,你就能做那个对质量真正要紧的选择:**别把文本切碎。**
`full_context_text=true`——模型在整段输入上做注意力,而不是一段一段地生成。切块的文本会在缝处撕裂
韵律和连贯;全上下文让长段落的表达保持自然。

这正是决策一和二就位后的回报。你*能*保住全上下文,只因为 paged-KV 拿掉了长度天花板、U8 拿掉了内存
墙。这些决策不是一张清单——它们是一条链,而全上下文生成,就挂在这条链的末端。

## 决策四 —— 批处理在调度器里,而非在某个模型文件里

现在说并发。CUDA 的答案是连续批处理,vLLM 直接递给你。在 OpenVINO 上你得自己搭——但*在哪里*搭才是
真正的决策。批处理逻辑活在**调度器/后端层**,而不是烤进一个单独的批处理 IR
(`online_batching=on`、`online_batch_scheduler=layered`)。

后果正是全部要点:**单用户和多用户请求复用同一套 IR。** 你不导出、也不在单流模型旁边再发一个"批处理
模型";你发一套图,由一个分层调度器把请求准入、并把它们的解码步一起推进。trade-off 是你自己写那个
准入与解码步调度器——正是 vLLM 白送给 CUDA 的那部分——但你保住了一个模型产物,并在它之上获得灵活的
并发。

<figure class="figure">
<svg viewBox="0 0 620 188" role="img" aria-label="Layered scheduler over one shared IR set">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.sc{fill:#eef6f4;stroke:#0f766e;stroke-width:1.6}.ir{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="pa" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="16" y="26" width="96" height="24" rx="6"/><text x="30" y="43" class="s">请求 A</text>
  <rect class="n" x="16" y="80" width="96" height="24" rx="6"/><text x="30" y="97" class="s">请求 B</text>
  <rect class="n" x="16" y="134" width="96" height="24" rx="6"/><text x="30" y="151" class="s">请求 C</text>
  <rect class="sc" x="170" y="58" width="180" height="72" rx="9"/><text x="186" y="82" class="tb">分层调度器</text><text x="186" y="102" class="s">准入 + 推进解码步</text><text x="186" y="118" class="s">在线批处理</text>
  <rect class="ir" x="410" y="58" width="190" height="72" rx="9"/><text x="426" y="82" class="tb">一套 IR</text><text x="426" y="102" class="s">talker paged-KV(U8)</text><text x="426" y="118" class="s">+ subcode + decoder</text>
  <path class="a" d="M112 38 Q150 50 170 74" marker-end="url(#pa)"/>
  <path class="a" d="M112 92 H170" marker-end="url(#pa)"/>
  <path class="a" d="M112 146 Q150 134 170 114" marker-end="url(#pa)"/>
  <path class="a" d="M350 94 H410" marker-end="url(#pa)"/>
</svg>
<figcaption>并发活在调度器里,于是同一套共享 IR 既服务单用户、也服务一批用户。没有单独的批处理模型要
导出、打包、保持同步。</figcaption>
</figure>

## 配角:INT8 权重、预热与 NPU

还有两个细节把它收圆。生产的 talker seed 图是权重压缩的——`int8_sym_batch_fused_gqa`,即 **INT8
对称**权重加**融合的 grouped-query attention**(压缩预设是 `fastest` 和 `minimal-online-gqa`)。又因为
OpenVINO 在首次使用时才编译图,运行时带了一个 **cache-warmup** 步骤,提前触发编译,好让你*用户的*第
一个请求不吃这份编译开销。在 Windows 上甚至有异构放置——`--npu-offload decoder` 把流式 decoder 预热到
一块 Intel **NPU**,而 talker 留在 GPU 上。`/health` 端点把这一切都暴露出来:KV 精度、预分配块数、最大
token 预算、批处理状态、设备——给一个你亲手搭的服务循环的可观测性。

## 教训

在 OpenVINO 上,"vLLM"不是你 import 的库——它是一组决策:用分页缓存而非 bucket、用量化缓存来塞进
预算、因为前两者让你负担得起而保住全上下文、把连续批处理推进调度器好让一套图服务所有人。亲手重建它
们,逼你把每一个都看成一个*带 trade-off 的决策*而非默认——并让你注意到它们叠成一条链,每一个都是让
下一个负担得起的前提。这正是 `pip install vllm` 给不了你的理解,也是这个项目值得做的真正原因。
