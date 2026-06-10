---
title: "一台 root 手机能藏住什么"
description: "包名、特性、权限、日志、服务、硬件证明，每条通道都有自己的边界。能藏的要藏干净，藏不了的要早点承认。"
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 分钟"
tags: ["android", "detection", "synthesis", "rasp"]
---

经过对各条检测通道的封堵，我触及了 Android 安全架构的底层骨架。这是一个边界清晰的对抗场，用户态的工程努力只能收敛到内核的允许范围。

针对不同层级的检测，我部署了一套组合架构：

```text
+-------------------+----------------------+-------------------+
|  Detection Path   | Mitigation Layer     | Status            |
+-------------------+----------------------+-------------------+
| PM Binder Calls   | system_server hook   | Resolved          |
| Build Fingerprint | resetprop (init)     | Resolved          |
| Su Binaries       | Mount Namespace      | Resolved          |
| /proc Enum        | hidepid=invisible    | Resolved          |
| Lineage Services  | SELinux sepolicy     | Resolved          |
| Device Logcat     | LogcatManagerService | Resolved          |
| Hardware Certs    | Keymaster/TEE        | Hardware Limit    |
| Isolated /proc    | Kernel / Boot image  | Hardware Limit    |
+-------------------+----------------------+-------------------+
```

我们在用户态重构并实施了所有可能的伪装，坚持按调用方过滤（`Binder.getCallingUid`）而不是在 App 内部建立战场，以保证目标进程地址空间的绝对洁净。当一切能够封堵的接口都被截断，剩下的则是无法逾越的物理极限。

一个是 Shamiko 式挂载命名空间隔离带来的副作用。隔离隐藏了 Magisk 的 `bind-mount`，却向 App 暴露了干净、未经篡改的 `/proc/cmdline` 和 `/proc/version`。由于模块被隔离在 App 外部，我们失去了修改该命名空间的能力，除非直接重写引导镜像或内核。

另一个则是 TEE 签名。在硬件认证机制中，硬件加密模块根据自身测量的 Bootloader 状态，使用固化在硅片上的私钥签发出一条包含 `deviceLocked=false` 的凭证。这条证书链直达 Google 出厂的公钥锚点。当支付后端对传入凭证执行签名校验时，一切基于上层的 hook 和数据修改都会原形毕露。伪装的极限止步于内核态的硬件隔离层。
