import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(p, 'utf8');
const site = 'https://mixtureofinsights.com';
const manifest = JSON.parse(read('dist/seo-manifest.json'));
const directory = read('dist/llms.txt');
const redirects = read('dist/_redirects').trim().split('\n');
const sitemap = read('dist/sitemap-0.xml');
let articles = 0;
for (const url of Object.keys(manifest.pages)) {
  const route = new URL(url).pathname;
  const html = read('dist' + route + 'index.html');
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(m => JSON.parse(m[1]));
  assert.ok(blocks.length, `${route}: missing JSON-LD`);
  const entity = blocks[0];
  if (route.includes('/blog/')) {
    articles++;
    assert.equal(entity['@type'], 'BlogPosting');
    assert.equal(entity.mainEntityOfPage, url);
    assert.equal(entity.author['@id'], site + '/about/#person');
    const about = route.startsWith('/zh/') ? '/zh/about/' : '/about/';
    assert.ok(html.includes(`rel="author" href="${about}"`));
    assert.equal(entity.author.url, site + about);
    assert.ok(directory.includes(url), `${route}: directory missing`);
    const modified = entity.dateModified ?? entity.datePublished;
    assert.ok(sitemap.includes(`<loc>${url}</loc><lastmod>${modified}</lastmod>`), `${route}: lastmod drift`);
    if (entity.dateModified) {
      assert.ok(Date.parse(entity.dateModified) >= Date.parse(entity.datePublished));
      assert.ok(html.includes(`datetime="${entity.dateModified.slice(0,10)}"`));
    }
  }
  if (route.endsWith('/about/')) {
    assert.equal(entity['@type'], 'ProfilePage');
    assert.equal(entity.mainEntity['@type'], 'Person');
    assert.equal(entity.mainEntity['@id'], site + '/about/#person');
  }
  if (route.includes('/blog/') || route.includes('/series/')) {
    const crumbs = blocks.find(b => b['@type'] === 'BreadcrumbList');
    assert.ok(crumbs && html.includes('class="wrap breadcrumbs"'));
    assert.equal(crumbs.itemListElement.at(-1).item, url);
    crumbs.itemListElement.forEach((b,i) => {
      assert.equal(b.position, i+1);
      assert.ok(manifest.pages[b.item]);
    });
  }
  if (!route.startsWith('/zh/')) {
    const legacy = '/en' + (route === '/' ? '' : route.slice(0,-1));
    assert.ok(redirects.includes(`${legacy} ${route} 301`));
    assert.ok(redirects.includes(`${legacy}/ ${route} 301`));
  }
}
assert.equal(articles,36);
assert.ok(!directory.includes(site+'/en/'));
assert.ok(!redirects.some(r => r.includes('*')));
for (const match of sitemap.matchAll(/<loc>(.*?)<\/loc>/g)) assert.ok(manifest.pages[match[1]], `non-blog URL in sitemap: ${match[1]}`);
console.log('PASS: 36 article schemas/dates/directory entries, author profiles, breadcrumbs and exact legacy redirects.');
