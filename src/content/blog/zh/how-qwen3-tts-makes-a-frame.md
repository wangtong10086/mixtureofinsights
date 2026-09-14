---
title: "拆解 Qwen3-TTS：OpenVINO 移植过程中的图分离与调度实践"
description: "在 OpenVINO 中分开导出 Qwen3-TTS 的 Talker、Subcode 和流式 Decoder，并为首段语音和稳态输出配置不同的解码块。"
date: 2026-06-10
order: 2
series: "openvino-tts"
reading: "38 分钟"
tags: ["llm", "tts", "openvino", "codec", "architecture", "ultra-x7"]
---

在[上一篇](/zh/blog/when-the-gpu-isnt-an-nvidia/)中，我们在 Ultra x7 358h 平台上，从底层的内存带宽、量化算子和连续批处理框架入手，完成了推理环境的调整。但把 Qwen3-TTS 整体导出为一个 OpenVINO IR 模型后，核显上的生成仍然很慢，高并发时内存也会迅速增长到 OOM。

分析 Qwen3-TTS 的计算拓扑后，我发现它的推理阶段并不具有相同的计算形状。

它包含三种计算形状（Compute Shape）和访存模式不同的子系统，需要通过图分离（Graph Splitting），让编译器分别进行硬件加速。

下面介绍我在 [`exporter.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/exporter.py) 中对 Qwen3-TTS 的拆图方式，以及如何通过非对称块调度解决流式响应的延迟问题。

---

## 1. 症结所在：多码本 RVQ 带来的计算冗余

要理解为什么要拆分图，必须先弄懂神经音频 Codec 所采用的**残差矢量量化（[Residual Vector Quantization, RVQ](https://arxiv.org/abs/2107.03312)）**机制，该机制最早由 Google 的 SoundStream 和 Meta 的 [EnCodec](https://arxiv.org/abs/2210.13438) 推广。

在传统的 LLM 中，语言是一维的 Token 序列，生成一个词只需要单步自回归计算。但在音频领域，要在低比特率下重建高保真波形，Qwen3-TTS 每生成一帧（12Hz），吐出的并不是一个 Token，而是一摞由 $Q$ 层码本（Codebook）组成的立体向量。这种先粗粒度预测全局语义（Talker），再通过多层网络迭代修补声学细节（Subcode）的设计，深受 Google [AudioLM (Borsos et al., 2022)](https://arxiv.org/abs/2209.03143) 架构理念的影响。

### RVQ 的层级逻辑

1.  **第一码本 $q_0$**：负责捕获最核心的语义和粗粒度的声学结构。生成它，需要模型回看迄今为止所有的音频历史。
2.  **后续码本 $q_1 ... q_{Q-1}$**：负责修补上一层量化时丢失的残差信号。

用数学表示其迭代量化过程：
$$
r_i \;=\; x \;-\; \sum_{j<i} q_j
$$

```text
[ Talker: 长上下文自回归网络 ]
  (历史 Paged-KV 缓存) 
         |
         v
  < 全局 Attention >
         |
         v
 [ 帧隐状态向量 H ] --------+
         |                 |
         v                 v
   ( 第一码本 q_0 )        |   [ Subcode: 短循环残差修补 ]
         |                 +-> [ 计算残差 r_1 ]
         |                           |
         |                           v
         |                     ( 第二码本 q_1 )
         |                           |
         |                           v
         |                     [ 计算残差 r_2 ]
         |                           |
         |                           v
         |                     ( 第三码本 q_2 )
         |                           |
         v                           v
===========================================
               [ Decoder ]
```

### O(n^2) 算力灾难

两部分的计算量不同：
*   生成 $q_0$（Talker）的单步时间复杂度是 $O(n^2 \cdot d)$，由于涉及全量的历史 KV 读写，这是一个极其吃显存带宽的**访存密集型**任务。
*   生成后续的 $Q-1$ 个码本（Subcode）时，它只处理当前隐状态 $H$，无需回看历史，复杂度为 $O(Q \cdot d)$。

整体导出时，计算 $Q-1$ 个副码本的循环每次都会访问历史 KV 缓存。这些冗余访问会耗尽 Ultra x7 358h 核显剩余的带宽。

---

## 2. 代码级图分离：面向计算形状的解耦

为处理这些冗余访问，我在 [`qwen3_tts_ov/exporter.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/exporter.py) 中将完整 Pipeline 拆成三张独立的图。

### 2.1 剥离重型 Talker：注入 Paged-KV

将主干自回归网络剥离为 `talker_stateful_batch_gqa.xml`。
如上一篇所述，这张图移除了内部静态缓存结构，取而代之的是暴露给 C++ 运行时的指针接口。我们在编译前注入了 `SDPAToPagedAttention` Pass。这张图在运行时会被部署在 iGPU 上，独占经过 U8 量化的大规模内存池，专门处理 $O(n^2)$ 的长上下文注意力。

### 2.2 导出极速的 Subcode 缓存图

