---
title: "Google Wallet 不是 Play Integrity 那一关"
description: "Play Integrity 过了 STRONG，Wallet 还是拒绝加卡。问题不在本地伪装，而在支付后端对硬件证明的校验。"
date: 2026-06-09
order: 1
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "attestation", "google-wallet", "tee"]
---

这次排查一开始很像一个配置问题：LineageOS、解锁 Bootloader、Magisk root，都已经被一整套隐藏栈压住，
Play Integrity 也拿到了 **BASIC + DEVICE + STRONG**。按直觉，Wallet 至少应该愿意往下走一步。它没有。

真正值得查的就是这个“不应该”。如果本地完整性已经过了，拒绝发生在哪里？是账号、IP、设备状态，还是
Wallet 走了另一条证明链？我把这些解释一条条排掉，最后只剩一个不太讨喜的答案：它不是配置缺口，而是一堵墙。

## 第一个现象

添加任何卡片都在令牌化(tokenization)阶段失败,提示一句笼统的 *"不符合安全标准"*。
既然完整性已经过了 STRONG,那门槛就不在完整性。那在哪?

## 去看真正失败的那一层

加卡过程中,把 logcat 过滤到 `TapAndPay`:

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet 向 KeyStore 申请一个**硬件背书的「存储密钥」(storage key)**,带上一个认证挑战
(`setAttestationChallenge`),然后在**服务端**校验返回的认证。这道校验——而非 Play Integrity——
才是那堵墙。

这里的机制是 Android **密钥认证(key attestation)**。KeyMint(TEE keystore HAL)返回一条 X.509
**证书链**,共三环,各自承载不同的东西:

| 证书 | 由谁签发 | 承载什么 |
|---|---|---|
| 叶子(认证证书) | 中间证书 | 密钥认证扩展 OID `1.3.6.1.4.1.11129.2.1.17`,其中 `RootOfTrust` → `verifiedBootState` + `deviceLocked`,外加密钥属性与你传入的挑战 |
| 中间证书 | 根证书 | 认证批次 / 设备型号权威——把叶子和 Google 的权威绑在一起的那一环 |
| Google 硬件认证根 | 自签(出厂烧录) | 后端固定(pin)的公钥锚点;链若不终结于此,就不是真实 TEE |

关键在于:**`verifiedBootState` 和 `deviceLocked` 这两个字段是 TEE——而非 Android——填写并用一把
OS 读不到的密钥签名的。** 用户态可以整天对 App 撒谎,却无法以 TEE 的身份签名,也无法在 Bootloader
解锁时让 TEE 报出 `deviceLocked: true` / `verifiedBootState: Verified`。

## 是设备问题,还是账号/IP 问题?

最有用的一个对照实验:**同一个 Google 账号、同一条 VPN、同一张卡,在另一台没 root 的手机上能
正常加卡。** 这一下就排除了账号信誉、代理 IP 和发卡行。剩下的唯一变量,就是*这台设备的认证*。

## 伪造是本地就失败了,还是被服务端拒了?

决定性的检查:在 GMS(uid 10074)做认证的那一刻,`keystore2` / `KeyMint` **没有任何本地报错**。
也就是说 TrickyStore 在本机*成功伪造*了存储密钥认证;失败是在约 2.4 秒的网络往返之后才回来的。
**是 Google 的支付后端识破并拒绝了这份伪造认证。**

## 试过的一切——结果都一样

- 一个有效、**未被吊销**的 keybox(每个证书序列号在用前都比对过 Google 的吊销列表)。
- 对 `walletnfcrel` *和* `gms` 都开 TrickyStore 的 `!` **generate** 全链伪造模式。
- Reddit 的方子:把 `pif.json` 里所有 `spoof*` 设为 `0`(关掉 PIF 指纹伪装)。
- XDA 的步骤:清除 GMS×2 / GSF / Vending / Wallet 数据后重启。

反复抓了多轮完整的添加卡片 logcat dump,每一份都有好几兆——每一条路,都终结在同一句
`Device fails attestation`。

## 那真把 TEE 修好呢?

