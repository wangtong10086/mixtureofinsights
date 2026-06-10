---
title: "StockMask: a stock illusion without touching a single app"
description: "HideMyApplist hides package names. Apps still detected the custom ROM. The fix was a 200-line module that filters system_server responses by who's asking — never injecting into the app itself."
date: 2026-06-09
order: 2
series: "android-hardening"
reading: "12 min read"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

You hid the package list with HideMyApplist. Banking and shopping apps still threw
human-verification challenges. Something else was announcing the custom ROM. This is how
to find it, and how to close it with a small LSPosed module that never touches the apps
themselves — defensive research into where the right layer to filter actually is.

## What HMA can't see

A LineageOS device announces itself through **PackageManager** in ways that have nothing
to do with the package list. Every one of these is a Binder call from the app's process
into `system_server`, where the real `PackageManagerService` (PMS) lives — the app holds
only an `IPackageManager` proxy and gets back whatever PMS decides to return:

```text
$ pm list features | grep lineage
feature:org.lineageos.android        # literally "this is LineageOS"
feature:org.lineageos.livedisplay
feature:org.lineageos.trust
...
$ pm list permissions | grep lineage
permission:lineageos.permission.TRUST_INTERFACE
...
```

One call — `hasSystemFeature("org.lineageos.android")` — and the app knows. The call
crosses Binder into PMS, which checks its in-memory feature map and returns `true`. HMA
never touches features or permissions; it only rewrites the package-list calls.

## The wrong fix, and the right one

You *can* delete the feature XMLs in `/product/etc/permissions/`. But several of them
double as the publish switch for the matching `system_server` service — delete
`livedisplay`/`trust`/`profiles` and those features stop working. The XML route forces a
hide-vs-function trade-off.

The right fix keeps the feature **present** (so the system keeps working) and hides it
only **from the apps that ask** — by filtering the response inside `system_server` based
on *who is asking*. Why is `system_server` the correct layer and not the app? Because of
**who holds the trusted answer**. PMS is the single source of truth that every app queries
over Binder; it already knows the caller's identity for free, because Binder stamps every
incoming transaction with the real, kernel-verified UID of the sender —
`Binder.getCallingUid()` cannot be spoofed by the calling app. So you filter at the one
place that (a) sees every query, (b) knows who's asking with certainty, and (c) lives in a
process the app can never read into. The alternative — injecting into the app to intercept
its *receipt* of the answer — means putting your code inside the very process you're trying
to look clean to. That's backwards.

