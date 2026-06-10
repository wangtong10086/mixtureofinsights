# Sources & provenance

This file records the **real repositories, code, and external references** each blog series is
grounded in. It is internal documentation for the repo — it is **not** rendered into the site or
any post. Its purpose: every technical claim in a post should trace back to something here, so the
posts stay code-grounded rather than paraphrased from memory.

> Maintenance rule: when you edit a post's technical content, update the corresponding entry below
> (and vice-versa). If a claim can't be traced to a source here, it shouldn't be stated as fact.

## Editorial writing policy

The site should read like a normal high-quality technical blog. Career value should
come indirectly: readers trust the author because the articles are deep, coherent,
source-grounded, and useful.

- Core Chinese posts should usually open with a situation, failure, question, or debugging
  path before the conclusion. Code anchors and metrics should appear as part of the
  investigation, not as proof cards.
- Public metrics may be stated when the benchmark scope is described honestly; private
  benchmark data, customer/user material, keys, serials, and raw sensitive logs must not
  be copied into posts.
- The writing center is project-grounded AI engineering: data generation,
  verifier/reward design, training, evaluation, remote execution, inference serving,
  and runtime observability. It should sound useful to serious technical readers first,
  with enough process that a reader can follow how the answer was found.
- Android-hardening content is supporting evidence for systems debugging and security
  judgment, but it should stand as a normal systems/security exploration series in its
  own right.

## Series → source repositories

