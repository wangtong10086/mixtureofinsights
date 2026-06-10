import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { langOf, slugOf } from '../i18n';

export async function GET(context) {
  const posts = (await getCollection('blog'))
    .filter((p) => langOf(p.id) === 'en')
    .sort((a, b) => +b.data.date - +a.data.date);
  return rss({
    title: 'Mixture of Insights',
    description: 'Notes on LLM post-training, RL, agents, and the systems underneath, by Wang Tong.',
    site: context.site,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: `/blog/${slugOf(p.id)}/`,
    })),
  });
}
