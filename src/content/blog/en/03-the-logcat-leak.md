---
title: "The logcat leak"
description: "You hid the packages and the features. Then you notice fifteen apps quietly holding READ_LOGS — reading the whole device log, where every stray Magisk and lineage string is sitting in plain text."
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "10 min read"
tags: ["android", "logcat", "read_logs", "selinux"]
---

You hid the packages. You hid the features. Then an app asks to "access all device logs",
and you realize: anything you missed — a stray `Magisk` line, your module's tag, a
`lineage` string — is sitting in logcat for any app that can read it.

The thing that makes this a real channel and not a curiosity: **logcat is system-wide, not
per-app.** The system log buffers (`main`, `system`, `crash`, `events`, …) carry output
from *every* process — the framework, GMS, your Magisk daemon's stderr, your LSPosed
module's own `log()` calls, init's verified-boot chatter. A normal app can't read another
app's memory, but an app holding `READ_LOGS` reads all of that in plain text. It's the one
side channel where the tells you carefully hid from the PackageManager API leak right back
out as raw strings.

## The discovery

A quick audit of who already holds `READ_LOGS` — the read-only half of the revoke script:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "android.permission.READ_LOGS: granted=true" && echo "$p"
done
```

Fifteen third-party apps came back — four banks, a ride-hailer, a maps app, two
e-commerce giants, an IM client, a music app — all able to read the **global** log.

## The surprise: it's an *install* permission here

`READ_LOGS` has protection level `signature|privileged|`**`development`**. Android's
protection levels are a base level plus optional flags, and they decide *how* a permission
can ever be granted:

| Protection level | Who gets it, and how |
|---|---|
| `normal` | Auto-granted at install; no prompt. Low-risk (e.g. `INTERNET`, `VIBRATE`). |
| `dangerous` | Runtime user prompt (`requestPermissions`), per-permission-group, revocable in Settings. |
| `signature` | Granted only if the requesting app is signed with the **same key** as the declarer (the platform key, for framework permissions). No user involvement. |
| `privileged` (flag, the modern replacement for the deprecated `signatureOrSystem`) | A preinstalled app in `/system/priv-app` whose package is on the device's **privileged-permission allowlist** XML. |
| **`development`** (flag) | A signature-or-privileged permission that can *additionally* be toggled at runtime by a shell with `pm grant` / `appops` — and that some ROMs auto-grant on install. |

Read `signature|privileged|development` as the OR of those grant paths: an app signed with
the platform key gets it (`signature`); a privileged system app in `/system/priv-app` with
the right allowlist entry gets it (`privileged`); and — the surprising one — the
`development` flag makes it a *development* permission. "Development" means it is meant for
debugging, so it's deliberately handed an extra grant path the others lack:
`adb shell pm grant <pkg> android.permission.READ_LOGS` (and the matching `appops`/`cmd
appops` toggles) can switch it on from the `shell` UID — **and some ROMs auto-grant it at
install.** On the LineageOS build in question, declaring `READ_LOGS` in the
manifest was enough: granted at install time, no runtime prompt, no user action. These apps
didn't hack anything; the ROM handed it over. (On a stock Pixel the same app would *not*
get it this way — it would have to go through `LogcatManagerService`'s runtime dialog,
below. ROM behavior here genuinely differs.)

Worth knowing for context: historically (pre-Android-7 era) plain third-party apps could
hold `READ_LOGS` and read everyone's logs, which is exactly why Google reclassified it to
signature/privileged and walled runtime access behind a per-request user prompt. A ROM
that auto-grants the `development` path quietly reopens the door that change was meant to
shut.

## Closing it, in three layers

**1. Revoke.** `development` permissions are revocable and the revocation **survives app
updates** (only a full reinstall re-grants). `code/scripts/revoke-readlogs.sh` walks every
third-party package, revokes from the ones that hold it, then re-scans to confirm none
remain:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  if dumpsys package "$p" 2>/dev/null | grep -q "android.permission.READ_LOGS: granted=true"; then
    if pm revoke "$p" android.permission.READ_LOGS 2>/dev/null; then echo "revoked: $p"; else echo "FAILED:  $p"; fi
  fi
done
echo "--- remaining holders (should be empty) ---"
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" 2>/dev/null | grep -q "android.permission.READ_LOGS: granted=true" && echo "STILL: $p"
done
```

(The script pipes this into `adb shell su`, so the whole sweep runs in one rooted shell.
Re-run it after a *full* uninstall+reinstall of any app — that, and only that, re-grants.)

**2. Default-deny the runtime path.** After revoke, an app calling `logcat` at runtime
routes through `LogcatManagerService.processNewLogAccessRequest`, which (for a caller that
isn't otherwise allowed) raises the "allow all logs?" dialog and waits on the user. The
hardening is to turn that into a silent default-deny for third-party callers inside
`system_server` — call `declineRequest` before any prompt is shown. The decision runs on a
handler thread, *not* inside the Binder transaction, so `Binder.getCallingUid()` here would
return `system_server`'s own UID; the real caller uid must come from the **request
object**:

```java
XposedBridge.hookAllMethods(lms, "processNewLogAccessRequest", new XC_MethodHook() {
    @Override protected void beforeHookedMethod(MethodHookParam p) {
        try {
            Object req = (p.args != null && p.args.length > 0) ? p.args[0] : null;
            if (req == null) return;
            int uid = XposedHelpers.getIntField(req, "mUid");
            if (!isThirdPartyAppId(uid)) return;        // system/root -> normal
            XposedHelpers.callMethod(p.thisObject, "declineRequest", req); // deny, no dialog
            p.setResult(null);
        } catch (Throwable ignored) {}
    }
});
```

This is `hookLogAccess` in the same `Main.java` as the feature/permission hooks — the
*third* limb of the module, on `com.android.server.logcat.LogcatManagerService`. Note it's
a `beforeHookedMethod`: it short-circuits the request *before* the service can raise the
dialog, calling `declineRequest` and setting the result to null so the original method
never runs. And it reuses the exact same `isThirdPartyAppId(uid)` appId test as the
PackageManager hooks — the only difference is *where the uid comes from*. (Method names
confirmed by dex-dumping `services.jar`: `processNewLogAccessRequest`, `declineRequest`,
and the `LogAccessRequest.mUid` field exist on this build.)

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

There are really *two* gates in front of the log here, and the verification trap conflated
them. The first is the permission check (`READ_LOGS` granted or not), enforced in the
framework. The second is logd's own access control, enforced by **SELinux + the caller's
UID** down in the daemon: even the framework check passing, logd decides what a given
domain may read. `su <uid>` satisfies the UID but keeps the privileged domain, so it sails
past logd's domain check — which is precisely why it lied. The `untrusted_app` domain is
the one a real app runs in, and it's the one logd actually gates.

## Takeaway

Log access is an easy channel to forget and a trivial one to exploit. On a ROM that
auto-grants `READ_LOGS`, assume a chunk of your installed apps already have it — audit,
revoke, default-deny at the runtime path, and stop logging anything incriminating
yourself.

## Further reading

- [`READ_LOGS` permission](https://developer.android.com/reference/android/Manifest.permission#READ_LOGS) — protection level and intended access model.
- [Permissions on Android — protection levels](https://developer.android.com/guide/topics/permissions/overview#permission-protection-levels) — what `signature`, `privileged`, and `development` each mean and how they combine.
- [AOSP `LogcatManagerService`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java) — the runtime "allow all logs?" gate, `processNewLogAccessRequest` / `declineRequest`.
