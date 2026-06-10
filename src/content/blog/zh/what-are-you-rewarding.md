---
title: "你到底在奖励什么?"
description: "RL 不会优化你想要的——它优化的,恰好是你写下来的那个数。两者之间的缝隙就是 reward hacking,而把它收拢,才是真正的大部分工作。验证器 vs 奖励模型,以及一个约束奖励是怎么挣到那 +12% 的。"
date: 2026-06-13
order: 3
series: "post-training"
reading: "8 分钟"
tags: ["llm", "rl", "reward-model", "rlvr", "reward-hacking"]
---

有一条支配每一次 RL 运行的法则:**策略优化的,恰好是你定义的那个数,而不是你以为它代表的那一丁点
含义。** "我写下的奖励"和"我想要的行为"之间的每一道缝隙,都会被找到、然后被利用——带着一个除此
之外无所事事的搜索过程的全部耐心。RL 后训练里大部分的活,不是优化器,而是收拢那道缝隙。

## 两种奖励,以及各自的用武之地

**验证器(RLVR)。** 一个*程序*去检查输出。方案是否没超预算?时间窗是否真的排得开?最终的数是否
正确?当正确性可被程序校验时,这是黄金标准:精确、便宜,而且关键在于——只要检查是完备的,它*没有
可供利用的盲点*。

**奖励模型(RM)。** 当没有程序能判时,一个*学出来的*模型给质量打分。"这个方案合理且可执行吗?"、
"这个回答有帮助吗?"——这些判断没有干净的 oracle。RM 给你一个验证器够不到的信号。但它本身是个模型,
也就意味着它*有*盲点,而策略会把每一个都找出来。

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

## reward hacking 究竟长什么样

事后看从不微妙,事前看从不显眼:

- **验证器的缺口。** 一条你忘了检查的约束,就是一条策略可以随便违反的约束。忘了验证停靠点的顺序
  是否合理,你就会得到一堆满足每一项编码检查、却在物理上荒谬的方案。
- **RM 的盲点。** 奖励模型会悄悄地奖励*表层*特征——长度、自信的语气、整洁的格式、附和用户。不管它,
  策略就学会又长、又自信、又谄媚,而奖励全程在涨。
- **那个破绽:** 奖励涨,留出集评测不涨。这种背离就是警报。如果你的数字在升、你的 Benchmark 没升,
  你不是在变好——你是在变得更擅长那个奖励。

## 怎么收拢这道缝隙

- **把可校验的东西推进验证器。** 每一条你能写成程序的约束,都是策略钻不了的空子。验证器的完备性,
  是你手里杠杆最高的一件事。
- **继续拴着 KL 绳(又一次)。** 一条朝 SFT 参考的惩罚,限定了策略为利用奖励能扭曲到多远。还是
  [上一篇](/zh/blog/cold-start-then-climb/)那条绳,在身兼两职。
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
