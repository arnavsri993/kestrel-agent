# Installing an explicit development candidate

Canonical installation defaults to a clean commit at the freshly checked
`origin/main` tip. Local combinations of unmerged pull requests require an
explicit development candidate. This does not merge or publish those changes
to `main`.

Commit the complete candidate on a focused branch, fetch `origin/main`, and
ensure that the candidate includes that current main tip. From that clean
worktree, use its full commit SHA for both the owner claim and the install:

```sh
git fetch origin main
git rev-parse HEAD
node scripts/install-development-macos-app.mjs --claim-owner --candidate-commit <full-commit-sha>
corepack pnpm install:mac:dev --candidate-commit <full-commit-sha>
```

When another worktree owns deployment, add
`--handoff-from <recorded-owner-workspace>` to the owner claim. The claim records
the candidate SHA; any changed candidate needs a new claim and rebuilt bundle.
An abbreviated SHA, branch name, dirty tree, outdated main base, stale bundle,
stable release channel, or non-development bundle is rejected. The installer
retains its lock, signed-bundle verification, desktop/core build identity and
artifact hash checks, owner handoff, and refusal to downgrade or replace an
unrelated installed commit.

Installation replaces only the canonical `/Applications/Kestrel.app`, retains
the previous bundle in Trash, and preserves user profile data. Reopen that app
and exercise the affected flow to verify the running result. Publish the source
through an unmerged pull request independently of local installation.
