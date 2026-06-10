---
title: "能藏的,与不能藏的"
description: "一张完整的地图:一个无特权的 App 如何识别一台 root 的自定义 ROM,每条通道由什么封住,以及那两堵用户态怎么都撼动不了的墙。"
date: 2026-06-10
order: 5
series: "android-hardening"
reading: "6 分钟"
tags: ["android", "detection", "synthesis", "rasp"]
---

在一台设备上耗了几周之后,这是总纲——一张完整的地图:一个无特权的 App 如何识别一台 root 的
自定义 ROM,每条通道由什么封住,以及那少数几堵用户态怎么都撼动不了的墙。

## 检测通道,及其结局

| 通道 | App 通过什么读到 | 由什么封住 | 状态 |
|---|---|---|---|
| 包名列表 | `getInstalledPackages` | HideMyApplist(system_server,按调用方) | ✅ |
| 系统特性 | `hasSystemFeature` / `getSystemAvailableFeatures` | 按调用方的 system_server 钩子 | ✅ |
| 自定义权限 | 权限枚举 | 按调用方的 system_server 钩子 | ✅ |
| 构建身份 | `Build.*`(props) | resetprop + Play Integrity Fix(保持一致) | ✅ |
| 启动 / verity 状态 | `ro.boot.*` props | resetprop(`green` / `locked` / `enforcing`) | ✅ |
| root 二进制 | `File.exists("/system/bin/su"…)` | Magisk 是 systemless —— 没有可找的东西 | ✅ |
| 进程列表 | 枚举 `/proc` | 内核 `hidepid=invisible` | ✅ |
| 进程内 hook | `/proc/self/maps` | Shamiko 名单(不注入 Zygisk) | ✅ |
| Magisk 挂载 | `/proc/self/mountinfo` | Shamiko 隔离 | ✅ |
| 自定义服务 | `ServiceManager.getService` | sepolicy `deny … find` | ✅ |
| 设备日志 | `READ_LOGS` / logcat | 撤销 + LogcatManagerService 拒绝 | ✅ |
| 调试设置 | `Settings.Global.adb_enabled` | 关掉 USB 调试 | ⚠️ 副产物 |
| **隔离** App 的 `/proc` | 它们真实的 cmdline / version | 只能改引导镜像 / 内核 | 🧱 墙 |
| 硬件认证 | TEE / KeyMint | 无解 —— 链到硅片 | 🧱 墙 |

## 浮现出来的三条原则

**1. 按调用方过滤,别注入进 App。** 最强的隐藏全都住在*那一个*共享的 `system_server` 里,按
`Binder.getCallingUid()` 改写应答。App 自己的进程保持洁净——里面没有可供检测的东西。逐 App 的
Xposed 注入既可被检测,在面对硬核 RASP 时还会要命(它弄崩了银行 App)。

**2. 一致性胜过伪装。** 在一台其余处处都是小米的系统上硬安一个 Pixel 指纹,*更*容易被检测。每一个
分区指纹、每一个安全补丁日期、每一个 prop 都必须讲同一个故事。Wallet 上最大的一条红鲱鱼,就是
PIF 和系统对不上的一个指纹。

**3. 弄清你站在哪堵墙前。** 有两堵,用户态撼动不了。

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
权限、props、`/proc`、服务、日志。你赢不了一个铁了心、会去读自己隔离 `/proc` 的原生 RASP,也赢不了
一个校验硬件认证的支付后端。把力气用在你真能封住的通道上,把墙写明白,别花好几天去假装一堵墙只是
个配置缺口。
