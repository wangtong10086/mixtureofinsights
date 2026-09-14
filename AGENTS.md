# Working in Mixture of Insights

This is Wang Tong's bilingual technical blog, not a SaaS landing page or a generated résumé. Help readers find and understand the engineering work. Do not manufacture a personality for the author.

## Read before changing the site

- `README.md`: stack, layout, development and deployment.
- `docs/EDITORIAL_REDESIGN.md`: the current redesign brief, scope and acceptance criteria.
- `docs/SOURCES.md`: provenance for technical articles. Repository code can substantiate an implementation, but does not by itself prove benchmark results or an author's personal experience.
- `.agents/skills/editorial-site-redesign/SKILL.md` for layout or website-copy work.
- `.agents/skills/hardcore_tech_blog/SKILL.md` for article editing. Its legacy name is retained for compatibility; it does not require a hacker persona or fixed narrative.

## Preserve compatibility

Use the existing Astro static-site architecture. Keep both locales, existing article slugs, publication dates, series keys/order, RSS, sitemap, canonical/hreflang/OG metadata, math, code highlighting, source links, and giscus pathname mapping. Existing article URLs must continue to work without relying on client-side JavaScript. New archive and series pages are additive.

Do not migrate the site to React, Next.js, a CMS, or an animation framework for this task. Prefer small typed Astro components, shared locale-aware rendering, and CSS. Do not install third-party skills or packages merely to follow this brief; inspect any genuinely necessary dependency and explain it in the PR.

## Writing and factual boundaries

Write for engineers who know the field but may not know this project. Explain the local mechanism or constraint, not generic background. Use specific filenames, assumptions, failure conditions, measurements and sources where they exist.

Preserve the distinction between a code observation, a derivation, an illustrative example, a measured result, an opinion, and a first-person historical claim. Do not invent experiments, dates, hardware, employment details, failed attempts, anecdotes or personal opinions to make prose sound human. Do not convert collaborators' work into singular first-person authorship.

Remove repetition and inflated framing selectively. Do not mechanically ban a punctuation mark, technical term, conclusion, diagram format or sentence length. Do not replace a generic assistant voice with a compulsory terse hacker voice. Never optimize for an AI detector or deliberately add errors.

Unsupported substantive claims belong in an editorial audit with the evidence needed. Do not silently strengthen, weaken or replace them while calling the change copyediting. Keep technical changes separate from presentation and prose-only changes. Do not edit code blocks, equations or source anchors as part of a style pass.

English and Chinese should convey the same facts and uncertainty, but need not share sentence structure. Read each whole article before editing its summary.

## Work and validation

Work on the task branch. Keep changes reviewable: separate layout, website copy, and article edits. Do not use a full-site rewrite to hide uncertain edits.

Use Node 22, matching the existing deployment workflow. Run `npm ci` and `npm run build`; run any checks added by the implementation. Validate the rendered site at desktop and mobile sizes, both locales and themes. Inspect long code, math, tables, SVG diagrams, navigation, focus states, TOC anchors and language switching. Include an actual browser-check report; distinguish passing, failing and untested checks. A successful build is not a visual or accessibility audit.

## Delivery boundary

A push to `master` triggers the existing Cloudflare deployment. Do not push to `master`, merge a PR, enable auto-merge, dispatch deployment workflows, run `npm run deploy`/`wrangler deploy`, access credentials, or regenerate covers using paid services unless the user separately authorizes deployment. Leave a draft PR with implementation notes, test commands, screenshots if available, and remaining editorial questions.

Do not claim that Codex accepted a task, that tests passed, or that a site was deployed without the corresponding returned evidence.

## Code Review Rules

- Treat changed existing routes, locale pairing, giscus identifiers/pathnames or publication dates as compatibility risks. Add navigation without changing the existing identities.
- Treat invented first-person evidence and silent alterations to technical claims as content correctness defects, even when the prose reads better.
- Keep deployment and credential handling outside this redesign. Review browser behavior independently of build success.
