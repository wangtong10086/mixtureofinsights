---
title: "Auditing from the app's eyes"
description: "You can't tell what a normal app sees from adb shell — shell has privileges an app never does. Three lenses for looking through the app's eyes, and the blind spot of each."
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "6 min read"
tags: ["android", "selinux", "auditing", "nsenter"]
---

After the packages, features, permissions, props, and logs were handled, the honest
question remained: **what else can a normal app still observe?** You can't answer that
from `adb shell` — shell is uid 2000 with privileges an app never has. You have to look
through the app's eyes.

## Three lenses (and their blind spots)

**Lens 1 — `su -z`, the app's SELinux domain.**

```bash
su 10253 -z u:r:untrusted_app:s0 -c '<binary>'
```

Faithful for uid- and SELinux-gated checks (like logd). Blind spot: `untrusted_app`
can't `exec` `/system/bin/sh`, so no shell scripts — only single exec-allowed binaries.

**Lens 2 — `nsenter` into a running app.**

```bash
nsenter -t $(pidof com.target) -m cat /proc/cmdline
```

Faithful for the **mount-namespace / filesystem** view — which matters because Shamiko
gives denylisted apps an *isolated* namespace. Blind spot: runs as root, so SELinux reads
differ.

**Lens 3 — read the app's `/proc/<pid>` directly.**

```bash
grep -icE 'zygisk|lsposed|magisk|riru' /proc/<pid>/maps    # injection traces
grep TracerPid /proc/<pid>/status                          # 0 = not traced
```

Faithful for what's actually mapped into the process.

## What the lenses revealed

Mostly clean:

- **Root files**: none — `su`, `busybox`, `Superuser`, `XposedBridge.jar` all absent.
- **Props**: no `magisk`/`lineage`/`su`/`twrp` — only `ro.debuggable=0`, `ro.secure=1`.
- **`/proc` is `hidepid=invisible`**: apps can't enumerate other processes, so magiskd,
  the su daemon, and zygote are simply invisible.
- **Denylisted apps' `/proc/<pid>/maps`**: zero injection hits — Shamiko did its job.

Two things still leaked:

1. **`adb_enabled=1` / `development_settings_enabled=1`** — app-readable via
   `Settings.Global`. A weak "debugging device" signal, and on only because USB debugging
   is on for the work itself. Turn it off and it's gone — not worth a hot
   `SettingsProvider` hook with a huge blast radius.
2. **LineageOS system services** — `lineagehardware`, `lineagelivedisplay`,
   `lineagetrust`, `profile` — each with a dedicated SELinux type. A native RASP that
   bypasses hidden-API could `ServiceManager.getService("lineagehardware")` and detect the
   ROM *even after features are hidden.*

## Closing the service vector at the kernel

Hidden-API gates that call for ordinary apps, but not for native bypass — so close it at
the layer enforced regardless: **SELinux**. A magiskpolicy rule denies the untrusted
domains from ever finding the services:

```text
deny untrusted_app  lineage_hardware_service  service_manager { find }
deny isolated_app   lineage_hardware_service  service_manager { find }
... (all 10 lineage_* / hal_lineage_* types)
```

Persisted as `sepolicy.rule` in a Magisk module. System domains are untouched —
LiveDisplay et al. keep working — but no app can discover the services. Verified: clean
boot, `Enforcing`, lineage services still registered for the system.

## The method, distilled

Don't audit from `adb shell`. Pick the lens that's faithful for the *kind* of leak, mind
each lens's blind spot, and when SELinux or hidden-API gating muddies the picture, either
write a one-off probe APK or just close the hole at the SELinux layer — where the answer
doesn't depend on the app's tricks.
