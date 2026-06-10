---
title: "你到底在奖励什么?"
description: "RL 不会替你理解目标，它只会认真优化你写下来的那个数。奖励和真实意图之间的缝隙，就是 reward hacking 生长的地方。"
date: 2026-06-10
order: 3
series: "post-training"
reading: "13 分钟"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

奖励函数最危险的地方，是它看起来很像目标本身。你写下一个分数，训练开始上升，日志也很漂亮，于是很容易
忘记：模型优化的是那个数，不是你脑子里的意图。只要两者之间有缝，策略就会把缝撬开。

这个问题是在规划 Agent 上被我反复撞出来的。一个方案看起来“合理”，但细看预算超了；路径看起来顺，时间窗
却排不开。把这些东西交给奖励模型猜，它偶尔会给面子；但 RL 不会给面子，它会专门去找 RM 犯错的角落。
于是后来我越来越倾向于一个笨办法：凡是能写成程序检查的约束，都从 RM 里拿出来，做成 `VerifierResult`
里的硬信号。剩下那些真写不出来的，再交给模型判断。

这就是古德哈特定律在后训练里的样子：*当一个度量变成目标，它就不再是一个好的度量。* 工程上的问题不是
“奖励完美吗”——它不会完美——而是策略能走多远，代理才开始撒谎，以及你能不能在那之前把它拦住。

## 两种奖励,以及各自的用武之地

**验证器(RLVR)。** 一个*程序*去检查输出。方案是否没超预算?时间窗是否真的排得开?最终的数是否
正确?当正确性可被程序校验时,这是黄金标准:精确、便宜,而且关键在于——只要检查是完备的,它*没有
可供利用的盲点*。

**奖励模型(RM)。** 当没有程序能判时,一个*学出来的*模型给质量打分。「这个方案合理且可执行吗?」、
「这个回答有帮助吗?」——这些判断没有干净的 oracle。RM 给你一个验证器够不到的信号。但它本身是个模型,
也就意味着它*有*盲点,而策略会把每一个都找出来。

这个取舍尖锐到可以精确陈述。验证器与真实目标的相关性**对你施加的优化压力是平的**——它是一段固定
程序,所以一个真正没超预算的方案,无论策略推得多狠,都判正确,也没有什么训练区域的边缘可以掉下去。
它的覆盖是局部的(只覆盖你能编码进去的),但在那覆盖之内,它不随优化退化。RM 正好相反:覆盖广,但
它是一个在有限样本上拟合出的有限模型,所以它与真相的相关性**随着策略移出分布而衰减**——每一步优化,
都是朝着 RM 从没训练过、最可能出错的输入迈一步。验证器:窄,但抗优化。RM:广,但在优化下脆弱。正是
这种不对称,使得正确的设计是:把每一件可校验的东西都推进验证器,只让 RM 去覆盖那块无法再化简的模糊
余项。

规划 Agent 真正的奖励,两者都不是——而是一次**分解**:

