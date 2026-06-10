---
title: "What you can and can't hide"
description: "The full map of how a non-privileged app detects a rooted custom ROM, what closes each channel, and the two walls that nothing in userspace will move."
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 min read"
tags: ["android", "detection", "synthesis", "rasp"]
---

After weeks on one device, here is the synthesis — the full map of how a non-privileged
app detects a rooted custom ROM, what closes each channel, and the few walls that nothing
in userspace will move.

## The detection channels, and their fate

The full map: each channel, how a non-privileged app probes it, the countermeasure, and —
the part that actually matters — *which layer* the fix has to live at. A fix at the wrong
layer is either detectable (in-app) or ineffective (above the thing it's trying to gate).

| Channel | How a non-privileged app probes it | Countermeasure (artifact) | Layer the fix lives at | Status |
|---|---|---|---|---|
| Package list | `PackageManager.getInstalledPackages` (Binder → PMS) | HideMyApplist, filter by caller UID | `system_server` (PMS) | ✅ |
| System features | `hasSystemFeature` / `getSystemAvailableFeatures` | StockMask `hookFeatures` ([post 2](/blog/02-stockmask/)) | `system_server` (PMS + `IPackageManagerImpl` + `ComputerEngine`) | ✅ |
| Custom permissions | `getAllPermissionGroups` / permission enumeration | StockMask `hookPermissions` (`PermissionManagerService`) | `system_server` | ✅ |
| Build identity | `Build.FINGERPRINT` / `SystemProperties.get` | `fuxi_prop_spoof/post-fs-data.sh` — `resetprop` of every `ro.*.build.*`, `--delete` of `ro.lineage.*`; PIF for consistency | property layer (`resetprop`) | ✅ |
| Boot / verity state (props) | `ro.boot.verifiedbootstate` / `ro.boot.vbmeta.device_state` | same script — `resetprop … device_state locked`, `veritymode enforcing` | property layer | ✅ |
| Root binaries | `File.exists("/system/bin/su"…)`, `$PATH` scan | Magisk is **systemless** — nothing on the real fs | image/mount layer | ✅ |
| Process list | enumerate `/proc/<pid>` | kernel `hidepid=invisible` (proc mount option) | kernel | ✅ |
| In-process hooks | read own `/proc/self/maps` for `zygisk`/`lsposed` | Shamiko denylist — app gets **no Zygisk injection** | injection layer (Zygisk denylist) | ✅ |
| Magisk mounts | read own `/proc/self/mountinfo` | Shamiko **mount-namespace isolation** | per-app mount namespace | ✅ |
| `/proc/cmdline` · `/proc/version` (global view) | read the global `/proc/cmdline` for `*-NIGHTLY-*`, `/proc/version` for the build host | `post-fs-data.sh` `sed`-strips the NIGHTLY token + docker build-host, then `mount --bind`s the fakes | global `/proc` (bind-mount) | ✅* |
| Custom (Lineage) services | `ServiceManager.getService("lineagehardware")` | `fuxi_prop_spoof/sepolicy.rule` — `deny … service_manager find` ([post 4](/blog/04-auditing-from-the-apps-eyes/)) | SELinux (kernel-enforced) | ✅ |
| Device logs | `READ_LOGS` → `logcat` | `scripts/revoke-readlogs.sh` + StockMask `hookLogAccess` ([post 3](/blog/03-the-logcat-leak/)) | permission + `system_server` + logd/SELinux | ✅ |
| Debug settings | `Settings.Global.adb_enabled` / `development_settings_enabled` | turn off USB debugging (don't hook `SettingsProvider`) | configuration (user) | ⚠️ artifact |
| `/proc` of **isolated** apps | own real `cmdline` / `version` from inside the isolated namespace | boot-image / kernel edit only — the bind-mount above can't reach an isolated namespace | kernel / boot image | 🧱 wall |
| Hardware attestation | KeyStore key with `setAttestationChallenge`, validated server-side ([post 1](/blog/01-the-google-wallet-wall/)) | nothing — the TEE signs the truth | TEE / StrongBox (below the kernel) | 🧱 wall |

<small>*The `/proc` bind-mount reaches the global view and non-isolated apps; a
Shamiko-isolated app gets a pristine `/proc` the bind-mount can't touch — that's the same
seam as the first wall below.</small>

## Three principles that emerged

**1. Filter by caller; don't inject into apps.** The strongest hides all live in the
*one* shared `system_server`, rewriting responses by `Binder.getCallingUid()`. The app's
own process stays pristine — there is nothing in it to detect. Per-app Xposed injection is
both detectable and, against hardened RASP, fatal (it crashed bank apps).

**2. Consistency beats spoofing.** A Pixel fingerprint bolted onto an otherwise-Xiaomi
system is *more* detectable than one coherent stock identity. Every partition fingerprint,
every security-patch date, every prop must tell the same story. The single biggest Wallet
red herring was a fingerprint that PIF and the system disagreed on.

**3. Know which wall you're at.** There are two, and both are immovable for the same root
reason: the trustworthy answer is produced *below* the layer a userspace module can reach.

- **Isolated `/proc`.** Shamiko-style **mount-namespace isolation** is a double-edged tool.
  Giving a denylisted app its own namespace hides the Magisk bind-mounts — but it does so by
  giving the app the *clean, real* view, which means the app reads the genuine
  `/proc/self/cmdline`, `/proc/version`, and `/proc/self/mountinfo`. A module that lives in
  the app's address space (Zygisk) was deliberately *not* injected into that app — so there
  is nothing in there to rewrite those files. The only thing that changes what an isolated
  `/proc` reports is editing the boot image or kernel. Unreachable from a module by
  construction.
- **Hardware key attestation.** The TEE (or a discrete StrongBox secure element) signs
  `verifiedBootState` and `deviceLocked` with a key the OS cannot read, and the chain
  terminates at a **factory-burned Google attestation root** ([post
  1](/blog/01-the-google-wallet-wall/)). All of that happens below the kernel; userspace
  cannot sign as the TEE and cannot make genuine hardware attest `locked` when the bootloader
  is unlocked. A forged chain satisfies a *local* check but a strict backend (Google Wallet)
  rejects it.

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
use — package list, features, permissions, props, `/proc`, services, logs. Every ✅ in the
table above is one small, auditable artifact: a 205-line LSPosed module
(`code/stockmask/`), a 30-rule `sepolicy.rule`, two shell scripts
(`post-fs-data.sh`, `revoke-readlogs.sh`), and otherwise stock Magisk/Shamiko. What you
will *not* beat is a determined native RASP that reads its own isolated `/proc`, or a
payment backend that validates hardware attestation. Aim your effort at the channels you
can actually close, document the walls plainly, and don't burn days pretending a wall is a
config gap.

## Further reading

- [Android key attestation](https://developer.android.com/privacy-and-security/security-key-attestation) — the cert chain, the attestation extension OID, and the `verifiedBootState` / `deviceLocked` fields the TEE signs.
- [Android Verified Boot (AVB)](https://source.android.com/docs/security/features/verifiedboot) — where the boot state the TEE attests to is actually computed and locked.
- [SELinux for Android](https://source.android.com/docs/security/features/selinux) — the kernel-enforced layer behind the service-discovery and logd walls.
