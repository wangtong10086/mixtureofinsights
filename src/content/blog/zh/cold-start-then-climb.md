---
title: "冷启动,再往上爬"
description: "在一个难任务上、从 base 模型直接做纯 RL,产出的多半是高方差的垃圾——而策略梯度的数学能精确说出为什么。解法是一套两阶段配方:先用小规模 SFT 冷启动给策略一个形状,再用 GRPO 往上爬。这篇给出配方、数学,以及真正会咬人的失败模式。"
date: 2026-06-12
order: 2
series: "post-training"
reading: "13 分钟"
tags: ["llm", "rl", "grpo", "sft", "reasoning"]
---

强化学习改进的是一个你*已经拥有*的策略。把它指向一个 base 模型加一个难任务——硬约束下的长链路
规划——你就会撞上那个坑:如果策略几乎从不偶然走出一条好轨迹,RL 就没有东西可放大。你得到的是高
方差、缓慢的进展,以及看起来像噪声的奖励曲线。解法是别从冷的开始。这是我一再回到的配方——这次
把数学也摆出来,因为正是数学告诉你这套配方*什么时候*是必需的。

## 为什么 RL 之前要冷启动:梯度自己会说话

从 REINFORCE 到 GRPO,所有策略梯度方法都是下面这个式子的某种变体:

$$
\nabla_\theta J(\theta) \;=\; \mathbb{E}_{y \sim \pi_\theta}\big[\, A(y)\, \nabla_\theta \log \pi_\theta(y \mid x) \,\big],
$$

一个**对策略自身采样**取的期望。把它读成一笔搜索预算:一个行为对梯度的贡献,正比于策略当前产出
它的频率。如果一条好轨迹在 base 模型下的概率是 $10^{-4}$,而你每个 prompt 采 8 条 rollout,那么
大约每 1,250 个 prompt 才能见到一条——其余 9,999 份梯度贡献全是朝任意方向乱推的噪声。RL 不会
*凭空变出*行为,它只会*重新加权*行为。概率 ≈ 0 就意味着梯度 ≈ 0,哪怕你给它挂上再大的奖励。

还有一个更阴险的项:方差。在稀疏的 0/1 奖励下,梯度估计的方差按 $p(1-p)$ 摊到你的采样预算上——
恰好在成功率最低、你最需要信号的区间里最糟。这就是为什么"从 base 直接纯 RL"在难的垂直任务上,
奖励曲线能平成几千步的噪声:信号存在,但被你的 batch size 付不起的采样方差埋掉了。

一次小而干净的 **SFT 冷启动**修好的就是这个起点。你不是想端到端地教会任务;你是把
$p(\text{好轨迹})$ 从 $10^{-4}$ 抬到比如 $10^{-1}$——到了这个量级,8 条样本的组里几乎每个
prompt 都包含一组可用的对比,同一个刚才还在噪声里空转的 GRPO 循环,突然就爬起来了。冷启动买到的
是*样本效率*,不是能力。

## 四步配方(R1 味)

这复刻了 DeepSeek-R1 的冷启动思路,改造到一个垂直任务上:

1. **在 base 上用 GRPO 探索。** 直接在 base 上跑 GRPO,逼出长思维链规划——让它在奖励压力下,去
   发现哪些推理路径能抵达有效方案。这个阶段*预期*就是难看的;你在挖稀有的好轨迹,不是在训练产品。
2. **拒绝采样出种子。** 从那次探索里,只留下高正确率的 `推理 → 规划` 样本(由你的验证器判定——见
   [第 1 篇](/zh/blog/post-training-is-a-data-problem/))。这就是你的 SFT 种子:小(数千的量级,
   不是几十万)、干净、且——关键——是*模型自己的语气*,所以在它上面做 SFT 不会像人写的示范那样
   跟模型的分布打架。
3. **SFT 冷启动。** 在种子上微调 base。一到两个 epoch;你要的是格式和习惯,不是背诵。模型现在能
   稳定地*产出*你想要的形状。
4. **正式上 GRPO。** 现在跑主 GRPO 阶段,用一个对你真正在意的东西打分的奖励——约束满足、
   预算/时间一致性、路线可行性——让它往上爬。

两个阶段,一句话:**SFT 给策略一个形状,GRPO 拿奖励把它磨锋利。**

## 两个阶段如何对应到代码

在 Orbit 里,两个阶段是*同一个*配置对象——`orbit/training/config.py` 里的 `SwiftConfig`——
只是翻转 `train_type`。冷启动是 `train_type="sft"`;往上爬是 `train_type="rlhf",
rlhf_type="grpo"`。`SwiftConfig.to_yaml_dict()` 只在这一对被设上时才吐出 GRPO 专属的旋钮:

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

