import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export function snapshot() {
  return Object.fromEntries(['en', 'zh'].flatMap((lang) =>
    readdirSync(`src/content/blog/${lang}`).filter((file) => file.endsWith('.md')).sort().map((file) => {
      const text = readFileSync(`src/content/blog/${lang}/${file}`, 'utf8').replace(/\r\n/g, '\n');
      const front = text.split('---')[1];
      const body = text.slice(text.indexOf('---', 3) + 3);
      return [`${lang}/${file}`, {
        route: `${lang === 'zh' ? '/zh' : ''}/blog/${file.slice(0, -3)}/`,
        identity: ['title', 'date', 'order', 'series', 'reading', 'tags'].map((key) => front.match(new RegExp(`^${key}:.*$`, 'm'))?.[0] ?? ''),
        code: hash(JSON.stringify(body.match(/```[\s\S]*?```/g) ?? [])),
        math: hash(JSON.stringify(body.match(/\$\$[\s\S]*?\$\$|(?<!\$)\$(?!\$)[^\n$]+\$/g) ?? [])),
        headings: body.match(/^#{1,6} .+$/gm) ?? [],
        links: body.match(/\]\([^\s)]+|(?:href|src)="[^"]+"/g) ?? [],
        figures: hash(JSON.stringify(body.match(/<svg[\s\S]*?<\/svg>/g) ?? [])),
        body: hash(body),
      }];
    })
  ));
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(snapshot(), null, 2) + '\n');
