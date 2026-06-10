---
title: "StockMask：不碰 App，也能造一层原厂感"
description: "HideMyApplist 藏得住包名，藏不住系统特性。更稳的办法是在 system_server 里按调用方过滤回答，而不是把钩子塞进每个 App。"
date: 2026-06-09
order: 2
series: "android-hardening"
reading: "12 分钟"
tags: ["android", "lsposed", "lineageos", "system_server"]
---

一开始我以为包名藏住就差不多了。HideMyApplist 生效，常见 root 包也看不见，可银行和购物 App 还是会
把设备当成可疑环境。说明还有别的东西在主动自报家门。

后来查到的不是某个 App 的奇技淫巧，而是 Android 自己很正常的一层：PackageManager 会把系统特性和权限
告诉调用方。问题于是变成：能不能不碰 App，只在 `system_server` 回答问题时，按调用方收窄视野？

## HMA 看不到的东西

一台 LineageOS 设备会通过 **PackageManager** 暴露自己,而这和包名列表毫无关系。下面每一项都是
一次从 App 进程发起、跨 Binder 进入 `system_server` 的调用——真正的 `PackageManagerService`(PMS)
住在那里;App 手里只有一个 `IPackageManager` 代理,拿回的是 PMS 决定返回给它的东西:

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

一次调用——`hasSystemFeature("org.lineageos.android")`——App 就知道了。这次调用跨 Binder 进入
PMS,PMS 查它内存里的特性表,返回 `true`。HMA 从不碰特性和权限,它只改写包名列表那几个调用。

## 错的修法,和对的修法

你*可以*删掉 `/product/etc/permissions/` 里的特性 XML。但其中好几个同时是对应
`system_server` 服务的发布开关——删掉 `livedisplay`/`trust`/`profiles`,这些功能就停了。XML
这条路逼你在"隐藏"和"功能"之间二选一。

对的修法,是让特性**仍然存在**(系统照常工作),只对**正在问的那个 App** 隐藏它——办法是在
`system_server` 里按*谁在问*来过滤应答。为什么 `system_server` 才是对的层,而不是 App?因为
**谁握着那个可信的答案**。PMS 是每个 App 都跨 Binder 去查的唯一真相源;它本就免费知道调用方的
身份,因为 Binder 给每一笔进来的事务都盖上了发送方真实的、由内核核验的 UID——
`Binder.getCallingUid()` 没法被调用方伪造。于是你在那一个地方过滤,它(a)看得见每一次查询,
(b)百分百确定是谁在问,(c)还住在一个 App 永远读不进去的进程里。另一条路——注入进 App、拦截它
*收到*答案的那一刻——等于把你的代码塞进你正想对其装清白的那个进程。那是反着来的。

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

整个模块就是一个文件——`code/stockmask/src/com/stockmask/Main.java`,连 import 和注释一共 205 行。
它只声明一个 Xposed 入口类(`assets/xposed_init` 里写的正是 `com.stockmask.Main`),而它做的第一件事,
就是在任何不是 `system_server` 的进程里直接退出:

```java
@Override
public void handleLoadPackage(LoadPackageParam lpparam) {
    if (lpparam == null || !"android".equals(lpparam.packageName)) return;
    ClassLoader cl = lpparam.classLoader;
    hookFeatures(cl);
    hookPermissions(cl);
    hookLogAccess(cl);
}
```

那个 `"android"` 包名*就是* `system_server`——在 LSPosed 的作用域选择器里,它是标着「系统框架」
的那一项;模块只勾它,别的一概不勾。没有任何 App 进程会加载这段代码,这道守卫保证了这一点。

调用方判断是两个小辅助函数——appId 公式,以及一个从活着的 Binder 事务上读取真实 UID 的包装:

```java
private static boolean isThirdPartyAppId(int uid) {
    return (uid % 100000) >= 10000;
}

/** For Binder-dispatched methods: filter real third-party callers only. */
private static boolean shouldFilter() {
    int uid;
    try { uid = Binder.getCallingUid(); } catch (Throwable t) { return false; }
    return isThirdPartyAppId(uid);
}
```

