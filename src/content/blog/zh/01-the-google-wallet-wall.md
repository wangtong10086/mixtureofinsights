---
title: "Google Wallet 不是 Play Integrity 那一关"
description: "Play Integrity 过了 STRONG，Wallet 还是拒绝加卡。问题不在本地伪装，而在支付后端对硬件证明的校验。"
date: 2026-06-09
order: 1
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "attestation", "google-wallet", "tee"]
---

我最初以为这只是个简单的配置问题。一台刷了 LineageOS 的骁龙 8 Gen 2 设备，Bootloader 已解锁，挂着 Magisk root，但我已经用一整套隐藏栈压住了这些特征。Play Integrity 返回了 BASIC + DEVICE + STRONG，直觉上 Wallet 至少该让我走到绑卡的一半。但它在第一步就断了。

添加任何卡片都在令牌化（tokenization）阶段失败，报错仅有一句毫无信息量的 "不符合安全标准"。如果本地完整性已经过了 STRONG，那这道墙建在哪里？

把 logcat 过滤到 `TapAndPay`，我抓到了真正的抛出点：

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet 向 KeyStore 申请一个硬件背书的存储密钥（storage key），带上一个认证挑战（`setAttestationChallenge`），然后在 Google 支付后端校验返回的认证。这道校验，而不是 Play Integrity，才是真正的门限。

底层机制是 [Android 密钥认证（Key Attestation）](https://developer.android.com/privacy-and-security/security-key-attestation)。KeyMint 返回一条 X.509 证书链。每一环的权威传递路径如下：

```text
[ Google Hardware Root ] 
          | (Self-signed by Google at factory, pinned in backend)
          v
[ Intermediate Cert ]
          | (Attestation batch / Device model authority)
          v
[ Leaf Attestation Cert ]
          (Contains OID 1.3.6.1.4.1.11129.2.1.17)
          (verifiedBootState + deviceLocked)
```

关键在于：`verifiedBootState` 和 `deviceLocked` 字段是 TEE 填写的，并用一把 OS 读不到的密钥签名。我可以在用户态写一万行 hook 拦截 App 的调用，却无法凭空捏造一个 TEE 内部的私钥签名。这是一种纯粹的密码学隔绝。

在 GMS（uid 10074）做认证的那一刻，`keystore2` / `KeyMint` 没有任何本地报错。这意味着 TrickyStore 在本机成功伪造了存储密钥认证，失败是在 2.4 秒的 TLS 网络往返之后才传回来的。伪造的证书被 Google 后端的公钥锚点识破。

我试过把 `pif.json` 里所有 `spoof*` 设为 `0`，试过注入 `!` 全链伪造模式，试过清空所有 GMS 数据。每一份动辄数兆的 dump 日志最终都终结在 `Device fails attestation`。

我用小米 vendor 的 `KmInstallKeybox` 二进制尝试了真正的 TEE 修复，写入 `persist` 分区恢复认证密钥。这套操作找回了 Widevine L1，但 Wallet 依然拒绝。修好的 TEE 现在会诚实地将 Bootloader 状态报成解锁， Play Integrity 退回 BASIC。修复 TEE 意味着强迫设备说真话，而唯一能把 `deviceLocked` 翻成 true 的位反转，只存在于重新上锁并刷回原厂的引导镜像中。完整性判决不等于密钥认证，前者在用户态操作，后者在硅片内闭环。
