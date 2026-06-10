---
title: "当 GPU 不是 N 卡"
description: "整个 LLM 技术栈都默认 CUDA。可你面前的 GPU,往往是一块 Intel 核显,或者一颗 CPU。要让一个真实、低延迟的自回归 TTS 在那儿流式跑起来,意味着把你平时 pip install 就有的那些东西——解码循环、KV 缓存、批处理调度器——在 OpenVINO 上亲手重建。"
date: 2026-06-17
order: 1
series: "openvino-tts"
reading: "14 分钟"
tags: ["llm", "inference", "openvino", "tts", "edge"]
---

LLM 世界里几乎一切,都悄悄默认了一块 N 卡。vLLM、各种 kernel、教程——CUDA 是我们呼吸的水。可真正
摆在用户面前的 GPU,同样常常是一块 **Intel 核显**、一块 Arc,或者干脆一颗 CPU。要让一个现代自回归
TTS 模型在那儿跑起来——快、流式、生产可用——是一种真正不同的工程,因为那套舒适的技术栈根本不在。
这正是 `qwen3-tts-openvino` 这个项目。

## CUDA 技术栈究竟替你做了什么

值得把「一旦离开 CUDA 你失去了什么」说清楚,因为「不就是换个后端」严重低估了它。现代服务栈是一堆
CUDA 专属的工程,每一块都在解一个真实瓶颈:

- **融合 kernel(fused kernel)。** FlashAttention 计算注意力时,从不在 HBM 里实体化那个 $n\times n$ 的
  分数矩阵——它在 SRAM 里分块计算,把一个 $O(n^2)$ 内存的操作变成 $O(n)$ 内存的。这是手写的 CUDA。离开
  CUDA,你退回到会实体化中间结果的通用注意力,把内存搬运的账全吃下。
