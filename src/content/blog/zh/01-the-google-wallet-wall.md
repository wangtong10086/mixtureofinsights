---
title: "Google Wallet 不是 Play Integrity 那一关"
description: "Play Integrity 过了 STRONG，Wallet 还是拒绝加卡。问题不在本地伪装，而在支付后端对硬件证明的校验。"
date: 2026-06-09
order: 1
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "attestation", "google-wallet", "tee"]
---

我最初以为是配置问题。这台骁龙 8 Gen 2 设备刷了 LineageOS，Bootloader 已解锁，也装了 Magisk root。配置隐藏栈后，Play Integrity 返回 BASIC + DEVICE + STRONG，Wallet 却仍然无法绑卡。

添加任何卡片都在令牌化（tokenization）阶段失败，只提示 "不符合安全标准"。Play Integrity 的 STRONG 结果没有解释这次失败，我需要继续查绑卡流程。

将 logcat 过滤到 `TapAndPay` 后，可以看到异常出在存储密钥认证这一步：

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet 向 KeyStore 申请一个硬件背书的存储密钥（storage key），带上一个认证挑战（`setAttestationChallenge`），然后在 Google 支付后端校验返回的认证。这次失败发生在密钥认证校验，Play Integrity 通过并不能让它通过。

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

`verifiedBootState` 和 `deviceLocked` 由 TEE 填写，并用 OS 无法读取的密钥签名。用户态 hook 可以拦截 App 调用，但无法生成这个 TEE 私钥的签名。

在 GMS（uid 10074）做认证的那一刻，`keystore2` / `KeyMint` 没有任何本地报错。这意味着 TrickyStore 在本机成功伪造了存储密钥认证，失败是在 2.4 秒的 TLS 网络往返之后才传回来的。伪造的证书被 Google 后端的公钥锚点识破。

我试过把 `pif.json` 里所有 `spoof*` 设为 `0`，试过注入 `!` 全链伪造模式，试过清空所有 GMS 数据。每次的 dump 日志都有数兆，最终仍然报 `Device fails attestation`。

我用小米 vendor 的 `KmInstallKeybox` 二进制尝试了真正的 TEE 修复，写入 `persist` 分区恢复认证密钥。这套操作找回了 Widevine L1，但 Wallet 依然拒绝。修好的 TEE 现在会诚实地将 Bootloader 状态报成解锁， Play Integrity 退回 BASIC。只有重新上锁并刷回原厂引导镜像，才能让 `deviceLocked` 变为 true。这里需要区分完整性判决与密钥认证：前者在用户态操作，后者在硬件内完成。
