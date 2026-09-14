---
title: "What you can and can't hide"
description: "A reference table of custom-ROM detection channels and the changes used for each, followed by the remaining isolated /proc and hardware-attestation limits."
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 min read"
tags: ["android", "detection", "synthesis", "rasp"]
---

After weeks of work on these detection channels, I collected the probes and corresponding changes in one table. Each change has to act at the layer where RASP can observe the information.

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

I filtered responses in `system_server` by caller UID, keeping injected code out of the app processes. The returned information also had to agree across interfaces: a single mismatched partition fingerprint triggered RASP alerts instantly.

Two limits remained beyond these userspace changes:

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

Second, the [Android Key Attestation (Google, 2024)](https://developer.android.com/privacy-and-security/security-key-attestation) checks the hardware-reported boot state. The TEE records the boot state natively and signs it via a key userspace cannot read. A forged chain can satisfy local checks, but server-side validation against the hardware root fails instantly. A userspace module cannot produce a signature with the TEE's private key.
