---
title: "Google Wallet card-add failure despite Play Integrity STRONG"
description: "Investigating a Google Wallet card-add failure on an unlocked Xiaomi 13 that passed Play Integrity STRONG, from TapAndPay logs to key attestation."
date: 2026-06-09
updatedAt: 2026-09-15
order: 1
series: "android-hardening"
reading: "11 min read"
tags: ["android", "attestation", "google-wallet", "tee"]
---

A Play Integrity STRONG result did not make card tokenization succeed in this Xiaomi 13 investigation. The TapAndPay log instead pointed to storage-key attestation. The public Android documentation explains the certificate fields; the precise Google payment-backend rejection rule cannot be established from client logs alone.

Adding any card failed at tokenization with a generic *"doesn't meet security standards"*. Since [Play Integrity (Google, 2024)](https://developer.android.com/google/play/integrity/verdicts) passed STRONG, integrity wasn't the gate.

I filtered logcat during the add-card process to `TapAndPay`:

```text
TapAndPay: CheckOrGetStorageKeyStep. Start.
TapAndPay: Device fails attestation
TapAndPay: attestation failed   ->  TapAndPayApiException
TapAndPay: CheckOrGetStorageKeyStep. Attestation Error.
Pay:       Failed to fetch the storage key, will attempt to only use keystore.
```

Wallet asks Android KeyStore to generate a key with an attestation challenge, then validates the resulting attestation server-side. That validation was rejecting the device.

When I create a hardware-backed key with `setAttestationChallenge(...)`, KeyMint returns an X.509 certificate chain. The leaf carries a [key-attestation extension](https://developer.android.com/privacy-and-security/security-key-attestation) (OID `1.3.6.1.4.1.11129.2.1.17`) whose `RootOfTrust` field records `verifiedBootState` and a `deviceLocked` boolean. The TEE — not Android — fills in those fields and signs them with a key the OS can't read. Wallet sends the chain to Google's backend. The backend checks the signature path to the genuine root and reads the [bootloader state](https://source.android.com/docs/security/features/verifiedboot) straight out of the signed extension. On a STRONG-capable device, this is *StrongBox*-class hardware; the signing happens below the kernel.

During the GMS (uid 10074) attestation, `keystore2` logged no local error. TrickyStore successfully forged the storage-key attestation on-device. It intercepted the keystore call and substituted a chain signed with a leaked "keybox". The rejection came back only after a 2.4s network round-trip. Google's payment backend detects and rejects the forged attestation.

```text
+-------------------------------------------------------------+
|               WHAT THE DEVICE CAN PRESENT                   |
+-------------------------------------------------------------+
  [ Forged attestation (TrickyStore) ] ------+
                                             |
  [ Genuine TEE · unlocked bootloader] ------+---> [ Google payment backend ]
                                             |
  [ Genuine TEE · locked (stock)     ] ------+
```
Google's backend enforces the physical reality of the silicon state. Userspace can lie to apps, but it cannot sign as the TEE, and it cannot make the TEE report `deviceLocked: true` when the bootloader is unlocked. The verified-boot state is baked into the hardware.

Repairing the TEE on an unlocked device only makes the TEE attest honestly. I verified this via the Xiaomi-vendor `KmInstallKeybox` binary repair runbook. The realistic Play Integrity ceiling is BASIC. Wallet tap-to-pay remains explicitly out of scope for a TEE repair on an unlocked device. The repaired TEE still reports an unlocked bootloader.

The broader [Android observation-layer overview](/blog/05-what-you-can-and-cant-hide/) separates local detection surfaces from hardware attestation.