<figure class="figure">
<svg viewBox="0 0 720 250" role="img" aria-label="system_server filters PackageManager responses by caller UID">
  <style>
    .bx{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}
    .hk{fill:#fff;stroke:#b4530a;stroke-width:1.8}
    .t{font:13px sans-serif;fill:#1c1b19}
    .s{font:11.5px sans-serif;fill:#6b6862}
    .ok{font:12px sans-serif;fill:#0f766e;font-weight:700}
    .no{font:12px sans-serif;fill:#b4530a;font-weight:700}
    .ln{stroke:#6b6862;stroke-width:1.4;fill:none}
  </style>
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker>
  </defs>

  <rect class="bx" x="12" y="26" width="150" height="34" rx="7"/>
  <text x="26" y="48" class="t">system / root app</text>
  <rect class="bx" x="12" y="74" width="150" height="34" rx="7"/>
  <text x="26" y="96" class="t">third-party app</text>

  <rect class="hk" x="250" y="40" width="210" height="86" rx="9"/>
  <text x="266" y="64" class="t">system_server</text>
  <text x="266" y="84" class="s">PackageManager + StockMask hook</text>
  <text x="266" y="104" class="s">filter by Binder.getCallingUid()</text>

  <rect class="bx" x="540" y="26" width="168" height="34" rx="7"/>
  <text x="556" y="48" class="ok">real lineage features ✓</text>
  <rect class="bx" x="540" y="100" width="168" height="34" rx="7"/>
  <text x="556" y="122" class="no">lineage stripped — "stock"</text>

  <path class="ln" d="M162 43 H250" marker-end="url(#a2)"/>
  <path class="ln" d="M162 91 H250" marker-end="url(#a2)"/>
  <path class="ln" d="M460 64 H540 V52" marker-end="url(#a2)"/>
  <path class="ln" d="M460 100 H505 Q540 100 540 112 V116" marker-end="url(#a2)"/>

  <text x="250" y="158" class="s">The app's own process is never touched — nothing in it to detect.</text>
</svg>
<figcaption>One hook, in the single shared process every app queries. The app's memory
stays pristine; only the answer changes, per caller.</figcaption>
</figure>

The whole module is a single file — `code/stockmask/src/com/stockmask/Main.java`, 205
lines including imports and comments. It declares one Xposed entry class
(`assets/xposed_init` names exactly `com.stockmask.Main`) and its very first act is to
bail out of every process that isn't `system_server`:

```java
@Override
public void handleLoadPackage(LoadPackageParam lpparam) {
    if (lpparam == null || !"android".equals(lpparam.packageName)) return;
    ClassLoader cl = lpparam.classLoader;
    hookFeatures(cl);
    hookPermissions(cl);
    hookLogAccess(cl);
}
```

That `"android"` package name *is* `system_server` — in LSPosed's scope picker it's the
entry labelled "System Framework," and the module ships scoped to it and nothing else. No
app process ever loads this code; the guard makes sure.

The caller test is two small helpers — the appId formula and a wrapper that reads the
genuine UID off the live Binder transaction:

```java
private static boolean isThirdPartyAppId(int uid) {
    return (uid % 100000) >= 10000;
}

/** For Binder-dispatched methods: filter real third-party callers only. */
private static boolean shouldFilter() {
    int uid;
    try { uid = Binder.getCallingUid(); } catch (Throwable t) { return false; }
    return isThirdPartyAppId(uid);
}
```

That UID test is exactly the AOSP app-UID convention: `Process.FIRST_APPLICATION_UID` is
`10000` and the per-user offset is `100000`, so `uid % 100000` strips the profile to
recover the **appId**, and `appId >= 10000` is "installed third-party app, in any
profile." Everything below `10000` is a fixed system/daemon appId — `AID_SYSTEM` (1000),
`AID_RADIO` (1001), `AID_SHELL` (2000), and the HAL/daemon UIDs that back the Lineage
services themselves. And because `shouldFilter()` runs *synchronously inside the Binder
transaction* — invoked from an `afterHookedMethod`, on the same thread that dispatched the
call — `Binder.getCallingUid()` returns the genuine caller, not `system_server`'s own UID.

The interception point for the boolean check is an *after*-hook on `hasSystemFeature`: let
the real method run, inspect what it was about to return, and rewrite the result *only*
when the caller is a third-party app asking about a Lineage name. The actual hook body, verbatim:

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

Every hook body is wrapped in `try { … } catch (Throwable ignored) {}` for the same
reason: an uncaught throw inside `system_server` bootloops the device. `isLineageName`
isn't a single-string match either — it catches the whole family (`org.lineageos.*`,
`lineageos.*`, the legacy `cyanogenmod` names, and any string merely *containing*
`lineage`), so a renamed feature can't slip through.

Because the real method already executed and only third-party appIds get rewritten, the
daemons fall through untouched: LiveDisplay's own process (a system appId) still reads
`org.lineageos.livedisplay` as `true`, so it keeps working. You hide the feature from the
bank app without amputating it from the OS.

Verified:

```text
su 2000  -c 'cmd package has-feature org.lineageos.android'  -> true   (system)
su 10236 -c 'cmd package has-feature org.lineageos.android'  -> false  (taobao uid)
service list | grep -c lineage                               -> 10     (still alive)
```

## The bug that cost an extra reboot

`hasSystemFeature` filtered correctly, but `getSystemAvailableFeatures()` (the *list*)
didn't. The reason is a refactor in how PMS is structured: on Android 14+ the
Binder-facing entry points were split out of the monolithic PMS class. The list method
the app actually reaches lives on the inner class
`PackageManagerService$IPackageManagerImpl`, which in turn reads from an immutable
**snapshot** (`ComputerEngine`) rather than from PMS directly — a copy-on-write design for
lock-free reads. Hooking the old PMS method missed both. The fix is to hook the same two
method names across *all three* classes:

```java
private void hookFeatures(ClassLoader cl) {
    String[] classes = {
        "com.android.server.pm.PackageManagerService",
        "com.android.server.pm.PackageManagerService$IPackageManagerImpl",
        "com.android.server.pm.ComputerEngine",
    };
    for (String cn : classes) {
        Class<?> clazz;
        try { clazz = XposedHelpers.findClass(cn, cl); }
        catch (Throwable t) { continue; }
        try { XposedBridge.hookAllMethods(clazz, "hasSystemFeature", hasFeatureHook); } catch (Throwable ignored) {}
        try { XposedBridge.hookAllMethods(clazz, "getSystemAvailableFeatures", listFeatureHook(cl)); } catch (Throwable ignored) {}
    }
}
```

The list hook has one wrinkle the boolean hook doesn't: the result isn't always a plain
`List`. The Binder-facing getters return a `ParceledListSlice` wrapper. So the hook
unwraps it via `getList()`, filters out the Lineage entries by reflecting the `name` field
off each `FeatureInfo`, then *re-wraps* the kept entries in a fresh slice — and only
touches the result if something actually changed:

```java
List<?> src;
if (result instanceof List) { src = (List<?>) result; }
else { src = (List<?>) XposedHelpers.callMethod(result, "getList"); sliced = true; }
...
if (sliced) {
    Object slice = XposedHelpers.newInstance(
        XposedHelpers.findClass("android.content.pm.ParceledListSlice", cl), kept);
    p.setResult(slice);
} else {
    p.setResult(kept);
}
```

> Lesson: `hasX` and `getXList` often resolve to different classes *and* different return
> types. Verify each; don't assume the obvious one serves the Binder call.

## The permissions, by the same lever

Features are only half of what a LineageOS install announces — it also registers custom
permissions like `lineageos.permission.TRUST_INTERFACE`. `hookPermissions` applies the
identical caller-filtered pattern to `PermissionManagerService` (and its
`…Impl` variant), nulling out `getPermissionInfo` for a Lineage permission name and
slicing the Lineage entries out of `queryPermissionsByGroup` / `getAllPermissionGroups`
— the same `ParceledListSlice` unwrap-filter-rewrap as the feature list. One pattern,
four method families, every body in `try/catch`. That symmetry is the whole point: the
trustworthy answer lives in one process, so one lever closes every variant of the
question.

## Why per-caller filtering wins

The apps' own processes stay pristine — no injected library in `/proc/self/maps`, no
hooked-method signature for RASP to find, no second copy of the Xposed runtime sharing
their address space. The only hook lives in `system_server`, a process a normal app has no
SELinux permission to read into. RASP that scans its own memory finds nothing because
there is nothing in its memory; the lie was told upstream, at the source of truth, before
the answer ever crossed Binder. It's the architecture HMA uses for packages, generalized to
features, permissions, settings, and log access.

The module ships **silent** (no `XposedBridge.log` anywhere in `Main.java` — that string is
itself a tell; see [the logcat post](/blog/03-the-logcat-leak/) for why your own debug
output is a detection surface), scoped to "System Framework" only. And it builds *without
the Android SDK or Gradle*: `code/stockmask/build.sh` is six steps —
`javac` → `d8` (from `r8.jar`) → `aapt2 link` → zip the dex in → `zipalign` → `apksigner`
— compiling the one `.java` against a fetched Xposed `api-82.jar` and an ancient
`android.jar` stub (only `Binder`/`FeatureInfo` are touched directly; everything else goes
through `XposedHelpers` reflection, which is what lets the same APK survive version drift).
205 lines, one file, no build system.

## Further reading

- [AOSP PackageManagerService](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/pm/PackageManagerService.java) — the source of truth, and where `IPackageManagerImpl` / the `Computer` snapshot split lives.
- [`Binder.getCallingUid()`](https://developer.android.com/reference/android/os/Binder#getCallingUid()) — why the kernel-stamped caller UID can't be forged by the app.
- [LSPosed](https://github.com/LSPosed/LSPosed) — the framework that lets a module hook `system_server` without touching app processes.
