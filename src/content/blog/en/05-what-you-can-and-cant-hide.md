---
title: "What you can and can't hide"
description: "The full map of how a non-privileged app detects a rooted custom ROM, what closes each channel, and the two walls that nothing in userspace will move."
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 min read"
tags: ["android", "detection", "synthesis", "rasp"]
---

After weeks of engineering against detection channels, I synthesized the final map of how an app probes a rooted custom ROM, and at what layer the countermeasure must exist. A fix at the wrong layer is fatal against RASP.

| Channel | Probe | Countermeasure | Layer |
|---|---|---|---|
| Package list | `getInstalledPackages` | HideMyApplist | `system_server` |
| System features | `hasSystemFeature` | StockMask | `system_server` |
| Custom permissions | permission enum | StockMask | `system_server` |
| Build identity | `Build.FINGERPRINT` | `resetprop` / PIF | property layer |
| Boot state | `ro.boot.verifiedbootstate` | `resetprop` | property layer |
| Root binaries | `File.exists("/system/bin/su")` | Magisk | image/mount layer |
| Process list | enumerate `/proc/<pid>` | `hidepid=invisible` | kernel |
| In-process hooks | `/proc/self/maps` | Shamiko denylist | injection layer |
| Magisk mounts | `/proc/self/mountinfo` | Shamiko | per-app namespace |
| Global `/proc` | `cmdline` | bind-mount | global `/proc` |
| Custom services | `getService` | `deny ... find` | SELinux |
| Device logs | `READ_LOGS` | revoke + StockMask | logd/SELinux |
| Isolated `/proc` | `cmdline` inside namespace | **None** | kernel |
| Attestation | `setAttestationChallenge` | **None** | TEE |

I adhered strictly to filtering by caller instead of injecting into apps. The strongest covers lived in `system_server`, rewriting responses based on caller UID. My app processes remained absolutely pristine. Consistency beat spoofing: a single mismatched partition fingerprint triggered RASP alerts instantly.

But I hit two immovable walls that userspace simply cannot touch:

```text
+--------------------------------+       +--------------------------------+
|  Shamiko-isolated /proc        |       |  Hardware key attestation      |
+--------------------------------+       +--------------------------------+
| Isolation hides magisk mounts  |       | The TEE reports the real boot- |
| but restores the real cmdline. |       | loader state. Strict backends  |
| A module can't reach it; only  |       | reject forgeries.              |
| a boot-image/kernel edit does. |       | Only stock passes.             |
+--------------------------------+       +--------------------------------+
```

First, Shamiko's mount-namespace isolation gives the app a clean view, stripping Magisk bind-mounts. But doing so restores the genuine `/proc/self/cmdline` and `/proc/version`. Since my Zygisk module didn't inject into the isolated app, there was no code present to rewrite those files.

Second, the [Android Key Attestation (Google, 2024)](https://developer.android.com/privacy-and-security/security-key-attestation) evaluates hardware reality. The TEE records the boot state natively and signs it via a key userspace cannot read. A forged chain can satisfy local checks, but server-side validation against the hardware root fails instantly. A userspace module is powerless against silicon math.
