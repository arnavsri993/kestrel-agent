# Kestrel Website (`@kestrel/website`)

The official marketing and documentation website for Kestrel, built with Next.js (App Router, Turbopack, static export) and Vanilla CSS tokens.

---

## 20-Point Launch Checklist Compliance

This website implements all 20 essential launch features:

1. **Custom 404 Page** (`src/app/not-found.tsx`)
2. **CTA Above the Fold** (`src/app/page.tsx` `.hero-actions`)
3. **Internal Links** (Header nav, deep anchor targets, footer directory)
4. **Thank You & Onboarding Page** (`src/app/thank-you/page.tsx`)
5. **Breadcrumbs Component** (`src/components/Breadcrumbs.tsx` with `schema.org/BreadcrumbList`)
6. **Verified Case Studies** (`src/app/case-studies/page.tsx` & Home featured cases)
7. **5+ Interactive FAQs** (`src/components/FaqSection.tsx` with `schema.org/FAQPage`)
8. **Guaranteed Response Time Promise** (`src/components/ResponsePromise.tsx` SLA badges)
9. **Sticky Mobile CTA** (`src/components/StickyMobileCta.tsx` for small viewports)
10. **robots.txt & sitemap.xml** (`src/app/robots.ts`, `src/app/sitemap.ts`)
11. **Unique Page Titles** (Distinct `<title>` per route)
12. **Custom Meta Descriptions** (SEO-optimized snippets on each page)
13. **Social Share Image** (`layout.tsx`, `/media/social-preview.svg`)
14. **Maps + Transit Directions** (`src/components/LocationDirections.tsx` for SF Engineering Hub)
15. **Verified Reviews & Social Proof** (`src/components/ReviewsSection.tsx`)
16. **Alt Text on Images** (100% WCAG 2.1 AA accessible)
17. **Local Schema Markup** (`src/components/JsonLd.tsx` for `SoftwareApplication` & `LocalBusiness`)
18. **Privacy Policy Page** (`src/app/privacy/page.tsx`)
19. **Google Analytics Integration** (`src/components/GoogleAnalytics.tsx` with IP anonymization)
20. **Team & Contributor Profiles** (`src/components/TeamSection.tsx`)

For full technical documentation, see [`docs/website-checklist.md`](../../docs/website-checklist.md).

---

## Development & Build Commands

```bash
# Start local development server
pnpm --filter website dev

# Typecheck and compile static production export to out/
pnpm --filter website build

# Serve exported static build
pnpm --filter website start:test
```
