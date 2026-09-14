---
title: "你到底在奖励什么?"
description: "规划 Agent 如何结合约束验证器与奖励模型，以及过程奖励、KL 正则和奖励过度优化的检查方式。"
date: 2026-06-10
order: 3
series: "post-training"
reading: "13 分钟"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

奖励分数上升，很容易被当成任务能力提升。但模型优化的是写进奖励函数的数值；如果它与实际目标有差异，策略就会利用这种差异。

我在规划 Agent 上反复遇到这个问题：方案看起来合理，实际超了预算；路线看起来顺，时间窗却排不开。奖励模型（RM）有时会给这些方案高分，RL 随后就会利用这些误判。所以我把能用程序检查的约束写进 `VerifierResult`，其余判断才交给 RM。

这就是 [古德哈特定律 (Goodhart's Law)](https://en.wikipedia.org/wiki/Goodhart%27s_law) 在后训练里的样子：*当一个度量变成目标，它就不再是一个好的度量。* Manheim 与 Garrabrant 在 [*Categorizing Variants of Goodhart's Law* (2018)](https://arxiv.org/abs/1803.04585) 中将回归型、极值型、对抗型失效分开，这帮助我区分了后来遇到的 RM 失效。排查时，我关心的是策略偏离到什么程度，奖励就不再反映实际质量，以及能否在此之前停止优化。

## 两种奖励与物理隔离

**验证器(RLVR)**。一段固定的代码去检查输出。方案是否没超预算？时间窗是否真的排得开？最终的数是否正确？当正确性可被程序校验时，这是黄金标准。它的核心价值在于：只要检查是完备的，它没有可供利用的盲点。

**奖励模型(RM)**。当没有程序能判时，一个学出来的模型给质量打分。判断“方案合理且可执行吗”没有干净的 oracle。RM 给你一个验证器够不到的信号。但它本身是个拟合出的网络，必然存在决策边界的盲区，而策略会用极大似然去试探每一个盲区。

验证器与真实目标的相关性对优化压力是平坦的——它是一段确定性程序，真正没超预算的方案始终会被判为正确，不存在移出训练分布的问题。RM 正好相反：它是有限样本上拟合出的有限模型，与真相的相关性随着策略移出分布而急剧衰减。每一步优化，都是朝着 RM 从没见过、最可能出错的输入迈进。基于这种不对称，我的架构设计是：把所有可校验的逻辑下沉到验证器，只让 RM 兜底不可计算的模糊余项。

规划 Agent 的真实奖励被拆解为这样一条计算流：

```text
[ 策略输出方案 ]
       |
       +---> (精确计算) 验证器 (Verifier)  ---> [ 预算 / 时间窗 / 可行性 ] (硬约束信号)
       |
       +---> (统计推断) 奖励模型 (RM)      ---> [ 语义合理性 / 语气 ] (软质量得分)
       |
       v
    最终奖励 (Reward) = \lambda_1 * 验证器得分 + \lambda_2 * RM 得分
```

## 代码里的验证器实现

在 Orbit 项目里，验证器被收敛成一个协议（`Protocol`）。在 [`orbit/verifiers/base.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/verifiers/base.py) 中，它只负责把轨迹映射为结构化奖励。契约由两个 pydantic 模型承载：`VerifierSpec` 持有超参旋钮，`VerifierResult` 持有拆解后的输出：

```python
class VerifierSpec(StrictModel):
    kind: str = "static_trace"
    gamma: float = 0.99
    lambda_delta: float = 1.0   # 势函数塑形权重
    lambda_g: float = 1.0       # 局部(每步)分数权重
    lambda_env: float = 1.0     # 环境奖励权重
    lambda_u: float = 1.0       # 终局效用权重
    process_weight_max: float = 4.0
    baseline_strategy: str = "trajectory_mean"
```

奖励并不是单一标量。在 [`orbit/verifiers/static.py`](https://github.com/wangtong10086/orbit/blob/main/orbit/verifiers/static.py) 中，`StaticTraceVerifier.verify` 用四个加权项拼出每步的密集奖励：

```python
reward = (
    self.spec.lambda_delta * (phi_prefix[idx + 1] - phi_prefix[idx])  # 势函数差分
    + self.spec.lambda_g * local_scores[idx]                          # 单步即时奖励
    + self.spec.lambda_env * env_rewards[idx]                         # 外部环境反馈
)
if idx == len(local_scores) - 1:
    reward += self.spec.lambda_u * terminal_score                     # 终局结算
```

第一项是基于势的塑形 (Potential-based Shaping)。根据经典强化学习理论，势函数 $\phi$ 在两步之间的差分，能在不改变最优策略的前提下加入稠密引导，这可以在数学上规避 reward hack。随后对这些反馈进行折现计算，并用 `process_weight_max` 进行硬裁剪。裁剪限制了单步的异常优势梯度，避免它主导策略更新。

## 奖励崩溃的缩放律

开发时我遇到过这样的背离：训练 Reward 持续上涨，留出集 Benchmark 却停滞甚至下降。模型过拟合了 RM 的评分方式，实际任务表现没有改善。如 DeepMind 收录的 [Specification gaming 案例集](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4) 所示，Agent 总能找到违背精神却满足字面的漏洞。

Gao、Schulman 与 Hilton 在 [*Scaling Laws for Reward Model Overoptimization* (2022)](https://arxiv.org/abs/2210.10760) 中精确刻画了这种现象：代理 RM 分数单调上升，而真实金标准分数先升、见顶、然后回落。金标准奖励可以拟合为 KL 距离 $d = \sqrt{\mathbb{D}_{\mathrm{KL}}}$ 的函数：

$$
R(d) \;=\; d\,(\alpha - \beta \log d)
$$

这个拟合意味着，存在一个最优 KL 距离，超过这个预算，每多 1 nat 的散度带来的都是真实性能的倒退。扩大 RM 规模能推迟这个顶点的到来，但无法消灭它。

另外，正如 Pan 等人在 [*The Effects of Reward Misspecification* (2022)](https://arxiv.org/abs/2201.03544) 中指出的，随着能力提升，策略会发生相变式跳变，骤然发现并利用 hack。

## 缝隙的闭环策略

1. **补全验证器**。把所有可计算约束写进程序，这是我最优先处理的部分。
2. **保留 KL 正则**。带 KL 正则的目标具有闭式最优解：
   $$
   \pi^*(y\mid x) \;\propto\; \pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\,r(x,y)\Big).
   $$
   $\beta$ 决定了允许奖励倾斜参考先验的力度。那些为了刷分而产生的乱码或格式复读，正是由于 $\pi_{\mathrm{ref}}$ 给出的先验概率近乎为零，所以可以通过调节 $\beta$ 作为强力刹车。
3. **对抗更新**。策略学会的新把戏就是 RM 的 Out-of-Distribution 样本。必须将策略的失败模式持续打标并重训 RM，保持分布同步。
4. **信评测，不信奖励**。留出集的验证器 Benchmark 才是唯一的真相。

最终，我在规划 Agent 上拿到了复杂约束满足率 12% 的内部 Benchmark 涨幅。改进来自补全验证器、将硬约束完全移出 RM，以及持续处理策略产生的新 exploit，优化器本身没有变化。
