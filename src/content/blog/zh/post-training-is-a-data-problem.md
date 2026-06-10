---
title: "后训练是个数据问题"
description: "很多后训练项目最后拼的不是 PPO、GRPO 还是 DPO，而是你能不能持续造出好数据：合成轨迹、自我博弈、拒绝采样，再加一个足够可靠的裁判。"
date: 2026-06-10
order: 1
series: "post-training"
reading: "13 分钟"
tags: ["llm", "post-training", "synthetic-data", "rejection-sampling"]
---

在刚接触强化学习微调时，很容易陷入算法缩写的崇拜：这该用 PPO，还是 GRPO，抑或是 DPO？直到我在训练器中挣扎，看着 loss 平稳下降但模型死活学不到目标行为，或者评测指标出现神经质般的震荡时，我才明白一个物理定律：优化器只是在爬坡，而这个坡的陡峭程度与方向，完全是由喂进去的数据分布决定的。

要想把一个 Base 模型中沉睡的潜在能力唤起 (elicit)，并在巨大的状态空间里将其塑形 (shape)，单纯对梯度进行把戏远远不够。真正的战场在更上游：如何无中生有地制造出大量含有致密逻辑信息的高质量样本，并把那些有毒的噪声无情地截杀掉。

## 架构重组：四台数据引擎的咬合

在 ORBIT 的体系里，我编写了四座独立的流水线模块，全部输出标准化的 JSONL 数据 (`messages`, `env`, `score`, `task_id`)。

**1. 确定性合成轨迹**：在复杂的长链路规划任务中，人工标注昂贵且错漏百出。我构建了环境模拟器直接生成确定性的轨迹。在 [`orbit/data/liveweb_teacher_gen.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/data/liveweb_teacher_gen.py) 中，系统完全不调用 LLM，而是通过回放缓存的 Web 工具数据直接拼装出完美的组合调用流。这正是类似 [WebSailor (2025)](https://arxiv.org/abs/2507.02592) 中倡导的“高信息熵合成数据”思路。

**2. 自我博弈 (Self-Play)**：在封闭规则下，让生成器在 OpenSpiel 沙盒里疯狂对弈，只保留那些导向胜利的轨迹。

**3. 拒绝采样 (Rejection Sampling)**：其实就是 Best-of-N 的工程化降级，将推理算力转化为数据密度。它的有效性是有严谨的数学支撑的。如果单样本存活概率为 $p$，那么采 $N$ 条至少存活一条的概率是 $1-(1-p)^N$。当 $p=0.1, N=20$ 时，存活率逼近 88%。在期望意义上，保留 Top-1 样本带来的隐式策略改进，等同于相对于 Base 策略产生了约为 $\log N - \frac{N-1}{N}$ nats 的 KL 散度偏移。正如 [Llama 2 (Touvron et al., 2023)](https://arxiv.org/abs/2307.09288) 所验证的，这是一种在有界偏离内获取更高质量梯度的免训练强化范式。

**4. 裁判验证器 (Judge/Verifier)**：前面所有的引擎都依赖于它。这台处于 [`orbit/verifiers/static.py`](https://github.com/wangtong10086/mixtureofinsights/blob/main/src/orbit/verifiers/static.py) 中的冷血验证机器，或者是根据复杂 rubric 运转的静态规则判定。这直接响应了 [Constitutional AI (Bai et al., 2022)](https://arxiv.org/abs/2212.08073) 中将自我批评提纯为监督信号的哲学。

## 原理推演：飞轮效应的物理方程

这四台引擎组合起来，形成了一个严密的反馈飞轮，这也正是 [STaR (Zelikman et al., 2022)](https://arxiv.org/abs/2203.14465) 最初揭示的“生成 $\to$ 过滤 $\to$ 微调”循环：

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

即便在 $t=0$ 时只有 $5\%$ ($p_0=0.05$) 的良率，只要 $g=2$，四轮之后几率就会膨胀 16 倍，通过率跃升至约 $46\%$。这里的生死线就在 $g$。如果验证器带有噪声，放过了有毒样本，$g$ 就会向 $1$ 跌落。一旦 $g \le 1$，整个引擎立刻抛锚，飞轮变成了空转。

## 硬核落地：把工程预算砸向验证器

在这个物理规律面前，我彻底改变了算力分配逻辑：
1. 我几乎不再碰底层的训练器代码，把所有的工程精力投入到生成器和那些极其复杂的验证规则（Rubric）中。
2. 良率 $p$ 是真正的试金石。它不仅预测了下一轮模型能力的上限，更是裸露的成本账单。为了凑齐 $M$ 条训练种子，需要消耗 $\approx M/p$ 的推理算力。如果能把漏洞百出的裁判写得更严格，良率的微小跃升将直接砍掉一半的账单。

在后训练的深水区里，不存在什么魔法梯度，只有冷冰冰的数据过滤与无情的验证逻辑。
