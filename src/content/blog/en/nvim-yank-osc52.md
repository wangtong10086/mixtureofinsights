---
title: "Neovim: yank to the system clipboard (OSC 52)"
description: "Make Neovim's yank reach the system clipboard over SSH / WSL — Neovim ≥ 0.10 supports OSC 52 natively, a few lines of config away."
date: 2024-06-16
order: 6
reading: "2 min read"
tags: ["neovim", "osc52", "terminal"]
---

> An early practical note · migrated from the old blog. Over SSH or in WSL, Neovim's `yank`
> doesn't reach the system clipboard by default. Since Neovim 0.10 there's native **OSC 52**
> support, and a few lines of config fix it.

Note: you need Neovim **≥ 0.10** (0.10 added native OSC 52 support — see
[Neovim PR #25872](https://github.com/neovim/neovim/pull/25872)).

Add this to your `init.lua`:

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

Now selecting in visual mode copies straight to the system clipboard. Because Windows Terminal
doesn't support the *paste* direction of OSC 52, if you need to paste *from* the system clipboard
into Neovim, still use `<C-v>` (Ctrl + v).

For an intro to OSC 52 and which terminals support it, see
[this r/vim guide](https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/).

References:

- <https://github.com/neovim/neovim/issues/28611>
- <https://www.reddit.com/r/neovim/comments/188smrx/how_do_i_use_osc52_in_neovim100/>
