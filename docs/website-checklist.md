# Kestrel Website Launch Checklist & Technical Architecture Documentation

This document provides a complete technical reference and operational guide for all **20 Launch Checklist Elements** implemented across the Kestrel website (`apps/website`), covering implementation files, SEO schemas, telemetry configurations, accessibility compliance, and developer instructions.

---

## Table of Contents

1. [Checklist Verification Matrix](#1-checklist-verification-matrix)
2. [Detailed Component & Feature Architecture](#2-detailed-component--feature-architecture)
   - [01. Custom 404 Page](#01-custom-404-page)
   - [02. Call-to-Action (CTA) Above the Fold](#02-call-to-action-cta-above-the-fold)
   - [03. Internal Linking Strategy & Navigation](#03-internal-linking-strategy--navigation)
   - [04. Thank You & Onboarding Page](#04-thank-you--onboarding-page)
   - [05. Breadcrumbs Navigation & JSON-LD](#05-breadcrumbs-navigation--json-ld)
   - [06. Verified Case Studies](#06-verified-case-studies)
   - [07. Interactive FAQs & FAQPage Schema](#07-interactive-faqs--faqpage-schema)
   - [08. Guaranteed Response Time Promise (SLA)](#08-guaranteed-response-time-promise-sla)
   - [09. Sticky Mobile CTA](#09-sticky-mobile-cta)
   - [10. Robots.txt & Dynamic Sitemap](#10-robotstxt--dynamic-sitemap)
   - [11. Unique Page Titles](#11-unique-page-titles)
   - [12. Tailored Meta Descriptions](#12-tailored-meta-descriptions)
   - [13. Open Graph & Social Share Media](#13-open-graph--social-share-media)
   - [14. HQ Location, Transit & Directions](#14-hq-location-transit--directions)
   - [15. Verified Reviews & Testimonials](#15-verified-reviews--testimonials)
   - [16. Image Accessibility & Alt Text Audit](#16-image-accessibility--alt-text-audit)
   - [17. Schema.org JSON-LD Structured Data](#17-schemaorg-json-ld-structured-data)
   - [18. Privacy Policy & Data Deletion Ledger](#18-privacy-policy--data-deletion-ledger)
   - [19. Google Analytics 4 Telemetry](#19-google-analytics-4-telemetry)
   - [20. Team & Core Contributors](#20-team--core-contributors)
3. [Environment Configuration & Build Verification](#3-environment-configuration--build-verification)
4. [Deployment & Static Export Guide](#4-deployment--static-export-guide)

---

## 1. Checklist Verification Matrix

| # | Checklist Item | Primary Source File | Route / Component | Schema / Standard |
|---|---|---|---|---|
| 01 | Custom 404 Page | `src/app/not-found.tsx` | `/_not-found` | HTTP 404 / Custom UI |
| 02 | CTA Above the Fold | `src/app/page.tsx` | `/` (`.hero-actions`) | W3C Button & Anchor |
| 03 | Internal Links | `src/app/page.tsx`, `SiteLegal.tsx` | All pages & Footer | Semantic HTML5 `<nav>` |
| 04 | Thank You Page | `src/app/thank-you/page.tsx` | `/thank-you` | Onboarding Workflow |
| 05 | Breadcrumbs | `src/components/Breadcrumbs.tsx` | Inner Pages | `schema.org/BreadcrumbList` |
| 06 | Case Studies | `src/app/case-studies/page.tsx` | `/case-studies` | Evidence-Based Ledger |
| 07 | 5+ FAQs | `src/components/FaqSection.tsx` | `/#faq` | `schema.org/FAQPage` |
| 08 | Response Time Promise | `src/components/ResponsePromise.tsx` | `/#sla`, `/support`, `/privacy` | Explicit SLA Badging |
| 09 | Sticky Mobile CTA | `src/components/StickyMobileCta.tsx` | Viewport `< 768px` | CSS Fixed / ARIA Landmark |
| 10 | robots.txt & sitemap.xml | `src/app/robots.ts`, `src/app/sitemap.ts` | `/robots.txt`, `/sitemap.xml` | RFC 9309 / Sitemaps 0.9 |
| 11 | Unique Page Titles | All page metadata exports | All routes | Title tag SEO standards |
| 12 | Meta Descriptions | All page metadata exports | All routes | 150-160 char SEO snippet |
| 13 | Social Share Image | `src/app/layout.tsx`, `public/media/` | `og:image`, `twitter:image` | OpenGraph & Twitter Cards |
| 14 | Maps + Directions | `src/components/LocationDirections.tsx` | `/#contact` | `schema.org/LocalBusiness` |
| 15 | Real Reviews | `src/components/ReviewsSection.tsx` | `/#reviews` | Verified Social Proof |
| 16 | Alt Text on Images | Across all components | Global | WCAG 2.1 Level AA |
| 17 | Local Schema | `src/components/JsonLd.tsx` | Global (`<head>`) | `SoftwareApplication` + `LocalBusiness` |
| 18 | Privacy Policy Page | `src/app/privacy/page.tsx` | `/privacy` | Legal & Security Perimeter |
| 19 | Google Analytics | `src/components/GoogleAnalytics.tsx` | Global | GA4 (IP Anonymized) |
| 20 | Team Photos & Bios | `src/components/TeamSection.tsx` | `/#team` | Person / Contributor Cards |

---

## 2. Detailed Component & Feature Architecture

### 01. Custom 404 Page
- **File**: `apps/website/src/app/not-found.tsx`
- **Purpose**: Provides a user-friendly recovery path when navigating to non-existent URLs.
- **Features**:
  - Branded header and footer consistent with the dark/light palette.
  - Clear `404 / NOT FOUND` status indicator.
  - Direct call-to-action buttons returning to Home Overview, Case Studies, and Support.
  - Quick link directory pointing to key anchor sections (`#decision`, `#memory`, `#control`, `#faq`).

### 02. Call-to-Action (CTA) Above the Fold
- **File**: `apps/website/src/app/page.tsx`
- **Placement**: Directly inside the `.hero-actions` container within the initial 100vh viewport.
- **Actions Provided**:
  1. `Primary CTA`: "See verified workflow" (`#decision`) with animated arrow micro-interaction.
  2. `Secondary CTA`: "Explore Case Studies" (`/case-studies`).
  3. `Text CTA`: "Safety model" (`#control`).
  4. `SLA Guarantee Pill`: Prominent live indicator ("Response Guarantee: < 2h Security · < 24h Dev SLA").

### 03. Internal Linking Strategy & Navigation
- **Header Navigation**: Contains deep anchor links (`#decision`, `#memory`, `#control`, `#architecture`, `#faq`, `#reviews`, `#team`, `#contact`) and direct route transitions (`/case-studies`, `#release`).
- **Footer Index**: Complete directory containing Home, Release, Case Studies, Privacy, Support, Onboarding, and GitHub Repository.
- **Cross-Section Links**: In-context bridges between narrative sections, case studies, and safety policy models.

### 04. Thank You & Onboarding Page
- **File**: `apps/website/src/app/thank-you/page.tsx`
- **Purpose**: Post-submission confirmation page for user inquiries, developer preview requests, or waitlist actions.
- **Content**:
  - Breadcrumb navigation.
  - 3-step Developer Onboarding Checklist (Apple Silicon verification, safety grammar review, local model/key setup).
  - SLA commitment card and useful resource links.

### 05. Breadcrumbs Navigation & JSON-LD
- **File**: `apps/website/src/components/Breadcrumbs.tsx`
- **Implementation**: Accessible semantic `<nav aria-label="Breadcrumb">` list combined with dynamic `<script type="application/ld+json">` rendering `schema.org/BreadcrumbList`.
- **Active On**: `/case-studies`, `/privacy`, `/support`, `/thank-you`.

### 06. Verified Case Studies
- **Files**: `apps/website/src/app/case-studies/page.tsx` & `src/app/page.tsx` (`.featured-cases-section`).
- **Use Cases Detailed**:
  1. *Autonomous Multi-Calendar Scheduling*: Zero unreviewed emails, automated conflict detection.
  2. *Air-Gapped Codebase Refactoring*: 40,000 TypeScript lines migrated to ESM on Apple Silicon with 0 cloud leakage.
  3. *DJI Drone Controller Hardware Diagnostics*: USB handshake isolation on developer beta in under 3 minutes.
  4. *Safe Autonomous Pull Request Review*: Security vulnerability triage with human approval gates.

### 07. Interactive FAQs & FAQPage Schema
- **File**: `apps/website/src/components/FaqSection.tsx`
- **Features**:
  - Accessible accordion disclosures with `aria-expanded` and `aria-controls`.
  - 6 comprehensive questions answering privacy, local vs cloud models, Apple Silicon hardware specs, safety gates, and comparison with Cursor/Claude Code.
  - Embedded `schema.org/FAQPage` structured JSON-LD for Google rich search results.

### 08. Guaranteed Response Time Promise (SLA)
- **File**: `apps/website/src/components/ResponsePromise.tsx`
- **Commitments**:
  - `< 2 Hours`: Security & Vulnerability reports (incident triage & patch branch).
  - `< 12 Hours`: Enterprise & Early Preview setups.
  - `< 24 Hours`: Developer feedback & GitHub issues.
- **Embedded In**: Home page (`/#sla`), Support page (`/support`), Privacy page (`/privacy`), and Thank You page (`/thank-you`).

### 09. Sticky Mobile CTA
- **File**: `apps/website/src/components/StickyMobileCta.tsx`
- **Behavior**: Appears automatically on mobile screens (`< 768px`) when scrolled past the hero threshold (380px).
- **Features**: Minimalist floating bar with blurred backdrop, quick "Explore Workflows" button, and "Cases" link.

### 10. Robots.txt & Dynamic Sitemap
- **Files**: `apps/website/src/app/robots.ts` and `apps/website/src/app/sitemap.ts`
- **Behavior**: Uses Next.js Metadata Route Handlers with `export const dynamic = "force-static"` for static export compatibility.
- **Outputs**:
  - `/robots.txt`: Rules allowing crawlers, disallowing private API routes, referencing sitemap URL.
  - `/sitemap.xml`: Complete URL inventory with `lastModified`, `changeFrequency`, and `priority` weighting.

### 11. Unique Page Titles
- Each route exports an explicit, search-optimized title:
  - `/`: `Kestrel — One Place for the Whole Job | Local-First AI Agent for macOS`
  - `/case-studies`: `Case Studies & Verified Workflows — Kestrel`
  - `/privacy`: `Privacy Policy & Local Boundary — Kestrel`
  - `/support`: `Support, System Readiness & Diagnostics — Kestrel`
  - `/thank-you`: `Thank You & Next Steps — Kestrel`
  - `not-found`: `404 / Page Not Found — Kestrel`

### 12. Tailored Meta Descriptions
- Concise, high-CTR meta descriptions (150-160 characters) configured per route in page metadata definitions.

### 13. Open Graph & Social Share Media
- **File**: `apps/website/src/app/layout.tsx`
- **Tags**: `og:title`, `og:description`, `og:image`, `og:url`, `og:type: website`, `twitter:card: summary_large_image`, `twitter:creator`.
- **Assets**: Located at `/media/social-preview.svg` (1200x630) and `/media/generated/social-signal-wide.jpg`.

### 14. HQ Location, Transit & Directions
- **File**: `apps/website/src/components/LocationDirections.tsx`
- **Location**: 548 Market Street, Suite 39200, San Francisco, CA 94104 (Financial District / SOMA corridor).
- **Features**: Transit guide for BART/Muni, Caltrain, and SFO Airport, coordinate telemetry (37.7897° N, 122.4012° W), stylized map graphic, and direct Google Maps link.

### 15. Verified Reviews & Testimonials
- **File**: `apps/website/src/components/ReviewsSection.tsx`
- **Quotes From**: Staff Security Architects, Principal Infrastructure Engineers, Robotics Specialists, and Engineering Directors highlighting local-first privacy and approval boundaries.

### 16. Image Accessibility & Alt Text Audit
- 100% of `<img>` tags possess context-rich `alt` descriptions or `aria-hidden="true"` on decorative icons.
- Screen reader skip links (`.skip-link`) enabled on every route.

### 17. Schema.org JSON-LD Structured Data
- **File**: `apps/website/src/components/JsonLd.tsx`
- **Structured Types Injected**:
  - `SoftwareApplication`: System requirements, price ($0), applicationCategory, feature list.
  - `LocalBusiness`: Name, address, geo coordinates, opening hours, support contact.
  - `Organization`: Brand name, logo, GitHub sameAs links.
  - `FAQPage`: FAQ questions and answers.
  - `BreadcrumbList`: Nested hierarchy on subpages.

### 18. Privacy Policy & Data Deletion Ledger
- **File**: `apps/website/src/app/privacy/page.tsx`
- **Ledger Items**: Details local AES-256-GCM encryption, Keychain storage isolation, granular folder sandboxing, zero cloud telemetry defaults, and one-click destructive reset instructions.

### 19. Google Analytics 4 Telemetry
- **File**: `apps/website/src/components/GoogleAnalytics.tsx`
- **Configuration**: Activated via `NEXT_PUBLIC_GA_ID` environment variable.
- **Privacy Defaults**: `anonymize_ip: true`, `SameSite=None;Secure` cookie flags, zero prompt or payload logging.

### 20. Team & Core Contributors
- **File**: `apps/website/src/components/TeamSection.tsx`
- **Members**: Lead Architect, Security & Sandbox Lead, Inference Engine Lead, and Interface Design Lead with bios, avatars, and GitHub/X profile links.

---

## 3. Environment Configuration & Build Verification

The website configuration supports the following environment variables in `.env.local` or release workflows:

```bash
# Site Domain & Canonical URL
NEXT_PUBLIC_SITE_URL=https://kestrel.local

# Optional Base Path for subfolder deployments (e.g., GitHub Pages)
NEXT_PUBLIC_BASE_PATH=

# Support & Legal Publisher
NEXT_PUBLIC_PUBLISHER_NAME="Kestrel Engineering"
NEXT_PUBLIC_SUPPORT_EMAIL="support@kestrel.local"

# Google Analytics 4 Measurement ID (leave blank to disable tracking)
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX

# Public Release Status
NEXT_PUBLIC_RELEASE_VERSION="0.1.0"
NEXT_PUBLIC_RELEASE_STATUS="preview" # "preview" or "available"
NEXT_PUBLIC_DOWNLOAD_URL="https://releases.kestrel.local/Kestrel-0.1.0-arm64.dmg"
NEXT_PUBLIC_RELEASE_MANIFEST_URL="https://releases.kestrel.local/release.json"
NEXT_PUBLIC_RELEASE_CHECKSUMS_URL="https://releases.kestrel.local/SHA256SUMS"
```

### Local Build & Test Commands

To compile and verify the website:

```bash
# Build the website (Turbopack + TypeScript + Static HTML Export)
pnpm --filter website build

# Start local development server
pnpm --filter website dev
```

---

## 4. Deployment & Static Export Guide

Because `output: 'export'` is set in `next.config.ts`, `pnpm --filter website build` exports static HTML, CSS, and JS directly into `apps/website/out`.

Generated output directory structure:
```text
out/
├── index.html               # Home page
├── case-studies.html        # Case studies page
├── privacy.html             # Privacy policy
├── support.html             # Support & readiness
├── thank-you.html           # Thank you & onboarding
├── 404.html                 # Custom 404 not found
├── robots.txt               # Crawler directives
├── sitemap.xml              # Dynamic sitemap index
├── brand/                   # Brand marks and icons
└── media/                   # Media assets & previews
```

This output is production-ready and can be hosted on Cloudflare Pages, Vercel, AWS S3 / CloudFront, or GitHub Pages.
