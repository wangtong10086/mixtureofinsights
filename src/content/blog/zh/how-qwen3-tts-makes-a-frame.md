---
title: "Qwen3-TTS 怎么造出一帧声音"
description: "一个 TTS 模型不是一张图,而是一条由计算形状迥异的图组成的小流水线。把 Qwen3-TTS 搬上 OpenVINO 的关键设计动作,是沿着缝去切:一张 talker 图做长上下文注意力,一张 cached subcode 图补齐多码本帧的其余部分,再加一个分块流式 decoder。"
date: 2026-06-20
order: 2
series: "openvino-tts"
reading: "14 分钟"
tags: ["llm", "tts", "openvino", "codec", "architecture"]
---

[概览](/zh/blog/when-the-gpu-isnt-an-nvidia/)说过,一个 12Hz 的自回归 TTS 是一条推理*循环*,不是
单次前向。这一篇把循环打开。大多数人当成已解决黑盒的东西——「文本进去,音频出来」——其实是一条由计算
形状非常不同的图组成的小流水线,而把它搬上 OpenVINO 的全部门道,就是沿着这些形状发生变化的缝去切。

## 一帧是一摞,不是一个 token

从模型吐出什么开始。在每个 **12Hz** 步,它产出一个音频*帧*,而一帧不是单个 token——它是一个**多码本
codec 帧**:一小摞码本 token,合起来描述一个声音切片。另有一个 codec 把这一串帧变成波形。所以「生成
语音」意思是:以每秒 12 帧的节奏,产出一摞码本 token,再把帧解码成 PCM。

一帧之所以是*一摞*而不是单个 token,原因在 codec。像 SoundStream、EnCodec 这样的神经音频 codec,用
**残差矢量量化(residual vector quantization,RVQ)**量化每一帧:每个码本量化的是前面那些码本留下的
*残差*。把潜向量记作 $x$,设 $q_j$ 是码本 $j$ 选出的码字,那么码本 $i$ 量化的是

$$
r_i \;=\; x \;-\; \sum_{j<i} q_j,
$$

于是第一个码本($r_1 = x$)拿到整个向量、捕获粗结构,第二个补它漏掉的,第三个再补*那一层*,而重建就是
running sum $\hat{x} = \sum_{i} q_i$。$Q$ 个码本、每个 $V$ 项,一帧就携带 $Q \log_2 V$ 比特——而码本
天生就**按重要性排序**:第一个是承重的(丢了它整帧就听不懂了——你丢的是 $x$ 本身),后面的是精修(丢了
它们,残差只是停在更粗的层级,音频变毛糙)。这个排序不是脚注。它正是模型可以把昂贵机器花在*第一个*码本、
而把其余交给一个便宜、被缓存的步骤的架构理由——这正是本篇要讲的那条缝。

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
一个隐状态**。这是需要 KV 缓存的部分,因为它要回看之前的一切——每帧一个真正的 AR 步。在 exporter 里这
是 *seed* 图;manifest 把它键为 `talker_stateful_batch_gqa`(存为 `talker_stateful_batch_sdpa_paged_gqa_seed.xml`),
它是一个把 KV 缓存参数留作动态的 talker,好让原生后端能把它们改写成分页注意力:

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

其中 `kv_heads = config.num_key_value_heads if gqa_cache else config.num_attention_heads`——也就是
GQA seed 导出的是*分组后*(更少)的 KV 头,正是第三篇缓存账所依赖的那一缩。

**`subcode_greedy_cached` 图**做便宜但量多的部分:以那个隐状态为条件,**补齐同一帧的其余码本**,并返回
下一帧 embedding。它是从 talker 的 `code_predictor`(它自己的小 transformer 加上每个码本头一个 `lm_head`)
单独导出的 wrapper,而非完整的 talker——所以它不带任何长上下文注意力机器。manifest 把它直白地键为
`"subcode_greedy_cached": "subcode_greedy_cached.xml"`。这是帧内的、贪心的、且*被缓存*的——一个跨码本的
小内循环。

为什么在这儿切?因为两者在硬件层面毫无共同点——而计算形状把这一点定量地说清楚了。设 $n$ 为迄今生成的
帧数,$Q$ 为每帧码本数,$d$ 为模型维度。

**talker 是 $O(n^2)$ 的那部分。** 它是全上下文自回归注意力:在第 $n$ 帧它要注意到前面所有 $n$ 个位置,
所以单帧的注意力工作量量级是 $O(n \cdot d)$,而生成整句的代价是 $\sum_{i=1}^{n} O(i \cdot d) =
O(n^2 d)$。这就是每个 transformer 都要付的那个二次项,也是为什么 talker 是唯一*需要* KV 缓存的一级:
缓存过去的 key/value,把每步的重算从 $O(n^2)$ 压回 $O(n)$。它**每帧跑一次**,且是唯一随段落变长而无界
增长的一级。

