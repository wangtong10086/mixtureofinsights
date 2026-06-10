---
name: hardcore-tech-blog
description: Write and revise Chinese hardcore technical blog posts in a first-person hacker diary style with high information density, ASCII diagrams, inline source and paper citations, bottleneck analysis, architecture reasoning, and natural non-summary endings. Use when drafting, rewriting, editing, or reviewing advanced technical blog articles.
---

# 极客技术博客写作风格指南 (Geek Technical Blog Style Guide)

这份文档提炼了我们在重构 `qwen3-tts-openvino` 系列博客时确立的**“硬核黑客日记 (Hardcore Hacker Diary)”**写作范式。在未来使用 AI 或手动编写高级技术博客时，请严格遵守以下核心原则，确保文章具备极高的信息熵、极客感与可读性。

## 1. 叙事视角与基调 (Narrative Perspective & Tone)
- **第一人称单数**：统一使用“我 (I)”而不是“我们 (We)”，即使项目有多人参与，也应保持独立开发者的个人复盘视角。
- **克制与平静**：拒绝任何推销式、情绪化或烂俗的转折句式（如“确实...但是”、“不过...并不”）。保持冷静理性的口吻，“平静地说出做了什么，遇到了什么物理极限，是如何用代码一步步解决的”。
- **去套路化结尾**：**绝对禁止**在文章末尾添加“总结 (Conclusion)”、“结语”或独立的“延伸阅读”区块。文章应在一个核心技术点的剖析后自然收尾，或者以一句精炼的工程感慨戛然而止，留下余味。

## 2. 结构范式 (Structural Paradigm)
不要写成没有深度的“项目说明书”，而应遵循**“瓶颈剖析 -> 原理推演 -> 架构重组 -> 结果证明”**的深水区逻辑路线：
1. **抛出真实的痛点**：例如缺乏 CUDA 时的生态真空。
2. **计算物理极限**：用确切的数学公式（如算术强度 $I=2/b$）和具体的硬件参数（如 119GB/s 内存带宽）量化瓶颈。
3. **分层优化策略**：将解决方案严格划分为不同维度（算子级、代码级、框架级、平台异构级）。
4. **硬核落地**：展示绕开高层抽象（如 Python GIL）并深入底层（如 C++ 内存管理、指针劫持）的真实操作。

## 3. 视觉与排版 (Visuals & Formatting)
- **ASCII 图表优先**：放弃可能导致渲染失败或过于现代的 Mermaid，转而使用极具复古极客感的 **ASCII 图形**（如时序图、Gantt 图、架构流向图）。不仅能在纯文本中秒开，还能显著增强 Hacker 氛围。
- **代码片段**：不仅要贴代码，还要在代码中标注核心的 Hack 手段（如 `SDPAToPagedAttention` 算子注入）。

## 4. 引用与文献 (Citations & Source Code Links)
- **内联 GitHub 源码引用**：当提到具体的项目代码文件时，**必须**使用 Markdown 超链接将其直接指向仓库的真实代码行或文件。
  - *正确示范*：在 [`qwen3_tts_ov/online_batch.py`](https://github.com/wangtong10086/qwen3-tts-openvino/blob/main/qwen3_tts_ov/online_batch.py) 中，我部署了...
- **内联学术文献引用**：遇到学术界通用概念（如 Continuous Batching、PagedAttention、RVQ）时，**不要**在文末统一列出参考文献，而是直接在文中首次出现的地方**内嵌论文的 Arxiv 或官网链接**，并附加 1-2 句极其精炼的核心思想解释。
  - *正确示范*：这也就是 [PagedAttention (Kwon et al., 2023)](https://arxiv.org/abs/2309.06180) 引入的类似操作系统虚拟内存的分页机制...

## 5. 信息熵要求 (Information Entropy)
- **拒绝泛泛而谈**：单篇博客的信息量必须拉满。不跳跃逻辑，背景知识要向相关领域的读者解释透彻（例如为什么 NPU 适合流式 Decoder，为什么 iGPU 适合 DP4A 指令集量化）。读者读完后，必须能获得系统底层的真实工程 insight，而不仅仅是对框架调包的理解。
