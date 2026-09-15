# Mixture of Insights

Source for **[mixtureofinsights.com](https://mixtureofinsights.com)** — a bilingual
(English / 中文) technical blog by **Wang Tong (王通)**, an LLM post-training & agent
algorithm engineer. It is a project-grounded technical blog about post-training and
RL, agent data and evaluation, remote GPU orchestration, inference serving, and the
low-level systems work underneath.

The name is a small joke on **Mixture of Experts** — notes routed to whatever hard
system currently has my attention. The site should read like a serious technical
blog, not a resume: strong articles first, with investigation trails, code anchors,
failure modes, and engineering trade-offs used as part of the writing rather than
as overt self-promotion.

## Stack

- **[Astro 5](https://astro.build)** — static site, content collections, built-in i18n
- **Cloudflare Workers** (static assets) — hosting, custom domain, Web Analytics
- **Shiki** code highlighting · inline hand-drawn **SVG diagrams**
- **AI cover images** generated with **Cloudflare Workers AI** (`flux-1-schnell`)
- **giscus** comments (GitHub Discussions) · **IndexNow** + JSON-LD/OG for SEO

## Layout

```
src/
  content/blog/{en,zh}/   posts — one folder per language, slug-matched across both
  components/             Home, Post, Comments (shared, locale-aware)
  layouts/Base.astro      <head>, header/footer, theme toggle, analytics, JSON-LD
  pages/                  / (en) and /zh/ (zh): home, about, blog/[...slug], rss
  i18n.ts                 UI strings, the series registry, lang/slug/url helpers
  styles/global.css       the "paper" theme (light + dark)
public/og/                per-post cover images (1024² JPEG)
scripts/gen-covers.py     regenerate covers via Workers AI
astro.config.mjs · wrangler.jsonc
```

Posts are grouped into ordered **series** (defined in `src/i18n.ts`); each post is a
Markdown file in both `en/` and `zh/` sharing a slug. Front-matter: `title`,
`description`, `date`, `order`, `series`, `reading`, `tags`.

> **中文 front-matter gotcha:** a `"..."` YAML string can't contain a straight
> double-quote — use 「」 instead, or js-yaml will fail the build.

## Sources & provenance

The posts are grounded in real source code, not paraphrased docs. See
[`docs/SOURCES.md`](docs/SOURCES.md) for the mapping of each series to the repository, code
anchors (files/symbols), and external references it's written against — plus the secrets policy
for the Android series. Keep it in sync when editing a post's technical content.

## Develop

Use Node 22. The editorial redesign adds locale-aware archive and series pages,
with recent posts on the homepage. Reading dates use UTC; existing article URLs
and OG images are preserved. Set optional front-matter `showCover: true` only when
a cover contributes to an article; the default is to keep it out of the reading page.

```bash
npm ci
npm run check       # Astro / TypeScript diagnostics
npm run dev          # http://localhost:4321
npm run build        # -> dist/
npm test             # built routes, feeds, metadata and protected content
```

See [the validation report](docs/REDESIGN_VALIDATION.md) for browser coverage,
screenshots, Windows CLI notes and remaining checks, and
[the editorial audit](docs/EDITORIAL_AUDIT.md) for claims needing source evidence.
The subsequent [HumanWriting review](docs/HUMANWRITING_REVIEW.md) covers prose edits
to all 18 articles in both languages and the checks run for that revision.

## Deploy (Cloudflare Workers)

Cloudflare credentials live outside this repo, in a local `.env` (never committed):

```bash
set -a; . /path/to/.env; set +a
export CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ID"
npm run build
npx wrangler deploy
```

## Covers

```bash
set -a; . /path/to/.env; set +a   # needs CLOUDFLARE_ID + CLOUDFLARE_API_TOKEN
python3 scripts/gen-covers.py     # writes public/og/<slug>.jpg
```

---

© Wang Tong · content licensed for reading; ask before reuse.
[GitHub](https://github.com/wangtong10086) ·
[LinkedIn](https://www.linkedin.com/in/%E9%80%9A-%E7%8E%8B-190ba329a/)
## SEO/GEO maintenance (2026-09-15)

- Build generates `llms.txt`, explicit redirects, sitemap modification dates and `seo-manifest.json` from the same content collection. Do not hand-edit generated files.
- Use `updatedAt` only for a substantive revision on a known date. Publication dates and stable URLs remain unchanged. Titles/descriptions are shared by visible pages and metadata.
- Run `npm run check`, `npm run build`, then `npm test` (Node 22). The original content baseline protects code, math, identity and sources; reviewed migrations in `scripts/fixtures/seo-*-migrations.json` narrowly document intentional title, source and section changes.
- The deploy workflow snapshots live page hashes, deploys, waits for the matching manifest, and submits only changed/added/removed URLs to IndexNow. A notification failure does not roll back an already successful deployment. Inspect the saved before/after manifests and receipt; retry only after verifying the deployed manifest.
- Cloudflare zone rule `3a7f7befd6e2408dbc13afbf336ba675` in ruleset `103d86ca7fcc42f38d83dbf648a73254` permanently redirects only the blog `www` host to the apex, preserving path/query. Disable that rule to undo it; other subdomains are unaffected.
- Review source limitations in `docs/SEO_CONTENT_REVIEW.md` and question mapping in `docs/SEO_QUERY_MAP.json`. Search dashboards and their non-public exports stay outside this public repository.
