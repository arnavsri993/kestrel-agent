# Outreach and application workflow

Kestrel now has a reusable, draft-first outreach workspace for the Delta marketing handoff. It stores contacts and drafts in encrypted private state and exposes the following agent tools:

- `outreach.contacts.upsert` and `outreach.contacts.list` maintain a deduplicated local contact list.
- `outreach.contacts.update_status` records `new`, `contacted`, `replied`, or `do_not_contact`.
- `outreach.drafts.create` creates a message for `application_follow_up`, `business_outreach`, `recruiting`, or `other`.
- `outreach.drafts.list` and `outreach.drafts.approve` keep the review step visible.
- `outreach.send` can send only an approved draft, always requires a fresh one-time approval, and verifies the configured email connector's result.

The default development email connector is deterministic and does not contact an account. A connected sender must be explicitly configured before this becomes an external delivery path. LinkedIn posts, LinkedIn messages, and Slack messages remain separate human or connector actions; this workflow does not impersonate a user or automate engagement.

## Delta operating loop

1. Import an authorized application export or webhook payload into contacts with source `application-form` and campaign `application-follow-up`.
2. Review the contacts and exclude anyone who opted out or is not eligible for follow-up.
3. Draft short, truthful follow-ups for abandoned applications and business-outreach messages for marketing.
4. Review recipient, purpose, facts, and wording; approve only the drafts that are ready.
5. Send one approved draft at a time after the fresh approval prompt, then verify delivery.
6. Record replies and opt-outs so the next run does not contact the wrong person.

The form provider should supply only the fields needed for this loop. It must not be treated as permission to scrape LinkedIn, infer consent, or send a bulk campaign. The system intentionally leaves the final form account, sender identity, audience, and message policy under team control.