有一招不是 userspace 伪造:把硬件认证密钥真正修回来。在这台骁龙 8 Gen 2 上,解锁 Bootloader
损坏了 TEE 的认证密钥 / RKP 注册;一个小米 vendor 的 `KmInstallKeybox` 二进制可以把它重新注册
(流程写在一份谨慎、设了门禁的 `fuxi-tee-repair-runbook.md` 里——它要写 `persist` 分区,不可逆,
所以全程是备份、空跑探测用法、以及人工确认的写入门禁)。这套修复确实能把**硬件密钥认证**和
**Widevine L1** 找回来。

但它**搬不动**这堵墙,而且 runbook 在自己的边界说明里就这么写了:修好的 TEE 现在会**诚实**地
认证——而解锁的 Bootloader 会被诚实地报成解锁。它现实的 Play Integrity 上限是 **BASIC**;
DEVICE/STRONG 和 Wallet 碰一碰,在解锁设备上的 TEE 修复里被明确列为*不在保证范围*。修好硅片在这里
帮不上忙,恰恰*因为*它让设备说了真话。唯一能把 `deviceLocked` 翻成 true 的,是重新上锁 + 刷回原厂。

## 把这堵墙画出来

<figure class="figure">
<svg viewBox="0 0 720 230" role="img" aria-label="Three attestation paths; only genuine+locked passes">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/>
    </marker>
  </defs>
  <style>
    .b{fill:#fff;stroke:#e9e4dc;stroke-width:1.5;rx:8}
    .t{font:14px sans-serif;fill:#1c1b19}
    .s{font:12px sans-serif;fill:#6b6862}
    .ln{stroke:#6b6862;stroke-width:1.5;fill:none}
    .ok{fill:#0f766e;font:13px sans-serif;font-weight:700}
    .no{fill:#b4530a;font:13px sans-serif;font-weight:700}
  </style>
  <text x="14" y="22" class="s">设备能交出的东西</text>
  <rect class="b" x="14" y="34" width="250" height="40" rx="8"/>
  <text x="28" y="59" class="t">伪造认证 (TrickyStore)</text>
  <rect class="b" x="14" y="92" width="250" height="40" rx="8"/>
  <text x="28" y="117" class="t">真实 TEE · 已解锁 Bootloader</text>
  <rect class="b" x="14" y="150" width="250" height="40" rx="8"/>
  <text x="28" y="175" class="t">真实 TEE · 已锁 (原厂)</text>
  <rect class="b" x="360" y="92" width="170" height="40" rx="8"/>
  <text x="378" y="117" class="t">Google 支付后端</text>
  <path class="ln" d="M264 54 H312 Q336 54 336 96 V108" marker-end="url(#ar)"/>
  <path class="ln" d="M264 112 H352" marker-end="url(#ar)"/>
  <path class="ln" d="M264 170 H312 Q336 170 336 128 V120" marker-end="url(#ar)"/>
  <path class="ln" d="M530 100 H600" marker-end="url(#ar)"/>
  <text x="610" y="86" class="no">✗ 拒绝(识破伪造)</text>
  <text x="610" y="105" class="no">✗ 拒绝(如实报告已解锁)</text>
  <text x="610" y="124" class="ok">✓ 唯一能过的</text>
</svg>
<figcaption>Play Integrity STRONG 能被一份伪造满足。而 Wallet 的存储密钥认证,校验严到它满足不了。</figcaption>
</figure>

## 结论——是一堵真墙,不是配置缺口

在一台解锁 / TEE 损坏的设备上,Wallet 加卡**靠任何设备侧手段都做不到**。那些声称能"修好
Wallet"的社区教程,适用的是*真实* TEE 认证完好、只是被隐藏起来的设备——而不是一台硬件认证已经
损坏、只能伪造的设备。

## 教训

在烧掉好几天之前,先把层次分清楚:**完整性判决不等于密钥认证。** 前者在用户态可伪造;后者一直
链到硅片。当一个后端校验的是后者,props、模块、指纹、清缓存都撼动不了它。先弄清你站在哪堵墙前。
