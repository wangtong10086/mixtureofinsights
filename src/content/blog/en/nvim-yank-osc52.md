---
title: "Neovim: yank to the system clipboard (OSC 52)"
description: "Make Neovim's yank reach the system clipboard over SSH / WSL — Neovim ≥ 0.10 supports OSC 52 natively, a few lines of config away."
date: 2024-06-16
order: 6
reading: "4 min read"
tags: ["neovim", "osc52", "terminal"]
---

> An early practical note · migrated from the old blog. Over SSH or in WSL, Neovim's `yank`
> doesn't reach the system clipboard by default. Since Neovim 0.10 there's native **OSC 52**
> support, and a few lines of config fix it.

**What OSC 52 actually is.** It's a terminal escape sequence — `OSC` = *Operating System
Command* — of the form `ESC ] 52 ; c ; <base64-payload> BEL`. Neovim doesn't talk to any
clipboard API; it just prints those bytes to the TTY, and the *terminal emulator* decodes the
base64 and sets the system clipboard. That's the whole trick, and it's why it works where the
usual clipboard tools don't: the escape rides the same byte stream as everything else, so it
traverses an SSH pipe or a WSL boundary for free — no `xclip`, no `pbcopy`, no X11 forwarding, no
shared clipboard daemon. The terminal at your end does the writing.

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

The `paste` half is the asymmetry worth understanding. Copy is a one-way push — Neovim emits the
escape and is done. Paste would need the *reverse*: Neovim sends an OSC 52 *query* and the
terminal answers with the clipboard contents, which is a round-trip many terminals (Windows
Terminal among them) simply don't implement, and which some disable for security since it lets a
remote program read your local clipboard. So the `my_paste` shim above just reads back Neovim's
own register instead of asking the terminal — keeping yank/put consistent within the editor. When
you genuinely need the *system* clipboard's contents, use the terminal's native paste (`<C-v>` /
Ctrl-Shift-V), which arrives as ordinary typed input and sidesteps OSC 52 entirely.

For an intro to OSC 52 and which terminals support it, see
[this r/vim guide](https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/).

References:

- <https://github.com/neovim/neovim/issues/28611>
- <https://www.reddit.com/r/neovim/comments/188smrx/how_do_i_use_osc52_in_neovim100/>
