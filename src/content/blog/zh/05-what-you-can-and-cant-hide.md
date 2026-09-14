---
title: "一台 root 手机能藏住什么"
description: "整理各条检测通道对应的处理方式，以及用户态修改之后仍存在的隔离 /proc 和硬件认证限制。"
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 分钟"
tags: ["android", "detection", "synthesis", "rasp"]
---

前几篇分别处理了包信息、系统服务和日志等检测通道。下面按作用层整理已部署的修改，以及仍受内核和硬件限制的部分：

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

我们在用户态实施了所有可能的伪装，按调用方（`Binder.getCallingUid`）过滤响应，让 App 进程无需加载注入代码。处理完这些接口后，仍有两处无法通过用户态修改解决。

一个是 Shamiko 式挂载命名空间隔离带来的副作用。隔离隐藏了 Magisk 的 `bind-mount`，却向 App 暴露了干净、未经篡改的 `/proc/cmdline` 和 `/proc/version`。由于模块被隔离在 App 外部，我们失去了修改该命名空间的能力，除非直接重写引导镜像或内核。

另一个则是 TEE 签名。在硬件认证机制中，硬件加密模块根据自身测量的 Bootloader 状态，使用固化在硅片上的私钥签发出一条包含 `deviceLocked=false` 的凭证。这条证书链直达 Google 出厂的公钥锚点。支付后端校验证书签名时，能识别上层 hook 和数据修改。用户态无法取得硬件私钥，也就无法替换这条签名链。
