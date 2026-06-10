---
title: "算力不够上 RLHF，就把 DPO 用对"
description: "DPO 好用，不是因为它神秘，而是因为它把奖励模型折进了一个离线目标。少了在线 rollout，省下的麻烦会回到另一处：偏好数据。"
date: 2026-06-10
order: 4
series: "post-training"
reading: "12 分钟"
tags: ["llm", "dpo", "alignment", "preference-data", "vllm"]
---

不是所有对齐问题都值得上整套 RLHF。做角色一致性、语气偏好、出戏惩罚时，我真正需要的往往不是在线探索，
而是一批足够干净的“这样更好 / 那样更糟”的配对。为这种问题训奖励模型、跑 rollout、再看 PPO 稳不稳，
有点像为了过一道门搬来一台挖掘机。

DPO 吸引我的地方正在这里：它把那台重机器折进了一个离线目标。训练脚本最后只是读
`prompt/chosen/rejected` JSONL，接上 TRL 的 `DPOTrainer`，用一个 `beta` 把策略钉在参考模型附近。少了
rollout，麻烦并没有消失，只是换了地方：偏好对要足够贴近参考模型，训练时还要盯住 chosen logprob 这种
容易被平均 loss 掩盖的信号。

## RLHF 到底买到了什么——而 DPO 又跳过了什么

RLHF(PPO 式)是三个运动部件:从偏好里训一个**奖励模型** $r_\phi$,再跑一个**在线 RL 循环**——
从策略采样、用 RM 打分、更新——外加一根 KL 缰绳保持理智。它真正在最大化的目标是

$$
\max_{\pi_\theta}\; \mathbb{E}_{x,\,y\sim\pi_\theta}\big[\, r_\phi(x,y)\,\big]
\;-\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta(y\mid x)\,\|\,\pi_{\mathrm{ref}}(y\mid x)\right].
$$

它很强,但它是一个要拟合的奖励模型、一个要看护的不稳定在线循环,以及不小的算力。DPO 的洞察是:对
*恰好这个目标*而言,你从来不需要那个循环。

## 唯一值得知道的那段推导

这个 KL 正则化目标有一个已知的闭式最优解。对任意奖励 $r$,最大化它的策略是

$$
\pi^*(y\mid x) \;=\; \frac{1}{Z(x)}\,\pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\, r(x,y)\Big),
$$

也就是把参考模型按指数化的奖励重新加权(这是标准的「奖励即后验」结论;$Z(x)$ 是对所有回复求和的
那个难算的归一化项)。现在把它反解——求出能产生某个给定策略的那个奖励:

$$
r(x,y) \;=\; \beta \,\log\frac{\pi^*(y\mid x)}{\pi_{\mathrm{ref}}(y\mid x)} \;+\; \beta\log Z(x).
$$

这就是那个戏法。奖励*隐含*在策略里——任何策略本身**就是**一个奖励模型,读法就是它对参考模型的
对数比。把这个表达式代进偏好的 Bradley-Terry 模型
$P(y_w \succ y_l) = \sigma\!\big(r(x,y_w)-r(x,y_l)\big)$,那些 $\beta\log Z(x)$ 项——也就是难算的
那部分——*互相抵消*,因为它们不依赖于回复。剩下的是一个你能直接从两个对数概率算出来的损失:

