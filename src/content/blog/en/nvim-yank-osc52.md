---
title: "Neovim: yank to the system clipboard (OSC 52)"
description: "How I make Neovim's yank reach the system clipboard over SSH / WSL — utilizing Neovim ≥ 0.10's native OSC 52 support."
date: 2024-06-16
order: 6
reading: "4 min read"
tags: ["neovim", "osc52", "terminal"]
---

Over SSH or in WSL, Neovim's `yank` doesn't reach my system clipboard by default. Because I run headless servers without X11 forwarding, I bypass the typical `xclip` or `pbcopy` daemons entirely. Since Neovim 0.10 merged native OSC 52 support in [Neovim PR #25872](https://github.com/neovim/neovim/pull/25872), I push clipboard bytes directly through the TTY.

**What OSC 52 actually is.** It's a terminal escape sequence — `OSC` = Operating System Command — structured as `ESC ] 52 ; c ; <base64-payload> BEL`. Neovim doesn't talk to any clipboard API. I just have it print those bytes to the standard output, and my terminal emulator decodes the base64 and executes the system clipboard write. The escape sequence rides the exact same byte stream as everything else, so it pierces an SSH pipe or a WSL virtualization boundary for free. The host terminal executes the write.

I inject this routing into my `init.lua`:

```lua
-- Shim to read back Neovim's own register
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

The `paste` half is an asymmetric compromise. Copy is a one-way push — I emit the escape and I'm done. Paste requires the reverse: Neovim sends an OSC 52 query and the terminal answers with the clipboard contents. Because remote processes reading my local clipboard is a massive security vulnerability, terminal emulators (like Windows Terminal) simply don't implement the round-trip read. 

So my `my_paste` shim intercepts the call. It just reads back Neovim's own register instead of polling the terminal, maintaining yank/put consistency purely within the editor state. When I genuinely need the host system clipboard's contents, I bypass OSC 52 and use the terminal's native paste (`<C-v>` or `Ctrl-Shift-V`), piping it in as raw STDIN input.
