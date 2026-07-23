# Workstrand daily-work replacement — completion report

## Outcome

Workstrand now presents one primary daily-work entry instead of a scheduling-only product:

- choose or add a project directly from the new-task screen;
- describe an outcome in natural language;
- let automatic execution select the available provider and model;
- follow progress in the conversation;
- approve consequential actions before they run;
- review the resulting evidence in the same task.

Manual provider and model selection remains available under **Advanced execution** without blocking the default path. Conversation-only work can start without granting a project folder.

## Compatibility boundary

Human-visible product naming is **Workstrand** across the desktop app, website, CLI output, ACP identity, remote web surface, and editor integrations. Existing technical identifiers remain unchanged where renaming could break installed data or integrations, including `@kestrel/*` package names, the `kestrel` CLI command, protocol and IPC identifiers, Keychain service names, environment variables, and the legacy user-data directory.

## Render evidence

- Desktop revised state: `artifacts/screenshots/desktop/workstrand-revised/today.png`
- Desktop project and execution setup: `artifacts/screenshots/desktop/workstrand-revised/task-setup.png`
- Desktop compact, onboarding, approval, and error states are in the same evidence directory.
- Website desktop: `artifacts/screenshots/website/revised/homepage-desktop.png`
- Website mobile: `artifacts/screenshots/website/revised/homepage-mobile.png`

## Visual refinement

The first render exposed three high-impact issues:

1. Execution settings looked mandatory. They were moved behind **Advanced execution**.
2. Build and fix starters appeared usable without project access. They are now disabled until a project is selected.
3. The **Local** badge could be read as a local-model claim. It now reads **Local host**.

Project-access helper text was also strengthened for readability. The revised renders were rechecked at desktop and compact widths with keyboard focus and reduced-motion behavior.

## Validation

- Workspace typecheck passed.
- Unit suite passed: 26 files, 137 tests.
- Desktop and website production builds passed.
- Website end-to-end suite passed: 44 tests across desktop and mobile.
- Desktop isolated-browser smoke test passed.
- CLI, remote web, ACP, and editor-integration package smoke checks passed.
- Production secret scan passed.
- Asset registry verification passed.
- Desktop renderer stayed inside the existing JavaScript and CSS budgets.

## Why this is not generic

The interface is organized around the user's job rather than an AI feature grid: project scope, outcome, live work, approval, and evidence form one continuous surface. A warm graphite shell, restrained serif hierarchy, explicit local-host status, and consequence-aware approval states give Workstrand a recognizable operating character while keeping the work itself dominant.

## Remaining limits

This pass did not execute a paid live-provider task, complete manual VoiceOver coverage, sign or notarize the desktop app, or publish a public release. The automatic-routing path, packaged surfaces, local browser flow, builds, tests, and security checks are verified locally.
