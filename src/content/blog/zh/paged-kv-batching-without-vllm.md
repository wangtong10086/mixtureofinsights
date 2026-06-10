---
title: "没有 vLLM，也要管好 KV 和批处理"
description: "模型图只是开始。长上下文、并发和核显内存预算一起压过来时，paged-KV、U8 缓存和在线批处理才真正决定它能不能服务。"
date: 2026-06-10
order: 3
series: "openvino-tts"
reading: "14 分钟"
tags: ["llm", "inference", "openvino", "kv-cache", "batching"]
---

[上一篇](/zh/blog/how-qwen3-tts-makes-a-frame/)把模型切成了图。那一刻很容易产生错觉：图有了，服务也就
差不多了。真正把 sidecar 跑起来时，问题才开始挤到一起：长上下文会吃 KV，并发会放大 KV，核显内存又
不宽裕，而你手边没有 vLLM。

于是“能跑”变成了四个互相牵连的问题：缓存怎样增长，缓存用什么精度，长文本要不要切段，并发请求该在哪里
批起来。`OnlineBatchScheduler`、`SDPAToPagedAttention`、`--kv-cache-profile` 和 `/health` 都是这些
问题逼出来的，不是为了把架构图画得好看。

## 决策一 —— paged-KV,而非 fixed cache bucket

talker 需要的缓存随上下文增长,而 OpenVINO 想要静态形状。最显然的路是 **fixed bucket**:把模型在一组
固定缓存长度上导出(比如 96 个 bucket),运行时挑能装下的最小那个。它能用,但很难受:你要编译并打包
许多图变体,每个请求往上取整到一个 bucket 边界都在浪费内存,而且你继承了一个上下文长度的硬上限。

运行时改用 **OpenVINO paged-KV**——一个分块(block)的分页注意力缓存,于是生成持续到 EOS 或配置的
上下文/内存预算为止,**完全没有 fixed bucket**。关键是,这里的 paged-KV 并不是手写 CUDA,而是一个
OpenVINO 图 pass。原生后端读入导出的 *seed* 图(一个没有接缓存的 talker),对它跑 OpenVINO 自带的
`SDPAToPagedAttention`,在编译前把每一处 scaled-dot-product-attention 改写成 paged-attention 算子——
见 `native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp`:

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

trade-off 很诚实:分页注意力要接的东西(block table、分配、那张 no-cache seed 图)比一次 bucket 查表多。
换回来的是没有 bucket 组合爆炸、没有长度天花板,以及——用 README 自己的话——*降低的编译与打包复杂度*。
一张 seed 图(`talker_stateful_batch_gqa`),而不是一抽屉的 bucket 变体。

更深的赢面在内存,值得把账算一遍。**bucket 把每个请求往上取整到一个 bucket 边界**——经典的内部碎片。
若一个请求需要 $\ell$ 个 token 的缓存、能装下的最小 bucket 是 $L$,你就浪费了 $L-\ell$ 个 token 的缓存。
bucket 若按几何级数排布,过度分配可达到 bucket 比率那么多:把 $\ell=1{,}100$ 取整到 $2{,}048$ 的
bucket,这个请求的缓存有 **46%** 是死重。**分页**则按 $B$ 个 token 的小固定块分配(PagedAttention 的
设计;vLLM 取 $B=16$,这里的在线批处理路径也是——`OnlineBatchConfig` 里的 `block_size: int = 16`),
于是唯一的浪费是最后那个不满块的零头:

$$
\text{waste}_{\text{paged}} \;=\; B\left\lceil \tfrac{\ell}{B} \right\rceil - \ell \;<\; B,
\qquad\text{对比}\qquad
\text{waste}_{\text{bucket}} \;=\; L - \ell,
$$

也就是说,无论序列多长,*至多丢一个块*(不到 16 个 token),而非可能整整一个 bucket。正是这条有界碎片的
性质,让 paged-KV 能把许多并发序列塞进同一个核显内存池——本会随序列长度增长的碎片,坍缩成一个每序列的
常数。(PagedAttention 报告 KV 浪费近乎为零,对比预分配常见的 60–80%;机制正是这个。)

## 决策二 —— 一个 U8 KV 缓存

长上下文意味着,炸掉你内存预算的是 KV 缓存,而不是权重——公式告诉你为什么。对一个 transformer,KV 缓存
为每层、每个注意力头、每个 token、每个 batch 中的序列各存一个 key 和一个 value 向量:

$$
\text{KV bytes} \;=\; 2 \cdot L \cdot H \cdot d_{\text{head}} \cdot s \cdot B \cdot \text{bytes}_{\text{dtype}},
$$

其中开头的 $2$ 是 key 与 value,$L$ 是层数,$H$ 是 **KV 头数**(注意是 KV 头,不是 query 头——GQA 让
多个 query 头共享一组 KV,正是在这里把 $H$ 砍小),$d_{\text{head}}$ 是每头维度,$s$ 是序列长度,$B$
是 batch。两点值得注意。其一,它对 $s$ 和 $B$ **都是线性的**——长上下文*和*并发推的是同一个数,这里的
张力全在这一点。其二,运行时唯一能动、又无需重训的项,是 $\text{bytes}_{\text{dtype}}$。

