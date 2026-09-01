# OpenClaw 2.0 readiness review

The original documentation snapshot was reviewed on 2026-07-23; OpenClaw's
current release naming and migration formats were rechecked against the official
v2026.8.1 sources on 2026-08-31. This is a product-gap reference, not a claim
that Kestrel implements OpenClaw or shares its configuration format.

## Current release check

OpenClaw's official release stream uses calendar versions. The stable
[v2026.8.1 release](https://github.com/openclaw/openclaw/releases/tag/v2026.8.1)
is explicitly documented by OpenClaw as **AKA OpenClaw 2.0**. Kestrel pins that
release to immutable commit
`ea806575e6450e4d1efdfc72c19f04be982a1b9b` and records exact user-visible
behavior evidence in the [OpenClaw 2.0 behavior register](openclaw-2-behavior-matrix.json).
The existing [parity matrix](parity-matrix.md) remains a broad capability-family
catalog; it is not a substitute for the register's executable behavioral proof.

Run the canonical gate with:

```bash
corepack pnpm verify:openclaw2
```

That command validates the pinned provenance, evidence paths, classifications,
and release-blocking priorities before running the focused evidence suite.

## Patterns adopted

| OpenClaw pattern | Official reference | Kestrel decision |
| --- | --- | --- |
| Establish a working model route during onboarding and expose recovery when it fails | [Getting started](https://docs.openclaw.ai/start/getting-started), [Onboarding (CLI)](https://docs.openclaw.ai/start/wizard), [macOS app](https://docs.openclaw.ai/platforms/macos) | Setup now probes every configured cloud or Ollama route and shows the result before first use. The probe checks account/service reachability without sending project content. |
| Detect AI access already available on the Mac instead of requiring environment-only setup | [Onboarding (CLI)](https://docs.openclaw.ai/start/wizard) | Kestrel detects the Codex binary bundled with the official ChatGPT app plus bounded common Codex/Claude Code locations, then offers a persistent opt-in. Only the executable path and enablement choice are stored; vendor authentication remains untouched. |
| Provide one health/doctor path instead of scattering failure state | [Doctor](https://docs.openclaw.ai/cli/doctor), [Status](https://docs.openclaw.ai/cli/status) | The desktop Readiness page consolidates core health, model configuration, project grants, macOS permissions, backup state, and packaged-build status. |
| Treat a verified backup as an ordinary recovery operation | [Backup](https://docs.openclaw.ai/cli/backup) | Kestrel can create a no-overwrite local snapshot after stopping the core, include encrypted owned state and its protected key, hash every copied file, verify the copy, and reveal it in Finder. Project folders are deliberately excluded. |
| Make macOS permission state and signature limitations visible | [macOS permissions](https://docs.openclaw.ai/mac/permissions) | Readiness reports microphone, screen-recording, and Accessibility state and warns when the development build cannot provide stable permission identity. |
| Start conservative and keep powerful actions approval-gated | [Security](https://docs.openclaw.ai/gateway/security), [Exec approvals](https://docs.openclaw.ai/tools/exec-approvals) | Existing scoped folders, isolated tools, durable approval rules, and consequential-action pauses remain unchanged. Readiness does not loosen policy. |
| Let a person assess migration-sensitive automations, bindings, and plugins without carrying hidden authority across products | [Cron jobs](https://github.com/openclaw/openclaw/blob/v2026.8.1/docs/automation/cron-jobs.md), [agent bindings](https://github.com/openclaw/openclaw/blob/v2026.8.1/docs/concepts/agent-bindings.md), [plugins](https://github.com/openclaw/openclaw/blob/v2026.8.1/docs/tools/plugin.md) | The migration dry run inventories counts of OpenClaw cron jobs, channel/ACP bindings, plugin decisions, and plugin load paths. It never copies their payloads, plugin configuration, executable paths, or credentials; the person recreates only selected behavior through Kestrel's own protected fields and approval model. |

## Deliberately not copied

- Kestrel does not add an OpenClaw Gateway, channel-pairing protocol, or OpenClaw configuration compatibility layer.
- Kestrel never copies raw reference-product settings files. It emits only non-secret, checksum-checked setting translations, and refuses a plan that attempts a raw settings import.
- Kestrel does not import OpenClaw scheduled payloads, channel/ACP bindings, plugin packages, plugin configuration, plugin paths, or credentials. The dry-run inventory is review-only.
- A provider reachability probe is not described as a full model completion. Normal first-task execution remains the end-to-end inference proof.
- The backup is a verified local directory snapshot, not OpenClaw's tar or SQLite repository format. Automated restore is still a separate recovery feature.
- Ad-hoc development packaging remains unsuitable for stable long-term macOS TCC permissions. Developer ID signing and notarization are still release blockers.

The register also records the remaining structured-question gap as P2 rather
than presenting the existing approval and waiting-state UI as rich question
controls. This keeps the readiness claim honest while preserving Kestrel's
separate approval boundary.
