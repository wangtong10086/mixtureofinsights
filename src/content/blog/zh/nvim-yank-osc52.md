---
title: "Neovim：用 OSC 52 穿越终端剪贴板屏障"
description: "在 SSH 和 WSL 中配置 Neovim 0.10 的 OSC 52 复制，并用终端粘贴快捷键读取本地剪贴板。"
date: 2024-06-16
order: 6
reading: "4 分钟"
tags: ["neovim", "osc52", "terminal"]
---

配置分布式节点时，我经常通过多层 SSH 或 WSL 使用 Neovim。`yank` 复制的内容只留在远程编辑器的寄存器里，默认不会进入本地系统剪贴板。

常见做法是配置 X11 转发、共享剪贴板守护进程或 `xclip`/`pbcopy` 代理，但这些方案的网络和权限配置比较脆弱。Neovim 0.10 加入了原生 OSC 52 支持（见 [Neovim PR #25872](https://github.com/neovim/neovim/pull/25872)），可以直接通过终端输出传送剪贴板内容。

## OSC 52 的通信机制

OSC（Operating System Command）是一系列标准化的终端转义序列。OSC 52 的格式是 `ESC ] 52 ; c ; <base64 载荷> BEL`。

Neovim 不调用外部操作系统的剪贴板 API，而是将文本编码为 base64，放入这串控制符，再写入当前 TTY 的标准输出流（stdout）。当你本地的终端模拟器（如 Alacritty 或 Windows Terminal）解析字节流并截获到该控制符时，由终端负责完成 base64 解码并执行底层剪贴板系统调用。

控制信号与普通文本共享同一条 TCP 连接，因此可以穿过任何容器边界和 SSH 跳转。

## 寄存器与转义层的映射

要求 Neovim 版本 **≥ 0.10**，且终端本身支持 OSC 52 解析（支持状态表参考 [终端支持度指南](https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/) 与 [社区讨论](https://www.reddit.com/r/neovim/comments/188smrx/how_do_i_use_osc52_in_neovim100/)，或者详见 [Neovim Issue #28611](https://github.com/neovim/neovim/issues/28611)）。

只需在 `init.lua` 中显式覆写剪贴板提供者（Provider）：

```lua
-- 构造一个仅读取 Neovim 内部寄存器的回退函数
function my_paste(reg)
  return function(lines)
    local content = vim.fn.getreg('"')
    return vim.split(content, "\n")
  end
end

-- 劫持系统剪贴板通道
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

这里的 `copy` 和 `paste` 不能对称处理。复制只需向 TTY 发送转义序列，粘贴则需要终端回传数据：Neovim 必须向终端发送 OSC 52 查询指令，并阻塞等待终端将本地剪贴板内容回传。

出于安全沙箱隔离的考虑，现代终端（包括 Windows Terminal）往往会阻断这种被动的远程剪贴板探测请求。所以配置中的 `my_paste` 不查询 TTY，只读取 Neovim 的匿名寄存器 `"`。当确实需要向编辑器粘贴本地数据时，直接利用宿主机终端原生快捷键（如 `<C-v>` 或 `<C-S-v>`），通过标准输入流（stdin）模拟普通字符键入完成写入。
