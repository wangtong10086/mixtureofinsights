---
title: "What you can and can't hide"
description: "The full map of how a non-privileged app detects a rooted custom ROM, what closes each channel, and the two walls that nothing in userspace will move."
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "6 min read"
tags: ["android", "detection", "synthesis", "rasp"]
---

After weeks on one device, here is the synthesis — the full map of how a non-privileged
app detects a rooted custom ROM, what closes each channel, and the few walls that nothing
in userspace will move.

## The detection channels, and their fate

| Channel | App reads it via | Closed by | Status |
|---|---|---|---|
| Package list | `getInstalledPackages` | HideMyApplist (system_server, by caller) | ✅ |
| System features | `hasSystemFeature` / `getSystemAvailableFeatures` | per-caller system_server hook | ✅ |
| Custom permissions | permission enumeration | per-caller system_server hook | ✅ |
| Build identity | `Build.*` (props) | resetprop + Play Integrity Fix (kept consistent) | ✅ |
| Boot / verity state | `ro.boot.*` props | resetprop (`green` / `locked` / `enforcing`) | ✅ |
| Root binaries | `File.exists("/system/bin/su"…)` | Magisk is systemless — nothing to find | ✅ |
| Process list | enumerate `/proc` | kernel `hidepid=invisible` | ✅ |
| In-process hooks | `/proc/self/maps` | Shamiko denylist (no Zygisk injection) | ✅ |
| Magisk mounts | `/proc/self/mountinfo` | Shamiko isolation | ✅ |
| Custom services | `ServiceManager.getService` | sepolicy `deny … find` | ✅ |
| Device logs | `READ_LOGS` / logcat | revoke + LogcatManagerService deny | ✅ |
| Debug settings | `Settings.Global.adb_enabled` | turn off USB debugging | ⚠️ artifact |
| `/proc` of **isolated** apps | their real cmdline / version | boot-image / kernel edit only | 🧱 wall |
| Hardware attestation | TEE / KeyMint | nothing — chains to silicon | 🧱 wall |

## Three principles that emerged

**1. Filter by caller; don't inject into apps.** The strongest hides all live in the
*one* shared `system_server`, rewriting responses by `Binder.getCallingUid()`. The app's
own process stays pristine — there is nothing in it to detect. Per-app Xposed injection is
both detectable and, against hardened RASP, fatal (it crashed bank apps).

**2. Consistency beats spoofing.** A Pixel fingerprint bolted onto an otherwise-Xiaomi
system is *more* detectable than one coherent stock identity. Every partition fingerprint,
every security-patch date, every prop must tell the same story. The single biggest Wallet
red herring was a fingerprint that PIF and the system disagreed on.

**3. Know which wall you're at.** There are two you cannot move from userspace.

<figure class="figure">
<svg viewBox="0 0 720 188" role="img" aria-label="The two walls: isolated /proc and hardware attestation">
  <style>
    .wall{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}
    .t{font:13.5px sans-serif;fill:#1c1b19;font-weight:700}
    .s{font:11.5px sans-serif;fill:#6b6862}
    .brick{stroke:#e3c9b3;stroke-width:1}
  </style>
  <rect class="wall" x="20" y="24" width="320" height="140" rx="8"/>
  <line class="brick" x1="20" y1="64" x2="340" y2="64"/><line class="brick" x1="20" y1="104" x2="340" y2="104"/><line class="brick" x1="20" y1="144" x2="340" y2="144"/>
  <line class="brick" x1="120" y1="24" x2="120" y2="64"/><line class="brick" x1="240" y1="64" x2="240" y2="104"/><line class="brick" x1="120" y1="104" x2="120" y2="144"/><line class="brick" x1="240" y1="144" x2="240" y2="164"/>
  <text x="40" y="48" class="t">Shamiko-isolated /proc</text>
  <text x="40" y="86" class="s">isolation hides magisk mounts but</text>
  <text x="40" y="104" class="s">restores the real cmdline / version —</text>
  <text x="40" y="122" class="s">a module can't reach it. Only a</text>
  <text x="40" y="140" class="s">boot-image / kernel edit does.</text>

  <rect class="wall" x="380" y="24" width="320" height="140" rx="8"/>
  <line class="brick" x1="380" y1="64" x2="700" y2="64"/><line class="brick" x1="380" y1="104" x2="700" y2="104"/><line class="brick" x1="380" y1="144" x2="700" y2="144"/>
  <line class="brick" x1="480" y1="24" x2="480" y2="64"/><line class="brick" x1="600" y1="64" x2="600" y2="104"/><line class="brick" x1="480" y1="104" x2="480" y2="144"/><line class="brick" x1="600" y1="144" x2="600" y2="164"/>
  <text x="400" y="48" class="t">Hardware key attestation</text>
  <text x="400" y="86" class="s">the TEE reports the real bootloader</text>
  <text x="400" y="104" class="s">state. A forgery is detectable by</text>
  <text x="400" y="122" class="s">strict backends (Google Wallet).</text>
  <text x="400" y="140" class="s">Only relock + stock passes.</text>
</svg>
<figcaption>The two walls. Everything to their left is closeable; neither of them is.</figcaption>
</figure>

## The honest bottom line

You can make a rooted LineageOS device pass the *cheap, common* checks that 95% of apps
use — package list, features, permissions, props, `/proc`, services, logs. You will not
beat a determined native RASP that reads its own isolated `/proc`, nor a payment backend
that validates hardware attestation. Aim your effort at the channels you can actually
close, document the walls plainly, and don't burn days pretending a wall is a config gap.
