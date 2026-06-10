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

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # -> dist/
```

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
