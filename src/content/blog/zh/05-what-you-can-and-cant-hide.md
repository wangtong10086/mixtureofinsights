---
title: "一台 root 手机能藏住什么"
description: "包名、特性、权限、日志、服务、硬件证明，每条通道都有自己的边界。能藏的要藏干净，藏不了的要早点承认。"
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "10 分钟"
tags: ["android", "detection", "synthesis", "rasp"]
---

前四篇其实都在摸同一张地图。包名能藏，系统特性能藏，日志能堵，服务发现也能压到 SELinux 层；但每堵上
一条路，都会冒出另一个更底层的问题：一个无特权 App 到底还能从哪里看出这是一台 root 的自定义 ROM？

所以这篇不急着再补一个洞，而是把几周排查过的通道摊开看：哪些能靠用户态工程封住，哪些必须下沉到内核或
TEE，哪些干脆应该早点承认是墙。

## 检测通道,及其结局

下面这张表更像排查笔记的索引：每条通道、一个无特权 App 如何探测它、对策，以及真正要紧的那一栏——这个
修复*非得住在哪一层*不可。修复装错了层，要么可被检测(装进 App)，要么无效(装在它本想把关的东西之上)。

| 通道 | 无特权 App 如何探测 | 对策(产物) | 修复所在的层 | 状态 |
|---|---|---|---|---|
| 包名列表 | `PackageManager.getInstalledPackages`(Binder → PMS) | HideMyApplist,按调用方 UID 过滤 | `system_server`(PMS) | ✅ |
| 系统特性 | `hasSystemFeature` / `getSystemAvailableFeatures` | StockMask 的 `hookFeatures`([第 2 篇](/zh/blog/02-stockmask/)) | `system_server`(PMS + `IPackageManagerImpl` + `ComputerEngine`) | ✅ |
| 自定义权限 | `getAllPermissionGroups` / 权限枚举 | StockMask 的 `hookPermissions`(`PermissionManagerService`) | `system_server` | ✅ |
| 构建身份 | `Build.FINGERPRINT` / `SystemProperties.get` | `fuxi_prop_spoof/post-fs-data.sh`——`resetprop` 改写每个 `ro.*.build.*`、`--delete` 掉 `ro.lineage.*`;一致性靠 PIF | 属性层(`resetprop`) | ✅ |
| 启动 / verity 状态(props) | `ro.boot.verifiedbootstate` / `ro.boot.vbmeta.device_state` | 同一脚本——`resetprop … device_state locked`、`veritymode enforcing` | 属性层 | ✅ |
| root 二进制 | `File.exists("/system/bin/su"…)`、扫 `$PATH` | Magisk 是 **systemless**——真实文件系统上没有东西 | 镜像 / 挂载层 | ✅ |
| 进程列表 | 枚举 `/proc/<pid>` | 内核 `hidepid=invisible`(proc 挂载选项) | 内核 | ✅ |
| 进程内 hook | 读自己的 `/proc/self/maps` 找 `zygisk`/`lsposed` | Shamiko 名单——App **不被注入 Zygisk** | 注入层(Zygisk 名单) | ✅ |
| Magisk 挂载 | 读自己的 `/proc/self/mountinfo` | Shamiko **挂载命名空间隔离** | 逐 App 挂载命名空间 | ✅ |
| `/proc/cmdline` · `/proc/version`(全局视图) | 读全局 `/proc/cmdline` 找 `*-NIGHTLY-*`、读 `/proc/version` 找构建主机 | `post-fs-data.sh` 用 `sed` 抹掉 NIGHTLY token 和 docker 构建主机,再 `mount --bind` 上假的 | 全局 `/proc`(bind-mount) | ✅* |
| 自定义(Lineage)服务 | `ServiceManager.getService("lineagehardware")` | `fuxi_prop_spoof/sepolicy.rule`——`deny … service_manager find`([第 4 篇](/zh/blog/04-auditing-from-the-apps-eyes/)) | SELinux(内核强制) | ✅ |
| 设备日志 | `READ_LOGS` → `logcat` | `scripts/revoke-readlogs.sh` + StockMask 的 `hookLogAccess`([第 3 篇](/zh/blog/03-the-logcat-leak/)) | 权限 + `system_server` + logd/SELinux | ✅ |
| 调试设置 | `Settings.Global.adb_enabled` / `development_settings_enabled` | 关掉 USB 调试(别去 hook `SettingsProvider`) | 配置(用户) | ⚠️ 副产物 |
| **隔离** App 的 `/proc` | 在隔离命名空间内读自己真实的 `cmdline` / `version` | 只能改引导镜像 / 内核——上面那个 bind-mount 够不到隔离命名空间 | 内核 / 引导镜像 | 🧱 墙 |
| 硬件认证 | 带 `setAttestationChallenge` 的 KeyStore 密钥,服务端校验([第 1 篇](/zh/blog/01-the-google-wallet-wall/)) | 无解——TEE 签的是真相 | TEE / StrongBox(内核之下) | 🧱 墙 |

<small>*这个 `/proc` bind-mount 触及全局视图和非隔离 App;一个被 Shamiko 隔离的 App 拿到的是
bind-mount 碰不到的、原始的 `/proc`——这和下面第一堵墙是同一道缝。</small>

## 浮现出来的三条原则

**1. 按调用方过滤,别注入进 App。** 最强的隐藏全都住在*那一个*共享的 `system_server` 里,按
`Binder.getCallingUid()` 改写应答。App 自己的进程保持洁净——里面没有可供检测的东西。逐 App 的
Xposed 注入既可被检测,在面对硬核 RASP 时还会要命(它弄崩了银行 App)。