**subcode 补齐是便宜、有界的那部分。** 以 talker 的隐状态为条件,它只为*当前*帧吐出码本 $2 \dots Q$。
不回看历史、不做注意力——它是一个长度 $Q-1$、跑在固定大小隐状态上的短贪心循环,所以每帧代价是 $O(Q
\cdot d)$,**与 $n$ 无关**。这个 $Q-1$ 是字面意义上的:在 exporter 里 subcode wrapper 迭代
`subcode_groups = int(config.num_code_groups) - 1` 个头,而运行时处处把输出 reshape 成
`codes.reshape(-1, self.num_code_groups)`——每帧一行、$Q$ 个码本宽。每步都很小、且整个被缓存。talker 的
代价随上下文膨胀,subcode 补齐的代价却是平的。

**流式 decoder 又是另一种形状**——一个(基本是)卷积/transformer 的栈,吃进一*块*已完成的帧、吐出
PCM,带的是一个有界的左上下文窗口,而不是整段历史。

三级,三种计算形状:$O(n^2 d)$ 且 KV 缓存;$O(Q d)$ 且恒定;分块且上下文有界。把它们融进一张图,你要么
在那 $Q-1$ 个子码本步里拖着整套长上下文注意力装置——为本质上 $O(1)$(就上下文而言)的活付 $O(n)$ 的
注意力;要么把两种相反的计算模式打成一个 OpenVINO 图编译器和 GPU 都摆不好的结(一个要不断增长的 KV
缓存加 block table,另一个要一个根本没缓存的小静态循环)。沿缝切开,每张图就成了你能各自按*自己的*形状
去导出、编译、优化的东西——talker 拿到它的分页 KV 缓存,subcode 图得以是一个被缓存的小循环,而非一次
完整前向。这就是「沿缝切」的回报:缝,正是计算形状发生变化的地方。

## decoder 流式吐,而且第一块很特殊

最后一级 `speech_decoder_stream` 把 codec 帧变成 PCM——而且它**分块**做,好让音频在整句说完前就开始
流出来。导出的 decoder 把自己的调度写在*文件名*里,直接由那两个数拼出:

```python
path = out_dir / f"speech_decoder_stream_c{left_context_frames}_t{chunk_frames}.xml"
```

于是 `c25_t12` 和 `c25_t24` 保留 **25 帧左上下文**,分别吐 12 或 24 个 token 的块;`c0_t8` 是**第一块**
——更小、无左上下文——专门调过,让*第一段音频*尽早离场。生产构建路径(`qwen3_tts_ov/build_fastest.py`)
钉死的正是这些数:`--stream-decoder-chunks 12,24`、`--stream-decoder-first-chunks 8,12`、
`--stream-decoder-left-context 25`。

这就是用三个数表达的延迟设计:一个小而便宜的第一块,把首音延迟压到最低;然后是更大的稳态块,带足够的
左上下文,让音频在块边界处保持连贯。流式不是事后糊上去的包装——它是 decoder 被*导出成*拥有的性质。

## 教训

一个 TTS 模型不是「一个模型」。它是一条图的流水线——embedding、一个长上下文 talker、一个 cached subcode
补齐器、一个分块 decoder——每一个有不同的计算形状。工程上的胜利,是**找到形状变化的缝、在那儿切**,
好让每一块都编译成硬件真正喜欢的东西。这种切缝让模型变快;它*也*让模型可移植,因为每个干净的块都是
OpenVINO 接得住的东西。这就引出下一个问题:你有了图——现在你得把它们服务起来,并发、在一块核显的内存
预算里、且没有 vLLM 的任何机械。这就是
[没有 vLLM 时的 paged-KV、U8 与批处理](/zh/blog/paged-kv-batching-without-vllm/)。

## 延伸阅读

- [SoundStream](https://arxiv.org/abs/2107.03312) —— 提出残差矢量量化(RVQ)的神经 codec;多码本帧结构的源头。
- [EnCodec](https://arxiv.org/abs/2210.13438) —— Meta 基于 RVQ 的神经音频 codec;有序码本量化的清晰参考。
- [AudioLM](https://arxiv.org/abs/2209.03143) —— 先粗后细的声学 token 建模范式(一个承重的第一码本、其后是精修),正是 talker/subcode 拆分所映照的模式。
- [OpenVINO 模型转换与优化](https://docs.openvino.ai/2024/openvino-workflow/model-preparation.html) —— 导出的子图如何变成可按形状编译的 IR。
</content>
