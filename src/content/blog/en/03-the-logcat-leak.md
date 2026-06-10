---
title: "The logcat leak"
description: "You hid the packages and the features. Then you notice fifteen apps quietly holding READ_LOGS — reading the whole device log, where every stray Magisk and lineage string is sitting in plain text."
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "10 min read"
tags: ["android", "logcat", "read_logs", "selinux"]
---

I hid the packages and features, but then I audited permissions and noticed fifteen third-party apps holding `READ_LOGS`. They were reading the global log, where Magisk daemon stderr and LSPosed module traces sat in plain text.

Logcat is system-wide. A normal app can't read another app's memory, but an app holding `READ_LOGS` reads the system log buffers in plain text. I discovered that on this LineageOS build, [`READ_LOGS`](https://developer.android.com/reference/android/Manifest.permission#READ_LOGS) was auto-granted at install. Its protection level is `signature|privileged|development`. The `development` flag allows a shell to grant it, and this ROM was silently auto-granting it upon manifest declaration.

I built a three-layer defense. First, I revoked the permission from all third-party apps using a root script:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  if dumpsys package "$p" 2>/dev/null | grep -q "android.permission.READ_LOGS: granted=true"; then
    pm revoke "$p" android.permission.READ_LOGS
  fi
done
```

Second, I default-denied the runtime path. I hooked [`LogcatManagerService`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java) inside `system_server`. Since the decision runs on a handler thread instead of a Binder transaction, I couldn't use `Binder.getCallingUid()`. I extracted the UID from the `LogAccessRequest` object.

```java
XposedBridge.hookAllMethods(lms, "processNewLogAccessRequest", new XC_MethodHook() {
    @Override protected void beforeHookedMethod(MethodHookParam p) {
        try {
            Object req = (p.args != null && p.args.length > 0) ? p.args[0] : null;
            if (req == null) return;
            int uid = XposedHelpers.getIntField(req, "mUid");
            if (!isThirdPartyAppId(uid)) return;
            XposedHelpers.callMethod(p.thisObject, "declineRequest", req);
            p.setResult(null);
        } catch (Throwable ignored) {}
    }
});
```

Finally, I stripped all my own `XposedBridge.log` statements from my modules. 

I almost fell into a verification trap. Running `su 10253 -c 'logcat'` returned 329 lines, making it look like the revoke failed. It hadn't. `su <uid>` keeps the privileged SELinux domain, bypassing logd's check. Forcing the real app context revealed the truth:

```text
su 10253 -z u:r:untrusted_app:s0 -c 'logcat -d -t 200' | wc -l   ->   0   (denied)
```
Logd enforces access via SELinux and caller UID. The `untrusted_app` domain is what logd actually gates. Testing from the app's actual SELinux domain is the only way to measure physical limits.
