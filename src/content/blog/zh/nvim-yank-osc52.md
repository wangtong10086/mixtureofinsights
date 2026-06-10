---
title: "Neovim: 复制到系统剪贴板 (OSC 52)"
description: "在 SSH / WSL 下让 Neovim 的复制直达系统剪贴板 —— Neovim ≥ 0.10 原生支持 OSC 52,几行配置即可。"
date: 2024-06-16
order: 6
reading: "2 min read"
tags: ["neovim", "osc52", "terminal"]
---

> 一条早期的实用笔记 · 迁移自旧博客。在 SSH 或 WSL 环境里，Neovim 的 `yank` 默认进不了
> 系统剪贴板。Neovim 0.10 起原生支持 **OSC 52**，几行配置就能解决。

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

此时在可视模式下选中即可复制到系统剪贴板。因为 Windows Terminal 不支持 OSC 52 的
*粘贴* 方向，所以若需要把系统剪贴板的内容贴进 Neovim，仍用 `<C-v>`（Ctrl + v）。

OSC 52 的介绍与各终端支持情况可参考
[这篇 r/vim 指南](https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/)。

参考资料：

- <https://github.com/neovim/neovim/issues/28611>
- <https://www.reddit.com/r/neovim/comments/188smrx/how_do_i_use_osc52_in_neovim100/>