用整数把它落地。取一个中等规模的 talker——比如 $L=28$ 层、$H=8$ 个 KV 头(GQA 已经在这儿把 $H$ 砍
小了——在线路径选的正是 GQA seed 图,调度器据此设 `heads = 8 if paged_kv_seed_uses_gqa(seed_key) else 16`)、
$d_{\text{head}}=128$(`OnlineBatchConfig` 与原生后端里 `head_dim` 的真实默认值)。每 token 每序列就是 $2 \cdot 28 \cdot 8 \cdot 128 = 57{,}344$ 个元素。
在 **fp16**($\text{bytes}=2$)下,约 $112\,\text{KB}$ 每 token;一段 $8{,}000$ token 的全上下文,
*单条*流就约 $0.9\,\text{GB}$。撑住四条并发流,光缓存就约 $3.6\,\text{GB}$——在一块和系统 RAM 共享的
核显上,这还没算权重,预算就没了。

把缓存切到 **U8(8 比特)**、$\text{bytes}=1$:上面每个数都**减半**。同一条 8k token 的流从 $0.9$ 降到
$0.45\,\text{GB}$;四条流从 $3.6$ 降到 $1.8\,\text{GB}$。这是那个让长的、全上下文生成塞进核显内存信封的
唯一关键,而且它和[第一篇](/zh/blog/when-the-gpu-isnt-an-nvidia/)的带宽论证复利叠加——缓存字节减半,也
就是每个带宽受限的解码步要读的缓存*流量*减半。代价是量化的老一套:对 K、V 做 per-token、per-channel
量化,引入一个有界误差 $|x - \hat{x}| \le \tfrac{1}{2}\,\text{scale}$,一点点经过验证的质量成本,换 2 倍
的内存与带宽收益。它是生产默认,而 CLI 标志把这一点说得很白——`qwen3_tts_ov/cli.py` 里的
`--kv-cache-profile`:

```python
parser.add_argument(
    "--kv-cache-profile",
    default="auto",
    choices=KV_CACHE_PROFILE_CHOICES,
    help="Paged-KV cache memory profile. Default auto uses the fastest default, currently u8.",
)
```

调度器配置也一致:`OnlineBatchConfig` 携带 `kv_precision: str = "u8"`,直接以 `kv_cache_precision`
传给原生 runner。于是 `--kv-cache-profile auto` 正解析成这个——U8 paged-KV。

## 决策三 —— 全上下文,不切段

有了 paged-KV 和 U8 让长上下文*负担得起*,你就能做那个对质量真正要紧的选择:**别把文本切碎。**
请求携带一个 `full_context_text` 布尔(长文本全 AR 路径),而生产 sidecar 把切段当成仅调试的兜底——
API 暴露了 `allow_auto_segment_text` / `auto_segment_text`,但文档写明「Debug fallback only;
production long text is full-AR」。当 `full_context_text=true`,模型在整段输入上做注意力,而不是一段
一段地生成。切块的文本会在缝处撕裂韵律和连贯;全上下文让长段落的表达保持自然。

这正是决策一和二就位后的回报。你*能*保住全上下文,只因为 paged-KV 拿掉了长度天花板、U8 拿掉了内存
墙。这些决策不是一张清单——它们是一条链,而全上下文生成,就挂在这条链的末端。

## 决策四 —— 批处理在调度器里,而非在某个模型文件里

现在说并发。CUDA 的答案是连续批处理,vLLM 直接递给你。在 OpenVINO 上你得自己搭——但*在哪里*搭才是
真正的决策。批处理逻辑活在**调度器/后端层**,而不是烤进一个单独的批处理 IR。sidecar 默认就把它打开;
两个标志是 `qwen3_tts_ov/cli.py` 里的 `--online-batching on` 和 `--online-batch-scheduler layered`:

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

那个 `scheduler` 只有这一个选项是故意的——Python 的 `OnlineBatchScheduler` 拒绝其他任何值
(`if scheduler != "layered": raise ValueError`),而底层原生连续批处理策略是 `layered_vllm`。

后果正是全部要点:**单用户和多用户请求复用同一套 IR。** 你不导出、也不在单流模型旁边再发一个「批处理
模型」;你发一套图,由一个分层调度器把请求准入、并把它们的解码步一起推进。trade-off 是你自己写那个
准入与解码步调度器——正是 vLLM 白送给 CUDA 的那部分——但你保住了一个模型产物,并在它之上获得灵活的
并发。

