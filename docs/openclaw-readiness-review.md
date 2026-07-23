# OpenClaw readiness review

Reviewed against the official OpenClaw documentation on 2026-07-23. This is a product-gap reference, not a claim that Workstrand implements OpenClaw or shares its configuration format.

## Patterns adopted

| OpenClaw pattern | Official reference | Workstrand decision |
| --- | --- | --- |
| Establish a working model route during onboarding and expose recovery when it fails | [Getting started](https://docs.openclaw.ai/start/getting-started), [Onboarding (CLI)](https://docs.openclaw.ai/start/wizard), [macOS app](https://docs.openclaw.ai/platforms/macos) | Setup now probes every configured cloud or Ollama route and shows the result before first use. The probe checks account/service reachability without sending project content. |
| Detect AI access already available on the Mac instead of requiring environment-only setup | [Onboarding (CLI)](https://docs.openclaw.ai/start/wizard) | Workstrand detects the Codex binary bundled with the official ChatGPT app plus bounded common Codex/Claude Code locations, then offers a persistent opt-in. Only the executable path and enablement choice are stored; vendor authentication remains untouched. |
| Provide one health/doctor path instead of scattering failure state | [Doctor](https://docs.openclaw.ai/cli/doctor), [Status](https://docs.openclaw.ai/cli/status) | The desktop Readiness page consolidates core health, model configuration, project grants, macOS permissions, backup state, and packaged-build status. |
| Treat a verified backup as an ordinary recovery operation | [Backup](https://docs.openclaw.ai/cli/backup) | Workstrand can create a no-overwrite local snapshot after stopping the core, include encrypted owned state and its protected key, hash every copied file, verify the copy, and reveal it in Finder. Project folders are deliberately excluded. |
| Make macOS permission state and signature limitations visible | [macOS permissions](https://docs.openclaw.ai/mac/permissions) | Readiness reports microphone, screen-recording, and Accessibility state and warns when the development build cannot provide stable permission identity. |
| Start conservative and keep powerful actions approval-gated | [Security](https://docs.openclaw.ai/gateway/security), [Exec approvals](https://docs.openclaw.ai/tools/exec-approvals) | Existing scoped folders, isolated tools, durable approval rules, and consequential-action pauses remain unchanged. Readiness does not loosen policy. |

## Deliberately not copied

- Workstrand does not add an OpenClaw Gateway, channel-pairing protocol, or OpenClaw configuration compatibility layer.
- A provider reachability probe is not described as a full model completion. Normal first-task execution remains the end-to-end inference proof.
- The backup is a verified local directory snapshot, not OpenClaw's tar or SQLite repository format. Automated restore is still a separate recovery feature.
- Ad-hoc development packaging remains unsuitable for stable long-term macOS TCC permissions. Developer ID signing and notarization are still release blockers.