这个 UID 判断正是 AOSP 的 App-UID 约定:`Process.FIRST_APPLICATION_UID` 是 `10000`,每用户偏移是
`100000`,所以 `uid % 100000` 剥掉 profile、还原出 **appId**,`appId >= 10000` 即「任意 profile 下
安装的第三方 App」。`10000` 以下都是固定的系统 / 守护进程 appId——`AID_SYSTEM`(1000)、
`AID_RADIO`(1001)、`AID_SHELL`(2000),以及撑起那些 Lineage 服务本身的 HAL / 守护进程 UID。又因为
`shouldFilter()` *在 Binder 事务内同步运行*——它是从 `afterHookedMethod` 里、在分发该调用的同一个线程上
被调的——`Binder.getCallingUid()` 返回的就是真正的调用方,而不是 `system_server` 自己的 UID。

布尔检查的拦截点是 `hasSystemFeature` 上的一个 *after* 钩子:让真实方法先跑完,看一眼它本来要返回什么,
只有当调用方是第三方 App、问的又是 Lineage 名字时,才改写结果。实际的钩子体,逐字如下:

```java
private final XC_MethodHook hasFeatureHook = new XC_MethodHook() {
    @Override protected void afterHookedMethod(MethodHookParam p) {
        try {
            if (!shouldFilter()) return;
            if (p.args == null || p.args.length == 0) return;
            Object a0 = p.args[0];
            if (a0 instanceof String && isLineageName((String) a0)
                    && Boolean.TRUE.equals(p.getResult())) {
                p.setResult(false);
            }
        } catch (Throwable ignored) {}
    }
};
```

每个钩子体都裹在 `try { … } catch (Throwable ignored) {}` 里,原因相同:`system_server` 里一个没接住的
抛出会让设备 bootloop。`isLineageName` 也不是单字符串匹配,它覆盖了一整族(`org.lineageos.*`、
`lineageos.*`、遗留的 `cyanogenmod` 名字,以及任何仅仅*含有* `lineage` 的字符串),改个名也溜不掉。

因为真实方法已经跑完、且只有第三方 appId 才被改写,这些守护进程原样放行:LiveDisplay 自己的进程
(系统 appId)照样把 `org.lineageos.livedisplay` 读成 `true`,功能照常。你对银行 App 藏住了特性,
却没把它从系统里割掉。

验证:

```text
su 2000  -c 'cmd package has-feature org.lineageos.android'  -> true   (系统)
su 10236 -c 'cmd package has-feature org.lineageos.android'  -> false  (淘宝 uid)
service list | grep -c lineage                               -> 10     (服务仍在)
```

## 多花一次重启的那个坑

`hasSystemFeature` 过滤对了,可 `getSystemAvailableFeatures()`(那个*列表*)没过滤。原因是 PMS
结构上的一次重构:在 Android 14+ 上,面向 Binder 的入口被从那个庞大的 PMS 类里拆了出来。App 真正
够到的那个列表方法住在内部类 `PackageManagerService$IPackageManagerImpl` 上,而它又是从一份不可变
的**快照**(`ComputerEngine`)里读数据,而不是直接读 PMS——这是一种为了无锁读取的写时复制
(copy-on-write)设计。只钩旧的 PMS 方法,这两处都漏了。解法是把同样两个方法名钩到*全部三个*类上:

```java
private void hookFeatures(ClassLoader cl) {
    String[] classes = {
        "com.android.server.pm.PackageManagerService",
        "com.android.server.pm.PackageManagerService$IPackageManagerImpl",
        "com.android.server.pm.ComputerEngine",
    };
    for (String cn : classes) {
        Class<?> clazz;
        try { clazz = XposedHelpers.findClass(cn, cl); }
        catch (Throwable t) { continue; }
        try { XposedBridge.hookAllMethods(clazz, "hasSystemFeature", hasFeatureHook); } catch (Throwable ignored) {}
        try { XposedBridge.hookAllMethods(clazz, "getSystemAvailableFeatures", listFeatureHook(cl)); } catch (Throwable ignored) {}
    }
}
```

