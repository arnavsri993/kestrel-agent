# Workstrand brand

## Name

**Workstrand** is the human-visible product name.

A workstrand is a sequence of related work. That maps directly to the product:
one persistent thread carries an outcome through context retrieval, planning,
human approval, execution, and verification.

The name should be written as `Workstrand` in prose and `workstrand` only where
a lowercase identifier is required.

## Position

**A local-first work agent with visible approval and verified delivery.**

Short product loop:

`Notice → Retrieve → Plan → Approve → Act → Verify`

## Mark

The mark is one continuous strand interrupted by a circular approval
checkpoint. The interruption is deliberate: Workstrand can carry the job, but
consequential action remains visibly gated.

Primary colors:

- Night: `#101713`
- Signal: `#d7ff52`
- Paper: `#f4f7f1`

Production assets live in:

- `artifacts/brand/workstrand-mark.svg`
- `apps/website/public/brand/workstrand-mark.svg`
- `apps/website/public/brand/workstrand-icon.svg`
- `apps/desktop/build/icon.svg`

The generated raster exploration is retained in `artifacts/brand/` as design
provenance. Production surfaces use the simplified vector geometry.

## Domain check

Checked on 2026-07-22 (America/Chicago):

- `workstrand.ai` — registry WHOIS returned `Domain not found`
- `workstrand.app` — Google Registry RDAP returned `404`
- `workstrand.dev` — Google Registry RDAP returned `404`
- `workstrand.com` — registered

Availability can change at any time. A registry check is not a reservation or
ownership claim.

## Compatibility boundary

The existing `@kestrel/*` package scope, `kestrel` CLI command, IPC and protocol
names, Keychain service, environment variables, editor command IDs, and local
data-directory names remain compatibility identifiers. Changing them requires a
separately tested migration so existing encrypted history, credentials, plugins,
editor integrations, and automation entry points do not appear to disappear.
