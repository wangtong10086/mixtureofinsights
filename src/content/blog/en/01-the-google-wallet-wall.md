---
title: "The Google Wallet Wall"
description: "Play Integrity passes STRONG. Google Wallet still refuses to add a card. Here is why — proven, not guessed — and why it can't be forced onto an unlocked device."
date: 2026-06-09
order: 1
series: "android-hardening"
reading: "11 min read"
tags: ["android", "attestation", "google-wallet", "tee"]
---

A Xiaomi 13 running LineageOS, unlocked bootloader, Magisk root. A full hiding stack
makes it pass Play Integrity **BASIC + DEVICE + STRONG**. And Google Wallet *still*
refuses to add a card. This is the story of proving exactly why — and learning to tell
a configuration gap from a wall. (Defensive framing throughout: the point is to
understand the attestation chain well enough to know what *can't* be moved, not to move
it.)

## The symptom

Adding any card fails at tokenization with a generic *"doesn't meet security standards"*.
Since integrity passes STRONG, integrity isn't the gate. So what is?

The trap is assuming Play Integrity is the *only* server-side check Google runs. It isn't.
Play Integrity returns up to three labels — `MEETS_BASIC_INTEGRITY`,
`MEETS_DEVICE_INTEGRITY`, and `MEETS_STRONG_INTEGRITY` — and a relying party (Wallet,
your bank, anyone) is free to demand its *own* additional attestation on top. Wallet does
exactly that. The verdict and the storage-key attestation are two different evidence
chains, validated separately, and STRONG passing tells you nothing about the second.

## Reading the actual failure

Logcat during add-card, filtered to `TapAndPay`:

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet asks Android KeyStore to generate a key *with an attestation challenge*, then
validates the resulting attestation **server-side**. That validation — not Play
Integrity — is the wall.

The mechanism is Android **key attestation**. When you create a hardware-backed key with
`setAttestationChallenge(...)`, KeyMint (the TEE keystore HAL, formerly Keymaster) returns
an X.509 **certificate chain**: your leaf key's cert, signed by an intermediate, chaining
up to a **Google hardware attestation root** burned in at the factory. The leaf carries a
key-attestation extension (OID `1.3.6.1.4.1.11129.2.1.17`) whose `RootOfTrust` field
records two things the relying party cares about: `verifiedBootState`
(`Verified`/`SelfSigned`/`Unverified`/`Failed`) and a `deviceLocked` boolean. Crucially,
**the TEE — not Android — fills in those fields and signs them with a key the OS can't
read.** Wallet sends the chain to Google's backend; the backend checks the signature path
to the genuine root and reads the bootloader state straight out of the signed extension.
On a STRONG-capable device this is *StrongBox*-class hardware (a discrete secure element);
either way the signing happens below the kernel.

The chain has three links, each carrying a different load:

| Cert | Signed by | What it carries |
|---|---|---|
| Leaf (attestation cert) | the intermediate | the key-attestation extension OID `1.3.6.1.4.1.11129.2.1.17`, whose `RootOfTrust` → `verifiedBootState` + `deviceLocked`, plus the key's properties and the challenge you passed in |
| Intermediate(s) | the root | the attestation batch / device-model authority — the link that ties the leaf to Google's authority |
| Google hardware-attestation root | self-signed (factory-burned) | the public anchor the backend pins; if the chain doesn't terminate here, it's not a genuine TEE |

That is the whole problem stated precisely: userspace can lie to apps all day, but it
cannot sign as the TEE, and it cannot make the TEE report `deviceLocked: true` /
`verifiedBootState: Verified` when the bootloader is unlocked. The verified-boot state is
baked into what the hardware will attest to.

## Is it the device, or the account/IP?

The single most useful experiment: the **same Google account, same VPN, same card adds
fine on a separate non-rooted phone.** That eliminates account reputation, the proxy IP,
and the card issuer in one move. The remaining variable is *this device's attestation*.

## Is the forgery failing locally, or being rejected by the server?

