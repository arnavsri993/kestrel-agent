# Event and hackathon application assistant

Kestrel includes a local-first opportunity workspace for event and hackathon applications. Importing an official HTTPS URL creates an encrypted local draft; it does not contact or submit to the site.

The preparation agent can research the official page and use `events.prepare` to save:

- eligibility checks with evidence and an unresolved state,
- reusable or event-specific draft answers,
- answer provenance,
- `public`, `personal`, or `sensitive` labels.

Every agent-written answer starts unreviewed. Approval is rejected while a required answer is blank or unreviewed, or while any eligibility check is unresolved or false. Editing a reviewed answer clears its review state. Re-preparing an approved application invalidates the old approval.

After approval, **Continue with browser agent** opens a dedicated session. Its instruction contract requires the isolated browser, stops for explicit approval immediately before the external Submit action, and forbids inventing eligibility, legal attestations, consent, demographic facts, signatures, payments, or missing answers. New or changed form questions return to the user.

The application becomes `submitted` only through the high-consequence `events.mark_submitted` tool after a visible confirmation or receipt is observed. An ambiguous or failed external result leaves the local state approved, not submitted.

External event sites change frequently and may use CAPTCHAs, identity checks, payment, or terms that require direct user action. Kestrel treats those as handoff points rather than bypassing them.
