---
title: "先冷启动，再让 RL 往上爬"
description: "难任务上直接从 base 模型做纯 RL，常常只会得到高方差的噪声。先用一小批 SFT 样本把策略拉到可探索的区域，再用 GRPO 放大好轨迹。"
date: 2026-06-10
order: 2
series: "post-training"
reading: "13 分钟"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

第一次在那个规划任务上直接跑 RL 时，最刺眼的不是失败，而是奖励曲线的彻底平坦。偶尔冒出一点真实信号，旋即被高方差的梯度噪声吞噬。模型并非完全丧失能力，而是它通过随机游走触及可用轨迹的概率过低；策略梯度只能放大已采样的分布，无法凭空创造未知的路径。

这让我对冷启动的物理意义有了最直接的认知：SFT 不需要教会整个任务，它只需要把策略推送到 RL 优化器能够探索的概率盆地。通过建立这套 SFT 预热流水线，我解决了梯度空转的问题，让模型有了往上爬的立足点。正如 [*DeepSeek-R1* (2025)](https://arxiv.org/abs/2501.12948) 论文中在 R1-Zero 上的消融实验所展示的：纯 RL 容易陷入语言退化和早期探索崩溃，极小规模的优质冷启动数据是破局的关键。

## 梯度的物理实在

从 REINFORCE 到 GRPO，策略梯度方法的核心都是期望更新：

$$
\nabla_\theta J(\theta) \;=\; \mathbb{E}_{y \sim \pi_\theta}\big[\, A(y)\, \nabla_\theta \log \pi_\theta(y \mid x) \,\big]
$$

这是一个对策略自身采样的期望操作。如果一条高价值轨迹在 base 模型下的先验概率是 $10^{-4}$，而在 batch 内对每个 prompt 只采样 8 条 rollout，那么平均 1,250 个 prompt 才会发生一次有效碰撞。其余 9,999 次反向传播贡献的全是无向噪声。概率趋近于零，意味着期望梯度也趋近于零，奖励再高也无法穿透这层数学壁垒。

更棘手的是稀疏奖励下的采样方差。在 0/1 极性奖励中，梯度估计方差与 $p(1-p)$ 成正比，恰好在成功率最低的区间（即最需要定向引导的初始阶段）达到灾难性的极值。这就是为什么“直接用 base 做 RL”会表现为长达数千步的随机游走。

**SFT 冷启动**正是用来修补这个概率塌陷。它不是端到端的技能灌输，而是硬生生将 $p(\text{高价值轨迹})$ 从 $10^{-4}$ 强行提升到 $10^{-1}$ 的数量级。在这个概率密度下，8 条样本的局部 batch 终于能稳定产出正负对比，原本失效的 GRPO 循环瞬间满血复活。SFT 购买的是采样效率，而非绝对能力。

## R1 范式的代码投影

我复刻并精简了 DeepSeek-R1 的冷启动逻辑，将其收敛为四个核心步骤：

1. **Base 上的 GRPO 暴力探索**：直接在 base 模型上运行大预算的 GRPO，强制压榨出长思维链。这个阶段的损失函数必定极其难看，目标仅仅是沙里淘金。
2. **过滤高纯度种子**：利用验证器拦截，只保留具备绝对正确性的 `推理 -> 规划` 轨迹。这批数千量级的数据源于模型自身生成，避免了人类 SFT 数据导致的分布偏移。
3. **SFT 形状对齐**：使用上述种子在 base 模型上微调 1-2 个 epoch。使模型肌肉记忆住正确的输出格式。
4. **GRPO 纵向攀爬**：无缝切换到主 GRPO 阶段，由真实的业务奖励（约束验证、耗时评估）驱动模型强化能力。

在工程实现上，这两段逻辑被统合在 [`orbit/training/config.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/training/config.py) 中的 `SwiftConfig`。通过简单的 `train_type` 翻转即可切换引擎。当设定 `train_type="rlhf"` 与 `rlhf_type="grpo"` 时，配置项将释放 GRPO 的核心旋钮：

```python
if self.train_type == "rlhf":
    d["rlhf_type"] = self.rlhf_type
    if self.beta is not None:
        d["beta"] = self.beta
    if self.reference_model:
        d["ref_model"] = self.reference_model
    if self.rlhf_type in ("grpo", "ppo"):
        d["max_completion_length"] = self.max_completion_length
    if self.rlhf_type == "grpo":
        d["num_generations"] = self.num_generations
        if self.reward_funcs:
            d["reward_funcs"] = self.reward_funcs
```

`num_generations` 就是组大小 $K$，`beta` 控制 KL 惩罚，而 `reward_funcs` 则是注入的验证器算子。一切都在 [`orbit/training/sft.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/training/sft.py) 中的 `SwiftBackend.validate_config` 被严格收束。

## 剥离 Critic：GRPO 的降本增效

PPO 架构中，一个与策略模型同等体量的 Critic 网络占据了极大的显存带宽和计算开销。而由 [*DeepSeekMath* (2024)](https://arxiv.org/abs/2402.03300) 提出的 GRPO，用极其暴力的局部组内标准化彻底干掉了 Critic。

对于输入 $x$，GRPO 采样 $K$ 条回复，并通过奖励打分计算相对优势：

$$
\hat{A}_i \;=\; \frac{r_i - \operatorname{mean}(r_1,\dots,r_K)}{\operatorname{std}(r_1,\dots,r_K)}
$$

接着套用标准的 PPO 裁剪与显式 KL 正则：

$$
\mathcal{L} \;=\; -\,\mathbb{E}\!\left[\min\!\big(\rho_t \hat{A}_i,\;
\operatorname{clip}(\rho_t,\, 1-\varepsilon,\, 1+\varepsilon)\, \hat{A}_i\big)\right]
\;+\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta \,\|\, \pi_{\mathrm{ref}}\right]
$$

其计算流向极具硬核的极简美感：

```text
[ prompt ]
   |
   +-- (采样 K=4)
   |
   +-> 回答 1: 得分 0.9  (优势 = +0.4)
   +-> 回答 2: 得分 0.6  (优势 = +0.1)
   +-> 回答 3: 得分 0.4  (优势 = -0.1)
   +-> 回答 4: 得分 0.1  (优势 = -0.4)
   |
   +-- 均值: 0.5 (无需 Critic 网络预测)
```

用单次 prompt 拓展的 $K$ 倍并行采样，换取整个 Critic 网络的生命周期。在可验证奖励场景下，vLLM 的推理吞吐使得这一交易稳赚不赔。

值得注意的是，分母处的标准差 $\operatorname{std}$ 会引入系统性偏差，偏好低离散度的输出。这在 [*Dr. GRPO* (2025)](https://arxiv.org/abs/2503.20783) 的分析中被明确指出，而后续如 [*DAPO* (2025)](https://arxiv.org/abs/2503.14476) 提出的动态采样和 token 级损失，正是为了修复这类过度归一化带来的畸变。

## 监控指标的底层逻辑

在调试中，我总结了几处致命陷阱：

1. **死组陷阱**：如果 $K$ 条样本的得分完全一致，优势差分为 0，整个 batch 将提供零梯度，而你付出了全额的推理代价。冷启动的终极目标，就是确保 batch 内活组的比例。
2. **警惕策略熵坍缩**：KL 惩罚不能仅仅视为对齐，它在防止策略早衰。如果策略熵在早期急剧塌缩，意味着模型已在次优解处陷入局部极小；若在后期异常上升，则往往是文本退化的前兆。
3. **塑形变量的风险**：给模型注入长度奖励能强制拉长思维链，但也等于向优化器暴露了新的攻击面。

调优 RLHF 时，真正的主战场在于精细的奖励塑形以及通过基建将方差压制在可控范围内。冷启动负责提供第一推动力，而 GRPO 的组内标准化则负责在计算密度的物理极限内完成向上的攀爬。
