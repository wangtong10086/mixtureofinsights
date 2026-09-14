---
title: "无 vLLM 环境下的 Paged-KV 与连续批处理调度"
description: "用 OpenVINO Paged-KV、U8 缓存和连续批处理，在核显内存预算内调度 Qwen3-TTS 的长上下文与并发请求。"
date: 2026-06-10
order: 3
series: "openvino-tts"
reading: "42 分钟"
tags: ["llm", "inference", "openvino", "kv-cache", "batching", "ultra-x7"]
---

在[上一篇：图分离与调度实践](/zh/blog/how-qwen3-tts-makes-a-frame/)中，我们将 Qwen3-TTS 拆成三张子图，分别部署到 Ultra x7 358h 的 iGPU 与 NPU 上。

这些图能独立执行后，并发服务还要处理三个状态管理问题：

1. **无界的长上下文**：TTS 输入的文本越长，主干网络中堆积的 Key/Value 历史缓存（KV Cache）就越大，呈线性增长。
2. **突发的高并发**：当数十条语音流同时请求时，原本就庞大的缓存体积会被乘数级放大。
3. **共享内存预算**：不同于数据中心里显存充裕的 N 卡集群，Ultra x7 358h 的 iGPU 需要与系统及其它后台进程共享 LPDDR5x 物理内存，一旦越界触发操作系统 Swap 操作，RTF 会严重恶化。

CUDA 环境中的 vLLM 已经封装了这些功能。这次边缘端移植需要用 C++ 实现相应的缓存与调度逻辑。

---

## 1. 内存碎片之殇：Fixed Cache vs Paged-KV

作为一套偏向静态优化的编译器，OpenVINO 原生天然排斥在推理过程中形状（Shape）不断伸缩的张量。

### 1.1 灾难性的“固定桶”方案
为了处理动态生长的 KV 缓存，最朴素（也是诸多早期 AI 部署方案采用的）的方法是：**固定桶（Fixed Cache Buckets）**。即提前把系统可接受的长度分段，例如编译 128、256、512、1024 长度的模型。运行时根据当前长度，选择一个能装得下的“最小桶”。

固定桶会产生内部内存碎片（Internal Fragmentation）。
假设系统当前请求需要的缓存长度为 $\ell = 600$ Token，而系统能匹配的最小桶是 $L = 1024$。这就意味着有超过 40% 的内存虽然被分配出去，但只用于填充（Padding）。在并发场景下，如果 8 个请求同时被分配到过大的桶中，就会耗尽 iGPU 共享内存池。

