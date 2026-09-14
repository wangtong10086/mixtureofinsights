import { getCollection, type CollectionEntry } from 'astro:content';
import { langOf, slugOf, seriesKeys, type Lang } from '../i18n';

export type Post = CollectionEntry<'blog'>;
export const compareSlug = (a: Post, b: Post) =>
  slugOf(a.id) < slugOf(b.id) ? -1 : slugOf(a.id) > slugOf(b.id) ? 1 : 0;
export const byDate = (a: Post, b: Post) => +b.data.date - +a.data.date || compareSlug(a, b);
export const byOrder = (a: Post, b: Post) => a.data.order - b.data.order || compareSlug(a, b);
export async function postsFor(lang: Lang) {
  return (await getCollection('blog')).filter((p) => langOf(p.id) === lang).sort(byDate);
}
export function formatDate(date: Date, lang: Lang, month: 'short' | 'long' = 'short') {
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month, day: 'numeric', timeZone: 'UTC',
  }).format(date);
}
export function groupsFor(posts: Post[]) {
  return seriesKeys(posts).map((key) => ({
    key, posts: posts.filter((p) => p.data.series === key).sort(byOrder),
  }));
}
export async function seriesPaths(lang: Lang) {
  const all = await getCollection('blog');
  const other: Lang = lang === 'en' ? 'zh' : 'en';
  return groupsFor(all.filter((p) => langOf(p.id) === lang)).map((group) => ({
    params: { series: group.key },
    props: { seriesKey: group.key, posts: group.posts,
      hasTranslation: all.some((p) => langOf(p.id) === other && p.data.series === group.key) },
  }));
}

