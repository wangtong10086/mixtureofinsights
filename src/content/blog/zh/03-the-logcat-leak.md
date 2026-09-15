---
title: "Android READ_LOGS：同时检查权限与 SELinux 上下文"
description: "这次权限排查发现 15 个第三方 App 持有 READ_LOGS。撤销授权后，还要处理运行时请求，并在 App 的 SELinux 域下验证结果。"
date: 2026-06-10
updatedAt: 2026-09-15
order: 3
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "logcat", "read_logs", "selinux"]
---

这次日志权限排查的重点是验证边界：撤销 READ_LOGS 后，还要检查运行时日志请求及调用方的 SELinux 域。15 项授权是某次 LineageOS 安装的观察结果，不应推广到所有 ROM，也不等于证明每个 App 实际读取了所有日志。

完成 PMS 的 Binder hook 后，一个 App 弹出了“访问所有设备日志”的请求。系统特性之外，日志也是需要检查的信息来源。系统 logcat 缓冲区是没有按进程隔离的。一旦第三方 App 获得 [`READ_LOGS`](https://developer.android.com/reference/android/Manifest.permission#READ_LOGS) 权限，就能读取底层初始化日志、守护进程的 stderr，以及 LSPosed 模块中的 `XposedBridge.log` 明文输出。

我用 dump 命令遍历了系统里的包，发现有 15 个第三方 App 持有该权限。

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "android.permission.READ_LOGS: granted=true" && echo "$p"
done
```

在 Android 的安全模型中，`READ_LOGS` 保护级别是 `signature|privileged|development`。它本来需要系统签名或内置于 `/system/priv-app` 并在白名单中，而 `development` 标志允许通过 shell 授权。为了便于调试，某些第三方 ROM 会在应用声明时直接静默授予它。

我先写了一个 shell 循环，通过 `adb shell su` 执行 `pm revoke`，撤销所有已有授权。

撤销后，当应用发起 logcat 请求时，调用会被路由到 [`LogcatManagerService`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java)。默认逻辑是弹出一个用户确认对话框。这里我们需要直接拒绝第三方 App 的请求。

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

我用 `su 10253 -c 'logcat'` 测试时，仍然能读到日志，一度以为撤销授权没有生效。原因是这条命令保留了特权 SELinux 域，绕过了 logd 的域检查。用 `su 10253 -z u:r:untrusted_app:s0 -c 'logcat'` 恢复应用真实的 SELinux 上下文后，结果为 0。权限控制与 SELinux MAC 检查相互独立，通过框架层检查也不代表能通过内核检查。我还删除了模块里所有的 `XposedBridge.log`，避免自己的调试输出继续提供检测特征。

单改 UID 为什么不够，可继续阅读[从 App 上下文进行审计](/zh/blog/04-auditing-from-the-apps-eyes/)。
