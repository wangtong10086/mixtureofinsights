# 编辑审计 · 2026-09-14

本文前半保留页面改版阶段的审计记录，其中“其余 32 份正文未完整阅读”是当时的范围。作者随后授权 HumanWriting 编辑全站文章，现已完整阅读全部 36 份正文；新增发现见文末[全站复读补充](#全站复读补充humanwriting)，文字修订与验证见 [HUMANWRITING_REVIEW.md](HUMANWRITING_REVIEW.md)。旧表中的“保留”“未修改”只描述第一阶段。

范围：完整阅读并局部编辑了 `post-training-is-a-data-problem`、`when-the-gpu-isnt-an-nvidia` 的中英文全文；完整阅读两个 About 页面、`docs/SOURCES.md`、两份编辑 Skill；浏览全部 36 份文章的 front-matter 摘要，并搜索正文中的绝对化表述。其余 32 份正文仅检查命中片段，未完成逐句或技术审核。

这份审计不判定下面的经历或成绩为假。源码出处能帮助定位实现，但不能替代实验记录、设备信息或作者确认。本轮未逐一访问外部源码及论文，因此没有把来源清单误称为已完成外部核验。

## 已实施的编辑

- 首页说明缩为作者与主题；系列说明改为实际涵盖的机制。取消重复精选、装饰图和所有系列目录在首页的展开。
- About 删除重复的写作宣言和格言，保留联系方式与已公开工作方向。英文原有内部 benchmark、蒸馏和硬件数字未改写，也未复制到中文版。
- 两个样本的摘要改为文章主题。正文仅合并重复开场、删去“战场”“dominates them”等修辞；没有补写经历、替换实验结果或修改代码、公式、标题、标题锚点、来源链接。
- 后训练开头仍保留作者对 loss/data 的强判断与调参经历。中文将“物理定律”这个修辞标签改为“判断”，技术断言本身保留并列入下表。
- 中文 TTS 保留原有“我们”和“我”的分工表达；没有把协作经历改为独立作者经历。

## 需要证据或范围说明的项目

路径均相对于仓库；`{en,zh}` 表示两个语言文件。

| 位置与原句/片段 | 类别与问题 | 已有出处 | 后续处理 | 本轮自动修改 |
| --- | --- | --- | --- | --- |
| `src/content/blog/en/post-training-is-a-data-problem.md` 开头：“loss function is mostly irrelevant”；中文：“完全由数据分布决定” | 技术范围。需要限定任务、训练设置和比较范围 | `docs/SOURCES.md` 的 ORBIT 训练配置条目 | 用实验或明确论证支持范围；不要仅用更温和的句子冒充技术修正 | 仅合并开场、去掉修辞标签；断言保留 |
| 同上 EN 末段：“zero engineering time”“90% of my compute and engineering budget”；ZH 末节的投入叙述 | 作者经历/预算。静态映射函数不能证明资源分配 | `build_ms_swift_dataset` 只能定位实现 | 作者提供统计时间段、成本口径、工作记录 | 否 |
| 同上两个语言拒绝采样段：成功率公式与 KL 偏移 | 推导假设。独立采样、概率是否固定、Top-1/过滤采样的分布定义需说清；两种语言的 KL 表达不同 | 文中 Llama 2 引用；未重新核验论文的具体支持范围 | 单独技术修订，核对定理条件和中英推导 | 否；公式逐字保护 |
| 同上良率段：`g=2`、四轮 `46%`，以及“验证器更严格”后成本下降 | 示例与测量。前者是所设模型下的计算，不是已验证迭代收益；需区分更严格筛选与提高生成通过率 | 文中 odds 模型与 `docs/SOURCES.md` | 标清例子、测量及因果条件；不能暗示严格过滤必然提高通过率 | 否 |
| `src/content/blog/zh/when-the-gpu-isnt-an-nvidia.md` 第 1 节：Ultra x7 358h、Redwood Cove / Crestmont、8 Xe、LPDDR5x-7467、119 GB/s | 硬件与配置。需要核对是否属于同一设备/处理器；理论带宽不是有效带宽 | `docs/SOURCES.md` 记录实现，未提供这台设备的完整规格证据 | 作者设备报告、Intel 对应 SKU 规格、内存配置与带宽测量；目前不填入猜测的替代型号 | 否 |
| 同上中英文开头/缺少组件段：“entire stack evaporates”（现为“this deployment stack is unavailable”）；“不提供任何服务层的中间件” | 版本与技术范围。需区分项目所用版本、OpenVINO Runtime、GenAI 和生态组件 | 原文 OpenVINO 项目链接、`docs/SOURCES.md` | 按实际版本逐项核实；不能把某次移植的约束推广至整个生态 | 只去掉比喻；实质断言保留 |
| 同上 EN RTF 段：“the only way”满足 83 ms；ZH 第 5 节“实际压测”稳定 RTF、降低噪音 | 性能与经历。必要性、并发规模、设备/模型/量化版本、RTF 分布和功耗噪音均缺测试条件 | runtime/profile 源码条目不能证明收益 | 补匿名测试设置及结果，不用新故事解释 | 否 |
| 同上 ZH 第 3/4 节：INT8 音质损失几乎不可闻、U8 后“腰斩” | 精度与比较口径。需分清 FP16/INT8 权重、FP16/U8 KV、质量评测与内存估算 | `online_batch.py`、权重压缩与图转换条目 | 核对对比基线、音质测评、实际缓存形状 | 否 |
| `src/pages/about.astro` Work 段；`{en,zh}/what-are-you-rewarding.md` 结尾；EN `cold-start-then-climb.md` | 内部成绩：“~12%”、Qwen 35B→4B、8×H200。需要区分相对提升与百分点、基线、数据集和时间 | `docs/SOURCES.md` 的训练/验证器条目 | 提供可公开的实验摘要；没有证据前保留原文、不扩大曝光 | 否；About 仅将 Lately 改为 Work，避免持续暗示近期状态 |
| `src/content/blog/zh/post-training-is-a-data-problem.md` 两个源码链接 | 链接目标可疑：指向本站仓库的 `main/src/orbit/...`，与 SOURCES 的独立 ORBIT 仓库不一致 | `docs/SOURCES.md` 的 `orbit/data/liveweb_teacher_gen.py`、`orbit/verifiers/static.py` | 实际查验源仓库 revision 后做独立链接修复；本轮保留来源锚点 | 否 |
| 两篇 TTS 样本及后训练样本的中英全文 | 双语范围不同：中文 TTS 有详细硬件章节，英文较短；后训练引用与推导也不同 | 四份全文已读 | 后续技术编辑单独对齐事实与限制，不用局部去修辞掩盖已有差异 | 仅新摘要对齐；未宣称全文等价 |

## 其余摘要的筛查结果

每组都查看了 en/zh 的 description；这里的“保留”不等于真实性验证。

| Slug（两种语言） | 摘要筛查与下一步 |
| --- | --- |
| `01-the-google-wallet-wall` | “proven, not guessed”和 Wallet 后端机制的确定性需要对应日志和平台资料，保留并待核验 |
| `02-stockmask` | 200 行与“不注入 App”需对应源码范围；去掉“原厂感”可作以后纯编辑，不改本轮正文 |
| `03-the-logcat-leak` | “fifteen”属于某次设备观察，需要保留时间/设备范围；摘要有戏剧式开场 |
| `04-auditing-from-the-apps-eyes` | UID/命名空间/SELinux 域等具体任务较清楚；优先保留 |
| `05-what-you-can-and-cant-hide` | “full map”“nothing”“能藏干净”过强；需核对涵盖范围 |
| `06-paypal-crash-two-root-signals` | 摘要较具体；`SOURCES.md` 列出了证据与限制，未复核私有证据或全文，保留 |
| `a-control-plane-for-renting-gpus` | “actual bottleneck”“Here is my bet”混合机制与修辞；以后可围绕控制面、执行面写摘要 |
| `orbit-a-task-agnostic-core` | “completely”“prevented ... breaking”可能暗示无条件隔离保证，需查边界与测试 |
| `orbit-the-bundle-is-the-contract` | “ensure exact”需要区分记录约定与保证；以后压缩机器消失的重复叙事 |
| `cold-start-then-climb` | EN“high-variance garbage”不增加信息；两种语言的任务难度/采样条件应明确 |
| `dpo-when-you-cant-afford-rlhf` | EN 比较收益没有口径；ZH OOC 踩坑叙事与 EN 摘要主题不完全相同，需先读完整两篇 |
| `self-play-and-the-games-models-teach-themselves` | EN“There's no dataset”范围过宽；明确是哪个任务的可用示范数据 |
| `what-are-you-rewarding` | EN +12% 待核验；双方均以强反转开场，可在后续全文阅读后删重复 |
| `how-qwen3-tts-makes-a-frame` | 图拆分对象清楚，可保留机制，后续查验图与缓存职责 |
| `paged-kv-batching-without-vllm` | “真正的胜负手”、EN 命令式短句主要是修辞；中文硬件/内存数字片段需和第 1 篇一起核验 |
| `nvim-yank-osc52` | ZH“没有外挂，只有…”可删的口号；OSC 52 是否可用仍依赖终端/SSH 环境设置，需阅读全文后编辑 |

没有逐篇重写这 32 份正文。后续可先核对后训练推导和 TTS 硬件/测量，再扩展编辑范围。阅读时长 front-matter 也保持原值，未重新估算。

## 全站复读补充（HumanWriting）

以下为完整阅读全部 18 对中英文文章后的新增疑问。检查依据是仓库中的文章、代码示例和 `docs/SOURCES.md`，没有把外部链接未核验的内容当作已证实事实。文字编辑可以去掉比喻，不能替这些问题作技术结论；涉及公式、测量与来源的修正应单独评审。

| 位置 | 待核验问题 | 需要的后续证据或处理 |
| --- | --- | --- |
| `01-the-google-wallet-wall`，中英文的 Wallet 请求和完整性结论 | 从 2.4 秒往返推断具体后端拒绝原因，以及 Strong Integrity、StrongBox 与解锁状态之间的关系，是否超出了本次观测？ | 对应设备/系统版本的日志，以及平台对相关判定的公开说明；区分观察、推断与通用约束。 |
| `02-stockmask` 中文，UID 筛选段 | 正文“appId 大于 10000”与示例中的 `>= 10000` 边界不一致。模块能覆盖哪些 App 查询路径也需要明确。 | 核对实际实现与 UID 边界后同时修正文句和示例；本轮保留代码。 |
| `03-the-logcat-leak`、`04-auditing-from-the-apps-eyes`、`05-what-you-can-and-cant-hide` | 日志授权、SELinux 域和检测面的结论依赖具体系统及应用环境。15 个 App 是一次观察，不能作为普遍数量；覆盖面也不能仅由一套探针推出。 | 附设备/ROM、Android 版本及探针运行条件；区分框架返回、内核状态和测试覆盖。 |
| `06-paypal-crash-two-root-signals`，复现及结果段 | 现有 SOURCES 已明确限制：历史触发因素未知、黑屏机制未知、`0x122` 为静态推导、Magisk-only SELinux 未捕获、离线复现不等于整机 A/B/A。 | 保留这些限制；若扩展结论，应补实机多轮冷启动及缺失对照。iFAST 只观察到后续开发者选项提示，不能据此写成后续功能、支付或服务端验证全部通过。本轮没有访问私有调试记录。 |
| ORBIT 三篇，重试、插件隔离与产物清单段 | 清单与固定配置是否足以保证精确重现？局部 import 是否消除所有副作用？“没有任何 if”及所有修改限于单一插件的说法需和实际边界对应。 | 检查固定 revision 的代码与隔离测试；列出随机性、外部依赖和故障恢复的条件。 |
| `cold-start-then-climb`，稀疏奖励与方差推导 | 文中 `p(1-p)`、稀有成功下的高方差叙述和“9999”噪声描述需要区分绝对方差、相对误差及梯度估计；8 次采样和任务覆盖的结论缺任务条件。Dr. GRPO 的长度偏置与组内标准差解释也需核对。 | 重新检查推导的变量定义、采样假设和所引论文；本轮未修改公式或把这些叙述改成相反结论。 |
| `what-are-you-rewarding`，potential shaping、验证器及成绩段 | `phi_next - phi` 与折扣因子的关系、策略不变性的条件未交代完整；验证器“无法被利用”等表述的适用范围不明。约 12% 提升仍缺比较口径。 | 核对塑形公式的任务假设；提供验证器覆盖/反例，以及基线、样本和指标。 |
| `dpo-when-you-cant-afford-rlhf`，DPO/RLHF 比较 | 比较结果、成本与“不需要在线探索”的判断属于特定项目；两种语言叙事内容并不完全一致。 | 提供训练设置和比较口径；技术对齐时不要仅把中文故事复制到英文。 |
| `self-play-and-the-games-models-teach-themselves`，轨迹筛选和种群段 | 代码的 `score < 0.5` 过滤会留下边界 0.5，和“只保留胜局”的文字需要核对。300 次模拟及 5-roll 的近最优判断缺定义；SOURCES 对长运行闭环的公开实现范围也需要与正文对齐。 | 检查游戏计分、平局处理、搜索基准和已公开实现；保留示例以供独立修订。 |
| `when-the-gpu-isnt-an-nvidia`、`paged-kv-batching-without-vllm` | 设备规格疑问延续前表。OpenVINO 服务组件与 PagedAttention 的可用性依赖版本；量化质量、2 倍吞吐、3 倍并发、纳秒/微秒级时延及尾延迟保证缺测量条件。 | 核实设备与依赖版本、缓存形状及对比基线；分别提供质量评测、吞吐分布和时延分位数。 |
| `how-qwen3-tts-makes-a-frame`，Talker/Subcode 与复杂度段 | 单步注意力成本、累计成本和 KV 缓存收益混用；“stateless”与 cached Subcode 的缓存范围需要说明。TTFT、TTFA、首音频分块也不能不加定义地互换。 | 对照导出图、缓存生命周期与性能采样点，分别说明时间和内存复杂度。 |
| `nvim-yank-osc52`，终端兼容性段 | “任意容器/SSH 环境”及 Windows Terminal 读取剪贴板支持的陈述受终端版本、multiplexer 与配置限制。 | 在版本明确的终端组合上测试写入和读取；保留两者权限方向的区别。 |
| ORBIT/后训练中文文章的源码引用 | 不只最初两处，多个链接指向本站仓库 `mixtureofinsights/blob/main/src/orbit/...`，而 SOURCES 指向独立 ORBIT 仓库。 | 逐一确认文件和 revision 后独立修复；本轮没有猜测链接目标或更换来源锚点。 |

前一阶段记录的内部成绩、训练预算、拒绝采样推导、硬件规格和双语范围问题仍未解决。此处完整阅读和发现疑点，不等同于完成事实审查。

## 2026-09-15 SEO review follow-up

The bilingual source review and unresolved experimental claims are tracked in `SEO_CONTENT_REVIEW.md`. Broken public repository paths are corrected and pinned to inspected commits. The TTS cached Subcode claim, undiscounted potential shaping, Bernoulli variance explanation and self-play filtering threshold are corrected in prose. Original code/math/diagrams remain protected; qualifications distinguish their actual scope. Private Android code is no longer represented as publicly accessible.