### 1.2 引入操作系统的智慧：Paged-KV
为消除碎片，我们使用虚拟内存中的分页（Paging）方式。这也就是 [PagedAttention (vLLM)](https://arxiv.org/abs/2309.06180) 的核心思想。

在 `OnlineBatchConfig` 调度器配置中，我们规定了底层显存池的分配粒度：
```python
@dataclass
class OnlineBatchConfig:
    block_size: int = 16 # 每个页块仅容纳 16 个 Token 的缓存
    max_cache_blocks: int = 2048 # 全局池总计约 32k Token 容量
```

在这种设计下，无论序列多长，系统都是一块一块（每块 16 Token）地向外派发内存。如果长度为 $\ell = 600$，系统分配 $\lceil 600 / 16 \rceil = 38$ 块。
唯一的内存浪费只会发生在最后一个填不满的尾块中：

$$
\text{Waste}_{\text{paged}} \;<\; \text{Block\_Size (16 Token)}
$$

对比 Fixed Bucket 那动辄数百 Token 的浪费，Paged-KV 将整体并发承载能力提升了近 3 倍。

### 1.3 底层 C++ 劫持算子
OpenVINO Python API 没有 PagedAttention。为了把这套理念落地，我必须下沉到原生 C++ 核心层。
我导出了一张“干净、毫无缓存连接”的主干网络图（`talker_stateful_batch_gqa.xml`）。在执行 `core.read_model` 读取它之后，在 C++ 层对计算图应用 Pass `SDPAToPagedAttention`。

```cpp
// native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp 核心代码
auto model = core.read_model(seed_xml);
add_readvalue_initializers(model);

// 全局扫描图结构，寻找 Scaled Dot-Product Attention，并替换为 Paged 变体
try {
    ov::pass::SDPAToPagedAttention(
        false, false, allow_score_aggregation, false, false, false)
        .run_on_model(model);
} catch (const std::exception& exc) { /* 降级处理 */ }

// 将我们配置的 block_size, heads 固化进去
specialize_kv_cache_parameters(model, heads, block_size, head_dim, cache_element_type);
```

转换后的模型使用页表映射，不再依赖静态桶。

---

## 2. 突破带宽天际线：极限 U8 缓存量化

解决碎片后，KV 缓存本身的体积仍然很大。
在上一篇中我强调过，Ultra x7 358h 面临的最大考验是 **总线带宽受限**。

让我们重新审视 KV Cache 的理论体积公式：
$$
\text{KV bytes} \;=\; 2 \cdot L \cdot H \cdot d_{\text{head}} \cdot s \cdot B \cdot \text{bytes}_{\text{dtype}}
$$
- $L=28$ (网络层数)
- $H=8$ (得益于 GQA，Key/Value 头数大幅缩小)
- $d_{\text{head}}=128$ (头维度)
- $B=4$ (并发数)
- $s=8000$ (假设一段较长对话积累的 Token 数)

在常规的 FP16 精度（$\text{bytes}_{\text{dtype}}=2$）下，4 条并发流就需要 3.6GB 的 LPDDR5x 内存。这对于和系统共享内存的核显平台是不可接受的，读写这 3.6GB 数据带来的带宽延迟足以彻底摧毁 RTF。

公式中唯一能动的变量，就是数据精度。
我们在系统的统一调度入口通过 CLI 参数 `kv-cache-profile` 和后端的配置项，启用了 U8 (8-bit Unsigned Integer) 量化缓存。

```python
# 强制开启底层 U8 缓存量化
kv_precision: str = "u8"
```

当 OpenVINO 底层收到 `U8` 的信号时，会对历史累积的浮点 Key 和 Value 向量执行实时的 Per-Token / Per-Channel 对称量化与反量化。
对应的变化有两项：

1. **缓存占用减半**：从 3.6GB 降至 1.8GB。
2. **读写量减半**：计算单元每步解码需要等待总线传送的数据量减少 50%，算术强度大幅抬升，直接抵消了量化/反量化本身增加的微量计算开销。

---

## 3. Python 锁外的战役：连续批处理调度器

如果你采用静态批处理（Static Batching，等当前批次的句子全读完才接入新请求），那么一个只包含 5 个词的短回复，如果排在一段几百词的朗读任务后面，它也必须挂起等待几百个步数。系统的响应延迟极不稳定。

真正的解法是构建 **连续批处理 ([Continuous Batching](https://www.usenix.org/conference/osdi22/presentation/yu))**。这一思想最早由 Orca 系统提出，为了绕过 Python GIL 带来的高频调度卡顿，我们让 Python 管理请求，由 C++ 执行解码。

### 3.1 调度机制大解剖
在 Python 端（[`qwen3_tts_ov/online_batch.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/online_batch.py)），我部署了一个名为 `OnlineBatchScheduler` 的守护线程。它管理着一切业务请求，但从不触碰实际的张量。

它的 `_loop` 以单次解码步（Single Step）为粒度运行。

```text
[时间轴]               T=0   1   2   3   4   5   6   7   8   9   10  11  12  13  14
-----------------------------------------------------------------------------------
【静态批处理 (浪费算力)】
请求 A (长文本)        [=========================================]
请求 B (短文本)        [=============] (空闲...)
请求 C (新来阻塞)                              [=========================================]

【连续批处理 (高利用率)】
请求 A (长文本)        [=========================================]
请求 B (短文本)        [=============]
请求 C (无缝插入)                    [=========================================]
-----------------------------------------------------------------------------------
```

在连续批处理中，每跑完一步 Token 前向传播，调度器都会处理准入、执行和结束事件：
1. **准入评估**：检查当前的 Block Table 是否还有剩余页块。如果有，从等待队列中拉取新请求 `C`，为其分配缓存页表，并在**下一微秒**就将其无缝混入正在执行的 Batch 中。
2. **步进执行**：调用 `runner.online_batch_step`，让底层的 C++ `NativeCodegenRunner` 操作 GPU 硬件，一次性对混杂在一起的 $A$、$B$、$C$ 请求执行并行前向计算。
3. **移除已完成请求**：如果请求 $B$ 遇到了 EOS（句子结束符）或者到达了代码组的设定上限，就结束该请求并立即回收它占用的 Paged-KV 物理块，而不影响一旁继续生成的 $A$。

```python
# OnlineBatchScheduler _loop 核心调度源码
result = runner.online_batch_step(
    max_decode_batch=self.config.max_batch_size,
    max_events=self.config.max_events,
    num_code_groups=self.runtime.num_code_groups,
)

for event in result:
    kind = event.kind
    # kind == 2: 生成自然结束(EOS) / kind == 3: 被强行截断(MaxLength)
    if kind in {2, 3}:
        request.output.put(None)
        with self._lock:
            # 即刻驱逐已完成序列，下一帧计算立刻释放对应内存
            self._requests.pop(int(native_id), None)
```

这种单步粒度的精密调度，最大化填平了 Ultra x7 358h iGPU 的计算管线，确保了无论高并发波峰如何突起，系统绝不出现长尾卡死现象。

这次移植需要同时处理缓存分配、访存量和请求调度。Paged-KV 管分配粒度，U8 减少缓存读写，连续批处理则让新请求不必等待整批语音结束。它们共同决定了这些模型图能否用于并发服务。
