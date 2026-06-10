---
title: "logcat 泄漏:十五个 App 正悄悄读着你整台设备的日志"
description: "你藏好了包名,也藏好了特性。然后你发现十五个 App 默默持有 READ_LOGS——读着整台设备的日志,而你漏掉的每一行 Magisk、lineage 字样都明晃晃地躺在那里。"
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "8 分钟"
tags: ["android", "logcat", "read_logs", "selinux"]
---

你藏好了包名。你藏好了特性。然后一个 App 弹窗请求「访问所有设备日志」,你才意识到:任何你漏掉的
东西——一行散落的 `Magisk`、你模块的 tag、一个 `lineage` 字串——都正躺在 logcat 里,任何能读它的
App 都看得见。

让这成为一条真旁路、而非小插曲的,是这一点:**logcat 是全系统的,不是按 App 隔离的。** 系统日志
缓冲区(`main`、`system`、`crash`、`events` ……)装的是*每一个*进程的输出——框架、GMS、你 Magisk
守护进程的 stderr、你 LSPosed 模块自己的 `log()` 调用、init 的 verified-boot 絮语。普通 App 读不了
另一个 App 的内存,但一个持有 `READ_LOGS` 的 App,把这些全以明文读走。你从 PackageManager API 那
小心藏好的破绽,在这条旁路上以原始字符串的形式原样漏了回来。

## 发现

快速排查一下谁已经持有 `READ_LOGS`——也就是吊销脚本里只读的那一半:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "android.permission.READ_LOGS: granted=true" && echo "$p"
done
```

回来了十五个第三方 App——四家银行、一个打车、一个地图、两个电商巨头、一个 IM、一个音乐 App——
全都能读**全局**日志。

## 意外:在这里它是个*安装期*权限

`READ_LOGS` 的保护级别是 `signature|privileged|`**`development`**。Android 的保护级别是一个基础
级别加上若干可选标志,它们决定一个权限*能以何种方式*被授予:

| 保护级别 | 谁能拿到、怎么拿到 |
|---|---|
| `normal` | 安装时自动授予,无弹窗。低风险(如 `INTERNET`、`VIBRATE`)。 |
| `dangerous` | 运行时用户弹窗(`requestPermissions`),按权限组,在设置里可撤销。 |
| `signature` | 仅当请求方与声明方用**同一把签名**(框架权限即平台密钥)才授予。无需用户参与。 |
| `privileged`(作为标志使用) | `/system/priv-app` 下的预装 App,且其包名在设备的**特权权限白名单** XML 里。 |
| **`development`**(标志) | 一个 signature 或 privileged 权限,但*额外*允许 shell 通过 `pm grant` / `appops` 在运行时打开——而且某些 ROM 会在安装时自动授予。 |

把 `signature|privileged|development` 读成这几条授予路径的「或」:用平台密钥签名的 App 拿得到
(`signature`);`/system/priv-app` 下且在白名单里的特权系统 App 拿得到(`privileged`);而那个意外
的——`development` 标志让它成了一个*开发*权限。「开发」意味着它本是为调试准备的,所以特意被多给了
一条别人没有的授予路径:`adb shell pm grant <pkg> android.permission.READ_LOGS`(以及对应的
`appops` 开关)能从 `shell` UID 把它打开——**而且某些 ROM 会在安装时自动授予它。** 在那台
LineageOS 上,在清单里声明 `READ_LOGS` 就够了:安装时即授予,没有运行时弹窗,没有用户操作。这些
App 没有黑掉什么;是 ROM 主动递了过去。

## 三层把它堵上

**1. 撤销。** `development` 权限是可撤销的,而且撤销**在 App 更新中存活**(只有完整重装才会重新
授予)。`code/scripts/revoke-readlogs.sh` 会遍历每个第三方包,对持有该权限的逐个撤销,然后再扫一遍
确认没有残留:

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

(脚本把这整段管进 `adb shell su`,于是整轮清扫在一个 root shell 里跑完。任何 App 做过*完整的*
卸载+重装后要重跑一次——也只有这种情况才会重新授予。)

**2. 默认拒绝运行时那条路。** 撤销后,App 在运行时调 `logcat` 会走到
`LogcatManagerService.processNewLogAccessRequest`——对一个没有别的途径被放行的调用方,它会弹出
「允许访问所有日志?」并等用户。加固的办法是把它变成对第三方调用方的静默默认拒绝:在
`system_server` 里、在任何弹窗出现之前就调 `declineRequest`。这个决策跑在 handler 线程上,*不在*
Binder 事务内,所以这里的 `Binder.getCallingUid()` 会返回 `system_server` 自己的 UID;真正的
调用方 uid 必须从**请求对象**里取:

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

这就是和特性 / 权限钩子同一份 `Main.java` 里的 `hookLogAccess`——模块的*第三*条腿,挂在
`com.android.server.logcat.LogcatManagerService` 上。注意它是 `beforeHookedMethod`:在服务能弹出
对话框*之前*就把请求短路掉,调 `declineRequest` 并把结果置空,于是原方法根本不会跑。它复用的正是和
PackageManager 钩子完全相同的 `isThirdPartyAppId(uid)` appId 判断——唯一的区别是 *uid 从哪来*。
(方法名是反编译 `services.jar` 核实的:这个 build 上 `processNewLogAccessRequest`、`declineRequest`
以及 `LogAccessRequest.mUid` 字段都存在。)

**3. 让自己闭嘴。** 删掉每一句 `XposedBridge.log("StockMask …")`。你自己的调试日志就是个检测字串。

## 差点骗到我的那个验证陷阱

用 `su 10253 -c 'logcat'` 测,回来了 **329 行**——看着像撤销失败了!其实没有。`su <uid>` 仍处在
*特权* SELinux 域里,绕过了 logd 的 uid 检查。逼出 App 真实的上下文,才说真话:

```text
su 10253 -z u:r:untrusted_app:s0 -c 'logcat -d -t 200' | wc -l   ->   0   (被拒)
su 2000  -z u:r:shell:s0          -c 'logcat -d -t 200' | wc -l   -> 139   (对照)
```

> 永远从 App 真实的 SELinux 域去测。一个只在 `su` 下出现的「泄漏」,可能是测试在说谎,而不是设备。

日志前面其实有*两道*门,而那个验证陷阱把它俩混为一谈了。第一道是权限检查(`READ_LOGS` 授没授),
在框架层强制。第二道是 logd 自己的访问控制,由守护进程里的 **SELinux + 调用方 UID** 强制:哪怕
框架那道过了,logd 仍会决定某个域能读什么。`su <uid>` 满足了 UID,却仍带着特权域,于是它直接绕过
了 logd 的域检查——这正是它说谎的原因。`untrusted_app` 才是真实 App 所处的域,也是 logd 真正
把关的那个。

## 要点

日志访问是一条容易被忘、又极易被利用的旁路。在一台会自动授予 `READ_LOGS` 的 ROM 上,默认假设
你装的 App 里有一批已经持有它——排查、撤销、在运行时那条路默认拒绝,并且别再自己往里写任何会
露馅的东西。

## 延伸阅读

- [`READ_LOGS` 权限](https://developer.android.com/reference/android/Manifest.permission#READ_LOGS) —— 保护级别与设计的访问模型。
- [Android 权限——保护级别](https://developer.android.com/guide/topics/permissions/overview#permission-protection-levels) —— `signature`、`privileged`、`development` 各自的含义,以及它们如何组合。
- [AOSP `LogcatManagerService`](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java) —— 运行时「允许访问所有日志?」那道门,`processNewLogAccessRequest` / `declineRequest`。