下面整个 GRPO 故事都压在三个字段上。`num_generations` 就是组大小 $K$——它的默认值是 `8`,正是上面
梯度论证里那句「每个 prompt 采 8 条 rollout」。`beta` 是 KL 惩罚系数 $\beta$。`reward_funcs` 是
验证器喂给 RL 的方式:这里点名的奖励函数就是给每条 rollout 打分的那个程序——正是
[第一篇](/zh/blog/post-training-is-a-data-problem/)里验证器的角色,如今产出每条 rollout 的奖励
$r_i$,再被 GRPO 标准化成优势。`SwiftBackend.validate_config`(在 `orbit/training/sft.py`)在任务
启动前就把这套组合卡住,拒绝任何不在已知集合
(`{"dpo", "grpo", "kto", "cpo", "simpo", "orpo", "ppo", "gkd"}`)里的 `rlhf_type`。

冷启动的*种子本身*由第一篇的拒绝采样路径构建——`filter_quality(records, min_score=...)` 只留下
高 `score` 的 `推理 → 规划` 样本,`build_ms_swift_dataset` 把它们打包成 SFT 阶段消费的
`{"messages": [...]}` 行。两个阶段,同一种数据集格式,同一个构建器。

## GRPO,这次带上真正的数学

PPO 需要一个独立的 *critic* 网络去估计逐 token 的价值基线——对 LLM 来说那是第二个和策略一样大
的模型:它的显存、它的前向、它自己的训练不稳定性。GRPO(出自 DeepSeekMath)用一个对可验证奖励
来说近乎朴素到不好意思的技巧,把它整个删掉了。

对每个 prompt $x$,从当前策略采一**组** $K$ 条回复 $y_1,\dots,y_K$,逐条用奖励打分。第 $i$ 条的
优势就是它的分数对组内做标准化:

$$
\hat{A}_i \;=\; \frac{r_i - \operatorname{mean}(r_1,\dots,r_K)}{\operatorname{std}(r_1,\dots,r_K)}
$$

再把这个 $\hat{A}_i$ 塞进熟悉的 PPO 式裁剪代理目标,外加一个对参考模型的显式 KL 惩罚:

$$
\mathcal{L} \;=\; -\,\mathbb{E}\!\left[\min\!\big(\rho_t \hat{A}_i,\;
\operatorname{clip}(\rho_t,\, 1-\varepsilon,\, 1+\varepsilon)\, \hat{A}_i\big)\right]
\;+\; \beta\, \mathbb{D}_{\mathrm{KL}}\!\left[\pi_\theta \,\|\, \pi_{\mathrm{ref}}\right],
\qquad
\rho_t = \frac{\pi_\theta(y_t \mid x, y_{<t})}{\pi_{\theta_{\mathrm{old}}}(y_t \mid x, y_{<t})}.
$$

