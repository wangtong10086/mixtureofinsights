---
title: "别用 adb shell 代替 App 的眼睛"
description: "shell 看到的世界，普通 App 未必看得到。要审计检测面，得从 App 自己的 UID、命名空间和 SELinux 域里看。"
date: 2026-06-10
order: 4
series: "android-hardening"
reading: "9 分钟"
tags: ["android", "selinux", "auditing", "nsenter"]
---

在确认上层逻辑阻断后，我需要做最后的渗透审计。`adb shell` 是一个充满欺骗性的环境：它以 UID 2000 运行于 `shell` SELinux 域中，看到的是未经 Magisk 和 Shamiko 处理的全局挂载表。以它的视角去排查 `untrusted_app` 能获取的特征，会产生大量的假阴性和假阳性。

为了复现 App 真正面临的沙盒约束，必须降级到它们的物理极限。我用三种透镜剥开了这个状态空间：

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

在隔离视界下，Magisk 守护进程、Zygote 以及其他进程因内核 `hidepid=invisible` 挂载选项而彻底隐身。`/proc/<pid>/maps` 中未见任何 Zygisk 注入痕迹。但扫描后仍有两处高危泄漏点。第一处是 `adb_enabled=1`，关闭 USB 调试即可抹除。第二处则触及了 Android 的核心通信管道：LineageOS 的自定义系统服务。

服务注册表对应用是全局可见的。一个原生层的 RASP 可以通过 `ServiceManager.getService("lineagehardware")` 直接定位到特征。我们在 Java 层注入的任何 hook 都无法拦截到底层的 C++ Binder 调用。

既然用户态挡不住，那就把防御下沉到内核的强制访问控制。我在 `fuxi_prop_spoof/sepolicy.rule` 注入了底层的 [SELinux 拒绝规则](https://source.android.com/docs/security/features/selinux)，切断所有不可信域对特定服务类型的 `find` 权限：

```text
deny untrusted_app lineage_hardware_service    service_manager { find }
deny untrusted_app lineage_livedisplay_service service_manager { find }
deny isolated_app  lineage_hardware_service    service_manager { find }
deny ephemeral_app lineage_hardware_service    service_manager { find }
```

这是一组笛卡尔积。三类 App 域与十类服务类型交叉，生成了 30 条不可逾越的内核拦截规则。我故意放开了系统域的访问，于是 Lineage 的内置进程依旧能够正常解析服务并工作，但对于第三方 App 而言，这些服务从 `service_manager` 的返回结果中物理蒸发了。这层封杀不依赖于目标程序的行为，完全是由内核强制生效的拓扑隔绝。
