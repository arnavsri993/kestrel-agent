# Persistent agent operations

This increment extends existing runtime sessions, encrypted memory, tool authorization, and working tasks. Robotics is an editable template with eight persistent specialists; other agents retain separate private context.

## Implemented

- Agent configuration and persistent specialist delegation, archive/restore, intersected tool/resource grants, and durable run-to-task outcome links including approval resume.
- Connections and Memory navigation, scope selectors that reuse the current tab, parent/specialist work history, scoped people/calendar, bounded knowledge recovery previews, and reduced sidebar clutter.
- Explicit source selection and processing consent, encrypted observations and indexed search, revisions/tombstones, bounded ingestion, cancellation, and restart persistence. Source review queues existing working tasks without starting a model or copying source text into their goals.
- Dedicated WhatsApp partition isolated from personal browser tools, protected Onshape read-only metadata adapter, and exact Google resource mappings. Unmapped persistent-agent connector access fails closed.
- Source-derived knowledge cleanup and authorization revalidation of prior connector tool results before provider calls.

## Dependency separation

The delivery branch starts at main a0eaeaa6. Only the task delta against the original dirty-checkout baseline was ported. Unrelated starfield, sidebar, and pre-existing uncommitted changes are excluded. Current main's shared Core service and independent-review implementation are retained; Onshape initialization lives in the shared service.

## Validation

- Full typecheck passed after resolving dedicated-window initialization.
- Full unit suite: 219 files / 1,518 tests passed, including synthetic encrypted 50,000-record ingestion, retrieval, cancellation, and restart.
- Packaged persistent-agent fixture passed: creation of eight specialists, scoped memory, source ingestion/revocation, dedicated partition, and detached-window restart.
- Broad verification passed through build, benchmarks, browser end-to-end tests, desktop startup, single-instance, layout, New Tab, settings, Writing Studio and file-icon checks. Browser smoke initially used a persistent agent for personal browser actions; its fixture now separates an agent for Universe assertions and a conversation for personal browser assertions, and the rerun passed. Later verify gates are not represented as passed.
- Installed at /Applications/Kestrel.app through install:mac:dev. Installed/package app.asar SHA256: 9a2a1ea3597988a9c7b328fc78555cedf4efcb3377cb0d3eed6ee29b8a047898. Final native accessibility inspection timed out; packaged UI proof does not establish the current user-visible window.

## Remaining work

The full architecture is not yet live. Automatic source extraction/planning/execution, comprehensive source-derived task/conversation deletion, full knowledge/work indexed search, richer correction/people identity controls, complete backup and connection registry coverage, and overlapping workspace mutation protection remain incomplete.

Live WhatsApp showed an unsupported browser page; no authenticated capture is claimed. Onshape and Google were not connected. A prior live specialist text response proves only that bounded model route, not CAD execution, source ingestion, or independent reviewer readiness. No credentials or profile data were copied or reset.

## Retention follow-up

Source receipts now use encrypted payloads, with legacy source receipts upgraded on reopen. Source deletion redacts matching receipts and tool messages, clears their transcript search terms, and blocks stale receipt/message writes. Assistant messages carry encrypted source-receipt provenance; directly affected answers are redacted and excluded from generic automatic memory capture. Legacy assistant answers after the read are conservatively redacted. Late writes for deleted task/knowledge IDs are rejected across restart, and explicitly linked task/knowledge graphs are removed on source expiry.

These checks do not establish complete retention closure: copied cross-session summaries, prior automatically derived timeline records, new records with lost provenance, external artifacts, historical backups, and streamed text already delivered to a provider are not covered by these changes. Automatic processing remains disabled pending the remaining pipeline work and verification.

## Explicit source review

Memory Sources now provides Review now and Stop review. Review requires model-processing consent and current resource access, reads one selected observation through sources.read, and stores analysis in the existing source-linked WorkingTask. Duplicate attempts are rejected. Limits are four model turns (or the lower configured limit), 2,000 output tokens per turn, and 60 seconds. No external-write tools are supplied. Required independent verification routes fail closed rather than bypassing their requirement. Completion requires a verified source-read receipt for this run. Proposed work remains explicitly unexecuted and unverified.

Fixture coverage checks consent, actual retrieval, task/source links, duplicate starts, cancellation, and source deletion. Full typecheck and 39 core regression tests passed before the final receipt check; the final focused review tests and Core typecheck also passed. This is user-triggered analysis, not automatic source scheduling or specialist execution. Retry/recovery UX and complete provider-backed live proof remain outstanding.
