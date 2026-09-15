---
title: "LLM 后训练数据：生成、验证与通过率"
description: "ORBIT 如何生成、筛选和验证训练轨迹，以及通过率如何影响数据收集成本。"
date: 2026-06-10
updatedAt: 2026-09-15
order: 1
series: "post-training"
reading: "13 分钟"
tags: ["llm", "post-training", "synthetic-data", "rejection-sampling"]
---

ORBIT 通过生成轨迹、验证打分、过滤失败样本和统一 JSONL 格式来构建后训练数据。工程上要先回答：每轮生成能留下多少可用样本？下文的几率增长计算是建立在固定提升系数假设上的示例，不是实测学习曲线，也不意味着筛选越严格，通过率就越高。

要唤起 (elicit) Base 模型的潜在能力，并在状态空间里将其塑形 (shape)，单靠调整梯度还不够。上游还需要生成大量高质量样本，并过滤其中的噪声。

<span id="架构重组四台数据引擎的咬合" aria-hidden="true"></span>

## 四种后训练数据生成引擎

ORBIT 中有四个独立的生成与验证模块，全部输出标准化的 JSONL 数据 (`messages`, `env`, `score`, `task_id`)。

**1. 确定性合成轨迹**：在复杂的长链路规划任务中，人工标注成本高，也容易出错。我构建了环境模拟器直接生成确定性的轨迹。在 [`orbit/data/liveweb_teacher_gen.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/data/liveweb_teacher_gen.py) 中，系统完全不调用 LLM，而是通过回放缓存的 Web 工具数据拼装出完全正确的组合调用流。这正是类似 [WebSailor (2025)](https://arxiv.org/abs/2507.02592) 中倡导的“高信息熵合成数据”思路。

**2. 自我博弈 (Self-Play)**：在封闭规则下，让生成器在 OpenSpiel 沙盒中对弈，只保留那些导向胜利的轨迹。

**3. 拒绝采样 (Rejection Sampling)**：将 Best-of-N 用于筛选训练数据，以更多推理换取更多可用训练数据。如果单样本存活概率为 $p$，那么采 $N$ 条至少存活一条的概率是 $1-(1-p)^N$。当 $p=0.1, N=20$ 时，存活率逼近 88%。在期望意义上，保留 Top-1 样本带来的隐式策略改进，等同于相对于 Base 策略产生了约为 $\log N - \frac{N-1}{N}$ nats 的 KL 散度偏移。正如 [Llama 2 (Touvron et al., 2023)](https://arxiv.org/abs/2307.09288) 所验证的，这是一种在有界偏离内获取更高质量梯度的免训练强化范式。

**4. 裁判验证器 (Judge/Verifier)**：前面所有的引擎都依赖于它。验证逻辑位于 [`orbit/verifiers/static.py`](https://github.com/wangtong10086/orbit/blob/5bf86f0aa77a38bbaa7b196de513e9b2afe455a4/orbit/verifiers/static.py)，按 rubric 中的静态规则判定。这对应了 [Constitutional AI (Bai et al., 2022)](https://arxiv.org/abs/2212.08073) 中将自我批评转成监督信号的思路。

<span id="原理推演飞轮效应的物理方程" aria-hidden="true"></span>

## 验证通过率与数据成本的关系

生成、筛选和训练形成反馈循环，对应 [STaR (Zelikman et al., 2022)](https://arxiv.org/abs/2203.14465) 最初揭示的“生成 $\to$ 过滤 $\to$ 微调”循环：

```text
[ Synthesizer (Self-Play) ] =======> [ Verifier (Filter / Score) ]
           ^                                      |
           |                                      v
[ Stronger Generator ] <======= [ SFT / RLHF on Survivors ]
```

我将这个过程用数学模型量化。记 $p_t$ 为第 $t$ 轮训练后验证器的通过率（良率）。假设每一轮微调带来的能力提升相当于将通过率的几率 (odds) 乘以一个放大系数 $g > 1$，其动力学可以描述为：

$$
\frac{p_t}{1-p_t} = g^t \cdot \frac{p_0}{1-p_0}
$$

即便在 $t=0$ 时只有 $5\%$ ($p_0=0.05$) 的良率，只要 $g=2$，四轮之后几率就会膨胀 16 倍，通过率跃升至约 $46\%$。这里需要关注 $g$。如果验证器有噪声，放过了有害样本，$g$ 就会趋向 $1$。一旦 $g \le 1$，通过率便不再增长。

<span id="硬核落地把工程预算砸向验证器" aria-hidden="true"></span>

## 验证器的工程投入与适用边界

这个判断改变了我的算力分配：

1. 我几乎不再碰底层的训练器代码，把所有的工程精力投入到生成器和验证规则（Rubric）中。
2. 良率 $p$ 既预测下一轮模型能力的上限，也决定数据收集成本。为了凑齐 $M$ 条训练种子，需要消耗 $\approx M/p$ 的推理算力。如果把验证规则写得更严格，良率的小幅提高就能让账单减半。

接下来需要确定[哪些检查交给验证器，哪些交给奖励模型](/zh/blog/what-are-you-rewarding/)。验证覆盖范围决定了“通过的轨迹”究竟代表什么。
