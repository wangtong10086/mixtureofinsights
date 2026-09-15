---
title: "StockMask：在 system_server 中按调用方过滤 LineageOS 特性"
description: "在 system_server 中按调用方 UID 过滤 LineageOS 特性和权限，让查询这些信息的 App 无需加载 hook 模块。"
date: 2026-06-09
updatedAt: 2026-09-15
order: 2
series: "android-hardening"
reading: "12 分钟"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

StockMask 在 system_server 内按 Binder 调用方过滤部分 PackageManager 特性和权限响应。本文说明作用范围及随 Android 版本变化的入口。模块源码属于私有项目，随文片段来自原排查，不构成可公开复现的完整模块，也不能证明所有检测通道均已消失。

```text
$ pm list features | grep lineage
feature:org.lineageos.android
feature:org.lineageos.livedisplay
$ pm list permissions | grep lineage
permission:lineageos.permission.TRUST_INTERFACE
```

App 只需调用一次 [`hasSystemFeature()`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/core/java/android/app/ApplicationPackageManager.java)，就能查到这些特征。如果修改 `/product/etc/permissions/` 的 XML，会导致 `system_server` 里的原生服务（如 livedisplay）因断言失败而崩溃。必须在 `system_server` 响应阶段，根据调用方的真实身份实施动态过滤。

我将钩子挂在负责回答查询的 `PackageManagerService` (PMS)。Binder 事务中的 `CallingUid` 由内核提供，用户态无法伪造，因此可以据此区分调用方：

```text
+-------------------+           Binder IPC           +-------------------------+
| Caller App        | -----------------------------> | system_server (PMS)     |
| (uid: 10236)      |    hasSystemFeature()          | getCallingUid() = 10236 |
+-------------------+ <----------------------------- | return false (Spoofed)  |
                                                     +-------------------------+
                                                              |
+-------------------+           Binder IPC                (same method)
| System Service    | ----------------------------->          |
| (uid: 1000)       |    hasSystemFeature()                   v
+-------------------+ <----------------------------- | return true (Original)  |
```

我在 `com.stockmask.Main`（私有源码，公开链接不可用） 中按 appId 过滤，判定它是否大于 `10000`（即第三方应用）：

```java
private static boolean shouldFilter() {
    int uid;
    try { uid = Binder.getCallingUid(); } catch (Throwable t) { return false; }
    return (uid % 100000) >= 10000;
}
```

在拦截 `hasSystemFeature` 时，我利用 after hook 等待原始调用结束，再修改返回结果。这种方式避免了破坏原有状态机：

```java
private final XC_MethodHook hasFeatureHook = new XC_MethodHook() {
    @Override protected void afterHookedMethod(MethodHookParam p) {
        try {
            if (!shouldFilter() || p.args == null || p.args.length == 0) return;
            Object a0 = p.args[0];
            if (a0 instanceof String && ((String) a0).contains("lineage") 
                    && Boolean.TRUE.equals(p.getResult())) {
                p.setResult(false);
            }
        } catch (Throwable ignored) {}
    }
};
```

对于获取特性列表的 `getSystemAvailableFeatures()`，在 Android 14+ 架构中，数据读取被重构为了无锁的写时复制快照（`ComputerEngine`）。不仅要 hook PMS，还要覆盖 `IPackageManagerImpl`。其返回类型被包装在 [`ParceledListSlice`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/core/java/android/content/pm/ParceledListSlice.java) 中。我需要将其拆包、过滤，再重新封装。

权限过滤（`getAllPermissionGroups` 等）也按调用方处理。过滤发生在 `system_server` 中，App 进程无需加载模块。RASP 扫描自身的 `/proc/self/maps` 时，看不到注入的模块和被修改的方法签名；Binder 返回之前，响应已经改好。

验证时应结合 [UID、SELinux 域和挂载命名空间](/zh/blog/04-auditing-from-the-apps-eyes/)，不能把 root shell 的响应当作 App 的结果。
