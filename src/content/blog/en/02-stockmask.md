---
title: "StockMask: caller-aware LineageOS feature filtering in system_server"
description: "A 200-line module filters LineageOS features and permissions in system_server by caller UID, without injecting into the apps making the requests."
date: 2026-06-09
updatedAt: 2026-09-15
order: 2
series: "android-hardening"
reading: "12 min read"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

StockMask filters selected PackageManager feature and permission responses in system_server according to the Binder caller. The article explains the scope and Android-version-dependent entry points. Its module source is in a private project; the snippets are examples from the original investigation, not a publicly reproducible full module or proof that all detection channels are removed.

```text
$ pm list features | grep lineage
feature:org.lineageos.android
feature:org.lineageos.livedisplay
feature:org.lineageos.trust
```

One call to `hasSystemFeature("org.lineageos.android")` and the app knows. I couldn't just delete the feature XMLs in `/product/etc/permissions/` because several double as publish switches for the `system_server` service.

I needed to filter the response inside `system_server` based on who is asking. Apps obtain these features from `system_server` over Binder. By reading [`Binder.getCallingUid()`](https://developer.android.com/reference/android/os/Binder#getCallingUid()), which the kernel verifies, I could know the caller's identity without spoofing risk. Injecting into the app to intercept its receipt means polluting its address space, triggering RASP.

```text
[ system / root app ] --------+
                              |
[ third-party app ] ----------+
                              |
                              v
                +----------------------------+
                |       system_server        |
                |  PackageManager + hook     |
                | filter by getCallingUid()  |
                +----------------------------+
                              |
           +------------------+------------------+
           |                                     |
           v                                     v
[ real lineage features ]             [ lineage stripped — "stock" ]
```

I wrote a single-file [LSPosed](https://github.com/LSPosed/LSPosed) module (`com.stockmask.Main`, 205 lines) scoped exclusively to `system_server`.

```java
private static boolean shouldFilter() {
    int uid;
    try { uid = Binder.getCallingUid(); } catch (Throwable t) { return false; }
    return (uid % 100000) >= 10000;
}
```

This tests standard AOSP app-UID conventions. An after-hook on `hasSystemFeature` let the real method run, inspecting and rewriting the result *only* for third-party callers asking about a Lineage name.

```java
private final XC_MethodHook hasFeatureHook = new XC_MethodHook() {
    @Override protected void afterHookedMethod(MethodHookParam p) {
        try {
            if (!shouldFilter()) return;
            if (p.args == null || p.args.length == 0) return;
            Object a0 = p.args[0];
            if (a0 instanceof String && isLineageName((String) a0)
                    && Boolean.TRUE.equals(p.getResult())) {
                p.setResult(false);
            }
        } catch (Throwable ignored) {}
    }
};
```

I caught a bug early on. `hasSystemFeature` filtered correctly, but `getSystemAvailableFeatures()` didn't. On Android 14+, Binder-facing entry points were split from the monolithic PMS class into [`PackageManagerService$IPackageManagerImpl`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/pm/PackageManagerService.java), reading from an immutable snapshot (`ComputerEngine`). I updated the hook to target all three classes.

For the permissions, I applied the identical caller-filtered pattern to `PermissionManagerService`, nulling out `getPermissionInfo` for Lineage permissions and slicing them out of `queryPermissionsByGroup`.

The apps' own processes had no injected library in `/proc/self/maps` or hooked-method signature for RASP to find. The module changed the response in `system_server`, before it crossed Binder.

Check the actual caller environment using [UID, SELinux domain and mount namespace](/blog/04-auditing-from-the-apps-eyes/) rather than treating a root-shell response as an app result.
