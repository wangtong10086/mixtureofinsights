---
title: "The Google Wallet Wall"
description: "Play Integrity passes STRONG. Google Wallet still refuses to add a card. Here is why — proven, not guessed — and why it can't be forced onto an unlocked device."
date: 2026-06-09
order: 1
series: "android-hardening"
reading: "6 min read"
tags: ["android", "attestation", "google-wallet", "tee"]
---

A Xiaomi 13 running LineageOS, unlocked bootloader, Magisk root. A full hiding stack
makes it pass Play Integrity **BASIC + DEVICE + STRONG**. And Google Wallet *still*
refuses to add a card. This is the story of proving exactly why — and learning to tell
a configuration gap from a wall.

## The symptom

Adding any card fails at tokenization with a generic *"doesn't meet security standards"*.
Since integrity passes STRONG, integrity isn't the gate. So what is?

## Reading the actual failure

Logcat during add-card, filtered to `TapAndPay`:

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet asks KeyStore for a **hardware-attested "storage key"**, then validates that
attestation **server-side**. That validation — not Play Integrity — is the wall.

## Is it the device, or the account/IP?

The single most useful experiment: the **same Google account, same VPN, same card adds
fine on a separate non-rooted phone.** That eliminates account reputation, the proxy IP,
and the card issuer in one move. The remaining variable is *this device's attestation*.

## Is the forgery failing locally, or being rejected by the server?

Decisive check: during the GMS (uid 10074) attestation, `keystore2` / `KeyMint` log
**no local error**. So TrickyStore *successfully forges* the storage-key attestation
on-device; the rejection comes back only after a ~2.4 s network round-trip.
**Google's payment backend detects and rejects the forged attestation.**

## Everything tried — all failed identically

- A valid, **unrevoked** keybox (every cert serial checked against Google's CRL).
- TrickyStore `!` **generate** mode for `walletnfcrel` *and* `gms` (full chain forgery).
- The Reddit fix: set every `spoof*` in `pif.json` to `0` (disable PIF fingerprint spoofing).
- The XDA step: clear data for GMS×2 / GSF / Vending / Wallet, then reboot.

Every path ended at the same `Device fails attestation`.

## The wall, drawn

<figure class="figure">
<svg viewBox="0 0 720 230" role="img" aria-label="Three attestation paths; only genuine+locked passes">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="#6b6862"/>
    </marker>
  </defs>
  <style>
    .b{fill:#fff;stroke:#e9e4dc;stroke-width:1.5;rx:8}
    .t{font:14px var(--sans, sans-serif);fill:#1c1b19}
    .s{font:12px var(--sans, sans-serif);fill:#6b6862}
    .ln{stroke:#6b6862;stroke-width:1.5;fill:none}
    .ok{fill:#0f766e;font:13px sans-serif;font-weight:700}
    .no{fill:#b4530a;font:13px sans-serif;font-weight:700}
  </style>
  <text x="14" y="22" class="s">WHAT THE DEVICE CAN PRESENT</text>
  <rect class="b" x="14" y="34" width="250" height="40" rx="8"/>
  <text x="28" y="59" class="t">Forged attestation (TrickyStore)</text>
  <rect class="b" x="14" y="92" width="250" height="40" rx="8"/>
  <text x="28" y="117" class="t">Genuine TEE · unlocked bootloader</text>
  <rect class="b" x="14" y="150" width="250" height="40" rx="8"/>
  <text x="28" y="175" class="t">Genuine TEE · locked (stock)</text>

  <rect class="b" x="360" y="92" width="170" height="40" rx="8"/>
  <text x="378" y="117" class="t">Google payment backend</text>

  <path class="ln" d="M264 54 H312 Q336 54 336 96 V108" marker-end="url(#ar)"/>
  <path class="ln" d="M264 112 H352" marker-end="url(#ar)"/>
  <path class="ln" d="M264 170 H312 Q336 170 336 128 V120" marker-end="url(#ar)"/>

  <path class="ln" d="M530 100 H600" marker-end="url(#ar)"/>
  <text x="610" y="86" class="no">✗ rejected (forgery detected)</text>
  <text x="610" y="105" class="no">✗ rejected (reports unlocked)</text>
  <text x="610" y="124" class="ok">✓ the only thing that passes</text>
</svg>
<figcaption>Play Integrity STRONG is satisfiable by a forgery. The Wallet storage-key
attestation is validated strictly enough that it isn't.</figcaption>
</figure>

## The conclusion — a real wall, not a config gap

On an unlocked / broken-TEE device, Wallet add-card is **not achievable by any
device-side means**. The community guides that "fix Wallet" work for devices whose
*real* TEE attestation is intact and merely hidden — not for one whose hardware
attestation is broken and can only be forged.

## The lesson

Separate the layers before you burn days: **an integrity verdict is not a key
attestation.** The first is forgeable in userspace; the second chains to silicon. When a
backend checks the second, no amount of props, modules, fingerprints, or cache-clearing
moves it. Know which wall you're standing at.
