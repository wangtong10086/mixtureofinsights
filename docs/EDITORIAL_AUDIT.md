# 编辑审计 · 2026-09-14

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