列表钩子比布尔钩子多一道弯:结果不一定是普通 `List`。面向 Binder 的那些 getter 返回的是
`ParceledListSlice` 包装。所以钩子先用 `getList()` 拆包,再反射读每个 `FeatureInfo` 的 `name` 字段
把 Lineage 项滤掉,然后把留下的项*重新包*进一个新的 slice——而且只有当确实有改动时才动结果:

```java
List<?> src;
if (result instanceof List) { src = (List<?>) result; }
else { src = (List<?>) XposedHelpers.callMethod(result, "getList"); sliced = true; }
...
if (sliced) {
    Object slice = XposedHelpers.newInstance(
        XposedHelpers.findClass("android.content.pm.ParceledListSlice", cl), kept);
    p.setResult(slice);
} else {
    p.setResult(kept);
}
```

> 教训:`hasX` 和 `getXList` 往往落在不同的类上*而且*返回不同的类型。每个都去核实,别想当然以为
> 最显眼的那个就服务于 Binder 调用。

## 权限,用同一根杠杆

特性只是 LineageOS 安装宣告自己的一半——它还注册了像 `lineageos.permission.TRUST_INTERFACE`
这样的自定义权限。`hookPermissions` 把完全相同的「按调用方过滤」模式套到 `PermissionManagerService`
(及其 `…Impl` 变体)上:对 Lineage 权限名,把 `getPermissionInfo` 的结果置 null;并把 Lineage 项从
`queryPermissionsByGroup` / `getAllPermissionGroups` 里切掉——用的是和特性列表一样的
`ParceledListSlice` 拆包-过滤-重包。一种模式,四组方法,每个方法体都裹在 `try/catch` 里。这种对称正是
要点所在:可信的答案只住在一个进程里,所以一根杠杆就能堵住这个问题的每一种变体。

## 为什么"按调用方过滤"才是赢法

App 自己的进程保持洁净——`/proc/self/maps` 里没有被注入的库,没有可供 RASP 找的被 hook 方法
签名,也没有第二份 Xposed 运行时和它共享地址空间。唯一的钩子住在 `system_server`——一个普通 App
没有 SELinux 权限读进去的进程。会扫自己内存的 RASP 一无所获,因为它内存里本就什么都没有;谎言是在
上游、在真相源、在答案跨过 Binder 之前就说好了的。这正是 HMA 隐藏包名所用的架构,被推广到了特性、
权限、设置和日志访问。

模块**静默发布**(`Main.java` 里没有任何一处 `XposedBridge.log`——那个字符串本身就是个破绽;
为什么你自己的调试输出也是一个检测面,见[logcat 那篇](/zh/blog/03-the-logcat-leak/)),作用域只勾
「系统框架」。而且它*不依赖 Android SDK,也不用 Gradle* 就能构建:`code/stockmask/build.sh` 一共六步——
`javac` → `d8`(来自 `r8.jar`)→ `aapt2 link` → 把 dex 塞进 zip → `zipalign` → `apksigner`——
把那一个 `.java` 编译到一份取来的 Xposed `api-82.jar` 和一份古老的 `android.jar` 桩上(只有
`Binder`/`FeatureInfo` 是直接用的,其余全走 `XposedHelpers` 反射,这正是同一个 APK 能扛住版本漂移的原因)。
205 行,一个文件,没有构建系统。

## 延伸阅读

- [AOSP PackageManagerService](https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/pm/PackageManagerService.java) —— 真相源,以及 `IPackageManagerImpl` / `Computer` 快照拆分所在之处。
- [`Binder.getCallingUid()`](https://developer.android.com/reference/android/os/Binder#getCallingUid()) —— 为什么内核盖章的调用方 UID 不能被 App 伪造。
- [LSPosed](https://github.com/LSPosed/LSPosed) —— 让模块在不碰 App 进程的前提下 hook `system_server` 的框架。
