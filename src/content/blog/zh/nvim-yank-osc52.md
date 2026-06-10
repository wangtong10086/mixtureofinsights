---
title: "Neovim：用 OSC 52 复制到系统剪贴板"
description: "在 SSH / WSL 下让 Neovim 的 yank 直达系统剪贴板。Neovim 0.10 之后原生支持 OSC 52，几行配置就够了。"
date: 2024-06-16
order: 6
reading: "4 分钟"
tags: ["neovim", "osc52", "terminal"]
---

> 一条早期的小笔记，迁移自旧博客。问题很普通：在 SSH 或 WSL 里写代码时，Neovim 的 `yank` 默认进不了
> 系统剪贴板。后来发现 Neovim 0.10 起已经原生支持 **OSC 52**，几行配置就够了。

**OSC 52 到底是什么。** 它是一条终端转义序列 —— `OSC` 即 *Operating System Command* —— 形如
`ESC ] 52 ; c ; <base64 载荷> BEL`。Neovim 不调用任何剪贴板 API；它只是把这串字节打印到 TTY，
由*终端模拟器*解码 base64 并写入系统剪贴板。整个戏法就这么简单,也正因如此它能在常规剪贴板工具
失灵的地方生效:这条转义和其它一切走的是同一条字节流,于是它能免费穿过 SSH 管道或 WSL 边界 ——
不需要 `xclip`、不需要 `pbcopy`、不需要 X11 转发、不需要共享剪贴板守护进程。写入由你这端的终端
完成。

注意：需要 Neovim 版本 **≥ 0.10**（0.10 增加了对 OSC 52 的原生支持，见
[Neovim PR #25872](https://github.com/neovim/neovim/pull/25872)）。

在 `init.lua` 中加入如下配置：

```lua
function my_paste(reg)
  return function(lines)
    local content = vim.fn.getreg('"')
    return vim.split(content, "\n")
  end
end

vim.g.clipboard = {
  name = "OSC 52",
  copy = {
    ["+"] = require("vim.ui.clipboard.osc52").copy("+"),
    ["*"] = require("vim.ui.clipboard.osc52").copy("*"),
  },
  paste = {
    ["+"] = my_paste("+"),
    ["*"] = my_paste("*"),
  },
}
```

值得弄清的是 `paste` 这一半的不对称。复制是单向推送 —— Neovim 发出转义就完事了。粘贴则需要
*反向*:Neovim 发一条 OSC 52 *查询*、终端把剪贴板内容回传 —— 这个往返是许多终端(Windows
Terminal 在内)干脆没实现的,有些终端还出于安全把它禁掉了,因为它允许一个远端程序读取你本地的
剪贴板。所以上面的 `my_paste` 垫片只是回读 Neovim 自己的寄存器,而不去问终端 —— 让编辑器内部的
yank/put 保持一致。当你确实需要*系统*剪贴板的内容时,用终端的原生粘贴(`<C-v>` / Ctrl-Shift-V),
它以普通键入输入的形式抵达,完全绕开 OSC 52。

OSC 52 的介绍与各终端支持情况可参考
[这篇 r/vim 指南](https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/)。

参考资料：

- <https://github.com/neovim/neovim/issues/28611>
- <https://www.reddit.com/r/neovim/comments/188smrx/how_do_i_use_osc52_in_neovim100/>