**2. 一致性胜过伪装。** 在一台其余处处都是小米的系统上硬安一个 Pixel 指纹,*更*容易被检测。每一个
分区指纹、每一个安全补丁日期、每一个 prop 都必须讲同一个故事。Wallet 上最大的一条红鲱鱼,就是
PIF 和系统对不上的一个指纹。

**3. 弄清你站在哪堵墙前。** 有两堵,而它俩之所以撼不动,根因相同:那个可信的答案是在用户态模块
够得到的层*之下*生成的。

- **隔离的 `/proc`。** Shamiko 式的**挂载命名空间隔离**是把双刃剑。给名单内的 App 一个自己的命名
  空间,藏住了 Magisk 的 bind-mount——但代价是给了 App 那个*干净、真实*的视图,于是 App 读到的是
  货真价实的 `/proc/self/cmdline`、`/proc/version`、`/proc/self/mountinfo`。一个住在 App 地址空间里的
  模块(Zygisk)恰恰被*故意不*注入进这个 App——所以里面没有任何东西能去改写这些文件。能改变隔离
  `/proc` 读出什么的,只有改引导镜像或内核。从构造上讲,模块就够不到它。
- **硬件密钥认证。** TEE(或一颗独立的 StrongBox 安全单元)用一把 OS 读不到的密钥给
  `verifiedBootState` 和 `deviceLocked` 签名,而证书链终结于一个**出厂烧录的 Google 认证根**([第
  1 篇](/zh/blog/01-the-google-wallet-wall/))。这一切都发生在内核之下;用户态无法以 TEE 的身份签名,
  也无法在 Bootloader 解锁时让真实硬件认证出 `locked`。一份伪造的链能满足*本地*检查,但严格的后端
  (Google Wallet)会拒绝它。

<figure class="figure">
<svg viewBox="0 0 720 188" role="img" aria-label="The two walls: isolated /proc and hardware attestation">
  <style>
    .wall{fill:#faf3ec;stroke:#b4530a;stroke-width:1.6}
    .t{font:13.5px sans-serif;fill:#1c1b19;font-weight:700}
    .s{font:11.5px sans-serif;fill:#6b6862}
    .brick{stroke:#e3c9b3;stroke-width:1}
  </style>
  <rect class="wall" x="20" y="24" width="320" height="140" rx="8"/>
  <line class="brick" x1="20" y1="64" x2="340" y2="64"/><line class="brick" x1="20" y1="104" x2="340" y2="104"/><line class="brick" x1="20" y1="144" x2="340" y2="144"/>
  <line class="brick" x1="120" y1="24" x2="120" y2="64"/><line class="brick" x1="240" y1="64" x2="240" y2="104"/><line class="brick" x1="120" y1="104" x2="120" y2="144"/><line class="brick" x1="240" y1="144" x2="240" y2="164"/>
  <text x="40" y="48" class="t">被 Shamiko 隔离的 /proc</text>
  <text x="40" y="86" class="s">隔离藏住了 magisk 挂载,却也</text>
  <text x="40" y="104" class="s">还原了真实的 cmdline / version——</text>
  <text x="40" y="122" class="s">模块够不到它。只有改引导镜像 /</text>
  <text x="40" y="140" class="s">内核才行。</text>
  <rect class="wall" x="380" y="24" width="320" height="140" rx="8"/>
  <line class="brick" x1="380" y1="64" x2="700" y2="64"/><line class="brick" x1="380" y1="104" x2="700" y2="104"/><line class="brick" x1="380" y1="144" x2="700" y2="144"/>
  <line class="brick" x1="480" y1="24" x2="480" y2="64"/><line class="brick" x1="600" y1="64" x2="600" y2="104"/><line class="brick" x1="480" y1="104" x2="480" y2="144"/><line class="brick" x1="600" y1="144" x2="600" y2="164"/>
  <text x="400" y="48" class="t">硬件密钥认证</text>
  <text x="400" y="86" class="s">TEE 如实报告真实的 Bootloader</text>
  <text x="400" y="104" class="s">状态。伪造会被严格的后端</text>
  <text x="400" y="122" class="s">(Google Wallet)识破。</text>
  <text x="400" y="140" class="s">只有重锁 + 原厂能过。</text>
</svg>
<figcaption>两堵墙。它们左边的一切都可封堵;而它们俩,都不能。</figcaption>
</figure>

## 诚实的结论

你能让一台 root 的 LineageOS 设备通过 95% 的 App 所用的那些*廉价、常见*的检查——包名列表、特性、
权限、props、`/proc`、服务、日志。上表里每一个 ✅,都是一件小而可审计的产物:一个 205 行的 LSPosed
模块(`code/stockmask/`)、一份 30 条规则的 `sepolicy.rule`、两个 shell 脚本(`post-fs-data.sh`、
`revoke-readlogs.sh`),其余都是原版的 Magisk/Shamiko。你*赢不了*的,是一个铁了心、会去读自己隔离
`/proc` 的原生 RASP,或一个校验硬件认证的支付后端。把力气用在你真能封住的通道上,把墙写明白,
别花好几天去假装一堵墙只是个配置缺口。

## 延伸阅读

- [Android 密钥认证](https://developer.android.com/privacy-and-security/security-key-attestation) —— 证书链、认证扩展 OID,以及 TEE 签名的 `verifiedBootState` / `deviceLocked` 字段。
- [Android Verified Boot(AVB)](https://source.android.com/docs/security/features/verifiedboot) —— TEE 所认证的启动状态究竟在哪里计算并锁定。
- [Android 上的 SELinux](https://source.android.com/docs/security/features/selinux) —— 服务发现与 logd 两堵墙背后那个内核强制的层。
