---
title: "Auditing from the app's eyes"
description: "You can't tell what a normal app sees from adb shell — shell has privileges an app never does. Three lenses for looking through the app's eyes, and the blind spot of each."
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "9 min read"
tags: ["android", "selinux", "auditing", "nsenter"]
---

After the packages, features, permissions, props, and logs were handled, the honest
question remained: **what else can a normal app still observe?** You can't answer that
from `adb shell` — shell lives in a different world than an app, on three axes at once.

## Why `adb shell` lies

`adb shell` runs as uid **2000** (`AID_SHELL`) in the SELinux domain **`shell`**. A normal
installed app runs as uid **10000+** (`AID_APP_START` and up) in the domain
**`untrusted_app`** (or `untrusted_app_3X` for the per-target-SDK split), and — on a hiding
stack — inside an **isolated mount namespace** that Magisk/Shamiko set up just for it. Each
axis hides a different thing:

- **UID.** `shell` is a trusted debug identity; many `/proc` entries, `dumpsys` surfaces and
  service calls that are allowed for uid 2000 are flatly denied to uid 10000+.
- **SELinux domain.** logd, `service_manager` `find`, and dozens of file types are gated by
  *domain*, not uid. `shell` carries broad allow rules that `untrusted_app` does not — so a
  read that succeeds under `shell` can be denied to the same uid in the app's domain (this is
  exactly the logcat trap from [the logcat post](/blog/03-the-logcat-leak/)).
- **Mount namespace.** `adb shell` sees the global mount table — every Magisk overlay and
  bind-mount. A denylisted app sees a *cleaned* namespace where those mounts were never
  applied. So the filesystem `adb shell` walks is not the one the app walks.

The only honest answer is to look through the app's eyes. Three lenses do it, each faithful
on one axis and blind on another. (For the leaks that *do* need a script — capturing an
app's own logcat to find which Activity throws the detection challenge, say — the repo's
`code/scripts/applog.sh` drives `adb logcat` filtered to one package's pid; but a script
runs as `shell`, not the app, so it can't answer the SELinux-gated questions below. For
those, the lens is the tool.)

## Three lenses (and their blind spots)

| Lens | Matches | Blind spot |
|---|---|---|
| 1. `su <uid> -z u:r:untrusted_app:s0` | the app's **uid + SELinux domain** | not the app's mount namespace; `untrusted_app` can't `exec /system/bin/sh`, so single binaries only, no scripts |
| 2. `nsenter -t <pid> -m` into the running app | the app's **mount namespace** (isolated `/proc`, no Magisk overlays) | runs as **root** — SELinux checks differ, so uid/domain-gated reads look more permissive than the app's |
| 3. read `/proc/<pid>/...` directly from shell | what is **actually mapped/recorded** for that process | shell's own uid/domain — false negatives (denied to the app but readable to you) and false positives (you read a path the app's namespace hides) |

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
the layer enforced regardless: **SELinux**. `code/fuxi_prop_spoof/sepolicy.rule` denies
the untrusted app domains from ever *finding* the services. The actual rule is a full
cross-product: every untrusted domain × every Lineage service type:

```text
# Deny third-party app domains from discovering LineageOS services via ServiceManager.getService
deny untrusted_app lineage_hardware_service   service_manager { find }
deny untrusted_app lineage_livedisplay_service service_manager { find }
deny untrusted_app lineage_trust_service       service_manager { find }
...
deny isolated_app  lineage_hardware_service    service_manager { find }
...
deny ephemeral_app lineage_hardware_service    service_manager { find }
...
```

Counting it out: **ten** service types — six `lineage_*_service` (globalactions,
hardware, health_interface, livedisplay, trust, profile) plus four `hal_lineage_*_service`
(health, livedisplay, powershare, touch) — denied across **three** app domains
(`untrusted_app`, `isolated_app`, `ephemeral_app`). That's why the file is thirty
`deny` lines, not three: a single forgotten domain (e.g. an instant app, or a Shamiko-
isolated one) would be a hole. System domains are deliberately *not* in the list —
LiveDisplay's own service registration and the system's reads still resolve — so the
feature keeps working while no app can discover it. Persisted as `sepolicy.rule` in a
Magisk module; verified on a clean `Enforcing` boot with the lineage services still
registered for the system.

## The method, distilled

Don't audit from `adb shell`. Pick the lens that's faithful for the *kind* of leak, mind
each lens's blind spot, and when SELinux or hidden-API gating muddies the picture, either
write a one-off probe APK or just close the hole at the SELinux layer — where the answer
doesn't depend on the app's tricks.

## Further reading

- [SELinux for Android (AOSP)](https://source.android.com/docs/security/features/selinux) — domains, types, and why `shell` and `untrusted_app` are allowed different things.
- [Android UIDs / AIDs](https://cs.android.com/android/platform/superproject/main/+/main:system/core/libcutils/include/private/android_filesystem_config.h) — `AID_SHELL` (2000), `AID_APP_START` (10000), and the rest of the fixed map.
- [`nsenter(1)`](https://man7.org/linux/man-pages/man1/nsenter.1.html) — entering another process's mount (and other) namespaces.
