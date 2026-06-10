---
title: "十五个 App 正在读整台设备的日志"
description: "包名和系统特性都藏好了，logcat 却还在漏。只要第三方 App 拿到 READ_LOGS，Magisk、Lineage 和你自己的调试输出都会变成线索。"
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "logcat", "read_logs", "selinux"]
---

在完成 PMS 的 Binder 劫持后，一个 App 突然弹出请求“访问所有设备日志”，这暴露了另一条致命的数据流向。系统 logcat 缓冲区是没有按进程隔离的。一旦第三方 App 获得 [`READ_LOGS`](https://developer.android.com/reference/android/Manifest.permission#READ_LOGS) 权限，底层初始化时的内核絮语、守护进程的 stderr、以及 LSPosed 模块里随手写的 `XposedBridge.log`，全都会被以明文拉走。

我用 dump 命令遍历了系统里的包，发现有 15 个第三方 App 持有该权限。

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "android.permission.READ_LOGS: granted=true" && echo "$p"
done
```

在 Android 的安全模型中，`READ_LOGS` 保护级别是 `signature|privileged|development`。它本来需要系统签名或内置于 `/system/priv-app` 并在白名单中，但 `development` 标志开了一个后门。为了便于调试，某些第三方 ROM 会在应用声明时直接静默授予它。

解决方案分三层推进。首先是强行撤销。我写了一个 shell 循环通过 `adb shell su` 执行 `pm revoke`，清理所有的存量授权。

撤销后，当应用发起 logcat 请求时，调用会被路由到 [`LogcatManagerService`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java)。默认逻辑是弹出一个用户确认对话框。在对抗场景下，我们需要静默阻断。

我在 `LogcatManagerService.processNewLogAccessRequest` 的入口处注入了 `beforeHook`。这里的难点在于，请求通过 handler 线程异步分发，此时 `Binder.getCallingUid()` 会返回 `system_server` 自己的 1000 UID。真实的调用方信息封装在请求对象的 `mUid` 字段中：

```java
XposedBridge.hookAllMethods(lms, "processNewLogAccessRequest", new XC_MethodHook() {
    @Override protected void beforeHookedMethod(MethodHookParam p) {
        try {
            Object req = (p.args != null && p.args.length > 0) ? p.args[0] : null;
            if (req == null) return;
            int uid = XposedHelpers.getIntField(req, "mUid");
            if (!isThirdPartyAppId(uid)) return;        
            XposedHelpers.callMethod(p.thisObject, "declineRequest", req); 
            p.setResult(null);
        } catch (Throwable ignored) {}
    }
});
```

我在终端用 `su 10253 -c 'logcat'` 测试，日志全盘喷出，几乎让我以为防御失效。但这是特权身份绕过了 logd 的 SELinux 域检查。用 `su 10253 -z u:r:untrusted_app:s0 -c 'logcat'` 恢复应用真实的 SELinux 上下文后，结果为 0。权限控制与 SELinux MAC 机制是相互独立的两个关卡，跨越了框架的审查，并不代表能在内核层通行。而在这个过程中，我还得删掉模块里所有的 `XposedBridge.log`，因为我自己的 debug 字符，就是检测脚本正在寻找的签名。
