---
title: "logcat 泄漏:十五个 App 正悄悄读着你整台设备的日志"
description: "你藏好了包名,也藏好了特性。然后你发现十五个 App 默默持有 READ_LOGS——读着整台设备的日志,而你漏掉的每一行 Magisk、lineage 字样都明晃晃地躺在那里。"
date: 2026-06-10
order: 3
series: "android-hardening"
reading: "5 分钟"
tags: ["android", "logcat", "read_logs", "selinux"]
---

你藏好了包名。你藏好了特性。然后一个 App 弹窗请求"访问所有设备日志",你才意识到:任何你漏掉的
东西——一行散落的 `Magisk`、你模块的 tag、一个 `lineage` 字串——都正躺在 logcat 里,任何能读它的
App 都看得见。

## 发现

快速排查一下谁已经持有 `READ_LOGS`:

```bash
for p in $(pm list packages -3 | cut -d: -f2); do
  dumpsys package "$p" | grep -q "READ_LOGS: granted=true" && echo "$p"
done
```

回来了十五个第三方 App——四家银行、一个打车、一个地图、两个电商巨头、一个 IM、一个音乐 App——
全都能读**全局**日志。

## 意外:在这里它是个*安装期*权限

`READ_LOGS` 是 `signature|privileged|`**`development`**。那个 `development` 标志让 LineageOS 在
**安装时**就把它授予任何在清单里声明了它的 App。没有运行时弹窗,没有用户操作——装上,就授予了。
这些 App 没有黑掉什么;是 ROM 主动递了过去。

## 三层把它堵上

**1. 撤销。** `development` 权限是可撤销的,而且撤销**在 App 更新中存活**(只有完整重装才会重新
授予):

```bash
pm revoke <pkg> android.permission.READ_LOGS
```

**2. 默认拒绝运行时那条路。** 撤销后,App 在运行时调 `logcat` 会撞上 `LogcatManagerService` 的
"允许访问所有日志?"弹窗。在 `system_server` 里对第三方调用方**自动拒绝**它——静默地,连弹窗都不
出现。那个决策跑在 handler 线程上,所以 uid 必须从**请求对象**里取,而不是 `Binder.getCallingUid()`:

```java
int uid = getIntField(req, "mUid");
if (uid % 100000 >= 10000) { callMethod(svc, "declineRequest", req); setResult(null); }
```

(方法名是反编译 `services.jar` 核实的:Android 16 上 `processNewLogAccessRequest`、`declineRequest`
都存在。)

**3. 让自己闭嘴。** 删掉每一句 `XposedBridge.log("StockMask …")`。你自己的调试日志就是个检测字串。

## 差点骗到我的那个验证陷阱

用 `su 10253 -c 'logcat'` 测,回来了 **329 行**——看着像撤销失败了!其实没有。`su <uid>` 仍处在
*特权* SELinux 域里,绕过了 logd 的 uid 检查。逼出 App 真实的上下文,才说真话:

```text
su 10253 -z u:r:untrusted_app:s0 -c 'logcat -d -t 200' | wc -l   ->   0   (被拒)
su 2000  -z u:r:shell:s0          -c 'logcat -d -t 200' | wc -l   -> 139   (对照)
```

> 永远从 App 真实的 SELinux 域去测。一个只在 `su` 下出现的"泄漏",可能是测试在说谎,而不是设备。

## 要点

日志访问是一条容易被忘、又极易被利用的旁路。在一台会自动授予 `READ_LOGS` 的 ROM 上,默认假设
你装的 App 里有一批已经持有它——排查、撤销、默认拒绝,并且别再自己往里写任何会露馅的东西。