原本位于主干中的循环，被单独导出为较小的图：`subcode_greedy_cached_batch.xml`。
它被设计为完全无状态（Stateless），唯一依赖的输入是从 Talker 拿到的单帧隐状态 $H$。这意味着无论长文本生成的音频进行到第几分钟，Subcode 这部分的算力开销被锁死在了常数级底线，根本不参与 KV 缓存的带宽消耗。

```python
# qwen3_tts_ov/exporter.py 拆图核心实现
class DynamicFusedCacheCodecStepPagedBatchGQASeedWrapper:
    def __init__(self, talker, subcode_export_mode="cached"):
        # 将 Talker 封装为支持 Paged-KV 的 GQA (Grouped-Query Attention) 变体
        self.talker = DynamicStatefulTalkerPagedBatchGQASeedWrapper(talker)
        # 依据策略将 Subcode 的残差循环分离为 Cached 无状态模式
        self.subcode = make_subcode_wrapper(talker, subcode_export_mode)
```

---

## 3. 流式解码挑战：首音延迟（TTFT）与左侧上下文的博弈

码本 Token 还要经过解码器（Decoder），才能转成 PCM 波形流。这一步需要兼顾首音延迟和历史上下文。

### 撕裂的音频与上下文约束
Decoder 本质上是一层层的卷积网络。为了保证每一帧拼接处不会出现破音和杂音撕裂，解码器在翻译当前帧时，必须向左“回看”一段历史波形，这被称为**左侧上下文（Left Context）**。

在常规配置中，我们需要凑齐一定数量的帧（比如 24 帧音频 + 25 帧历史 Context）才敢进行一次解码计算。
但第一段语音合成时还没有“25帧历史”。如果等模型填满这个窗口才开始解码，用户的**首音延迟（TTFT, Time-To-First-Token）**将飙升数百毫秒，影响流式对话体验。

### 3.1 解决方案：非对称块调度 (Asymmetric Chunk Scheduling)

为了尽早输出声音，同时保留后续解码需要的上下文，我们在 [`build_fastest.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/build_fastest.py) 编译脚本中分别导出首块和稳态两种解码图。

```python
# qwen3_tts_ov/build_fastest.py 参数定义
FASTEST_EXPORT_ARGS_PRODUCTION = (
    "--decoder-tokens", "256",
    "--stream-decoder-chunks", "12,24",
    "--stream-decoder-first-chunks", "8,12", # 第一块的非对称配置
    "--stream-decoder-left-context", "25",
)
```

1. **首块图（First Chunks）**：
   受参数 `--stream-decoder-first-chunks "8,12"` 控制。这是一张极其迷你的专用解码图。它只处理前 8 帧音频，**并且完全舍弃所有的 Left Context 历史约束**。Talker 生成 8 帧后，就通过 NPU 解码为波形并送至声卡。
   起音瞬间的波形会有极轻微的瑕疵，换来的是这 8 帧语音能够尽早输出，TTFT 达到物理下限。

2. **注重音质的稳态图（Steady Chunks）**：
   受参数 `--stream-decoder-chunks "12,24"` 约束，并严格固化了 25 帧的 `left-context`。首块输出后，底层调度器（`NativeCodegenRunner`）会在纳秒级无缝将数据流切换（Context-Switch）到这张包含历史约束的图上，保证后续数分钟生成的音频平滑、无撕裂。

```text
User           Talker (iGPU)        First_Decoder_Graph (NPU)     Steady_Decoder_Graph (NPU)
 |                  |                           |                             |
 |---文本请求------>|                           |                             |
 |                  | (极速生成前8帧 Token)     |                             |
 |                  |---投递8帧(无上下文)------>|                             |
 |<---首字节语音----|                           |                             |
 |  (极速 TTFT)     |                           |                             |
 |                  |                           |                             |
 |============ [ 持续生成循环 ] ================================================|
 |                  |                           |                             |
 |                  | (稳态生成后续24帧 Token)  |                             |
 |                  |---投递24帧(带25帧历史)--------------------------------->|
 |<---平滑语音------|                           |                             |
 |============================================================================|
```

---

## 4. 落地：C++ 接管调度大权

运行时要频繁调度三类图：
1. iGPU 上的重型 Talker（依赖 Paged-KV）
2. iGPU 上的短 Subcode 循环
3. NPU 上频繁切换环境的 First / Steady Decoder 状态机

如果用 Python 在上层通过循环来调度它们，Python GIL（全局解释器锁）的抖动会抵消前面的优化收益。

因此调度只能交给原生语言。在项目的 `native/` 目录下，所有基于 OpenVINO Tensor 的内存指针流转，全部在 C++ 层利用 `libqwen3_tts_ov_genai.so` 闭环。Python 调度器仅仅负责业务级的准入和超时控制，不再接触繁重的张量调度。

## 5. 总结

拆图后，Talker 的带宽需求、Subcode 的计算需求和 Decoder 的延迟要求可以分别处理，并分配到 Ultra x7 358h 的不同器件。并发时还需要决定哪些请求能进入 Paged-KV 内存池，这部分见[无 vLLM 环境下的 Paged-KV 与连续批处理调度](/zh/blog/paged-kv-batching-without-vllm/)。
