# Delta CTO task plan

This plan is grounded in the Delta Consulting Officers LinkedIn group conversation reviewed on 2026-08-03. It separates the tasks explicitly directed to Arnav from work assigned to other teammates.

## Arnav's tasks

| Task | Source in the conversation | Result |
| --- | --- | --- |
| Replace the current application form with the same questions on a cleaner provider, then share the link with the group. | Kharishma asked everyone to make a replacement form; Sashi then asked Arnav directly whether he could do it. | Provider recommendation and migration checklist are in [application-form-provider-evaluation](application-form-provider-evaluation.md). |
| Send the AI outreach agent to marketing so businesses can be contacted more efficiently. | Vyom directly tagged Arnav and asked for the AI agent to be sent to marketing. | The approval-gated outreach system is implemented in `@kestrel/agent-core`; see [outreach-and-application-workflow](outreach-and-application-workflow.md). |
| Like and repost the latest post. | Sashi asked `@All` to like and repost. | Manual LinkedIn action; no automated engagement was performed. |

## Team dependencies, not silently reassigned to Arnav

- Sashi owns following up with applicants who left applications in progress, plus additional personal and organization LinkedIn posts.
- Kharishma owns the contribution-points leaderboard and final pod restructuring.
- Vyom asked for a larger outreach/marketing posting team and daily Slack engagement expectations.

The conversation reported eight applications in progress but only one completed, while the current form did not expose the people who abandoned the process. That is a form-provider requirement from the team, not an assumption that Kestrel can access those records without an authorized export or webhook.

## Ready-to-send CTO handoff

> CTO update: I reviewed the application-form issue and recommend moving the application to Tally Pro so we can use the same questions, get a clean custom domain, see partial submissions, and connect the application flow to outreach automation. I also added a draft-first outreach workflow: contacts are imported locally, messages are drafted and reviewed, and sending requires a fresh approval plus provider verification. I have not sent LinkedIn posts, form invitations, or outreach messages automatically.

## Remaining human actions

1. Confirm the exact application questions and any file-upload/conditional-logic behavior.
2. Create the chosen form account, publish it on the team domain, test one submission and one abandoned submission, and share the URL in the LinkedIn group.
3. Connect an approved form export or webhook to Kestrel; do not paste credentials into chat.
4. Provide marketing with the approved outreach audience, sender account, and message policy.
5. Like/repost the requested LinkedIn post manually.