<figure class="figure">
<svg viewBox="0 0 620 196" role="img" aria-label="GRPO 组内相对优势">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.4}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.up{fill:#0f766e;font:12px sans-serif;font-weight:700}.dn{fill:#b4530a;font:12px sans-serif;font-weight:700}.a{stroke:#6b6862;stroke-width:1.3;fill:none}</style>
  <defs><marker id="g1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="78" width="120" height="40" rx="8"/><text x="36" y="103" class="t">prompt</text>
  <text x="170" y="30" class="s">采样 K = 4</text>
  <rect class="n" x="170" y="22" width="150" height="26" rx="6"/><text x="184" y="40" class="t">回答 · 得分 0.9</text>
  <rect class="n" x="170" y="56" width="150" height="26" rx="6"/><text x="184" y="74" class="t">回答 · 得分 0.6</text>
  <rect class="n" x="170" y="90" width="150" height="26" rx="6"/><text x="184" y="108" class="t">回答 · 得分 0.4</text>
  <rect class="n" x="170" y="124" width="150" height="26" rx="6"/><text x="184" y="142" class="t">回答 · 得分 0.1</text>
  <path class="a" d="M140 98 H170" marker-end="url(#g1)"/>
  <text x="350" y="86" class="s">均值 = 0.5</text>
  <text x="350" y="40" class="up">+0.4 ↑</text>
  <text x="350" y="74" class="up">+0.1 ↑</text>
  <text x="350" y="108" class="dn">−0.1 ↓</text>
  <text x="350" y="142" class="dn">−0.4 ↓</text>
  <text x="445" y="92" class="s">优势 = 得分 − 均值</text>
  <text x="445" y="110" class="s">没有 critic 网络</text>
</svg>
<figcaption>GRPO 的优势完全是相对同一 prompt 的其他样本而言的。组就是它自己的基线——这正是当
奖励可验证时它既便宜又稳定的原因。</figcaption>
</figure>

组均值干的正是 PPO 的 critic 干的活——提供一个基线,把裸奖励变成「比预期更好还是更差」——只不
过它是用 $K$ 个兄弟样本估出来的,而不是用一个训练出来的网络预测的。你拿第二个模型换了每个 prompt
$K$ 倍的采样。对可验证奖励来说,打分几乎免费、采样本来就是主要开销,这笔交易非常划算:实践中
rollout 阶段(一个 vLLM 实例给每个 prompt 生成 $K$ 条)吃掉 70–90% 的墙钟时间,真正的策略更新
反而是便宜的那部分。

调参之前值得知道:分母里那个看起来人畜无害的 $\operatorname{std}$ 是一个已知的偏差来源。除以组内
标准差会系统性地加权策略*输出一致*(低离散度)的 prompt,而原始的 token 级归一化让「长的错答案」
每 token 比「短的错答案」更便宜——两者都被「Dr. GRPO」的分析记录在案,也是后续若干工作(DAPO 在内)
去掉或修改归一化的原因之一。你不需要背住每个变体;你需要知道默认配方的天平上是压着手指的。

## 真正会咬人的几件事

- **死组问题。** 如果 $K$ 条样本拿到同一个奖励——全错,或全对——那么对每个 $i$ 都有
  $r_i - \operatorname{mean}(r) = 0$:这一组贡献的梯度是*零*,而采样成本你一分没少付。难任务训练
  早期,大多数组都是全错组。这就是冷启动论证用 GRPO 自己的语言重述了一遍,也是 DAPO 式**动态采样**
  (对退化组重采或跳过)存在的原因。盯住每个 batch 里「活组」的比例;它是你手上最诚实的进度表。
- **KL 缰绳拴着,并且想清楚 $\beta$ 在换什么。** 没有 KL 项,策略会漂进被奖励黑掉的退化文本。拴得
  太紧,它出不了 SFT 的盆地——奖励早早到顶。没有普适的数值(公开配方的典型值从 $10^{-3}$ 到
  $10^{-1}$ 不等);真正该看的观测量是 KL 曲线本身。缓慢增长是在学习;突然的尖峰通常是策略发现了
  一个 exploit。
- **盯熵,别只盯奖励。** 策略熵早期塌掉,意味着探索死了、这一轮在收敛到它最先碰到的东西;熵在后期
  *上升*往往意味着退化。两种情况奖励曲线都不会告诉你——两个都要记日志。
- **显式地塑形长 CoT。** 长度和格式奖励能阻止模型要么塌缩成不推理的短答、要么为了长度奖励而车轱辘
  话。但记住:每个塑形项都是一个新的可黑表面——长度奖励就是经典的自找的 reward hack
  ([下一篇](/zh/blog/what-are-you-rewarding/)整篇都在讲这个)。
- **组大小是旋钮,不是常数。** $K$ 控制的是 $\operatorname{mean}(r)$ 作为基线估计的方差:太小
  (2–4)优势就吵;太大就是为递减收益烧 rollout 预算。公开配方大多落在 $K = 8$–$64$。正确的问题
  是「在我当前的通过率下,$K$ 要多大,一个典型的组里才能同时出现一条成功和一条失败?」——通过率
  为 $p$ 时,组是*活的*的概率是 $1-p^K-(1-p)^K$。$p=0.05$、$K=8$ 时约 34%;$K=16$ 时约 56%。
  这下冷启动的职责被量化了:把 $p$ 抬到一个适中的 $K$ 就能让大多数组活着的水平。

在那个规划 Agent 上,这套两阶段 `SFT 冷启动 → GRPO` 流水线——由一个约束感知的奖励对齐——在内部
基准上把复杂约束满足率提了约 12%,幻觉方案也明显减少,*而且*没用大规模人工标注集。这个结果里安静
的英雄不是 GRPO,是那个奖励。这正是我们下一站要去的地方。

## 延伸阅读

- [DeepSeekMath](https://arxiv.org/abs/2402.03300) —— GRPO 的出处(§4)。
- [DeepSeek-R1](https://arxiv.org/abs/2501.12948) —— 前沿规模上的冷启动 → RL 配方;R1-Zero 就是「从 base 纯 RL 会怎样」的消融实验。
- [DAPO](https://arxiv.org/abs/2503.14476) —— 死组的动态采样、clip-higher、token 级损失;一份 GRPO 的实践者补丁清单。
- [Dr. GRPO](https://arxiv.org/abs/2503.20783) —— 上文提到的 std 归一化与长度偏差分析。