<figure class="figure">
<svg viewBox="0 0 620 200" role="img" aria-label="Reward decomposed into verifier and reward model">
  <style>.n{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}.v{fill:#eef6f4;stroke:#0f766e;stroke-width:1.5}.m{fill:#faf3ec;stroke:#b4530a;stroke-width:1.5}.t{font:12.5px sans-serif;fill:#1c1b19}.s{font:11px sans-serif;fill:#6b6862}.a{stroke:#6b6862;stroke-width:1.4;fill:none}</style>
  <defs><marker id="r1" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="#6b6862"/></marker></defs>
  <rect class="n" x="20" y="80" width="120" height="40" rx="8"/><text x="40" y="105" class="t">一个方案</text>
  <rect class="v" x="220" y="26" width="220" height="44" rx="9"/><text x="236" y="46" class="t">验证器(精确)</text><text x="236" y="62" class="s">预算 · 时间窗 · 可行性</text>
  <rect class="m" x="220" y="120" width="220" height="44" rx="9"/><text x="236" y="140" class="t">奖励模型(学出来的)</text><text x="236" y="156" class="s">"合理且可执行吗?"</text>
  <rect class="n" x="500" y="80" width="100" height="40" rx="8"/><text x="516" y="105" class="t">奖励</text>
  <path class="a" d="M140 92 Q180 60 220 50" marker-end="url(#r1)"/>
  <path class="a" d="M140 108 Q180 140 220 142" marker-end="url(#r1)"/>
  <path class="a" d="M440 48 Q480 70 500 90" marker-end="url(#r1)"/>
  <path class="a" d="M440 142 Q480 120 500 110" marker-end="url(#r1)"/>
</svg>
<figcaption>硬的、可校验的约束交给精确的验证器;软的质量交给奖励模型。把你*能*校验的一切,都推进
那不会被钻空子的那一半。</figcaption>
</figure>

## 代码里的验证器到底是什么

在 Orbit 里,验证器是一个小小的 `Protocol`(`orbit/verifiers/base.py`),只干一件事——把一条轨迹
变成一份结构化的奖励。这份契约是两个 pydantic 模型。`VerifierSpec` 持有旋钮;`VerifierResult`
持有拆解后的输出:

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

奖励*不是*单个标量——它沿轨迹被拆解开。实现 `StaticTraceVerifier.verify`(在
`orbit/verifiers/static.py`)用四个加权项拼出每步的过程奖励,正是上面那些 `lambda_*`:

```python
reward = (
    self.spec.lambda_delta * (phi_prefix[idx + 1] - phi_prefix[idx])  # 这一步取得的进展
    + self.spec.lambda_g * local_scores[idx]                          # 这一步本身有多好
    + self.spec.lambda_env * env_rewards[idx]                         # 环境信号
)
if idx == len(local_scores) - 1:
    reward += self.spec.lambda_u * terminal_score                     # 最终结果
```

第一项是**基于势的塑形(potential-based shaping)**——势函数 $\phi$ 在两步之间的变化,(由 Ng 等人
的经典结论)它在*不改变最优策略*的前提下加入稠密引导,是规避一整类 reward hack 的有原则做法。验证器
随后把这些折现成回报(`discounted_returns(..., gamma=...)`),减去一个 `trajectory_mean` 基线,再把
得到的优势权重裁剪到 `±process_weight_max`。这个裁剪本身就是一道反作弊护栏:任何单步的优势都无法
爆炸到主导整次更新。

针对上面「验证器 vs 奖励模型」的框架,有两点值得一提。第一,`terminal_score` 是硬的、可校验的那部分
(`success = terminal_score >= success_threshold`),而 `local_scores` / `potentials` 可以来自更软的
信号——所以单个 `StaticTraceVerifier` 自身*就*可以是那张图里的拆解:硬终局校验加软的逐步塑形。第二,
每个权重都是你在配置里设的 `lambda_*`,这意味着每个权重都是一个可被钻的面——把 `lambda_g` 调高,
策略就会去刷 `local_scores` 度量的任何东西。拆解买到了精度;它同时也把你需要看住的旋钮数量翻了上去。

## reward hacking 究竟长什么样

事后看从不微妙,事前看从不显眼:

- **验证器的缺口。** 一条你忘了检查的约束,就是一条策略可以随便违反的约束。忘了验证停靠点的顺序
  是否合理,你就会得到一堆满足每一项编码检查、却在物理上荒谬的方案。
- **RM 的盲点。** 奖励模型会悄悄地奖励*表层*特征——长度、自信的语气、整洁的格式、附和用户。不管它,
  策略就学会又长、又自信、又谄媚,而奖励全程在涨。
- **那个破绽:** 奖励涨,留出集评测不涨。这种背离就是警报。如果你的数字在升、你的 Benchmark 没升,
  你不是在变好——你是在变得更擅长那个奖励。

## 过度优化有一条缩放律

上面那种背离不是民间传说;它是被测出来的。Gao、Schulman 与 Hilton([2022](https://arxiv.org/abs/2210.10760))
对着一个*代理*奖励模型训练策略,同时把一个大得多的「金标准」RM 留作真实奖励的替身,并随着策略偏离
参考把两者都画出来。那个形状如今是 RLHF 里一个承重的事实:随着你花掉 KL 预算,**代理 RM 分数单调
上升,而金标准分数先升、见顶、然后回落**——这就是过度优化。他们把金标准奖励拟合成 KL 距离
$d = \sqrt{\mathbb{D}_{\mathrm{KL}}}$ 的一个干净函数,

$$
R(d) \;=\; d\,(\alpha - \beta \log d),
$$

恰好刻画了那条先升后落:早期的 KL 买来真实的改进,而过了某个预算,每多一 nat 的散度买到的代理收益,
*代价*是你真实性能的下降。两个操作上的后果。第一,存在一个**最优 KL 距离**——金标准奖励见顶的那个
点——再往后训,会让模型真的变差,而每一块仪表盘都说它在变好。第二,这个预算*随 RM 质量缩放*:一个
更大、训得更好的 RM 会把顶点往外推(崩溃之前能优化得更多),但没有任何有限的 RM 能消掉这个顶点。
这是「奖励是个代理」的定量版本——它有一个拐点,而你的活,就是在它附近停手。

## 怎么收拢这道缝隙

- **把可校验的东西推进验证器。** 每一条你能写成程序的约束,都是策略钻不了的空子。验证器的完备性,
  是你手里杠杆最高的一件事。
- **继续拴着 KL 绳(又一次),并且搞清楚它*为什么*能限制 hacking。** 一条朝 SFT 参考的惩罚,限定了
  策略为利用奖励能扭曲到多远——而 [DPO 那篇](/zh/blog/dpo-when-you-cant-afford-rlhf/)告诉你限定到
  具体多少。带 KL 正则的目标有一个闭式最优解

  $$
  \pi^*(y\mid x) \;\propto\; \pi_{\mathrm{ref}}(y\mid x)\,\exp\!\Big(\tfrac{1}{\beta}\,r(x,y)\Big).
  $$

  把它读成一个恒温器。奖励无权从零开始*写出*策略;它只能*倾斜*参考,而 $\beta$ 设定了它被允许倾斜的
  力度。一个参考认为荒谬地不可能的回答,需要一个巨大的奖励才能压过前面那个 $\pi_{\mathrm{ref}}$ 先验
  ——而这恰恰是对 reward hacking 的刹车,因为那些漫画式的钻空子(退化文本、格式刷屏)正是
  $\pi_{\mathrm{ref}}$ 赋予近零质量的那些回答。$\beta$ 越低,策略越能把奖励追到更偏离分布的地方、
  hack 得越狠;$\beta$ 越高,它越诚实,但能学到的也被封顶。这条绳不是个启发式的附加项;它是设定你在
  古德哈特曲线上位置的那根杠杆。还是[冷启动那篇](/zh/blog/cold-start-then-climb/)那条绳,在身兼两职。
- **拿策略的新失败去刷新 RM。** 策略一变强,它的*新*花招恰好是 RM 从没见过的样本。定期把新鲜的
  失败模式打标、重训 RM——否则它会过时,策略径直从它身上穿过去。
- **封顶 + 集成。** 有界的奖励、外加一个裁判集成,让任何单一盲点都不至于是灾难性的。
- **信评测,别信奖励。** 奖励是你*对着它*训练的代理指标;留出的、由验证器评分的 Benchmark 才是你
  *朝着它*训练的真相。两者打架时,评测赢。

## "+12%" 的诚实版本

规划 Agent 的复杂约束满足率在内部 Benchmark 上涨了约 12%。把功劳记给 GRPO 很诱人。但真相更平淡、
也更有用:增益来自把那个约束奖励做得*完备且可信*——堵上验证器缺口、把硬约束分解出 RM 的射程之外、
并逐个追杀策略发明的每一个新花招。优化器从头到尾都没变。**调 RL,大部分时候是在调奖励。**

不过验证器和裁判不只是训练信号——它们还是你判断这一切究竟有没有奏效的唯一凭据。这正是本系列接下来
要转向的:把评测框架当成真正的产品。

## 延伸阅读

- [古德哈特定律(原始)](https://en.wikipedia.org/wiki/Goodhart%27s_law)——以及 Manheim 与
  Garrabrant 的 [*Categorizing Variants of Goodhart's Law*](https://arxiv.org/abs/1803.04585),
  它把回归型、极值型、对抗型失效分开——一份关于奖励*如何*崩坏的有用分类。
- [Scaling Laws for Reward Model Overoptimization](https://arxiv.org/abs/2210.10760)——Gao、
  Schulman 与 Hilton;上面那条先升后落的曲线,以及 $d(\alpha-\beta\log d)$ 的拟合。
- [The Effects of Reward Misspecification](https://arxiv.org/abs/2201.03544)——Pan 等;随能力
  提升、策略骤然发现一个 hack 的那种相变式跳变。
- [Reward hacking / specification gaming](https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4)
  ——DeepMind 收录的一批「优化奖励的字面、违背其精神」的 Agent 案例。