| Series | Source repository | Visibility |
| --- | --- | --- |
| Post-Training in Practice | [`wangtong10086/orbit`](https://github.com/wangtong10086/orbit) | public |
| ORBIT (control/execution) | [`wangtong10086/orbit`](https://github.com/wangtong10086/orbit) | public |
| Shipping a TTS model on OpenVINO | [`wangtong10086/qwen3-tts-openvino`](https://github.com/wangtong10086/qwen3-tts-openvino) | public |
| Hardening a rooted Android device | [`wangtong10086/fuxi-stealth`](https://github.com/wangtong10086/fuxi-stealth) + a private device working directory (ground truth only) | fuxi-stealth: private |
| Neovim: OSC 52 (standalone note) | no project repo — upstream Neovim | — |

Local checkouts used while writing (paths on the author's machine, not part of this repo):
`~/orbit`, `~/qwen3-tts-openvino`, `~/fuxi-stealth`, and `~/xiaomi13` (private; see the secrets note
at the bottom).

## Code anchors per series

The specific files/symbols the posts are written against. Paths are relative to each repo root.

### Post-Training in Practice → `orbit`
- **Data engines** — `orbit/data/liveweb_teacher_gen.py` (`TeacherGenerator`,
  `generate_composite_trajectory`, `dedup_against_canonical`); `orbit/data/game_gen.py`
  (`SUPPORTED_GAMES`); `orbit/data/game_generators/search_generators.py`
  (`SearchTrajectoryGenerator`, `SEARCH_BUDGETS`).
- **Rejection sampling / SFT seed** — `orbit/data/sft.py` (`filter_quality`);
  `orbit/data/ms_swift_dataset.py` (`build_ms_swift_dataset`).
- **Verifiers / reward** — `orbit/verifiers/base.py` (`VerifierSpec`, `VerifierResult`);
  `orbit/verifiers/static.py` (`StaticTraceVerifier`).
- **Training config** — `orbit/training/config.py` (`SwiftConfig`, `num_generations`,
  `to_yaml_dict`); `orbit/training/sft.py` (`SwiftBackend.validate_config`);
  `orbit/training/dpo_config.py` (`generate_dpo_script`, `DPO_BETA` — note: self-contained
  template, partly dead in the public checkout; the post says so).
- **Self-play CLI** — `orbit/data/cli_game.py` (`--attempt-multiplier`,
  `game-selfplay-eval`); `orbit/domain_jobs/game_longrun/` (long-run trainer is stubbed in the
  public checkout; the post flags this).
- Correction recorded: the self-play post originally described an "AI Werewolf" setup; the shipped
  code is **OpenSpiel** board/card games with **MCTS / CFR / MCCFR**. Post rewritten to match.

### ORBIT (control/execution) → `orbit`
- **Control plane** — `orbit/core/control/service.py` (`CoreControlService`, `submit_task`);
  `orbit/core/control/registry.py` (`TaskPlugin`, `TaskRegistry`).
- **Contracts** — `orbit/core/contracts/execution.py` (`RunState`, `RunHandle`,
  `backend_key_for_request`); `orbit/core/contracts/tasks.py` (`TaskSubmission`).
- **Task plugins** — `orbit/tasks/training/plugin.py` (`TrainingPlugin`),
  `orbit/tasks/{evaluation,collection}/plugin.py`; `orbit/tasks/__init__.py`
  (`build_default_task_registry`).
- **Bundle** — `orbit/core/execution/bundle.py` (`JobBundle`, `ensure_structure`,
  `schema_version`); real layout is `inputs/ scripts/ artifacts/ runtime/` **+ `job.json`**
  (correction: the post originally said "three directories").
- **Provenance / pinning** — `orbit/tasks/training/bundle_builder.py`
  (`runtime-precheck.log`); `orbit/integrations/affinetes_swe/runner.py` (`_COMMIT_RE`,
  `_require_exact_ref`, dirty-check).
- **Entrypoints / templates** — `orbit/cli_control.py`, `orbit/cli_worker.py`;
  `execution_templates/targon-rental-host.yaml`.

### Shipping a TTS model on OpenVINO → `qwen3-tts-openvino`
- **Serving flags (all verified to exist)** — `qwen3_tts_ov/cli.py` (`--online-batching`,
  `--online-batch-scheduler`, `--kv-cache-profile`); `qwen3_tts_ov/profiles.py`
  (`int8_sym_batch_fused_gqa`, `minimal-online-gqa`, NPU-offload choices).
- **Online batching / paged-KV** — `qwen3_tts_ov/online_batch.py` (`OnlineBatchConfig`,
  `block_size`, `kv_precision`, `graph_variant`, `talker_stateful_batch_gqa`);
  `native/qwen3_tts_ov_genai/qwen3_tts_codegen.cpp` + `scripts/convert_paged_kv_graphs.py`
  (`SDPAToPagedAttention`).
- **Graph splitting** — `qwen3_tts_ov/exporter.py`, `qwen3_tts_ov/build_fastest.py`
  (`subcode_greedy_cached`, streaming-decoder chunk graphs).
- **Runtime / health** — `qwen3_tts_ov/runtime.py` (`compile_model`); `qwen3_tts_ov/server.py`
  (`/health`).
- Note: exact transformer dims (`L`, heads) used in the KV-cache memory example are illustrative
  round numbers — the repo ships no model `config.json` (weights are downloaded). The two dims that
  *are* in code (`head_dim=128`, GQA `heads=8`) are grounded in `online_batch.py`.

### Hardening a rooted Android device → `fuxi-stealth`
- **StockMask Xposed module** — `code/stockmask/src/com/stockmask/Main.java`
  (`handleLoadPackage`, `isThirdPartyAppId`, `shouldFilter`, `hasFeatureHook`, `listFeatureHook`,
  `hookFeatures`, `hookPermissions`, `hookLogAccess`, `processNewLogAccessRequest`,
  `declineRequest`, `ParceledListSlice`); `code/stockmask/build.sh`, `AndroidManifest.xml`,
  `assets/xposed_init`. (205 lines — the "200-line module" rounding.)
- **Prop/SELinux spoof** — `code/fuxi_prop_spoof/post-fs-data.sh`,
  `code/fuxi_prop_spoof/sepolicy.rule` (30 deny rules across 3 app domains × 10 service types).
- **Scripts** — `code/scripts/revoke-readlogs.sh`, `applog.sh`, `revert-app-limits.sh`.
- **Wallet / attestation ground truth** — a private device runbook and private Wallet capture logs
  (structure only; see secrets note).

## External references (papers, docs) by series

These are the "Further reading" citations already linked in the posts, consolidated for upkeep.

**Post-training**
- STaR <https://arxiv.org/abs/2203.14465> · Constitutional AI <https://arxiv.org/abs/2212.08073> ·
  Llama 2 <https://arxiv.org/abs/2307.09288> · WebSailor <https://arxiv.org/abs/2507.02592>
- DeepSeekMath/GRPO <https://arxiv.org/abs/2402.03300> · DeepSeek-R1
  <https://arxiv.org/abs/2501.12948> · DAPO <https://arxiv.org/abs/2503.14476> · Dr. GRPO
  <https://arxiv.org/abs/2503.20783>
- Goodhart's law <https://en.wikipedia.org/wiki/Goodhart%27s_law> · Categorizing Variants of
  Goodhart's Law <https://arxiv.org/abs/1803.04585> · Reward Model Overoptimization (Gao et al.)
  <https://arxiv.org/abs/2210.10760> · Reward Misspecification (Pan et al.)
  <https://arxiv.org/abs/2201.03544> · Specification gaming (DeepMind)
  <https://deepmindsafetyresearch.medium.com/specification-gaming-the-flip-side-of-ai-ingenuity-c85bdb0deeb4>
- DPO <https://arxiv.org/abs/2305.18290> · IPO <https://arxiv.org/abs/2310.12036> · S-LoRA
  <https://arxiv.org/abs/2311.03285>
- AlphaZero <https://arxiv.org/abs/1712.01815> · AlphaStar
  <https://www.nature.com/articles/s41586-019-1724-z> · Counterfactual Regret Minimization
  <https://papers.nips.cc/paper/2007/hash/08d98638c6fcd194a4b1e6992063e944-Abstract.html> ·
  OpenSpiel <https://github.com/google-deepmind/open_spiel>

**ORBIT**
- Kubernetes reconciler pattern
  <https://github.com/kubernetes/community/blob/master/contributors/design-proposals/architecture/architecture.md>
  · SRE Book ch.1 <https://sre.google/sre-book/introduction/> · Lampson, "Hints for Computer System
  Design" <https://www.microsoft.com/en-us/research/publication/hints-for-computer-system-design/>
- Parnas, "On the Criteria…" <https://www.win.tue.nl/~wstomv/edu/2ip30/references/criteria_for_modularization.pdf>
  · Open/closed principle <https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle> · Spolsky,
  "The Law of Leaky Abstractions" <https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/>
- Meyer, "Design by Contract" <https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf> ·
  ML Reproducibility Checklist <https://www.cs.mcgill.ca/~jpineau/ReproducibilityChecklist.pdf> ·
  "Hidden Technical Debt in ML Systems" <https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems.pdf>

**OpenVINO-TTS**
- FlashAttention <https://arxiv.org/abs/2205.14135> · PagedAttention/vLLM
  <https://arxiv.org/abs/2309.06180> · Orca <https://www.usenix.org/conference/osdi22/presentation/yu>
  · Roofline <https://dl.acm.org/doi/10.1145/1498765.1498785> · LLM.int8()
  <https://arxiv.org/abs/2208.07339>
- SoundStream <https://arxiv.org/abs/2107.03312> · EnCodec <https://arxiv.org/abs/2210.13438> ·
  AudioLM <https://arxiv.org/abs/2209.03143> · OpenVINO docs <https://docs.openvino.ai/>

**Android-hardening**
- Android key attestation <https://developer.android.com/privacy-and-security/security-key-attestation>
  · keystore attestation <https://developer.android.com/privacy-and-security/keystore#attestation> ·
  Play Integrity verdicts <https://developer.android.com/google/play/integrity/verdicts> · Verified
  Boot (AVB) <https://source.android.com/docs/security/features/verifiedboot>
- AOSP `PackageManagerService`
  <https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/pm/PackageManagerService.java>
  · `Binder.getCallingUid()` <https://developer.android.com/reference/android/os/Binder> · LSPosed
  <https://github.com/LSPosed/LSPosed>
- `READ_LOGS` <https://developer.android.com/reference/android/Manifest.permission#READ_LOGS> ·
  protection levels <https://developer.android.com/guide/topics/permissions/overview#permission-protection-levels>
  · AOSP `LogcatManagerService`
  <https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/services/core/java/com/android/server/logcat/LogcatManagerService.java>
- Android UIDs/AIDs
  <https://cs.android.com/android/platform/superproject/main/+/main:system/core/libcutils/include/private/android_filesystem_config.h>
  · SELinux for Android <https://source.android.com/docs/security/features/selinux> · `nsenter(1)`
  <https://man7.org/linux/man-pages/man1/nsenter.1.html>

**Neovim**
- Neovim OSC 52 (PR #25872) <https://github.com/neovim/neovim/pull/25872> · r/vim OSC 52 guide
  <https://www.reddit.com/r/vim/comments/k1ydpn/a_guide_on_how_to_copy_text_from_anywhere/>

## Blog infrastructure & services

The resources the site itself runs on (see `README.md` for the fuller picture):
[Astro 5](https://astro.build) · [Cloudflare Workers](https://workers.cloudflare.com/) (static
assets, custom domain, Web Analytics) · GitHub Actions auto-deploy (`.github/workflows/deploy.yml`)
· [Shiki](https://shiki.style/) code highlighting · [KaTeX](https://katex.org/) math (remark-math +
rehype-katex) · hand-drawn inline SVG diagrams · cover images via Cloudflare
[Workers AI](https://developers.cloudflare.com/workers-ai/) (`flux-1-schnell`) ·
[giscus](https://giscus.app/) comments · IndexNow + JSON-LD/OG for SEO.

## Secrets note (Android series)

The Android posts are grounded in the public `fuxi-stealth` code and a **private** device working
directory used only as ground truth. The following are **never** quoted or reproduced in posts or in
this doc: keybox material, certificate serials, revocation-list files, full Wallet capture logs, and
any personal identifiers. Only public mechanism names and the already-public log-line *structure*
(e.g. `TapAndPay: Device fails attestation`) appear in the posts.
