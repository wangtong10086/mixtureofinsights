---
title: "StockMask:不碰任何 App,造一层「原厂幻觉」"
description: "HideMyApplist 藏的是包名,App 却照样识破了自定义 ROM。解法是一个约 200 行的模块——它按「谁在问」来过滤 system_server 的应答,从不注入进 App 本身。"
date: 2026-06-09
order: 2
series: "android-hardening"
reading: "7 分钟"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

你用 HideMyApplist 藏好了包名列表。银行和购物 App 却照样弹人机验证。有别的东西在宣告这是自定义
ROM。这篇讲怎么找到它,以及怎么用一个小小的 LSPosed 模块、在从不碰 App 本身的前提下把它堵上。

## HMA 看不到的东西

一台 LineageOS 设备会通过 **PackageManager** 暴露自己,而这和包名列表毫无关系:

```text
$ pm list features | grep lineage
feature:org.lineageos.android        # 直白地写着"这是 LineageOS"
feature:org.lineageos.livedisplay
feature:org.lineageos.trust
...
$ pm list permissions | grep lineage
permission:lineageos.permission.TRUST_INTERFACE
...
```

一次调用——`hasSystemFeature("org.lineageos.android")`——App 就知道了。HMA 从不碰特性和权限。

## 错的修法,和对的修法

你*可以*删掉 `/product/etc/permissions/` 里的特性 XML。但其中好几个同时是对应
`system_server` 服务的发布开关——删掉 `livedisplay`/`trust`/`profiles`,这些功能就停了。XML
这条路逼你在"隐藏"和"功能"之间二选一。

对的修法,是让特性**仍然存在**(系统照常工作),只对**正在问的那个 App** 隐藏它——办法是在
`system_server` 里按*谁在问*来过滤应答。

<figure class="figure">
<svg viewBox="0 0 720 250" role="img" aria-label="system_server filters PackageManager responses by caller UID">
  <style>
    .bx{fill:#fff;stroke:#e9e4dc;stroke-width:1.5}
    .hk{fill:#fff;stroke:#b4530a;stroke-width:1.8}
    .t{font:13px sans-serif;fill:#1c1b19}
    .s{font:11.5px sans-serif;fill:#6b6862}
    .ok{font:12px sans-serif;fill:#0f766e;font-weight:700}
    .no{font:12px sans-serif;fill:#b4530a;font-weight:700}
    .ln{stroke:#6b6862;stroke-width:1.4;fill:none}
  </style>
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/></marker>
  </defs>
  <rect class="bx" x="12" y="26" width="150" height="34" rx="7"/>
  <text x="26" y="48" class="t">系统 / root 应用</text>
  <rect class="bx" x="12" y="74" width="150" height="34" rx="7"/>
  <text x="26" y="96" class="t">第三方 App</text>
  <rect class="hk" x="250" y="40" width="210" height="86" rx="9"/>
  <text x="266" y="64" class="t">system_server</text>
  <text x="266" y="84" class="s">PackageManager + StockMask 钩子</text>
  <text x="266" y="104" class="s">按 Binder.getCallingUid() 过滤</text>
  <rect class="bx" x="540" y="26" width="168" height="34" rx="7"/>
  <text x="556" y="48" class="ok">真实 lineage 特性 ✓</text>
  <rect class="bx" x="540" y="100" width="168" height="34" rx="7"/>
  <text x="556" y="122" class="no">lineage 被剥除 —— "原厂"</text>
  <path class="ln" d="M162 43 H250" marker-end="url(#a2)"/>
  <path class="ln" d="M162 91 H250" marker-end="url(#a2)"/>
  <path class="ln" d="M460 64 H540 V52" marker-end="url(#a2)"/>
  <path class="ln" d="M460 100 H505 Q540 100 540 112 V116" marker-end="url(#a2)"/>
  <text x="250" y="158" class="s">App 自己的进程从未被碰过 —— 里面没有可供检测的东西。</text>
</svg>
<figcaption>一个钩子,装在每个 App 都要去问的那个唯一共享进程里。App 的内存保持干净;变的只是应答,而且因调用方而异。</figcaption>
</figure>

整个思路,五行就够:

```java
// LSPosed 作用域 = "android"(system_server)仅此而已。不做任何 App 进程注入。
boolean shouldFilter() { return Binder.getCallingUid() % 100000 >= 10000; }

hookAllMethods(PackageManagerService, "hasSystemFeature", afterHook -> {
    if (shouldFilter() && isLineage(arg0) && result == true) setResult(false);
});
```

验证:

```text
su 2000  -c 'cmd package has-feature org.lineageos.android'  -> true   (系统)
su 10236 -c 'cmd package has-feature org.lineageos.android'  -> false  (淘宝 uid)
service list | grep -c lineage                               -> 10     (服务仍在)
```

## 多花一次重启的那个坑

`hasSystemFeature` 过滤对了,可 `getSystemAvailableFeatures()`(那个*列表*)没过滤——两边都还
看到 8 个 lineage 特性。原因:在 Android 14+ 上,面向 Binder 的列表方法住在内部类
`PackageManagerService$IPackageManagerImpl`(以及快照 `ComputerEngine`)上,**而不是**我钩的那个
PMS 类。把这三处都钩上,列表就也过滤了。

> 教训:`hasX` 和 `getXList` 往往落在不同的类上。每个都去核实,别想当然以为最显眼的那个就服务于
> Binder 调用。

## 为什么"按调用方过滤"才是赢法

App 自己的进程保持洁净——`/proc/self/maps` 里没有被注入的库,没有可供 RASP 找的被 hook 方法
签名。唯一的钩子住在 `system_server`,而 App 没法窥视它。这正是 HMA 隐藏包名所用的架构,被推广到
了特性、权限、设置和日志访问。

模块**静默发布**(不打 `XposedBridge.log`——那个字符串本身就是个破绽),作用域只勾 `system`,
并且用 `javac` + `d8` + `aapt2` 构建,无需 Gradle。
