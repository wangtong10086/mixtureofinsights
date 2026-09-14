export const languages = { en: 'EN', zh: '中文' } as const;
export type Lang = keyof typeof languages;
export const defaultLang: Lang = 'en';

export const ui = {
  en: {
    'nav.writing': 'Writing',
    'nav.about': 'About',
    'nav.archive': 'Archive',
    'nav.label': 'Main navigation',
    'nav.skip': 'Skip to content',
    'theme.dark': 'Switch to dark theme',
    'theme.light': 'Switch to light theme',
    'home.title': 'Technical notes',
    'home.recent': 'Recent writing',
    'home.all': 'All writing',
    'posts.count': 'articles',
    'archive.desc': 'All articles, by year.',
    'series.contents': 'In this series',
    'hero.title': 'Mixture of Insights.',
    'hero.desc':
      'Technical notes by Wang Tong on post-training, agents, inference, and systems debugging.',
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
    'nav.archive': '归档',
    'nav.label': '主导航',
    'nav.skip': '跳转到正文',
    'theme.dark': '切换为深色主题',
    'theme.light': '切换为浅色主题',
    'home.title': '技术笔记',
    'home.recent': '最近文章',
    'home.all': '查看全部文章',
    'posts.count': '篇文章',
    'archive.desc': '按年份排列的全部文章。',
    'series.contents': '本系列文章',
    'hero.title': 'Mixture of Insights.',
    'hero.desc':
      '王通的技术笔记，记录后训练、Agent、推理部署和系统排查。',
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

export function localUrl(lang: Lang, path: string) {
  return lang === 'zh' ? `/zh${path}` : path;
}
export function seriesUrl(lang: Lang, key: string) {
  return localUrl(lang, `/series/${key}/`);
}

/** series registry — key -> { order on homepage, localized display name, one-line blurb } */
export const series: Record<string, { order: number; en: string; zh: string; blurbEn?: string; blurbZh?: string }> = {
  'post-training': {
    order: 1,
    en: 'Post-Training in Practice',
    zh: '后训练实战',
    blurbEn: 'Data generation, verifiers, GRPO, DPO, and self-play in ORBIT.',
    blurbZh: 'ORBIT 中的数据生成、验证器、GRPO、DPO 与自我博弈。',
  },
  'orbit': {
    order: 2,
    en: 'ORBIT: remote GPU runs',
    zh: 'ORBIT：远程 GPU 运行',
    blurbEn: 'The control plane, task plugins, and run bundles for training on rented GPUs.',
    blurbZh: '在租用的 GPU 上运行训练：控制面、任务插件与运行产物。',
  },
  'openvino-tts': {
    order: 3,
    en: 'TTS on OpenVINO',
    zh: '把 TTS 模型搬上 OpenVINO',
    blurbEn: 'Qwen3-TTS graph export, KV caches, and streaming batch scheduling on Intel hardware.',
    blurbZh: 'Qwen3-TTS 在 Intel 硬件上的计算图导出、KV 缓存与流式批处理调度。',
  },
  'agents': {
    order: 4,
    en: 'Agents and evaluation',
    zh: 'Agent 与评测',
    blurbEn: 'Evaluation harnesses and trajectories for browser and software-engineering agents.',
    blurbZh: '浏览器与软件工程 Agent 的评测框架和任务轨迹。',
  },
  'android-hardening': {
    order: 5,
    en: 'Android system debugging',
    zh: 'Android 系统排查',
    blurbEn: 'App detection of modified Android systems: packages, permissions, logs, attestation, and startup failures.',
    blurbZh: '应用如何检测修改过的 Android 系统：包名、权限、日志、硬件证明与启动故障。',
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