$$
\mathcal{L}_{\mathrm{DPO}} \;=\; -\,\mathbb{E}_{(x,\,y_w,\,y_l)}\left[\log\sigma\!\left(
\beta\log\frac{\pi_\theta(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}
\;-\;
\beta\log\frac{\pi_\theta(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}
\right)\right].
$$

没有奖励模型。没有采样。没有在线循环。每对四次前向(策略和参考,各跑 chosen 和 rejected)加一个
逻辑斯蒂损失。KL 缰绳没有消失——它通过 $\pi_{\mathrm{ref}}$ 和 $\beta$ *烤进了损失里*。

这几乎逐行对应训练脚本。`orbit/training/dpo_config.py` 里的 `generate_dpo_script` 是一个代码
生成器——它吐出一份独立的 Python 脚本,把 `trl` 的 `DPOConfig` + `DPOTrainer` 接起来,而它的每个
字段都是上面那些旋钮之一。推导里的 $\beta$ 是一个字面常量,`max_prompt_length` 则只是序列预算的一半:

```python
DPO_BETA = 0.1
training_args = DPOConfig(
    output_dir=OUTPUT_DIR,
    learning_rate=5e-6,
    beta=DPO_BETA,
    max_prompt_length={config.max_seq_length // 2},
    gradient_checkpointing=True,
    ...
)
trainer = DPOTrainer(model=model, train_dataset=dataset, peft_config=peft_config, ...)
```

几个决定可以直接从代码里读出来。`DPO_BETA = 0.1` 是写死的 KL 缰绳——小到足以让人设动起来,紧到
足以把它锚住。训练是 **QLoRA**:base 以 4-bit 加载
(`BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4")`),只训练一个 LoRA adapter——
这正是下面那套「每角色一份」的服务故事便宜的原因;脚本里甚至有一个可选的
`PeftModel.from_pretrained(...).merge_and_unload()` 块,用来从一份先前的 SFT adapter 起步 DPO。
而数据集是当作纯 JSONL 加载的——`load_dataset("json", data_files=DATASET_PATH, split="train")`,
读 `prompt` / `chosen` / `rejected` 行,正是文档字符串写明的格式:
*「Path to DPO JSONL (prompt/chosen/rejected format)」*。这份 JSONL 就是数据引擎和训练器之间的
全部接口——所以下一节讲的是这些对,而不是损失。

(一点诚实的提醒:这个生成器是一个自包含模板,把 `DPO_BETA`、`learning_rate` 和 LoRA target
modules 写死了,而不是像 SFT/GRPO 那条路一样把它们穿过 `SwiftConfig`——所以请把上面这些数字当成
*这个脚本的*默认值,而不是一个可调的配置面。)

<figure class="figure">
<svg viewBox="0 0 640 188" role="img" aria-label="DPO 直接在 chosen 与 rejected 对上训练">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.ok{fill:#eef6f4;stroke:#0f766e;stroke-width:1.5}.no{fill:#faf3ec;stroke:#b4530a;stroke-width:1.5}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="d1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="74" width="120" height="40" rx="8"/><text x="38" y="99" class="t">prompt</text>
  <rect class="ok" x="200" y="26" width="200" height="40" rx="9"/><text x="216" y="51" class="t">chosen(在人设内)</text>
  <rect class="no" x="200" y="118" width="200" height="40" rx="9"/><text x="216" y="143" class="t">rejected(出戏)</text>
  <path class="a" d="M140 86 Q170 50 200 46" marker-end="url(#d1)"/>
  <path class="a" d="M140 102 Q170 140 200 138" marker-end="url(#d1)"/>
  <text x="430" y="44" class="up">↑ 似然</text>
  <text x="430" y="138" class="dn">↓ 似然</text>
  <text x="430" y="92" class="s">锚定到 SFT</text>
  <text x="430" y="108" class="s">参考(内建 KL)</text>
</svg>
<figcaption>没有奖励模型,没有在线 rollout。一个对偏好对的离线损失,钉在 SFT 参考上,让模型在学会
偏好的同时无法漂移。</figcaption>
</figure>

## 这个梯度到底在做什么

「把 chosen 推上去、把 rejected 压下去」这个直觉对,但不完整。对损失求导,逐样本的梯度是

$$
\nabla_\theta \mathcal{L}_{\mathrm{DPO}} \;=\; -\beta\,\underbrace{\sigma\!\big(\hat r_\theta(y_l) - \hat r_\theta(y_w)\big)}_{\text{权重:我们错得多离谱}}
\Big[\nabla_\theta\log\pi_\theta(y_w\mid x) - \nabla_\theta\log\pi_\theta(y_l\mid x)\Big],
$$

其中 $\hat r_\theta$ 是隐式奖励 $\beta\log\frac{\pi_\theta}{\pi_{\mathrm{ref}}}$。方括号是「抬 chosen、
压 rejected」的期望方向。真正要紧的是前面那个标量:当模型当前*把这对排错了*(rejected 比 chosen
打分还高)时它很大,而当模型*已经偏好 chosen* 后它趋近于零。DPO 会自动把梯度花在它正在排错的对
上、忽略它已经排对的——一个内建的难样本加权,不需要你调任何课程表。

同一个机制也是 DPO 主要失败模式的来源,值得看清楚。损失只约束对数比的*差*。没有任何东西钉住绝对
水平——于是一个常见、略微惊悚的观察是:训练中 *chosen* 回复的对数概率会**下降**,只是比 rejected
降得慢。间隔在拉大,损失在下降,模型技术上正在精确优化你要求的东西——同时却越来越不可能产出你
偏好的那些答案。(正是这个缺口催生了 IPO 这类变体——它给目标加了界——以及保守版/cDPO 一族。要盯
chosen 的 logprob,别只盯损失。)

## 数据仍然是全部的游戏

DPO 的简洁只是把难度推回它一向所在的地方:**偏好对。**训练器并不关心你*怎么*产出这份 JSONL——它
只读 `prompt` / `chosen` / `rejected` 行——所以整个工程问题都在 `generate_dpo_script` 的上游。
手标足够多正是你想躲开的成本,所以契合的套路就是把[第 1 篇](/zh/blog/post-training-is-a-data-problem/)
那台数据引擎对准偏好:

- **自我批判**,对照一套写下来的角色原则去起草并修订回复,
- **一个裁判 / 打分器**(第 1 篇那个验证器或奖励模型给出的 `score`)把候选排成 chosen/rejected,
- 只在自动化定不下来的残差上做**人工复核**。

这把人力成本压缩成一层薄薄的顶,底下是一条基本合成的流水线。有个细节是推导让它没得商量的:这些对
应该来自一个*靠近你参考模型*的模型(理想情况是 SFT 检查点自己的采样)。DPO 的数学假设偏好数据落在
参考模型的分布里;从别的模型抽出来的对会制造一个训练/服务的分布鸿沟,悄悄削弱结果。「大致 on-policy」
的偏好数据不是锦上添花——它是这个目标的一条假设。

## 出戏陷阱

这里 DPO 最锋利的用法是有的放矢,而不是泛泛而为。出戏(OOC)滑坡——模型破人设、漏出自己是助手、
掉了说话腔调——是会杀死一个角色扮演产品的失败。所以偏好对就是冲着*恰好这个*构造的:**rejected**
是一个貌似合理但出戏的回复,**chosen** 是在人设内的那个,并且**配对**到让两者唯一显著的差别就是你
想惩罚的那件事。最后这点是梯度干净的关键——如果 chosen 和 rejected 在长度、话题*和*人设上都不同,
DPO 可以靠利用其中任何一个来拉低间隔,你就教了它错的功课。一个构造良好的对只隔离一个维度,这时
DPO 学到的是对出戏行为的精确下压——一个本来要靠整套 RM + RL 循环才能表达的惩罚信号,这里仅靠
构造配对就买到了。

叠在第一阶段 SFT(人设、风格、身份逻辑)之上,这套 `SFT → DPO` 配方提升了角色一致性和多轮可控性,
而且比纯 SFT 或整套 RLHF 流水线都更快更稳。

## 同时服务很多角色

对齐不到部署不算完。一个角色扮演产品是*很多*人设,不是一个,而给每个角色加载一个完整微调不可扩展——
比如一个 14B 参数模型用 fp16 存,每个角色就是约 28 GB 权重,你服务不了几个 GPU 就满了。服务端
改用 **vLLM + S-LoRA**:人设是 LoRA 适配器(14B 模型上 rank-16 每个大概几十 MB,比 base 小约
1000 倍),很多个复用*同一个*共享 base、在同一张 GPU 上。S-LoRA 把适配器放在一个统一池里,并把命中
*不同*适配器的请求批在一起,于是单个部署能高吞吐地并发扮演几十个角色——这就是「每个角色一个模型」
和「一个 base,角色只是廉价增量」的差别。

## 要点

让方法配得上目标。**DPO 用于偏好、风格、人设对齐**——离线、稳定,大部分成本是好的偏好数据。它的
简洁挣得很诚实,靠一段把奖励模型坍缩成对数比的推导。但同一段推导也告诉你它的极限:它优化的是间隔,
不是绝对值,而且它假设近似 on-policy 的数据——忽略其一,损失会愉快地下降,而模型在变差。把
GRPO/RLHF 那套机器留给你真正需要对可验证奖励做在线探索的场合,比如那个规划 Agent。在轻工具就够用
的地方动用重工具,本身就是一种 reward hacking——黑的是你自己的时间。

## 延伸阅读

- [Direct Preference Optimization](https://arxiv.org/abs/2305.18290) —— 原始推导;§4 值得慢慢读。
- [IPO / "A General Theoretical Paradigm…"](https://arxiv.org/abs/2310.12036) —— 为什么无界的 DPO 目标会过拟合,以及一个有界的替代。
- [S-LoRA](https://arxiv.org/abs/2311.03285) —— 在一个 base 上服务上千个 LoRA 适配器。
