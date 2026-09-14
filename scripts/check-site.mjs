import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot } from './content-snapshot.mjs';

const read = (file) => readFileSync(file, 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/\s([\w:-]+)=(?:"([^"]*)"|'([^']*)')/g)]
  .map((m) => [m[1], decode(m[2] ?? m[3])]));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrs(m[0]));
const site = 'https://mixtureofinsights.com';
const files = walk('dist').filter((file) => file.endsWith('.html'));
const routeFile = (path) => {
  const local = decodeURIComponent(path).replace(/^\//, '');
  return path.endsWith('/') || !/\.[^/]+$/.test(path) ? join('dist', local, 'index.html') : join('dist', local);
};
const pages = new Map(files.map((file) => ['/' + file.replaceAll('\\', '/').replace(/^dist\//, '').replace(/index\.html$/, ''), read(file)]));
const current = snapshot();
const baseline = JSON.parse(read('scripts/fixtures/content-baseline.json'));
// The author's 2026-09-14 follow-up extends prose editing to all 18 bilingual posts.
// The original baseline still protects identity, code, math, headings and sources.
const editableSlugs = [
  '01-the-google-wallet-wall', '02-stockmask', '03-the-logcat-leak',
  '04-auditing-from-the-apps-eyes', '05-what-you-can-and-cant-hide',
  '06-paypal-crash-two-root-signals', 'a-control-plane-for-renting-gpus',
  'orbit-a-task-agnostic-core', 'orbit-the-bundle-is-the-contract',
  'post-training-is-a-data-problem', 'cold-start-then-climb', 'what-are-you-rewarding',
  'dpo-when-you-cant-afford-rlhf', 'self-play-and-the-games-models-teach-themselves',
  'when-the-gpu-isnt-an-nvidia', 'how-qwen3-tts-makes-a-frame',
  'paged-kv-batching-without-vllm', 'nvim-yank-osc52',
];
const editable = new Set(['en', 'zh'].flatMap((lang) => editableSlugs.map((s) => `${lang}/${s}.md`)));
for (const id of Object.keys(baseline)) assert.ok(current[id], `Missing original article ${id}`);
for (const [id, before] of Object.entries(baseline)) {
  const after = current[id];
  for (const field of ['route', 'identity', 'code', 'math', 'headings', 'links', 'figures']) {
    assert.deepEqual(after[field], before[field], `${id}: protected ${field} changed`);
  }
  if (!editable.has(id)) assert.equal(after.body, before.body, `${id}: outside the prose-edit scope`);
  assert.ok(pages.has(before.route), `Missing old route ${before.route}`);
}

let internalLinks = 0;
for (const [route, html] of pages) {
  assert.equal(tags(html, 'h1').length, 1, `${route}: expected one h1`);
  const linkTags = tags(html, 'link');
  assert.equal(linkTags.find((a) => a.rel === 'canonical')?.href, site + route, `${route}: canonical`);
  for (const link of linkTags.filter((a) => a.hreflang)) {
    const url = new URL(link.href);
    assert.equal(url.origin, site);
    assert.ok(existsSync(routeFile(url.pathname)), `${route}: missing translation ${url.pathname}`);
  }
  const locale = route.startsWith('/zh/') ? 'zh' : 'en';
  assert.equal(linkTags.find((a) => a.type === 'application/rss+xml')?.href, locale === 'zh' ? '/zh/rss.xml' : '/rss.xml');
  assert.ok(tags(html, 'a').some((a) => a.href === '#main-content'), `${route}: skip link`);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  if (route.includes('/blog/')) {
    assert.ok(html.includes("'data-mapping': 'pathname'"), `${route}: giscus mapping`);
    assert.ok(html.includes("'data-repo': 'wangtong10086/mixtureofinsights-comments'"));
    assert.ok(!tags(main, 'img').some((a) => a.class === 'cover'), `${route}: unexpected cover`);
    assert.ok(!/<details\b[^>]*\bopen\b/.test(main), `${route}: TOC should start collapsed`);
    const data = Object.values(current).find((p) => p.route === route);
    const date = data.identity.find((s) => s.startsWith('date:')).slice(6);
    assert.equal(tags(html, 'meta').find((a) => a.property === 'article:published_time')?.content, new Date(date).toISOString());
  } else if (!route.includes('/about/')) {
    assert.equal(tags(main, 'img').length, 0, `${route}: decorative index image`);
  }
  for (const tag of [...tags(html, 'a'), ...linkTags, ...tags(html, 'img'), ...tags(html, 'script')]) {
    const href = tag.href ?? tag.src;
    if (!href || /^(mailto:|tel:|data:|javascript:)/.test(href)) continue;
    const url = new URL(href, site + route);
    if (url.origin !== site) continue;
    const target = routeFile(url.pathname);
    assert.ok(existsSync(target), `${route}: broken internal target ${href}`);
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      const targetHtml = read(target);
      const ids = [...targetHtml.matchAll(/\sid="([^"]*)"/g)].map((m) => decode(m[1]));
      assert.ok(ids.includes(id), `${route}: missing anchor ${href}`);
    }
    internalLinks++;
  }
}

for (const lang of ['en', 'zh']) {
  const prefix = lang === 'zh' ? '/zh' : '';
  const entries = Object.entries(current).filter(([id]) => id.startsWith(lang + '/')).map(([id, data]) => ({ id, ...data }));
  const dateOf = (p) => p.identity.find((s) => s.startsWith('date:')).slice(6);
  const expectedRecent = [...entries].sort((a, b) => +new Date(dateOf(b)) - +new Date(dateOf(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 6).map((p) => p.route);
  const articleLinks = (html) => tags(html, 'a').filter((a) => a.href.startsWith(prefix + '/blog/')).map((a) => a.href);
  assert.deepEqual(articleLinks(pages.get(prefix + '/')), expectedRecent, `${lang}: recent order and duplicates`);
  assert.deepEqual(articleLinks(pages.get(prefix + '/archive/')).sort(), entries.map((p) => p.route).sort(), `${lang}: complete archive`);
  const groups = new Map();
  for (const p of entries) {
    const key = p.identity.find((s) => s.startsWith('series:'))?.split('"')[1];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, posts] of groups) {
    const orderOf = (p) => Number(p.identity.find((s) => s.startsWith('order:')).slice(7));
    posts.sort((a, b) => orderOf(a) - orderOf(b) || (a.id < b.id ? -1 : 1));
    assert.deepEqual(articleLinks(pages.get(`${prefix}/series/${key}/`)), posts.map((p) => p.route));
    for (const [index, post] of posts.entries()) {
      const nav = pages.get(post.route).match(/<nav class="post-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
      assert.deepEqual(articleLinks(nav), [posts[index - 1], posts[index + 1]].filter(Boolean).map((p) => p.route), `${post.route}: series navigation`);
    }
  }
  const feed = read(`dist${prefix}/rss.xml`);
  const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  assert.equal(items.length, entries.length, `${lang}: RSS count`);
  const feedPaths = items.map((item) => new URL(decode(item.match(/<link>(.*?)<\/link>/)[1])).pathname);
  assert.deepEqual(feedPaths.slice(0, 6), expectedRecent, `${lang}: RSS order`);
}
const sitemap = walk('dist').filter((file) => /sitemap-\d+\.xml$/.test(file)).map(read).join('');
for (const route of pages.keys()) assert.ok(sitemap.includes(`<loc>${site}${route}</loc>`), `${route}: sitemap missing`);
console.log(`PASS: ${Object.keys(current).length} protected article identities; ${pages.size} pages; ${internalLinks} internal references; bilingual archives, series, feeds, metadata and navigation.`);