为什么要批?回到带宽论证。单流的解码步读整个模型的权重,只为吐*一个* token——算术强度约 1 FLOP/字节,
深陷内存受限区,计算单元大多空转。把 $B$ 条流批进一步,权重只读**一次**、却复用在 $B$ 个 token 上:
权重流量被摊薄,算术强度抬升约 $B$ 倍,吞吐近乎线性攀升,直到要么 (a) 你打满计算、撞上 roofline 脊点,
要么 (b) $B$ 条流的 KV 缓存耗尽内存——决策二里的 $s \cdot B$ 项。后一个天花板,正是 paged-KV 和 U8 抬
高的那个。

**连续(在线)批处理**是让这件事成真的调度纪律。朴素的*静态*批处理等着把一批凑满,再让所有序列一起跑到
完成——于是一个短请求卡在一个长请求后面,得等长的跑完,而半空的批又浪费设备。连续批处理以*单个解码步*
的粒度调度:它在下一步就把新请求并入在飞的批,并立刻驱逐已完成的,始终把批保持得和内存预算允许的一样
满。赢的是占用率——设备守在它高效的批大小附近,而不是排空再重灌——这正是 vLLM 围绕之构建的设计,也是
分层调度器在这里重做的那个。

这套纪律在 `OnlineBatchScheduler._loop` 里看得一清二楚:每一轮都把新到的请求并入在飞集合、取消已死的、
跑*一*个批处理解码步,并立刻驱逐已完成的序列——准入与驱逐都在单步粒度上,而非整段话:

```python
result = runner.online_batch_step(
    max_decode_batch=self.config.max_batch_size,
    max_events=self.config.max_events,
    num_code_groups=self.runtime.num_code_groups,
)
# ... 每行:kind 1/3 -> 吐一帧;kind 2/3 -> 完成,驱逐
if kind in {2, 3}:
    request.output.put(None)
    with self._lock:
        self._requests.pop(int(native_id), None)
```

prompt 构建与语音解码仍是*每请求*的;只有 codec 自回归步被批处理——这正是 VoiceDesign、CustomVoice、
VoiceClone 一旦产出 prompt embedding 就能共享这一条路径的原因。

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

还有两个细节把它收圆。生产的 talker seed 图是权重压缩的——调度器默认的 `graph_variant` 是
`int8_sym_batch_fused_gqa`,即 **INT8 对称**权重加**融合的 grouped-query attention**。这个变体由
`scripts/compress_openvino_weights.py` 产出;相关预设是 `minimal-online-gqa`,它正好设上这个变体,并
*只*压缩那张低内存的生产 batch seed 图:

```python
elif args.preset == "minimal-online-gqa":
    if args.variant == parser.get_default("variant"):
        args.variant = "int8_sym_batch_fused_gqa"
    if args.mode == parser.get_default("mode"):
        args.mode = "int8_sym"
    # ... include_paged_kv_seed = True
    args.paged_kv_seed_keys = "talker_stateful_batch_gqa"
```

(`fastest` 预设是更宽的生产压缩;`minimal-online-gqa` 是精简的在线批处理那一份)。又因为 OpenVINO 在
首次使用时才编译图,运行时带了一个 **cache-warmup** 步骤,提前触发编译,好让你*用户的*第一个请求不吃
这份编译开销。还有异构放置——`--npu-offload decoder` 是一个真实选项
(`NPU_OFFLOAD_CHOICES = ("off", "auto", "decoder", "audio", "all", "require")`),它把
`decoder_device` 设成 `"NPU"`,把流式 decoder 预热到一块 Intel **NPU**,而 talker 留在 GPU 上。
`/health` 端点把这一切都暴露出来——`kv_cache_profile`、`native_paged_kv_precision`、
`native_paged_kv_block_size`、`kv_cache_preallocation`、`online_batching` 块、以及设备映射——给一个
你亲手搭的服务循环的可观测性。

## 教训

在 OpenVINO 上,「vLLM」不是你 import 的库——它是一组决策:用分页缓存而非 bucket、用量化缓存来塞进
预算、因为前两者让你负担得起而保住全上下文、把连续批处理推进调度器好让一套图服务所有人。亲手重建它
们,逼你把每一个都看成一个*带 trade-off 的决策*而非默认——并让你注意到它们叠成一条链,每一个都是让
下一个负担得起的前提。这正是 `pip install vllm` 给不了你的理解,也是这个项目值得做的真正原因。

## 延伸阅读

- [PagedAttention / vLLM](https://arxiv.org/abs/2309.06180) —— 分页 KV 的设计与碎片数字;§3–4 是这里重建的 block-table 与连续批处理机制。
- [Orca: a distributed serving system for transformers](https://www.usenix.org/conference/osdi22/presentation/yu) —— 迭代级(连续)批处理,让在线批处理回本的那个调度思想。
- [OpenVINO:优化推理与 KV 缓存](https://docs.openvino.ai/) —— 设备插件、权重压缩(INT8),以及预热步骤抢先做掉的那个模型缓存。
- [LLM.int8() / 权重量化](https://arxiv.org/abs/2208.07339) —— INT8 权重和 U8 缓存背后的精度-质量权衡。
