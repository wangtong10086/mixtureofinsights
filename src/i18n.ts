export const languages = { en: 'EN', zh: '中文' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

export const ui = {
  en: {
    'nav.writing': 'Writing',
    'nav.about': 'About',
    'hero.title': 'Mixture of Insights.',
    'hero.desc':
      'A long-running notebook about building and taking systems apart: models, tools, infrastructure, failures, and the judgment behind technical work.',
    'section.series': 'Series',
    'section.notes': 'Notes',
    'section.notesSub': 'Standalone',
    'post.contents': 'Contents',
    'post.comments': 'Comments',
    'post.prev': '← Previous in series',
    'post.next': 'Next in series →',
    'post.coverAlt': 'Cover illustration for',
    'footer.tagline': 'Field notes from the layers underneath · built with Astro on Cloudflare',
  },
  zh: {
    'nav.writing': '文章',
    'nav.about': '关于',
    'hero.title': 'Mixture of Insights.',
    'hero.desc':
      '这里会长期记录我拆解系统、训练模型、打磨工具时留下的笔记：从一行日志到一次架构取舍，从工程细节到人的判断。写给未来的自己，也写给同样愿意把问题追到底的人。',
    'section.series': '系列',
    'section.notes': '笔记',
    'section.notesSub': '独立文章',
    'post.contents': '目录',
    'post.comments': '评论',
    'post.prev': '← 上一篇',
    'post.next': '下一篇 →',
    'post.coverAlt': '封面插图：',
    'footer.tagline': '来自底层的实战笔记 · 由 Astro 构建、托管于 Cloudflare',
  },
} as const;

export function t(lang: Lang) {
  return (key: keyof (typeof ui)['en']) => ui[lang][key] ?? ui.en[key];
}

/** strip "en/" or "zh/" prefix from a content id -> slug */
export function slugOf(id: string) {
  return id.replace(/^(en|zh)\//, '');
}
export function langOf(id: string): Lang {
  return id.startsWith('zh/') ? 'zh' : 'en';
}
/** localized blog post URL */
export function postUrl(lang: Lang, slug: string) {
  return lang === 'zh' ? `/zh/blog/${slug}/` : `/blog/${slug}/`;
}

/** series registry — key -> { order on homepage, localized display name, one-line blurb } */
export const series: Record<string, { order: number; en: string; zh: string; blurbEn?: string; blurbZh?: string }> = {
  'post-training': {
    order: 1,
    en: 'Post-Training in Practice',
    zh: '后训练实战',
    blurbEn: 'From data engines to GRPO, reward hacking, DPO and self-play — the math for why each method works, and why the data usually outweighs the optimizer.',
    blurbZh: '后训练不只是换一个优化器。这里写数据怎么长出来、奖励怎么骗人、RL 什么时候值得上，以及模型到底学到了什么。',
  },
  'orbit': {
    order: 2,
    en: 'ORBIT — orchestrating training on rented GPUs',
    zh: 'ORBIT —— 在租来的 GPU 上编排训练',
    blurbEn: 'Make a training run a reproducible artifact, not a shell session: a declarative control plane reconciled against a disposable execution plane.',
    blurbZh: '租来的机器会消失，训练留下的东西不能消失。这个系列写一次运行怎样从 shell 会话变成可复现的工件。',
  },
  'openvino-tts': {
    order: 3,
    en: 'Shipping a TTS model on OpenVINO',
    zh: '把 TTS 模型搬上 OpenVINO',
    blurbEn: 'Rebuilding the CUDA serving stack — paged-KV, a quantized cache, continuous batching — on an Intel iGPU, derived from the bandwidth math up.',
    blurbZh: '离开 CUDA 以后，很多平时理所当然的东西都要重新做一遍：缓存、批处理、带宽账，还有第一帧声音。',
  },
  'agents': {
    order: 4,
    en: 'Agents that touch the real world',
    zh: '会碰真实世界的 Agent',
    blurbEn: 'Eval harnesses, browser and software-engineering trajectories — what it takes to make an agent act on the world and know whether it worked.',
    blurbZh: '评测框架、浏览器与软件工程轨迹 —— 让一个 Agent 真去作用于世界,并知道它是否成功,需要什么。',
  },
  'android-hardening': {
    order: 5,
    en: 'Hardening a rooted Android device against app detection',
    zh: '一台 root 手机能藏住什么',
    blurbEn: 'How a non-privileged app detects a rooted custom ROM, channel by channel — and the two walls (verified boot, hardware attestation) that userspace cannot move.',
    blurbZh: '从包名、系统特性、日志到硬件证明，一条通道一条通道地看：哪些能藏，哪些最好早点承认撞墙。',
  },
};
export function seriesName(key: string | undefined, lang: Lang): string | undefined {
  if (!key) return undefined;
  return series[key]?.[lang] ?? key;
}
export function seriesBlurb(key: string | undefined, lang: Lang): string | undefined {
  if (!key) return undefined;
  return lang === 'zh' ? series[key]?.blurbZh : series[key]?.blurbEn;
}
export function seriesOrder(key: string): number {
  return series[key]?.order ?? 99;
}
/** ordered list of series keys present in a set of posts */
export function seriesKeys(posts: { data: { series?: string } }[]): string[] {
  const keys = [...new Set(posts.map((p) => p.data.series).filter(Boolean) as string[])];
  return keys.sort((a, b) => seriesOrder(a) - seriesOrder(b));
}
