---
name: editorial-site-redesign
description: Audit and implement layout, navigation, typography and website-copy changes in Mixture of Insights. Use for this bilingual Astro blog's redesign and visual regression checks, not for unrelated product UI or autonomous deployment.
---

# Editorial site redesign

Make the engineering work easier to discover, read and verify. This is a repository-specific workflow, not a detector-evasion tool or a universal visual style.

## Inputs and boundaries

Read `AGENTS.md`, `README.md` and `docs/EDITORIAL_REDESIGN.md`. Inspect the actual current files before editing; the brief describes a baseline, not a guarantee that the branch has not changed. Use `.agents/skills/hardcore_tech_blog/SKILL.md` for article prose.

Preserve Astro, bilingual routes, publication dates, source evidence, comments, theme behavior and SEO. Do not deploy, merge, regenerate images through a paid service, or install other skills merely to run this one.

## Workflow

### 1. Establish a baseline

Inspect `Home.astro`, `Post.astro`, `Base.astro`, `Comments.astro`, `global.css`, `i18n.ts`, the content schema and both language route trees. Read representative articles, including long code, math and diagrams.

Run the existing build where possible. Save the existing article route set and relevant content identifiers. Capture or inspect desktop/mobile pages in both languages and themes. Separate direct observations, code-level risks and untested hypotheses. Do not say a screenshot was inspected when only HTML was retrieved.

### 2. Implement the chosen direction

Follow the editorial engineering notebook direction in the brief. Do not stop at another mood board or three generic alternatives. Start with discovery hierarchy: recent posts, compact series index and a complete archive. Keep series ordering on dedicated series pages. Remove duplicated full article previews and decorative list covers.

Use content-specific hierarchy, typography and spacing. Keep a narrow reading measure and a wider index where useful. Reuse existing fonts/colors unless changing them fixes an identified issue. Avoid replacing one template with another: no mandatory cards, hero slogan, gradients, terminal cosplay, fake handwritten flourishes, randomized misalignment or unnecessary animation.

Remove decorative body banners by default without deleting OG assets or meaningful figures. Reuse shared locale-aware components. Ensure new archive and series routes have working language counterparts and appropriate metadata.

### 3. Edit copy conservatively

Begin with homepage/UI/series/About text. Read the source article before editing a description. State the actual subject and scope; do not replace an unsupported broad claim with an invented first-person anecdote.

Only edit the sample article pairs authorized by the brief. Keep other full articles for the audit. Separate prose-only edits from changes requiring technical verification. Record unresolved claims in `docs/EDITORIAL_AUDIT.md`; do not silently repair their truth status.

### 4. Validate the rendered result

Run the build and any added checks. Check old URLs, locale pairs, series order, feeds, sitemap, canonical/hreflang, source links and giscus pathnames. A static build alone does not validate layout.

Check 390/768/1440px widths, both languages and themes, and the page types in the brief. Inspect 320px navigation, long headings, local code/math/table overflow, TOC anchors, previous/next, theme persistence and comment theme synchronization. Check visible keyboard focus, skip link, zoom, reduced motion and the main reading flow without JavaScript.

Use browser screenshots when available, not an AI-detector score. Save before/after evidence and identify the actual browser/viewport combinations tested. Do not report scores or passing checks that were not measured. Note third-party network failures separately.

### 5. Deliver reviewable work

Keep layout, site-copy, and article-edit commits separate. Update `docs/REDESIGN_VALIDATION.md` with test commands, outcomes, screenshots or reproduction steps, and explicit untested items. Leave a draft PR with implementation notes and unresolved editorial questions. Do not merge or deploy.

## Outputs

A working code diff, a scoped editorial audit, and an honest validation report. A plan or this skill file alone is not an implemented redesign.
