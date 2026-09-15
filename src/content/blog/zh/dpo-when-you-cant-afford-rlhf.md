---
title: "角色扮演 DPO：偏好对与 chosen 概率监控"
description: "用 DPO 处理角色扮演中的出戏问题：偏好对构造、损失下降但 chosen 概率也下降的现象，以及 S-LoRA 多角色部署。"
date: 2026-06-10
updatedAt: 2026-09-15
order: 4
series: "post-training"
reading: "12 分钟"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

本文在角色扮演场景中使用 DPO：以 prompt/chosen/rejected 三元组训练，省去在线 rollout 和单独训练奖励模型。偏好对围绕待纠正行为构造，训练时同时观察 loss 与 chosen 对数概率。公开 ORBIT 代码提供的是脚本生成器，仅凭这份代码不能复现下文的训练效果或多适配器服务结果。

我核算过 RLHF 的成本：额外训练奖励模型（RM）、维护 PPO 在线 rollout 循环，还要调好 KL 散度约束。对这次语气和人设问题，这套流程的算力与维护成本太高。

所以我改用 DPO（Direct Preference Optimization），将偏好学习转成离线分类训练，省去在线强化学习循环。

<span id="数学折叠隐式奖励的推导" aria-hidden="true"></span>

## DPO 隐式奖励的推导

推导见 [*Direct Preference Optimization* (Rafailov et al., 2023)](https://arxiv.org/abs/2305.18290) 第 4 节。

传统 RLHF 的目标函数为：

$$
\max_{\pi_\theta}\; \mathbb{E}_{x,\,y\sim\pi_\theta}\big[\, r_\phi(x,y)\,\big]
\;-\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta(y\mid x)\,\|\,\pi_{\mathrm{ref}}(y\mid x)\right]
$$

其理论上的闭式最优解是：

$$
\pi^*(y\mid x) \;=\; \frac{1}{Z(x)}\,\pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\, r(x,y)\Big)
$$

$Z(x)$ 作为配分函数在工程上无法遍历计算。DPO 通过代数变形，将奖励 $r(x,y)$ 通过策略网络自身反向表达，然后代入 Bradley-Terry 偏好概率模型中。在好坏回答相减时，$Z(x)$ 会被直接抵消。

奖励可以由策略与参考模型的概率比表示，最终损失函数不需要外置 RM：

$$
\mathcal{L}_{\mathrm{DPO}} \;=\; -\,\mathbb{E}_{(x,\,y_w,\,y_l)}\left[\log\sigma\!\left(
\beta\log\frac{\pi_\theta(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}
\;-\;
\beta\log\frac{\pi_\theta(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}
\right)\right]
$$

偏好对分别经过模型，计算流程如下：

```text
[ prompt ]
   |
   +-- (前向传播: 锚定 SFT 与参考模型)
   |
   +-> chosen (在设定内)   ----> [ 计算策略对数概率 ] ----> ↑ 似然推升
   |
   +-> rejected (出戏)     ----> [ 计算策略对数概率 ] ----> ↓ 似然打压
```

训练使用已有偏好对，增大两者的似然差，无需在线采样或额外打分。

## 代码注入与 TRL 适配

在实现层面，我通过 `orbit/training/dpo_config.py` 对接 TRL 库。将打标好的数据打包为 `prompt`/`chosen`/`rejected` 三元组格式。

```python
DPO_BETA = 0.1
training_args = DPOConfig(
    output_dir=OUTPUT_DIR,
    learning_rate=5e-6,
    beta=DPO_BETA,
    max_prompt_length=config.max_seq_length // 2,
    gradient_checkpointing=True,
    # 其他超参...
)
trainer = DPOTrainer(model=model, train_dataset=dataset, peft_config=peft_config, ...)
```

KL 惩罚系数 `beta` 锚定在 `0.1`。为突破显存瓶颈，底层走 QLoRA 量化通道，最终仅产出几 MB 的 adapter 权重。

<span id="梯度欺骗绝对似然下沉" aria-hidden="true"></span>

## 为什么 chosen 的绝对似然可能下降

初期测试时，训练集 Loss 持续下降，推断结果却变差了：模型丢失了预设语气，语义连贯性也受到严重影响。

对 DPO 损失函数求导可知，其梯度带有动态的 sigmoid 权重。模型把 rejected 排在 chosen 前面时，修正权重较大；两者差值拉开后，梯度减小。DPO 只约束相对边际，不约束绝对概率。

当模型难以学习复杂的 chosen 分布时，优化器会下调所有输出的绝对似然，只要 rejected 降得比 chosen 更多，损失就能继续减小。表现为 Loss 虽然在降，但 `chosen logprob` 也在持续暴跌——模型实际上正在丧失生成正确回答的能力。监控指标绝对不能止步于 Loss，还必须单独监控 `chosen logprob`。这也是为何学术界后续提出 [*IPO* (Azar et al., 2023)](https://arxiv.org/abs/2310.12036) 等方法，试图通过修正损失函数来遏制概率下沉。

<span id="变量控制与飞轮构造" aria-hidden="true"></span>

## 角色数据的一致性过滤

由于缺乏在线 Rollout 实时纠偏，DPO 对离线偏好数据的质量极其敏感。构造偏好对时，我要求只改变要纠正的那个变量。

Chosen 和 Rejected 必须在长度、信息量、排版上保持完全对齐，仅在核心缺陷（例如语气词的越界）上产生分歧。一旦存在长度差，DPO 会迅速将其作为作弊捷径。此外，偏好数据必须由当前 SFT 基座生成，直接灌入其他闭源模型的高维数据会引发严重的分布错位。

数据采集流程是：模型批量采样 -> 规则验证器阻断式打分 -> 生成 chosen/rejected 对。人工仅介入验证器规则的编写与少量的抽样兜底。

<span id="异构部署s-lora-的并发解法" aria-hidden="true"></span>

## 使用 S-LoRA 服务多个角色

面对几百个角色的并发推断需求，为每一个角色单独实例化 14B 参数模型会迅速耗尽集群显存。得益于 DPO 阶段采用的 QLoRA 架构，最终产物仅为适配器。在部署侧，我引入了 [*S-LoRA* (Sheng et al., 2023)](https://arxiv.org/abs/2311.03285) 作为调度后端，结合 vLLM 进行内存复用。

14B 基座模型在显存中常驻并作为共享内存。S-LoRA 的请求调度器在构建 Batch 时，会动态将对应的 LoRA adapter 加载至连续内存块。这种动态加载方式让单张 GPU 支撑了数十个角色的高频并发推断。

如果任务有可执行的正确性检查，并需要在线探索，可以对照本系列的 [SFT 冷启动与 GRPO](/zh/blog/cold-start-then-climb/)。