- **分页注意力(PagedAttention)。** vLLM 的 KV 缓存像虚拟内存一样分页,于是缓存能增长而无需预留最坏
  情况、也不碎片化(见 [PagedAttention 论文](https://arxiv.org/abs/2309.06180))。那是一个读 block table
  的定制 CUDA kernel。
- **CUDA graph。** 自回归解码*每个 token* 都要发起几十个小 kernel。在每隔几毫秒一个 token 的节奏下,光
  kernel 发起开销就能成为主导。CUDA graph 把整条每步发起序列一次性捕获,作为单次提交回放,把这份开销
  抹掉。
- **连续批处理(continuous batching)。** vLLM 的调度器以单个解码步的粒度准入和驱逐请求,于是新到的
  请求能立刻并入在飞的批,而不必等当前那个跑完。
- **NCCL。** 多卡张量并行靠 NCCL 做 all-reduce 这类集合通信。离开 N 卡,连「把模型摊到多张卡上」这件
  底层的事,都没有那套久经打磨的原语。

这些都不是「锦上添花」。它们是「流畅流式」和「卡顿」之间的差别。在 OpenVINO 上,这些你*一个都不会*白得。

## 为什么难,而不只是「导出成 ONNX」

一个 12Hz 的自回归 TTS,不是你 trace 一次就完事的前馈分类器。要把它服务起来,你需要整条推理循环,
而在 OpenVINO 上,这条循环得你来搭:

- 它**自回归解码**——这一步喂下一步——所以是一条真实的循环,带一个 **KV 缓存**,而不是单次前向;
- 它末端是一个把 token 变成波形的**神经 codec**,就在热路径上;
- 而「好」意味着**流式**:第一段音频要尽快出来,不是一个批处理作业。

CUDA 用户的这一切,vLLM 和它的同伴们直接端上来。在 OpenVINO 上,你就是那个框架。

## 你实际要搭的东西

<figure class="figure">
<svg viewBox="0 0 660 176" role="img" aria-label="PyTorch to OpenVINO IR to runtime to streamed audio">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.r{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}.t{font:12px sans-serif;fill:#1c1b19}.tb{font:12.5px sans-serif;fill:#1c1b19;font-weight:700}.s{font:10px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.5;fill:none}</style>
  <defs><marker id="t1" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="14" y="66" width="96" height="44" rx="8"/><text x="28" y="84" class="t">PyTorch</text><text x="28" y="100" class="s">Qwen3-TTS</text>
  <rect class="n" x="146" y="66" width="96" height="44" rx="8"/><text x="160" y="84" class="t">导出</text><text x="160" y="100" class="s">→ OpenVINO IR</text>
  <rect class="r" x="278" y="36" width="220" height="104" rx="10"/>
  <text x="294" y="58" class="tb">OpenVINO 运行时</text>
  <text x="294" y="78" class="s">AR 解码循环 + 分页 KV(U8)</text>
  <text x="294" y="96" class="s">vLLM 式在线批处理</text>
  <text x="294" y="114" class="s">原生 C++ codec → PCM</text>
  <text x="294" y="132" class="s">设备:CPU · 核显 · Arc</text>
  <rect class="n" x="534" y="66" width="112" height="44" rx="8"/><text x="548" y="84" class="t">流式</text><text x="548" y="100" class="s">音频(WS PCM)</text>
  <path class="a" d="M110 88 H146" marker-end="url(#t1)"/>
  <path class="a" d="M242 88 H278" marker-end="url(#t1)"/>
  <path class="a" d="M498 88 H534" marker-end="url(#t1)"/>
</svg>
<figcaption>那个 rust 色方块里的一切,正是 CUDA 用户永远看不见的——因为 vLLM 早替他们做完了。在
OpenVINO 上,它就是这个项目本身。</figcaption>
</figure>

- **高保真导出。** PyTorch → OpenVINO IR,既要 AR transformer *也*要它的 codec,导出得让解码循环和
  缓存行为正确,而不只是单次前向能跑。
- **一个装得下的 KV 缓存。** 运行时默认用**分页 KV 注意力 + U8(8 比特)KV 缓存**——把缓存量化,正是
  让长的、全上下文生成塞进一块核显内存预算的关键。具体说,原生后端对一张导出的 no-cache *seed* 图跑
  OpenVINO 自带的 `SDPAToPagedAttention` 图 pass,然后 `specialize_kv_cache_parameters` 钉住 U8 元素
  类型、头数与块大小(`native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp`)。
- **一个 vLLM 式的在线批处理器——在 OpenVINO 上。** 一个负责请求准入和解码步的调度器,让并发请求高效
  共享设备。它是 `qwen3_tts_ov/online_batch.py` 里的 `OnlineBatchScheduler`——一个守护线程,其 `_loop`
  把到来的请求排干、跑一个批处理 `online_batch_step`、并在每一轮驱逐已完成的序列。这正是非 CUDA 没有
  现成货的部分;连续批处理的服务循环,你得自己搭。
- **要流式,别切段。** 生成是**全上下文自回归**的——文本*不*被切成块——但音频在 `fastest` 档下,通过
  WebSocket PCM 流式吐出。延迟是头等目标,不是事后补的。
- **一条原生 C++ codec 流水线**,把 token→波形那一步放在热路径上,而不是每一帧都付 Python 的账。
- **运维的现实。** 设备选择(CPU/GPU)、一个只慢一次的首次编译缓存,以及**按模式懒驻留**
  (`--runtime-residency lazy` 是默认;服务器会驱逐空闲的模式),让 VoiceDesign、CustomVoice、
  VoiceClone 不同时占着内存——三种能力,一个 sidecar。

## OpenVINO 给你什么,又不给你什么

OpenVINO 不是 CUDA 的克隆;它是一个图编译器加运行时。它*确实*给你的东西很实在:一套稳定的 IR、一个
会融合算子并为目标设备挑选 layout 的图编译器,以及一个能通过设备插件把那套 IR 跑在 CPU、核显、Arc 和
NPU 上的统一运行时。最后这一点正是它值得用的全部理由——它是通往*非 N 卡*加速器的唯一成熟路径。

具体说,你真正赖以生存的 API 面很小:一个 `ov.Core`、每张图一次 `core.compile_model(...)`,以及一个你
在循环里驱动的 `create_infer_request()`。运行时的 `compile_model` 辅助函数(`qwen3_tts_ov/runtime.py`)
正是设备处理所在——它设上推理精度提示,在设备是 GPU 时打开 `GPU_ENABLE_LARGE_ALLOCATIONS`,并在 GPU
编译失败时回退到 CPU:

```python
config = {"INFERENCE_PRECISION_HINT": precision_hint}
# ...
if "GPU" in device:
    config["GPU_ENABLE_LARGE_ALLOCATIONS"] = "YES"
try:
    return core.compile_model(str(model_path), device, config)
except Exception as first_error:
    # ... 不带 large allocations 重试,再可选回退到 CPU
    return core.compile_model(str(model_path), "CPU", fallback_config)
```

它不给你的,是服务层。没有内置的连续批处理调度器,没有现成可以 `pip install` 的分页 KV 注意力,也没
有给自回归循环白送的 CUDA graph 等价物。OpenVINO 编译并运行一张*图*;而把一张图变成低延迟流式服务的
一切——解码循环、缓存、批处理器——都是你的活。还有第二份税:OpenVINO 在首次使用时才惰性编译图(它会把
编译好的 blob 通过 `CACHE_DIR` 缓存起来,但*第一次*编译无可避免),所以第一个请求会吃一份多秒级的成本,
除非你提前预热。这正是为什么运行时带了一个显式的 cache-warmup 步骤(详见[第三篇](/zh/blog/paged-kv-batching-without-vllm/))。

## 真正的对手:解码是带宽受限的

这是支配下游一切的那个事实。自回归解码**一次只生成一个 token**,而每一步它都要把*整个*模型的权重(还
有不断增长的 KV 缓存)从内存里读出来,只为产出一个 token。有用的度量是**算术强度(arithmetic
intensity)**——每搬运一字节所做的 FLOPs:

$$
I \;=\; \frac{\text{FLOPs}}{\text{搬运的字节数}}.
$$

对单 token 解码步,你大约做 $2N$ 次 FLOPs(每个参数一次乘加),同时读约 $N \cdot b$ 字节权重,其中 $N$
是参数量、$b$ 是每个权重的字节数。于是 $I \approx 2/b$——**fp16 下约 1 FLOP/字节**,与模型大小无关。
而硬件能提供的是每字节带宽几十到上百 FLOPs(它 roofline 上的*脊点 ridge point*)。当 $I$ 远落在脊点
左侧,你就是**内存带宽受限**:计算单元空转,等内存。解码是教科书般的例子。

换个角度看,batch 大小 $B$ 时每个权重仍只读一次、却用在约 $2B$ 次 FLOPs 上,所以 $I \approx 2B/b$——
batch 为 1 时是量级为 1 的数,只随着你加大 batch 才往上爬,远在脊点左边。这翻转了通常的直觉。一块核显
要紧的规格不是它的 TFLOPs,而是它的内存
**带宽**。每 token 的时间下界是

$$
t_{\text{token}} \;\gtrsim\; \frac{N \cdot b \;+\; \text{读取的 KV 字节}}{\text{BW}},
$$

两个设计选择从中直接掉出来。**量化权重**(INT8:$b=1$ 而非 2),每 token 搬运的字节大致减半。**量化 KV
缓存**(U8),缩小第二项——那一项随上下文增长。两者都是带宽牌,不是计算牌——这正是运行时默认用 INT8
权重(生产 seed 图变体是 `int8_sym_batch_fused_gqa`)加 U8 KV 缓存(调度器配置里的
`kv_precision: str = "u8"`)的原因。([第三篇](/zh/blog/paged-kv-batching-without-vllm/)算缓存的账。)这也是为什么
**批处理**是那个大杠杆:在一个解码步里服务 $B$ 个请求,权重只读*一次*、却摊到 $B$ 个 token 上,把 $I$
推向脊点,把一个带宽受限的问题变成计算受限的。

## 决定能不能上线的那个指标:RTF

对流式 TTS,有一个数把其余都收进去——**实时因子(real-time factor)**:

$$
\text{RTF} \;=\; \frac{\text{计算耗时}}{\text{产出音频的时长}}.
$$

$\text{RTF} < 1$ 意味着你生成音频比它播放更快——流式不卡顿的必要条件。$\text{RTF} = 0.5$ 时,你每秒
计算产出两秒语音,留出抖动余量;$\text{RTF} > 1$ 时,缓冲区耗尽,音频卡顿。在 12Hz 的帧率下,
$\text{RTF}=1$ 对应的每帧预算是 $1/12 \approx 83\,\text{ms}$ 的墙钟时间,而每一帧是一个 talker AR 步
加上 subcode 补齐加上它那份流式 decoder。RTF 是把上面那套带宽数学与一个可交付产品绑在一起的约束:正确
还不够,你得在面前那台设备上把每帧压进 $1/12$ 秒。(还有两个数与它并列:**首音延迟
time-to-first-audio**,分块 decoder 就为它调过;以及并发——在 RTF 之内你能同时撑住几条流,这是批处理器
买来的。)

## 教训:可移植性是一种能力

很容易把「能在 OpenVINO 上跑」归进「退路」——抢不到 H100 时才做的事。我倒过来看。生态是 CUDA 形状的,而
能把服务栈——分页 KV、在线批处理器、流式——在另一个运行时上重建,是一种真本事,理由有二。

第一,它能去 CUDA 去不了的地方:一台消费级笔记本的核显、一台 Intel 边缘盒子、任何没有 N 卡、也没有
数据中心的地方。对 TTS 这类东西,那才是实际部署面的大头。

第二——也是我看重的部分——它逼你*真正理解那条你平时 pip install 就略过的推理循环*。一旦你亲手搭过
AR 解码、对着真实内存预算给 U8 KV 缓存定过尺寸、写过准入调度器,vLLM 就不再是魔法,而成了一组你本可
自己做出的决定。那份理解,在哪儿都回本,CUDA 也不例外。

这是概览。系列接下来的篇章,会把那个 rust 色方块里的每个盒子逐一打开。下一篇:大家以为是已解决黑盒的
那部分——[Qwen3-TTS 究竟怎么把文本变成一帧声音](/zh/blog/how-qwen3-tts-makes-a-frame/),以及那个让
12Hz 多码本解码器在 OpenVINO 上变得可行的双图拆分。

## 延伸阅读

- [PagedAttention / vLLM](https://arxiv.org/abs/2309.06180) —— 连续批处理和分页 KV 在 CUDA 上替你买到了什么,以及为什么换个地方你得重建它们。
- [FlashAttention](https://arxiv.org/abs/2205.14135) —— 那个离开 CUDA 就失去的、IO 感知的融合注意力 kernel;这篇论文也是「注意力是内存受限的」这一论断最清楚的出处。
- [OpenVINO 文档](https://docs.openvino.ai/) —— IR、设备插件(CPU/GPU/NPU)与模型优化。
- [Roofline: an insightful visual performance model](https://dl.acm.org/doi/10.1145/1498765.1498785) —— Williams、Waterman 与 Patterson;算术强度和脊点的出处。
</content>
</invoke>
