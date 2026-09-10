# FTC team operations

Kestrel does not ship an FTC dashboard, a team database, or a special robotics
mode. A team uses the same local agentic workflow that Kestrel already provides
for any complex project: give it a scoped workspace, ask for a concrete outcome,
review consequential actions, and keep verifiable evidence with the work.

That is a particularly good fit for the computer-based work around a robotics
season. Kestrel can organize evidence, plan work, produce drafts, coordinate
agent tasks, and preserve an engineering story. It complements students and
mentors; it does not perform physical robot work.

## One agentic workflow across the team

```text
meeting notes + TeamCode + tests + observations + approved research
                              ↓
          Kestrel: scoped workspace, agent tasks, review gates
                              ↓
work plan → code review/test record → engineering log → scouting brief
           → portfolio draft → outreach/procurement draft → approval queue
```

The same workflow is useful across software, documentation, scouting,
operations, and outreach. Each output should retain its source evidence and
state whether it is a draft, a verified result, or an action awaiting approval.

## Existing agent capabilities applied to FTC work

| FTC workflow | Use the existing Kestrel agentic feature | Verification boundary |
| --- | --- | --- |
| TeamCode and software | Grant the TeamCode workspace; Kestrel can inspect code, make scoped changes, run tests, use Git/worktrees, and prepare a reviewable change. | A passing test or review is not a deployed or field-tested robot result. |
| Weekly planning | Turn meeting notes, issues, test observations, and dates into goals, task lanes, delegated work, and schedules. | The team supplies owners, priorities, and current facts; Kestrel must label assumptions. |
| Engineering documentation | Turn source records, commits, measurements, photos, and test output into an engineering-log or portfolio draft. | A draft cannot claim a mechanism was built or tested without team evidence. |
| Scouting and strategy | Analyze team-provided scouting records or dated public information, then create a brief with assumptions and alternatives. | Projections are not match results, alliance choices, or official event data. |
| Outreach and procurement | Research and prepare drafts, lists, or comparisons inside the workspace. | Sending, submitting, buying, publishing, or changing an external record remains approval-gated. |

The underlying product evidence is already in the repository: the
[architecture](architecture.md) describes scoped workspace tools, persistent
sessions, agent teams, schedules, workflows, and action receipts; the
[AI-native browser](ai-native-browser.md) describes browser/computer boundaries;
and the [browser-agent reliability benchmark](browser-agent-benchmark.md)
documents the deterministic execution evidence and what it explicitly does not
measure.

## A safe first demonstration

1. Give Kestrel a **team-owned workspace** with non-sensitive meeting notes, a
   TeamCode repository, and existing test or observation records. Do not import
   credentials, private student data, or a browser profile.
2. Ask: “Make a weekly FTC plan from these sources. Separate verified evidence,
   assumptions, missing information, and the next tests.”
3. Ask for a source-linked engineering-log or portfolio draft from the same
   evidence. Have a student or mentor review every physical-test, result, and
   external claim.
4. Keep outreach, purchases, calendar changes, publishing, and submissions in
   Kestrel's explicit approval queue. Preserve the resulting action receipt and
   its verification boundary.

An appropriate evaluation statement today is:

> Kestrel is a local, auditable FTC operations copilot for evidence-backed
> planning, software/documentation coordination, scouting preparation,
> portfolio drafting, and review-gated outreach. It complements the team; it
> does not claim autonomous physical robotics or human competition work.

## What is not measured or included

- No productivity percentage or student-equivalent claim has been measured.
- No direct FTC event-data integration, live schedule, roster database, or
  account connection is bundled.
- No CAD integration, fabrication, wiring, field testing, robot driving, pit
  work, safety certification, judging, or automatic rule compliance is
  provided.
- The browser benchmark measures deterministic tool execution against fixtures,
  not model reasoning, real accounts, live FTC websites, or robot performance.

The credible path to a higher estimate is measured team evidence: repeatable
workflows, independently verifiable artifacts, safe approval behavior, and
time logs. It is not an FTC-specific UI layer or a larger prompt.
