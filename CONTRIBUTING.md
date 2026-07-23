# Contribution policy

Workstrand is an owner-maintained private development preview. External patches, pull requests, and direct repository contributions are not accepted.

People who receive an owner-published installer or release artifact do not need repository write access. Repository access must never be used as a shortcut for distributing builds, and no collaborator should be granted push, merge, release, Actions-administration, secret-management, or package-publishing permissions.

For owner maintenance:

1. Install with `corepack pnpm install`.
2. Create a focused branch.
3. Run `corepack pnpm verify`, `corepack pnpm test:e2e`, and `corepack pnpm assets:verify`.
4. If UI changed, capture desktop and website desktop/mobile states and review them at actual size.
5. If a connector changed, add evidence for the permission boundary, idempotency behavior, read-back verification, and failure/retry path.

Do not commit credentials, OAuth tokens, private memory, unreviewed generated media, signed binaries, or a claim that mocked adapters are production connections. Schema changes require a forward migration. New external actions require an explicit policy level and audit events.
