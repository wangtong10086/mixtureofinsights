---
title: "Neovim OSC 52: copy over SSH and WSL, paste from the terminal"
description: "My Neovim ≥ 0.10 clipboard setup for SSH and WSL, using OSC 52 for copying and the terminal's paste shortcut for local clipboard contents."
date: 2024-06-16
updatedAt: 2026-09-15
order: 6
reading: "4 min read"
tags: ["neovim", "osc52", "terminal"]
---

With Neovim 0.10 or later and a terminal that accepts OSC 52 writes, remote yanks can reach the host clipboard through terminal output. The configuration below uses Neovim registers for its paste fallback; use the terminal paste shortcut for the host clipboard. Terminal and multiplexer permissions must allow the sequence, and clipboard reading is a separate capability.

Over SSH or in WSL, Neovim's `yank` doesn't reach my system clipboard by default. Because I run headless servers without X11 forwarding, I bypass the typical `xclip` or `pbcopy` daemons entirely. Since Neovim 0.10 merged native OSC 52 support in [Neovim PR #25872](https://github.com/neovim/neovim/pull/25872), I push clipboard bytes directly through the TTY.

OSC 52 is a terminal escape sequence (`OSC` means Operating System Command), structured as `ESC ] 52 ; c ; <base64-payload> BEL`. Neovim doesn't talk to any clipboard API. I just have it print those bytes to the standard output, and my terminal emulator decodes the base64 and executes the system clipboard write. The sequence travels in the ordinary terminal output stream, including over SSH or from WSL. The host terminal performs the clipboard write.

This is the clipboard configuration in my `init.lua`:

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

Copy and paste work differently here. Copy sends an escape sequence to the terminal. Paste requires a response: Neovim sends an OSC 52 query and the terminal answers with the clipboard contents. Because that would let remote processes read my local clipboard, terminal emulators (like Windows Terminal) simply don't implement the round-trip read.

The `my_paste` shim reads Neovim's own register without querying the terminal, so yank and put remain consistent within the editor. When I genuinely need the host system clipboard's contents, I bypass OSC 52 and use the terminal's native paste (`<C-v>` or `Ctrl-Shift-V`), piping it in as raw STDIN input.

For the broader remote-work setup, the [rented-GPU control-plane article](/blog/a-control-plane-for-renting-gpus/) explains how I retain job records beyond an SSH session.
