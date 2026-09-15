# 18 篇双语文章审阅与修改记录

审阅日期：2026-09-15。18 对文章均已完整阅读；前六篇优先处理。每对均修改标题、开头答案/适用条件和上下文内链，记录真实 updatedAt。原始发布日期、URL、系列顺序、代码、公式和已有证据保留。章节名称的改动保留旧锚点。技术事实按源码观察、推导和作者经验区分；下表待确认项没有补造实验。

## 1. post-training-is-a-data-problem

- EN：title: "Post-training is a data problem" → **title: "LLM post-training data: generation, verification and yield"**。 [页面](https://mixtureofinsights.com/blog/post-training-is-a-data-problem/)
- ZH：title: "后训练是个数据问题" → **title: "LLM 后训练数据：生成、验证与通过率"**。 [页面](https://mixtureofinsights.com/zh/blog/post-training-is-a-data-problem/)
- 读者问题：How do I generate and verify LLM post-training data?
- 页面答案：生成→验证→过滤→JSONL；通过率约束数据成本
- 支撑证据：ORBIT data and verifier paths; illustrative odds model
- 待确认：KL 推导条件、预算占比及训练收益未独立验证
- 章节名称调整：5 处，旧锚点兼容。

## 2. dpo-when-you-cant-afford-rlhf

- EN：title: "DPO when I can't afford RLHF" → **title: "DPO for role-play: preference pairs and chosen likelihood"**。 [页面](https://mixtureofinsights.com/blog/dpo-when-you-cant-afford-rlhf/)
- ZH：title: "算力不够上 RLHF，就把 DPO 用对" → **title: "角色扮演 DPO：偏好对与 chosen 概率监控"**。 [页面](https://mixtureofinsights.com/zh/blog/dpo-when-you-cant-afford-rlhf/)
- 读者问题：Why does chosen likelihood fall during DPO training?
- 页面答案：相对偏好目标不等于 chosen 绝对概率上升
- 支撑证据：DPO/IPO papers; ORBIT dpo_config.py
- 待确认：中英验证器叙述差异、QLoRA 产物大小与并发结果待确认
- 章节名称调整：6 处，旧锚点兼容。

## 3. what-are-you-rewarding

- EN：title: "What am I actually rewarding?" → **title: "Planning-agent rewards: verifiers, reward models and reward hacking"**。 [页面](https://mixtureofinsights.com/blog/what-are-you-rewarding/)
- ZH：title: "你到底在奖励什么?" → **title: "规划 Agent 奖励设计：验证器、奖励模型与奖励漏洞"**。 [页面](https://mixtureofinsights.com/zh/blog/what-are-you-rewarding/)
- 读者问题：How should a planning agent combine verifiers and reward models?
- 页面答案：硬约束程序检查、软判断模型评分、留出评测防止代理分数误导
- 支撑证据：ORBIT StaticTraceVerifier; reward overoptimization paper
- 待确认：12% 口径与验证器完备性待作者记录
- 章节名称调整：4 处，旧锚点兼容。

## 4. a-control-plane-for-renting-gpus

- EN：title: "A control plane for renting GPUs" → **title: "ORBIT: a control plane for experiments on rented GPUs"**。 [页面](https://mixtureofinsights.com/blog/a-control-plane-for-renting-gpus/)
- ZH：title: "租 GPU 的控制面" → **title: "ORBIT：租用 GPU 上的实验控制面"**。 [页面](https://mixtureofinsights.com/zh/blog/a-control-plane-for-renting-gpus/)
- 读者问题：How do I track and retry ML experiments on rented GPUs?
- 页面答案：本地身份与远程执行分离；保留模板、bundle、handle和已收集产物
- 支撑证据：ORBIT CoreControlService, execution service and templates
- 待确认：重提交不保证数值确定性；远端未收集产物无法自动恢复
- 章节名称调整：6 处，旧锚点兼容。

## 5. how-qwen3-tts-makes-a-frame

- EN：title: "How Qwen3-TTS makes a frame of sound" → **title: "Qwen3-TTS on OpenVINO: Talker, Subcode and streaming decode"**。 [页面](https://mixtureofinsights.com/blog/how-qwen3-tts-makes-a-frame/)
- ZH：title: "拆解 Qwen3-TTS：OpenVINO 移植过程中的图分离与调度实践" → **title: "Qwen3-TTS 的 OpenVINO 拆图：Talker、Subcode 与流式解码"**。 [页面](https://mixtureofinsights.com/zh/blog/how-qwen3-tts-makes-a-frame/)
- 读者问题：How are Qwen3-TTS graphs split for streaming OpenVINO inference?
- 页面答案：Talker/Subcode/Decoder 分离；首块与稳态窗口不同
- 支撑证据：exporter.py save_paged_kv_seed_talker_model and SubcodeGreedyCachedWrapper; build_fastest.py
- 待确认：旧 native_paged_kv.py 引用已定位到 exporter.py；TTFA/NPU实测待验证
- 章节名称调整：6 处，旧锚点兼容。

## 6. paged-kv-batching-without-vllm

- EN：title: "Paged-KV, U8, and batching where vLLM isn't" → **title: "OpenVINO Qwen3-TTS: Paged-KV, U8 cache and continuous batching"**。 [页面](https://mixtureofinsights.com/blog/paged-kv-batching-without-vllm/)
- ZH：title: "无 vLLM 环境下的 Paged-KV 与连续批处理调度" → **title: "OpenVINO Qwen3-TTS：Paged-KV、U8 缓存与连续批处理"**。 [页面](https://mixtureofinsights.com/zh/blog/paged-kv-batching-without-vllm/)
- 读者问题：How do Paged-KV and U8 support continuous batching on OpenVINO?
- 页面答案：分页减少碎片、U8减小载荷、逐步调度提高请求接入灵活性
- 支撑证据：online_batch.py and C++ graph pass; PagedAttention/Orca papers
- 待确认：2倍吞吐、3倍并发、时延与带宽极限缺实测条件
- 章节名称调整：0 处，旧锚点兼容。

## 7. cold-start-then-climb

- EN：title: "Cold-start, then climb" → **title: "SFT cold-start before GRPO for constrained planning"**。 [页面](https://mixtureofinsights.com/blog/cold-start-then-climb/)
- ZH：title: "先冷启动，再让 RL 往上爬" → **title: "约束规划的 SFT 冷启动与 GRPO"**。 [页面](https://mixtureofinsights.com/zh/blog/cold-start-then-climb/)
- 读者问题：When should I use SFT cold-start before GRPO?
- 页面答案：先提高可用轨迹概率，再用奖励差异强化
- 支撑证据：SwiftConfig, DeepSeekMath/R1 papers
- 待确认：稀疏奖励相对误差与绝对方差需区分；内部12%未复验
- 章节名称调整：0 处，旧锚点兼容。

## 8. orbit-a-task-agnostic-core

- EN：title: "A task-agnostic core, and plugins that earn their keep" → **title: "ORBIT task plugins: validation outside the execution core"**。 [页面](https://mixtureofinsights.com/blog/orbit-a-task-agnostic-core/)
- ZH：title: "ORBIT 的内核为什么不懂任务" → **title: "ORBIT 任务插件：将任务校验移出通用执行核"**。 [页面](https://mixtureofinsights.com/zh/blog/orbit-a-task-agnostic-core/)
- 读者问题：How can task plugins share one remote execution core?
- 页面答案：四个任务接口与共用执行流程分离
- 支撑证据：ORBIT registry.py, training/plugin.py
- 待确认：局部import不能保证所有依赖均无副作用
- 章节名称调整：0 处，旧锚点兼容。

## 9. orbit-the-bundle-is-the-contract

- EN：title: "The bundle is the contract" → **title: "ORBIT job bundles: logs, artifacts and dependency provenance"**。 [页面](https://mixtureofinsights.com/blog/orbit-the-bundle-is-the-contract/)
- ZH：title: "bundle 即契约" → **title: "ORBIT 任务 bundle：日志、产物与依赖来源"**。 [页面](https://mixtureofinsights.com/zh/blog/orbit-the-bundle-is-the-contract/)
- 读者问题：What should a remote ML job bundle preserve for debugging?
- 页面答案：输入、运行时、日志与产物分层；记录实际依赖
- 支撑证据：ORBIT bundle.py and exact-ref integration
- 待确认：只能审阅公开实现；不能复验作者所有运行记录
- 章节名称调整：0 处，旧锚点兼容。

## 10. self-play-and-the-games-models-teach-themselves

- EN：title: "Self-play, and the games my models teach themselves" → **title: "OpenSpiel training data: MCTS, CFR and trajectory filtering"**。 [页面](https://mixtureofinsights.com/blog/self-play-and-the-games-models-teach-themselves/)
- ZH：title: "自我博弈：让模型从游戏里捞数据" → **title: "OpenSpiel 训练数据：MCTS、CFR 与轨迹筛选"**。 [页面](https://mixtureofinsights.com/zh/blog/self-play-and-the-games-models-teach-themselves/)
- 读者问题：How can OpenSpiel MCTS and CFR generate LLM SFT data?
- 页面答案：求解器产生动作，环境返回收益，再转换为对话
- 支撑证据：search_generators.py threshold and attempt budget
- 待确认：长跑闭环公开实现有限；搜索近最优无基准
- 章节名称调整：0 处，旧锚点兼容。

## 11. when-the-gpu-isnt-an-nvidia

- EN：title: "When the GPU isn't an NVIDIA" → **title: "Qwen3-TTS on Intel: OpenVINO inference without CUDA"**。 [页面](https://mixtureofinsights.com/blog/when-the-gpu-isnt-an-nvidia/)
- ZH：title: "离开 N 卡后的真实世界：Ultra x7 358h 平台上的 TTS 推理框架重构" → **title: "Intel 平台上的 Qwen3-TTS：不依赖 CUDA 的 OpenVINO 推理"**。 [页面](https://mixtureofinsights.com/zh/blog/when-the-gpu-isnt-an-nvidia/)
- 读者问题：How can Qwen3-TTS stream on Intel hardware without CUDA?
- 页面答案：导出与运行时配合；缓存、量化、调度分别处理
- 支撑证据：qwen3-tts-openvino runtime and native backend
- 待确认：设备SKU/CPU/内存组合、音质功耗和RTF待原始记录
- 章节名称调整：0 处，旧锚点兼容。

## 12. 01-the-google-wallet-wall

- EN：title: "The Google Wallet Wall" → **title: "Google Wallet card-add failure despite Play Integrity STRONG"**。 [页面](https://mixtureofinsights.com/blog/01-the-google-wallet-wall/)
- ZH：title: "Google Wallet 不是 Play Integrity 那一关" → **title: "Play Integrity 通过后，Google Wallet 为什么仍绑卡失败"**。 [页面](https://mixtureofinsights.com/zh/blog/01-the-google-wallet-wall/)
- 读者问题：Why does Google Wallet fail when Play Integrity passes?
- 页面答案：两个流程的成功条件不能互相替代；以TapAndPay阶段定位
- 支撑证据：public Android attestation docs; reported private device logs
- 待确认：后台拒绝机制与修复经历未独立复验
- 章节名称调整：0 处，旧锚点兼容。

## 13. 02-stockmask

- EN：title: "StockMask: a stock illusion without touching a single app" → **title: "StockMask: caller-aware LineageOS feature filtering in system_server"**。 [页面](https://mixtureofinsights.com/blog/02-stockmask/)
- ZH：title: "StockMask：不碰 App，也能造一层原厂感" → **title: "StockMask：在 system_server 中按调用方过滤 LineageOS 特性"**。 [页面](https://mixtureofinsights.com/zh/blog/02-stockmask/)
- 读者问题：Where should caller-aware PackageManager filtering run?
- 页面答案：Binder响应侧过滤，版本相关入口需逐一检查
- 支撑证据：AOSP Binder/PMS; private StockMask provenance
- 待确认：私有源码公开断链撤下；appId阈值不是严格第三方包判定
- 章节名称调整：0 处，旧锚点兼容。

## 14. 03-the-logcat-leak

- EN：title: "The logcat leak" → **title: "Android READ_LOGS: auditing permission and SELinux context"**。 [页面](https://mixtureofinsights.com/blog/03-the-logcat-leak/)
- ZH：title: "十五个 App 正在读整台设备的日志" → **title: "Android READ_LOGS：同时检查权限与 SELinux 上下文"**。 [页面](https://mixtureofinsights.com/zh/blog/03-the-logcat-leak/)
- 读者问题：Why can su still read logcat after READ_LOGS is revoked?
- 页面答案：权限与SELinux域都属于有效访问条件
- 支撑证据：READ_LOGS docs; AOSP LogcatManagerService
- 待确认：15项授权及ROM自动授权机制待设备日志
- 章节名称调整：0 处，旧锚点兼容。

## 15. 04-auditing-from-the-apps-eyes

- EN：title: "Auditing from the app's eyes" → **title: "Android app-context audits: UID, SELinux and mount namespaces"**。 [页面](https://mixtureofinsights.com/blog/04-auditing-from-the-apps-eyes/)
- ZH：title: "别用 adb shell 代替 App 的眼睛" → **title: "Android 应用上下文审计：UID、SELinux 与挂载命名空间"**。 [页面](https://mixtureofinsights.com/zh/blog/04-auditing-from-the-apps-eyes/)
- 读者问题：How do I audit what an Android app can actually observe?
- 页面答案：分别验证UID、SELinux域、namespace和进程映射
- 支撑证据：nsenter docs; Android SELinux docs
- 待确认：命令执行域与完整进程身份不等价
- 章节名称调整：0 处，旧锚点兼容。

## 16. 05-what-you-can-and-cant-hide

- EN：title: "What you can and can't hide" → **title: "Rooted Android detection: userspace signals and attestation limits"**。 [页面](https://mixtureofinsights.com/blog/05-what-you-can-and-cant-hide/)
- ZH：title: "一台 root 手机能藏住什么" → **title: "Root Android 的检测面：用户态信号与硬件证明边界"**。 [页面](https://mixtureofinsights.com/zh/blog/05-what-you-can-and-cant-hide/)
- 读者问题：Which rooted Android signals are local and which involve attestation?
- 页面答案：分层列出检测通道与剩余边界
- 支撑证据：series mechanisms and Android key attestation docs
- 待确认：表格状态限于原环境；不承诺通用隐藏
- 章节名称调整：0 处，旧锚点兼容。

## 17. 06-paypal-crash-two-root-signals

- EN：title: "Debugging a PayPal startup crash: a device-number gap and an App Zygote errno" → **title: "PayPal startup crash: filesystem device numbers and App Zygote errno"**。 [页面](https://mixtureofinsights.com/blog/06-paypal-crash-two-root-signals/)
- ZH：title: "PayPal 闪退复盘：从一个设备号缺口追到 App Zygote 的 SELinux 错误码" → **title: "PayPal 启动闪退：文件系统设备号与 App Zygote 错误码"**。 [页面](https://mixtureofinsights.com/zh/blog/06-paypal-crash-two-root-signals/)
- 读者问题：How can App Zygote errno and st_dev affect an Android startup check?
- 页面答案：先分离输入信号，再进行上下文复现与组合验收
- 支撑证据：public patches, sanitized evidence, host test output
- 待确认：原始材料私有；不等于本轮重做实机实验
- 章节名称调整：0 处，旧锚点兼容。

## 18. nvim-yank-osc52

- EN：title: "Neovim: yank to the system clipboard (OSC 52)" → **title: "Neovim OSC 52: copy over SSH and WSL, paste from the terminal"**。 [页面](https://mixtureofinsights.com/blog/nvim-yank-osc52/)
- ZH：title: "Neovim：用 OSC 52 穿越终端剪贴板屏障" → **title: "Neovim OSC 52：通过 SSH、WSL 复制与终端粘贴"**。 [页面](https://mixtureofinsights.com/zh/blog/nvim-yank-osc52/)
- 读者问题：How do I copy from Neovim over SSH with OSC 52?
- 页面答案：终端输出写入剪贴板；粘贴与读取权限分开
- 支撑证据：Neovim PR25872 and provider documentation
- 待确认：终端/多路复用器版本相关；本轮未实测终端组合
- 章节名称调整：0 处，旧锚点兼容。

## 本轮核实与实质纠正

- ORBIT 引用固定到 `5bf86f0aa77a38bbaa7b196de513e9b2afe455a4`；TTS 固定到 `7ad76aad56301074ec689aac1d988d6461462916`。通过 GitHub 树验证引用路径，并读取关键实现；未运行训练或重新执行硬件基准。
- 原不存在的 `native_paged_kv.py` 引用定位到 `exporter.py` 的 `save_paged_kv_seed_talker_model`（2072–2113 行）。Subcode 缓存在帧内有界，不能称为完全无状态。
- StaticTraceVerifier 使用未折扣的势差，随后折扣回报；不能直接套用策略不变性保证。
- Bernoulli 方差在 p=0.5 最大，稀有成功涉及相对估计误差；不能用 p(1-p) 直接代表完整梯度方差。
- 自博弈 `score >= 0.5` 会保留零收益，不能写成严格只保留胜局；搜索预算也不能证明每步近最优。原示意图和代码保留并在正文解释。
- StockMask 的错误公开仓库链接移除，明确为私人源码，未假称公开可复现。

## 可核验性边界

这些修改不构成对全部技术结论的独立实验复现。12% 提升、吞吐/并发倍数、硬件性能与部分推导条件仍须作者原始记录；正文添加范围提示，待确认项保留在本表。公开链接是否存在与结论是否被实验支持分别记录。英文与中文保持相同事实边界，但未强行统一原有每个段落顺序。
