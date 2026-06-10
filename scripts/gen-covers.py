#!/usr/bin/env python3
"""Generate per-post cover images with Cloudflare Workers AI (flux-1-schnell).
Reads CLOUDFLARE_ID / CLOUDFLARE_API_TOKEN from env. Writes public/og/<slug>.jpg.
Run from web/:  set -a; . ../../xiaomi13/.env; set +a; python3 scripts/gen-covers.py
"""
import os, sys, json, base64, urllib.request, pathlib

ACCT = os.environ["CLOUDFLARE_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
MODEL = "@cf/black-forest-labs/flux-1-schnell"
OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "og"
OUT.mkdir(parents=True, exist_ok=True)

STYLE = ("flat editorial vector illustration, minimalist, lots of negative space, "
         "warm palette of rust orange, cream and deep teal on soft paper background, "
         "subtle grain, elegant, NO text, no words, no letters, no numbers")

POSTS = {
    "01-the-google-wallet-wall":
        "a stream of warm light blocked by a solid stone wall, a single sealed gate",
    "02-stockmask":
        "a funnel filter sorting glowing particles, one path kept clean one rerouted",
    "03-the-logcat-leak":
        "fine streams of light leaking out through a hairline crack in a smooth panel",
    "04-auditing-from-the-apps-eyes":
        "a single calm eye composed of layered translucent glass panels",
    "05-what-you-can-and-cant-hide":
        "two tall brick walls standing on an open gradient plain, horizon light",
    "nvim-yank-osc52":
        "a blinking terminal cursor linked to a clipboard by a thin glowing thread",
    # Post-Training in Practice
    "post-training-is-a-data-problem":
        "a self-feeding flywheel made of flowing luminous data particles and arrows of light",
    "cold-start-then-climb":
        "a single small spark at the base igniting a rising staircase of light that climbs upward",
    "what-are-you-rewarding":
        "a balance scale weighing glowing tokens, one pan clean and bright, the other subtly cracked",
    "dpo-when-you-cant-afford-rlhf":
        "two facing cards on a balance, one glowing and chosen, the other faded and set aside",
    "self-play-and-the-games-models-teach-themselves":
        "two mirrored abstract figures across a game board exchanging glowing moves in a circular loop",
    # ORBIT series
    "a-control-plane-for-renting-gpus":
        "a steady glowing control panel connected by a beam of light to a faint dissolving distant server",
    "orbit-a-task-agnostic-core":
        "a plain central hub with three distinct modular blocks docking into clean sockets from above",
    "orbit-the-bundle-is-the-contract":
        "a neat sealed crate with three layered glowing compartments and faint audit-trail lines returning",
    # OpenVINO TTS series
    "when-the-gpu-isnt-an-nvidia":
        "a small glowing processor chip emitting a flowing ribbon of sound waves across negative space",
    "how-qwen3-tts-makes-a-frame":
        "a stack of small glowing tiles assembling into one frame with a thin waveform ribbon flowing out",
    "paged-kv-batching-without-vllm":
        "a grid of small glowing memory blocks feeding one shared core, three request streams merging in",
}

def run(slug, subject):
    prompt = f"{subject}. {STYLE}"
    body = json.dumps({"prompt": prompt, "steps": 8}).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/ai/run/{MODEL}",
        data=body, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.load(r)
    img = (d.get("result") or {}).get("image")
    if not d.get("success") or not img:
        print(f"  FAIL {slug}: {d.get('errors')}"); return False
    (OUT / f"{slug}.jpg").write_bytes(base64.b64decode(img))
    print(f"  ok   {slug}.jpg ({len(base64.b64decode(img))//1024} KB)")
    return True

ok = sum(run(s, p) for s, p in POSTS.items())
print(f"generated {ok}/{len(POSTS)} covers -> {OUT}")
sys.exit(0 if ok == len(POSTS) else 1)