Decisive check: during the GMS (uid 10074) attestation, `keystore2` / `KeyMint` log
**no local error**. So TrickyStore *successfully forges* the storage-key attestation
on-device — it intercepts the keystore call and substitutes a chain signed with a leaked
"keybox" (a real per-device key + cert chain extracted from some other device). The leaf
it produces is well-formed and chains to a real root; that's why there's no local failure.
The rejection comes back only after a ~2.4 s network round-trip. **Google's payment
backend detects and rejects the forged attestation** — either because the keybox serial
has been added to Google's revocation list, or because the attested
`verifiedBootState`/`deviceLocked` don't match what a genuine, locked device of this model
would report. A forgery good enough to satisfy a *local* check is not good enough to
satisfy a backend that knows what the real root signs.

## Everything tried — all failed identically

- A valid, **unrevoked** keybox (every cert serial checked against Google's revocation
  list before use).
- TrickyStore `!` **generate** mode for `walletnfcrel` *and* `gms` (full chain forgery).
- The Reddit fix: set every `spoof*` in `pif.json` to `0` (disable PIF fingerprint spoofing).
- The XDA step: clear data for GMS×2 / GSF / Vending / Wallet, then reboot.

Across repeated full add-card capture runs — a stack of `wallet_addcard` / `wallet_retry`
logcat dumps, each megabytes long — every path ended at the same
`Device fails attestation`.

## What about fixing the TEE for real?

There's one move that isn't userspace forgery: actually repair the hardware attestation
key. Unlocking the bootloader on this Snapdragon 8 Gen 2 device damaged the TEE's
attestation key / RKP provisioning; a Xiaomi-vendor `KmInstallKeybox` binary can
re-provision it (the procedure lives in a careful, gated `fuxi-tee-repair-runbook.md` —
it writes the `persist` partition, which is irreversible, so it's all backups, dry-run
usage probing, and human-confirmed write gates). That repair genuinely brings back
**hardware key attestation** and **Widevine L1**.

But it does *not* move this wall, and the runbook says so in its own boundary notes: a
repaired TEE will now attest **honestly** — and an unlocked bootloader is reported
honestly as unlocked. Its realistic Play Integrity ceiling is **BASIC**; DEVICE/STRONG
and Wallet tap-to-pay are explicitly *out of scope* for a TEE repair on an unlocked
device. Fixing the silicon doesn't help here precisely *because* it makes the device tell
the truth. The only thing that flips `deviceLocked` to true is relocking with stock.

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
*real* TEE attestation is intact and merely hidden — i.e. the bootloader is relocked and
the only "problem" is a fingerprint or prop the OS reports inconsistently. They do nothing
for a device whose hardware attestation reports the truth — unlocked — and can only be
forged. The distinction is exactly the `deviceLocked` bit: hide-able versus baked-in.

## The lesson

Separate the layers before you burn days: **an integrity verdict is not a key
attestation.** Play Integrity's STRONG label is a verdict Google's server returns *about*
a device; a key attestation is a signed statement *by* the device's hardware. The first is
forgeable in userspace (and Wallet doesn't gate on it anyway); the second chains to
silicon and carries the bootloader state in a field the OS cannot touch. When a backend
validates the second, no amount of props, modules, fingerprints, or cache-clearing moves
it. Know which wall you're standing at — and this one is load-bearing concrete, not
drywall.

## Further reading

- [Android key attestation](https://developer.android.com/privacy-and-security/security-key-attestation) — the cert chain, the attestation extension, and `verifiedBootState` / `deviceLocked`.
- [Verifying hardware-backed key pairs with key attestation](https://developer.android.com/privacy-and-security/keystore#attestation) — the `setAttestationChallenge` flow and validating the chain against Google's root.
- [Play Integrity API verdicts](https://developer.android.com/google/play/integrity/verdicts) — what BASIC / DEVICE / STRONG actually assert, and why they're separate from any app's own attestation.
- [Android Verified Boot (AVB)](https://source.android.com/docs/security/features/verifiedboot) — where the boot state that the TEE attests to comes from.
