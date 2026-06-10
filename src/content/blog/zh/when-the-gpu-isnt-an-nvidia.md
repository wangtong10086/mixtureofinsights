---
title: "当 GPU 不是 N 卡"
description: "整个 LLM 技术栈都默认 CUDA。可你面前的 GPU,往往是一块 Intel 核显,或者一颗 CPU。要让一个真实、低延迟的自回归 TTS 在那儿流式跑起来,意味着把你平时 pip install 就有的那些东西——解码循环、KV 缓存、批处理调度器——在 OpenVINO 上亲手重建。"
date: 2026-06-17
order: 1
series: "openvino-tts"
reading: "8 分钟"
tags: ["llm", "inference", "openvino", "tts", "edge"]
---

LLM 世界里几乎一切,都悄悄默认了一块 N 卡。vLLM、各种 kernel、教程——CUDA 是我们呼吸的水。可真正
摆在用户面前的 GPU,同样常常是一块 **Intel 核显**、一块 Arc,或者干脆一颗 CPU。要让一个现代自回归
TTS 模型在那儿跑起来——快、流式、生产可用——是一种真正不同的工程,因为那套舒适的技术栈根本不在。
这正是 `qwen3-tts-openvino` 这个项目。

## 为什么难,而不只是"导出成 ONNX"

一个 12Hz 的自回归 TTS,不是你 trace 一次就完事的前馈分类器。要把它服务起来,你需要整条推理循环,
而在 OpenVINO 上,这条循环得你来搭:

- 它**自回归解码**——这一步喂下一步——所以是一条真实的循环,带一个 **KV 缓存**,而不是单次前向;
- 它末端是一个把 token 变成波形的**神经 codec**,就在热路径上;
- 而"好"意味着**流式**:第一段音频要尽快出来,不是一个批处理作业。

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
  让长的、全上下文生成塞进一块核显内存预算的关键。
- **一个 vLLM 式的在线批处理器——在 OpenVINO 上。** 一个负责请求准入和解码步的调度器,让并发请求高效
  共享设备。这正是非 CUDA 没有现成货的部分;连续批处理的服务循环,你得自己搭。
- **要流式,别切段。** 生成是**全上下文自回归**的——文本*不*被切成块——但音频在 `fastest` 档下,通过
  WebSocket PCM 流式吐出。延迟是头等目标,不是事后补的。
- **一条原生 C++ codec 流水线**,把 token→波形那一步放在热路径上,而不是每一帧都付 Python 的账。
- **运维的现实。** 设备选择(CPU/GPU)、一个只慢一次的首次编译缓存,以及**按模式懒驻留**,让
  VoiceDesign、CustomVoice、VoiceClone 不同时占着内存——三种能力,一个 sidecar。

## 教训:可移植性是一种能力

很容易把"能在 OpenVINO 上跑"归进"退路"——抢不到 H100 时才做的事。我倒过来看。生态是 CUDA 形状的,而
能把服务栈——分页 KV、在线批处理器、流式——在另一个运行时上重建,是一种真本事,理由有二。

第一,它能去 CUDA 去不了的地方:一台消费级笔记本的核显、一台 Intel 边缘盒子、任何没有 N 卡、也没有
数据中心的地方。对 TTS 这类东西,那才是实际部署面的大头。

第二——也是我看重的部分——它逼你*真正理解那条你平时 pip install 就略过的推理循环*。一旦你亲手搭过
AR 解码、对着真实内存预算给 U8 KV 缓存定过尺寸、写过准入调度器,vLLM 就不再是魔法,而成了一组你本可
自己做出的决定。那份理解,在哪儿都回本,CUDA 也不例外。

这是概览。系列接下来的篇章,会把那个 rust 色方块里的每个盒子逐一打开。下一篇:大家以为是已解决黑盒的
那部分——[Qwen3-TTS 究竟怎么把文本变成一帧声音](/zh/blog/how-qwen3-tts-makes-a-frame/),以及那个让
12Hz 多码本解码器在 OpenVINO 上变得可行的双图拆分。
