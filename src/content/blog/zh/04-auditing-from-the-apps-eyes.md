---
title: "以 App 的视角审计:怎么知道一个无 root 的 App 究竟看得见什么"
description: "你没法从 adb shell 判断一个普通 App 看得见什么——shell 拥有 App 永远没有的特权。用三种「镜片」透过 App 的眼睛去看,以及每一种的盲区。"
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "6 分钟"
tags: ["android", "selinux", "auditing", "nsenter"]
---

在包名、特性、权限、props、日志都处理完之后,诚实的问题仍在:**一个普通 App 还能观察到什么?**
你没法从 `adb shell` 回答它——shell 是 uid 2000,带着 App 永远没有的特权。你得透过 App 的眼睛去看。

## 三种镜片(以及各自的盲区)

**镜片一 —— `su -z`,App 的 SELinux 域。**

```bash
su 10253 -z u:r:untrusted_app:s0 -c '<binary>'
```

对 uid 和 SELinux 把关的检查(比如 logd)忠实。盲区:`untrusted_app` 不能 `exec`
`/system/bin/sh`,所以跑不了 shell 脚本——只能跑单个被允许 exec 的二进制。

**镜片二 —— `nsenter` 进一个运行中的 App。**

```bash
nsenter -t $(pidof com.target) -m cat /proc/cmdline
```

对**挂载命名空间 / 文件系统**视角忠实——这很关键,因为 Shamiko 给名单内的 App 一个*隔离*的命名
空间。盲区:它以 root 运行,所以 SELinux 把关的读取会不同。

**镜片三 —— 直接读该 App 的 `/proc/<pid>`。**

```bash
grep -icE 'zygisk|lsposed|magisk|riru' /proc/<pid>/maps    # 注入痕迹
grep TracerPid /proc/<pid>/status                          # 0 = 未被追踪
```

对进程里实际映射了什么忠实。

## 这些镜片照出了什么

大体干净:

- **root 文件**:没有——`su`、`busybox`、`Superuser`、`XposedBridge.jar` 全不存在。
- **props**:没有 `magisk`/`lineage`/`su`/`twrp`——只有 `ro.debuggable=0`、`ro.secure=1`。
- **`/proc` 是 `hidepid=invisible`**:App 无法枚举其他进程,所以 magiskd、su 守护进程、zygote 直接
  隐形。
- **名单内 App 的 `/proc/<pid>/maps`**:零注入命中——Shamiko 干了它该干的活。

还有两样仍在泄漏:

1. **`adb_enabled=1` / `development_settings_enabled=1`**——App 可通过 `Settings.Global` 读到。一个
   微弱的"调试设备"信号,而且只因为干活时开着 USB 调试。关掉它就没了——不值得为它去 hook 高频的
   `SettingsProvider`(影响面太大)。
2. **LineageOS 系统服务**——`lineagehardware`、`lineagelivedisplay`、`lineagetrust`、`profile`——
   各有专属的 SELinux 类型。一个绕过 hidden-API 的原生 RASP 可以
   `ServiceManager.getService("lineagehardware")` 探到 ROM,*哪怕特性已被隐藏*。

## 在内核层封死服务这条路

hidden-API 对普通 App 的那次调用设了门,但挡不住原生绕过——所以就在那个无论如何都强制执行的层
去封它:**SELinux**。一条 magiskpolicy 规则禁止那些不可信域去 find 这些服务:

```text
deny untrusted_app  lineage_hardware_service  service_manager { find }
deny isolated_app   lineage_hardware_service  service_manager { find }
... (全部 10 个 lineage_* / hal_lineage_* 类型)
```

作为 `sepolicy.rule` 持久化进一个 Magisk 模块。系统域不受影响——LiveDisplay 等照常工作——但没有
App 能发现这些服务。验证:开机正常、`Enforcing`、lineage 服务对系统仍在注册。

## 方法,提炼出来

别从 `adb shell` 审计。按泄漏的*种类*挑那把忠实的镜片,留意每把镜片的盲区,当 SELinux 或
hidden-API 把图景搅浑时,要么写一个一次性的探测 APK,要么干脆在 SELinux 层把洞堵上——在那里,答案
不取决于 App 的小把戏。
