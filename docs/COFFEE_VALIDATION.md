# Coffee support integration validation

- Scope: shared static CoffeeSupport component on English and Chinese About pages; fixed link to the existing live coffee site. No payment credentials or checkout API added to the blog.
- Browser: Chrome, Chinese desktop/light screenshot and English 390px/dark full-page screenshot inspected. Button, amount and one-time wording visible; English mobile document width 375px with viewport 390px (no horizontal overflow). Theme switching and locale routes observed. English light screenshot capture timed out; exhaustive theme/viewport and article regression audits were not performed for this scoped addition.
- Public Google DNS resolves the coffee domain; HTTPS with resolved IP and original hostname validates TLS and /api/health returns live/ready. This machine's ordinary DNS still fails for that subdomain.
- No live payment performed; previously reported Stripe risk blocks remain separate from this navigation change.
- First local check collided with the Astro development server's generated cache. Stopped the development server and reran validation sequentially.
- Node 22.23.2: npm ci completed; npm run check reported 0 errors/warnings/hints; npm run build generated 50 pages; npm test passed 36 article identities and 1076 internal references. npm ci reported 13 existing dependency audit findings; dependency upgrades are outside this change.
