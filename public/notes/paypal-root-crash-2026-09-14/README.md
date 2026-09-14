# PayPal startup investigation — source attachments / 源码附件

Date: 2026-09-14. These files accompany the [Chinese article](https://mixtureofinsights.com/zh/blog/06-paypal-crash-two-root-signals/) and [English article](https://mixtureofinsights.com/blog/06-paypal-crash-two-root-signals/).

## Files

| File | Purpose |
| --- | --- |
| [app-zygote-errno.patch](app-zygote-errno.patch) | Exact 20-line SELinux change used in the tested kernel |
| [magisk-mount-order-clean.patch](magisk-mount-order-clean.patch) | Exact final Magisk first-stage mount-order change, without temporary diagnostic logging |
| [evidence-summary.json](evidence-summary.json) | Sanitized technical results selected from local records |
| [error-path-tests.txt](error-path-tests.txt) | Recorded output of the 15 host control-flow tests |
| [diagnostic-matrix.svg](diagnostic-matrix.svg) | Source diagram for the article cover; rows describe installed changes and observed startup |
| [SHA256SUMS.txt](SHA256SUMS.txt) | Checksums of the files in this attachment directory, excluding the checksum file itself |

The patches are byte-identical to the local patches used for the accepted repair. The evidence summary is an authored extract, not the original logs. The host-test output is a historical result, not a test runner or a substitute for reproducing the tests.

## Exact source baselines

- Kernel: [LineageOS/android_kernel_xiaomi_sm8550 at 03e6e48a5b4ed606dfdd48bc782a57f9c778938b](https://github.com/LineageOS/android_kernel_xiaomi_sm8550/tree/03e6e48a5b4ed606dfdd48bc782a57f9c778938b), `security/selinux/hooks.c`, `selinux_setprocattr()`.
- Magisk: [topjohnwu/Magisk at e8a58776f1d7bdf852072ad0baa6eceb9a1e4aac](https://github.com/topjohnwu/Magisk/tree/e8a58776f1d7bdf852072ad0baa6eceb9a1e4aac), `native/src/init/init.rs` and `native/src/init/mount.rs`.
- Compiler source: LLVM `5e96669f06077099aa41290cdb4c5e6fa0f59349`, Clang 21.0.0. Matching the original compiler source revision did not mean identical compiler binaries.

The patches modify GPL-covered upstream projects; retain their upstream license requirements when redistributing modified source or binaries. Upstream context in each diff remains attributed to the linked project. No upstream acceptance of these local changes is claimed.

## Reuse and recovery / 复用与回退

在各自准确源码基线的干净 worktree 中先运行 `git apply --check /path/to/the.patch`，再评审和应用对应补丁。不要同时把两份补丁应用到同一个项目。

这不是可一键刷入的安装包。附件不包含设备启动镜像、原始配置、验签证书、完整原始日志或账户界面。重新构建需要当前设备的真实内核配置、工具链、模块与信任信息、对应系统启动镜像和打包校验，不能只凭 `uname` 相同认定兼容。

本次实际验证包括：保持 Full LTO / CFI、保留原模块验签公钥、核对内核及模块间的全部导入符号 CRC、15 项宿主控制流测试、临时启动、真实 App Zygote 复现、真实应用系统调用和用户认证后验收。正文区分了每阶段测到的结果与未覆盖部分。

每次新测试前，读取并校验当前设备原始 `boot`、`init_boot`，保留离线恢复副本，核对设备与活动槽位。仅临时启动时重启可结束该次临时内核；一旦持久写入，恢复必须对应实际改动的分区。本次组合修复写入了两个分区，完整回退需要恢复两个对应原镜像。

系统、内核或 Magisk 更新后，重新确认检测输入与修改是否适用，不要跨系统版本重刷本次旧镜像。造成黑屏的 ART 入口探针不在附件中，也不应作为后续定位的默认方案。

In a clean worktree at each exact baseline, run `git apply --check /path/to/the.patch` before review and application. These are two separate projects. This directory is not a turnkey build or flashing kit. A new device build requires its actual runtime configuration, compatible toolchain, original module/trust information, matching boot-image structure, and fresh compatibility and recovery checks.

Both `boot` and `init_boot` were persistently changed in the final accepted repair. Complete rollback requires both corresponding original images. A reboot alone only ends a temporary boot. Reassess the patches after updates; do not transplant old images across OS versions. The retired ART probe is intentionally absent.
