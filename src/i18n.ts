export const languages = { en: 'EN', zh: '中文' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

export const ui = {
  en: {
    'nav.writing': 'Writing',
    'nav.about': 'About',
    'hero.title': 'A mixture of insights.',
    'hero.desc':
      'Notes from an LLM post-training & agent engineer — alignment, RL and reward modeling by day; a standing habit of taking systems apart until I know exactly why they behave the way they do.',
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
    'hero.title': '洞见的混合。',
    'hero.desc':
      '一名大模型后训练与 Agent 算法工程师的笔记 —— 白天做对齐、强化学习与奖励建模；业余习惯把系统拆到底，直到弄清它为何如此运作。',
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

/** series registry — key -> { order on homepage, localized display name } */
export const series: Record<string, { order: number; en: string; zh: string }> = {
  'post-training': { order: 1, en: 'Post-Training in Practice', zh: '后训练实战' },
  'orbit': { order: 2, en: 'ORBIT — orchestrating training on rented GPUs', zh: 'ORBIT —— 在租来的 GPU 上编排训练' },
  'openvino-tts': { order: 3, en: 'Shipping a TTS model on OpenVINO', zh: '把 TTS 模型搬上 OpenVINO' },
  'agents': { order: 4, en: 'Agents that touch the real world', zh: '会碰真实世界的 Agent' },
  'android-hardening': { order: 5, en: 'Hardening a rooted Android device against app detection', zh: '对抗 App 检测:加固一台 root 的安卓设备' },
};
export function seriesName(key: string | undefined, lang: Lang): string | undefined {
  if (!key) return undefined;
  return series[key]?.[lang] ?? key;
}
export function seriesOrder(key: string): number {
  return series[key]?.order ?? 99;
}
/** ordered list of series keys present in a set of posts */
export function seriesKeys(posts: { data: { series?: string } }[]): string[] {
  const keys = [...new Set(posts.map((p) => p.data.series).filter(Boolean) as string[])];
  return keys.sort((a, b) => seriesOrder(a) - seriesOrder(b));
}
