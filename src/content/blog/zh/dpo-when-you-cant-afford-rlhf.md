---
title: "算力不够上 RLHF，就把 DPO 用对"
description: "记录一次用 DPO 搞定多角色出戏（OOC）的踩坑局。没有在线 Rollout 确实爽，但被 Loss 曲线骗过的坑也是真的痛。"
date: 2026-06-10
order: 4
series: "post-training"
reading: "12 分钟"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

最近我在搭一个多角色扮演的后端服务，遇到最头疼的工程阻碍就是模型频繁“出戏”（Out of Character）。比如一个傲娇的大小姐设定，推理到第十轮时突然跳出“作为一个人工智能助手，我很乐意为您解答”的死板回复。

常规的解决方案是引入 RLHF 框架，但我核算了算力成本与工程复杂度：训练一个额外的奖励模型（RM），构建 PPO 循环进行在线 rollout 采样，并维护脆弱的 KL 散度约束，整体 ROI 极低。为了修补一个 tone-of-voice 缺陷而引入 PPO 这样不稳定的在线梯度更新流水线，从架构上就是一种极度浪费。

于是我将技术栈切向了 DPO（Direct Preference Optimization）。DPO 的核心工程价值在于：**它将 PPO 庞杂的在线强化学习循环，降维打击成了一个静态的离线分类问题。**

## 数学折叠：隐式奖励的推导

仔细阅读 [*Direct Preference Optimization* (Rafailov et al., 2023)](https://arxiv.org/abs/2305.18290) 的第 4 节，其推导过程展现了极佳的数学优雅。

传统 RLHF 的目标函数为：

$$
\max_{\pi_\theta}\; \mathbb{E}_{x,\,y\sim\pi_\theta}\big[\, r_\phi(x,y)\,\big]
\;-\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta(y\mid x)\,\|\,\pi_{\mathrm{ref}}(y\mid x)\right]
$$

其理论上的闭式最优解是：

$$
\pi^*(y\mid x) \;=\; \frac{1}{Z(x)}\,\pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\, r(x,y)\Big)
$$

$Z(x)$ 作为配分函数在工程上无法遍历计算。但 DPO 的精妙之处在于代数变形——将奖励 $r(x,y)$ 通过策略网络自身反向表达，然后代入 Bradley-Terry 偏好概率模型中。在好坏回答相减时，$Z(x)$ 会被直接抵消。

**策略模型被重载成了自己的奖励裁判。** 最终落地的损失函数不需要任何外置 RM：

$$
\mathcal{L}_{\mathrm{DPO}} \;=\; -\,\mathbb{E}_{(x,\,y_w,\,y_l)}\left[\log\sigma\!\left(
\beta\log\frac{\pi_\theta(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}
\;-\;
\beta\log\frac{\pi_\theta(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}
\right)\right]
$$

其计算流向如同一台纯粹的前向推断机：

```text
[ prompt ]
   |
   +-- (前向传播: 锚定 SFT 与参考模型)
   |
   +-> chosen (在设定内)   ----> [ 计算策略对数概率 ] ----> ↑ 似然推升
   |
   +-> rejected (出戏)     ----> [ 计算策略对数概率 ] ----> ↓ 似然打压
```

没有在线采样，没有额外的打分流。只需要构造偏好对，强行拉大两者的似然差。

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

## 梯度欺骗：绝对似然下沉

然而在初期测试中，训练集上的 Loss 稳健收敛，推断结果却全面崩坏——模型不仅丢失了预设腔调，连基本的语义连贯性都被严重破坏。

对 DPO 损失函数求导可知，其梯度内嵌了一个动态的 sigmoid 权重阀门。若模型对 rejected 的评估高于 chosen，阀门全开以修正错误；一旦两者差值拉开，梯度便迅速趋缓。**DPO 只优化相对边际，对绝对概率毫无感知。**

当模型难以学习复杂的 chosen 分布时，优化器会选择一条数学捷径：**无差别下调所有输出的绝对似然**，只要保证 rejected 降得比 chosen 猛即可。表现为 Loss 虽然在降，但 `chosen logprob` 也在持续暴跌——模型实际上正在丧失生成正确回答的能力。监控指标绝对不能止步于 Loss，必须拉出 `chosen logprob` 的独立监控图谱。这也是为何学术界后续提出 [*IPO* (Azar et al., 2023)](https://arxiv.org/abs/2310.12036) 等方法，试图通过修正损失函数来遏制概率下沉。

## 变量控制与飞轮构造

由于缺乏在线 Rollout 实时纠偏，DPO 对离线偏好数据的质量极其敏感。构造数据集时，我强制执行了唯一的硬性约束：**严格控制单一变量**。

Chosen 和 Rejected 必须在长度、信息量、排版上保持完全对齐，仅在核心缺陷（例如语气词的越界）上产生分歧。一旦存在长度差，DPO 会迅速将其作为作弊捷径。此外，偏好数据必须由当前 SFT 基座生成，直接灌入其他闭源模型的高维数据会引发严重的分布错位。

数据采集链路依托于类似数据飞轮的架构：模型批量采样 -> 规则验证器阻断式打分 -> 生成 chosen/rejected 对。人工仅介入验证器规则的编写与少量的抽样兜底。

## 异构部署：S-LoRA 的并发解法

面对几百个角色的并发推断需求，为每一个角色单独实例化 14B 参数模型会瞬间击穿集群显存。得益于 DPO 阶段采用的 QLoRA 架构，最终产物仅为适配器。在部署侧，我引入了 [*S-LoRA* (Sheng et al., 2023)](https://arxiv.org/abs/2311.03285) 作为调度后端，结合 vLLM 进行内存复用。

14B 基座模型在显存中常驻并作为共享内存。S-LoRA 的请求调度器在构建 Batch 时，会动态将对应的 LoRA adapter 加载至连续内存块。通过这种指针级的动态挂载，单张 GPU 成功支撑了数十个角色的高频并发推断，物理极限被再一次拓宽。
