---
title: "StockMask: a stock illusion without touching a single app"
description: "HideMyApplist hides package names. Apps still detected the custom ROM. The fix was a 200-line module that filters system_server responses by who's asking — never injecting into the app itself."
date: 2026-06-09
order: 2
series: "android-hardening"
reading: "7 min read"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

You hid the package list with HideMyApplist. Banking and shopping apps still threw
human-verification challenges. Something else was announcing the custom ROM. This is how
to find it, and how to close it with a small LSPosed module that never touches the apps
themselves.

## What HMA can't see

A LineageOS device announces itself through **PackageManager** in ways that have nothing
to do with the package list:

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

One call — `hasSystemFeature("org.lineageos.android")` — and the app knows. HMA never
touches features or permissions.

## The wrong fix, and the right one

You *can* delete the feature XMLs in `/product/etc/permissions/`. But several of them
double as the publish switch for the matching `system_server` service — delete
`livedisplay`/`trust`/`profiles` and those features stop working. The XML route forces a
hide-vs-function trade-off.

The right fix keeps the feature **present** (so the system keeps working) and hides it
only **from the apps that ask** — by filtering the response inside `system_server` based
on *who is asking*.

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

The whole idea in five lines:

```java
// LSPosed scope = "android" (system_server) ONLY. No per-app injection.
boolean shouldFilter() { return Binder.getCallingUid() % 100000 >= 10000; }

hookAllMethods(PackageManagerService, "hasSystemFeature", afterHook -> {
    if (shouldFilter() && isLineage(arg0) && result == true) setResult(false);
});
```

Verified:

```text
su 2000  -c 'cmd package has-feature org.lineageos.android'  -> true   (system)
su 10236 -c 'cmd package has-feature org.lineageos.android'  -> false  (taobao uid)
service list | grep -c lineage                               -> 10     (still alive)
```

## The bug that cost an extra reboot

`hasSystemFeature` filtered correctly, but `getSystemAvailableFeatures()` (the *list*)
didn't. The reason: on Android 14+ the Binder-facing list method lives on the inner class
`PackageManagerService$IPackageManagerImpl` (and the snapshot `ComputerEngine`) — **not**
the PMS class I had hooked. Hook all three and the list filters too.

> Lesson: `hasX` and `getXList` often resolve to different classes. Verify each; don't
> assume the obvious one serves the Binder call.

## Why per-caller filtering wins

The apps' own processes stay pristine — no injected library in `/proc/self/maps`, no
hooked-method signature for RASP to find. The only hook lives in `system_server`, which
apps can't inspect. It's the architecture HMA uses for packages, generalized to features,
permissions, settings, and log access.

The module ships **silent** (no `XposedBridge.log` — that string is itself a tell),
scoped to `system` only, and builds with `javac` + `d8` + `aapt2` and no Gradle.
