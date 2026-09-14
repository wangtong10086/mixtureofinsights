import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { postsFor } from './posts';
import { postUrl, slugOf, type Lang } from '../i18n';

export async function feed(context: APIContext, lang: Lang) {
  const posts = await postsFor(lang);
  return rss({
    title: lang === 'zh' ? 'Mixture of Insights · 中文' : 'Mixture of Insights',
    description: lang === 'zh'
      ? '王通的技术笔记：后训练、Agent、推理部署和系统排查。'
      : 'Technical notes by Wang Tong on post-training, agents, inference, and systems debugging.',
    site: context.site!,
    customData: `<language>${lang === 'zh' ? 'zh-CN' : 'en'}</language>`,
    items: posts.map((p) => ({
      title: p.data.title, description: p.data.description, pubDate: p.data.date,
      link: postUrl(lang, slugOf(p.id)),
    })),
  });
}
