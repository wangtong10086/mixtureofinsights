---
title: "别用 adb shell 代替 App 的眼睛"
description: "shell 看到的世界，普通 App 未必看得到。要审计检测面，得从 App 自己的 UID、命名空间和 SELinux 域里看。"
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "9 分钟"
tags: ["android", "selinux", "auditing", "nsenter"]
---

处理完包名、特性、权限、props 和日志以后，我还剩一个不太舒服的问题：这些检查是在我自己的视角里干净，
还是在普通 App 的视角里也干净？

这个问题不能靠 `adb shell` 回答。shell 不是 App，它有不同的 uid、不同的 SELinux 域、不同的挂载命名空间。
它看到的世界更像维修间，不像 App 真正生活的房间。要做一次诚实的审计，就得尽量从 App 的眼睛里往外看。

## 为什么 `adb shell` 会说谎

`adb shell` 以 uid **2000**(`AID_SHELL`)、在 SELinux 域 **`shell`** 里运行。而一个普通安装的 App
以 uid **10000+**(`AID_APP_START` 起)、在域 **`untrusted_app`**(按目标 SDK 拆分时是
`untrusted_app_3X`)里运行,而且——在隐藏栈上——还处在一个 Magisk/Shamiko 专为它搭好的**隔离挂载
命名空间**里。每一个维度都藏着不同的东西:

- **UID。** `shell` 是个可信的调试身份;许多对 uid 2000 放行的 `/proc` 项、`dumpsys` 面、服务调用,
  对 uid 10000+ 是直接拒绝的。
- **SELinux 域。** logd、`service_manager` 的 `find`、以及几十种文件类型,是按*域*把关的,而不是
  按 uid。`shell` 带着 `untrusted_app` 没有的大量 allow 规则——所以一个在 `shell` 下成功的读取,
  对同一个 uid、换到 App 的域里就可能被拒(这正是 [logcat 那篇](/zh/blog/03-the-logcat-leak/)里的陷阱)。
- **挂载命名空间。** `adb shell` 看到的是全局挂载表——每一个 Magisk overlay 和 bind-mount。而一个
  名单内的 App 看到的是一个*被清理过*的命名空间,那些挂载从未被应用。所以 `adb shell` 走的文件系统,
  不是 App 走的那个。

唯一诚实的答案,是透过 App 的眼睛去看。三种镜片能做到,每一种在某一个维度上忠实、在另一个维度上失明。
(对那些*确实*需要脚本的泄漏——比如抓一个 App 自己的 logcat 来定位是哪个 Activity 抛出了检测挑战——
仓库里的 `code/scripts/applog.sh` 会把 `adb logcat` 按某个包的 pid 过滤后驱动起来;但脚本是以 `shell`
身份跑的,不是 App,所以它回答不了下面那些受 SELinux 门控的问题。对那些问题,镜片才是工具。)

## 三种镜片(以及各自的盲区)

| 镜片 | 匹配的是 | 盲区 |
|---|---|---|
| 一、`su <uid> -z u:r:untrusted_app:s0` | App 的 **uid + SELinux 域** | 不是 App 的挂载命名空间;`untrusted_app` 不能 `exec /system/bin/sh`,只能跑单个二进制,跑不了脚本 |
| 二、`nsenter -t <pid> -m` 进运行中的 App | App 的**挂载命名空间**(隔离的 `/proc`,无 Magisk overlay) | 以 **root** 运行——SELinux 检查不同,uid/域把关的读取看起来比 App 更宽松 |
| 三、从 shell 直接读 `/proc/<pid>/...` | 该进程**实际映射 / 记录**了什么 | 带的是 shell 自己的 uid/域——会有假阴性(对 App 拒绝、对你可读)和假阳性(你读到一条 App 命名空间里藏起来的路径) |

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
去封它:**SELinux**。`code/fuxi_prop_spoof/sepolicy.rule` 禁止那些不可信 App 域去*找到*这些服务。
实际规则是一个完整的笛卡尔积:每个不可信域 × 每个 Lineage 服务类型:

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

数一下:**十**个服务类型——六个 `lineage_*_service`(globalactions、hardware、health_interface、
livedisplay、trust、profile)加四个 `hal_lineage_*_service`(health、livedisplay、powershare、touch)
——在**三**个 App 域(`untrusted_app`、`isolated_app`、`ephemeral_app`)上各封一遍。这就是为什么这个
文件是三十行 `deny` 而不是三行:漏掉任何一个域(比如一个 instant app,或一个被 Shamiko 隔离的 App)
都是个洞。系统域是故意*不*在名单里的——LiveDisplay 自己的服务注册和系统的读取照样能解析——所以特性
照常工作,而没有 App 能发现它。作为 `sepolicy.rule` 持久化进一个 Magisk 模块;在一次干净的
`Enforcing` 开机上验证过,lineage 服务对系统仍在注册。

## 方法,提炼出来

别从 `adb shell` 审计。按泄漏的*种类*挑那把忠实的镜片,留意每把镜片的盲区,当 SELinux 或
hidden-API 把图景搅浑时,要么写一个一次性的探测 APK,要么干脆在 SELinux 层把洞堵上——在那里,答案
不取决于 App 的小把戏。

## 延伸阅读

- [Android 上的 SELinux(AOSP)](https://source.android.com/docs/security/features/selinux) —— 域、类型,以及为什么 `shell` 和 `untrusted_app` 被允许的事情不同。
- [Android UID / AID](https://cs.android.com/android/platform/superproject/main/+/main:system/core/libcutils/include/private/android_filesystem_config.h) —— `AID_SHELL`(2000)、`AID_APP_START`(10000),以及那张固定映射表的其余部分。
- [`nsenter(1)`](https://man7.org/linux/man-pages/man1/nsenter.1.html) —— 进入另一个进程的挂载(及其它)命名空间。
