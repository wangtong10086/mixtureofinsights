---
title: "The logcat leak"
description: "You hid the packages and the features. Then you notice fifteen apps quietly holding READ_LOGS — reading the whole device log, where every stray Magisk and lineage string is sitting in plain text."
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "5 min read"
tags: ["android", "logcat", "read_logs", "selinux"]
---

You hid the packages. You hid the features. Then an app asks to "access all device logs",
and you realize: anything you missed — a stray `Magisk` line, your module's tag, a
`lineage` string — is sitting in logcat for any app that can read it.

## The discovery

A quick audit of who already holds `READ_LOGS`:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "READ_LOGS: granted=true" && echo "$p"
done
```

Fifteen third-party apps came back — four banks, a ride-hailer, a maps app, two
e-commerce giants, an IM client, a music app — all able to read the **global** log.

## The surprise: it's an *install* permission here

`READ_LOGS` is `signature|privileged|`**`development`**. That `development` flag lets
LineageOS grant it **at install** to any app that merely declares it. No runtime prompt,
no user action — installed, therefore granted. These apps didn't hack anything; the ROM
handed it over.

## Closing it, in three layers

**1. Revoke.** `development` permissions are revocable and the revocation **survives app
updates** (only a full reinstall re-grants):

```bash
pm revoke <pkg> android.permission.READ_LOGS
```

**2. Default-deny the runtime path.** After revoke, an app calling `logcat` at runtime
hits `LogcatManagerService`'s "allow all logs?" dialog. Auto-decline it for third-party
callers inside `system_server` — silently, so no prompt appears. The decision runs on a
handler thread, so the uid must come from the **request object**, not
`Binder.getCallingUid()`:

```java
int uid = getIntField(req, "mUid");
if (uid % 100000 >= 10000) { callMethod(svc, "declineRequest", req); setResult(null); }
```

(Method names confirmed by dex-dumping `services.jar`: `processNewLogAccessRequest` and
`declineRequest` exist on Android 16.)

**3. Silence yourself.** Remove every `XposedBridge.log("StockMask …")`. Your own debug
line is a detection string.

## The verification trap that almost fooled me

Testing with `su 10253 -c 'logcat'` returned **329 lines** — looked like revoke failed!
It hadn't. `su <uid>` keeps the *privileged* SELinux domain, which bypasses logd's uid
check. Forcing the real app context tells the truth:

```text
su 10253 -z u:r:untrusted_app:s0 -c 'logcat -d -t 200' | wc -l   ->   0   (denied)
su 2000  -z u:r:shell:s0          -c 'logcat -d -t 200' | wc -l   -> 139   (control)
```

> Always test from the app's actual SELinux domain. A "leak" that only appears under
> `su` may be the test lying, not the device.

## Takeaway

Log access is an easy channel to forget and a trivial one to exploit. On a ROM that
auto-grants `READ_LOGS`, assume a chunk of your installed apps already have it — audit,
revoke, default-deny, and stop logging anything incriminating yourself.
