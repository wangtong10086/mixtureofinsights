---
title: "StockMask：不碰 App，也能造一层原厂感"
description: "HideMyApplist 藏得住包名，藏不住系统特性。更稳的办法是在 system_server 里按调用方过滤回答，而不是把钩子塞进每个 App。"
date: 2026-06-09
order: 2
series: "android-hardening"
reading: "12 分钟"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

我原以为用 HideMyApplist 藏住包名就足够了，但银行 App 依旧能精准判定设备处于非原生环境。这说明旁路泄露依然存在。通过跟踪跨进程调用，我发现 PackageManager 会直接把系统特性和自定义权限泄露给调用方。

```text
$ pm list features | grep lineage
feature:org.lineageos.android
feature:org.lineageos.livedisplay
$ pm list permissions | grep lineage
permission:lineageos.permission.TRUST_INTERFACE
```

App 只需调用一次 [`hasSystemFeature()`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/core/java/android/app/ApplicationPackageManager.java)，这些特征就暴露无遗。如果修改 `/product/etc/permissions/` 的 XML，会导致 `system_server` 里的原生服务（如 livedisplay）因断言失败而崩溃。必须在 `system_server` 响应阶段，根据调用方的真实身份实施动态过滤。

我将钩子挂在 `PackageManagerService` (PMS)，它是系统唯一的真相源。Binder 事务会打上内核强制的 `CallingUid`，这个设计天然免疫了用户态的伪造：

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

我在 [`com.stockmask.Main`](https://github.com/wangtong10086/mixtureofinsights/blob/main/code/stockmask/src/com/stockmask/Main.java) 中实现了一个极简的过滤逻辑，严格判定 appId 是否大于 `10000`（即第三方应用）：

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

权限过滤（`getAllPermissionGroups` 等）采用完全对称的架构。将逻辑收敛在 `system_server` 的意义在于，App 自己的内存空间保持绝对洁净。RASP 扫描自身的 `/proc/self/maps` 时，看不到任何注入的模块和被篡改的方法签名。谎言在 Binder 返回包抵达 App 内存之前就已经编织完成。
