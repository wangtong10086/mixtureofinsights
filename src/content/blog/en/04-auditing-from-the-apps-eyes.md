---
title: "Auditing from the app's eyes"
description: "You can't tell what a normal app sees from adb shell — shell has privileges an app never does. Three lenses for looking through the app's eyes, and the blind spot of each."
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "9 min read"
tags: ["android", "selinux", "auditing", "nsenter"]
---

To measure what a normal app could still observe, I stopped using `adb shell`. Shell lives in a different world than an app. `adb shell` runs as UID 2000 in the `shell` SELinux domain, while an app runs as UID 10000+ in `untrusted_app` and inside an isolated mount namespace that Shamiko sets up. 

I relied on three lenses to see through the app's eyes:

1. `su 10253 -z u:r:untrusted_app:s0 -c '<binary>'`
This perfectly matched the app's UID and SELinux domain for testing gatekeepers like logd. Its blind spot: `untrusted_app` can't execute `/system/bin/sh`.
2. `nsenter -t $(pidof com.target) -m cat /proc/cmdline`
Using [`nsenter(1)`](https://man7.org/linux/man-pages/man1/nsenter.1.html), I entered the running app's mount namespace. This revealed the filesystem without Magisk overlays. Its blind spot: it runs as root, bypassing SELinux constraints.
3. Reading `/proc/<pid>/...` directly from shell.
This showed me exactly what was mapped into the process, such as checking `maps` for Zygisk injection traces.

Through these lenses, the environment looked mostly clean. `/proc` was `hidepid=invisible`, Shamiko had isolated the namespaces perfectly, and there were zero injection hits. But two things leaked: `adb_enabled=1` and LineageOS system services. Services like `lineagehardware` were still resolvable via `ServiceManager.getService("lineagehardware")` by native code.

I closed the service vector at the kernel layer by modifying the [SELinux](https://source.android.com/docs/security/features/selinux) policy. I wrote a strict cross-product of denial rules preventing untrusted app domains from discovering Lineage services.

```text
deny untrusted_app lineage_hardware_service   service_manager { find }
deny untrusted_app lineage_livedisplay_service service_manager { find }
deny isolated_app  lineage_hardware_service    service_manager { find }
```

By persisting this via `sepolicy.rule` in a Magisk module, the OS completely blinded apps at the kernel level without interfering with the system domains that rely on them. Hidden-API gating only works for Java layer logic; closing it at SELinux physically prevents discovery regardless of the app's tricks.
