---
title: "别用 adb shell 代替 App 的眼睛"
description: "用 App 的 UID、SELinux 域、挂载命名空间和进程映射检查检测面，并区分各项检查能看到什么。"
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "9 分钟"
tags: ["android", "selinux", "auditing", "nsenter"]
---

完成上层拦截后，我要检查 App 还能读到哪些特征。直接使用 `adb shell` 并不能代表 App 的环境：它以 UID 2000 运行于 `shell` SELinux 域中，看到的是未经 Magisk 和 Shamiko 处理的全局挂载表。以它的视角去排查 `untrusted_app` 能获取的特征，会产生大量的假阴性和假阳性。

我分别检查了 App 的 SELinux 约束、挂载命名空间和内存映射：

```text
[ Lens 1: SELinux Bounds ]
su 10253 -z u:r:untrusted_app:s0 -c '/system/bin/cat /proc/net/unix'
(Subject to exact kernel MAC rules)

[ Lens 2: Mount Namespace ]
nsenter -t $(pidof com.target) -m cat /proc/cmdline
(Views the isolated mount tree constructed by Shamiko)

[ Lens 3: Memory Layout ]
cat /proc/<pid>/maps | grep -iE 'zygisk|lsposed'
(Raw memory mappings managed by kernel)
```

在这个隔离环境下，`hidepid=invisible` 挂载选项使 App 看不到 Magisk 守护进程、Zygote 及其他进程。`/proc/<pid>/maps` 中未见任何 Zygisk 注入痕迹。检查仍发现两处特征：`adb_enabled=1`，可以通过关闭 USB 调试消除；以及 LineageOS 的自定义系统服务。

服务注册表对应用是全局可见的。一个原生层的 RASP 可以通过 `ServiceManager.getService("lineagehardware")` 直接定位到特征。我们在 Java 层注入的任何 hook 都无法拦截到底层的 C++ Binder 调用。

为限制原生代码对这些服务的查询，我在 `fuxi_prop_spoof/sepolicy.rule` 注入了底层的 [SELinux 拒绝规则](https://source.android.com/docs/security/features/selinux)，切断所有不可信域对特定服务类型的 `find` 权限：

```text
deny untrusted_app lineage_hardware_service    service_manager { find }
deny untrusted_app lineage_livedisplay_service service_manager { find }
deny isolated_app  lineage_hardware_service    service_manager { find }
deny ephemeral_app lineage_hardware_service    service_manager { find }
```

三类 App 域与十类服务类型交叉，共生成 30 条拒绝规则。系统域仍可访问，因此 Lineage 的内置进程能正常解析服务并工作，第三方 App 则无法通过 `service_manager` 发现这些服务。限制由内核执行，不依赖目标程序使用哪种调用方式。
