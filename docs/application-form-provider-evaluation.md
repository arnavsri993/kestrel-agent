# Application-form provider evaluation

Checked 2026-08-03 against the providers' current public documentation. The Delta replacement needs the existing questions, a cleaner link than the current Vresonance-branded URL, shareable forms, conditional logic and uploads if the current application uses them, and visibility into partial applications so abandoned applicants can be followed up.

## Recommendation: Tally Pro

Tally is the best fit for the application plus outreach workflow. Its free plan covers unlimited forms and submissions, file uploads, conditional logic, and integrations including Google Sheets, Airtable, Zapier, Make, and webhooks. Tally Pro is the relevant paid step because it removes Tally branding, supports a custom domain, and adds partial-submission access. See [Tally pricing](https://tally.so/pricing) and [Tally features](https://tally.so/help/features).

The tradeoff is that a truly clean, team-owned application URL requires the paid plan. That is still a better match for the team's stated problem than upgrading the current form only to see abandoned applicants.

## Alternatives

| Provider | Strength | Limitation for this use |
| --- | --- | --- |
| [Weavely](https://www.weavely.ai/pricing) | Free unlimited forms and responses, multipage forms, logic, file uploads, styling, and team functionality. | Its custom domain and removal of Weavely branding are paid features; partial-submission visibility is not the clearest documented fit for this pipeline. |
| [Fillout](https://www.fillout.com/vs/google-forms) | Useful short-term stopgap with unlimited responses and broad integrations. | Fillout documents custom domains and removal of branding for Business/Enterprise; that is a large jump for a simple application form. See [custom domains](https://www.fillout.com/docs/help/custom-domains). |
| [Typeform](https://www.typeform.com/pricing) | Polished respondent experience. | The free plan allows only 10 responses per month and keeps Typeform branding, so it is a poor fit for a growing recruitment funnel. See [Typeform's free-plan limits](https://help.typeform.com/hc/en-us/articles/360032972852-Free-plan). |

## Migration checklist

1. Export the current form questions and mark required, conditional, upload, and consent fields.
2. Rebuild them in Tally and preserve the exact wording unless the team approves a change.
3. Publish on a team-owned custom domain and enable partial submissions.
4. Test a complete submission, an abandoned submission, a conditional branch, and an upload.
5. Share the new link with the Delta group and retire the old link only after the team confirms the replacement works.
6. Connect a least-privilege export or webhook to Kestrel. The integration should create local outreach contacts, never send automatically, and retain the source/campaign for review.
