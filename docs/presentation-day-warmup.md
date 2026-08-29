# Presentation-day profile warm-up (~15 minutes)

Cold Kestrel profiles make **What Should I Do** (New Tab widgets, suggested actions)
and **It Remembers How I Work** (memory badge, Recent memories widget) look sparse on
stage. Run this scripted warm-up on the **presentation Mac** after section G install
steps and **before** the audience arrives.

This is not demo mode or fixture seeding — it uses the same real profile, local model,
and encrypted database the live demo will use.

**Related:** [Stanford demo checklist](stanford-demo-checklist.md) (E6, C5, G) ·
[AI Tinkerers runbook](ai-tinkerers-demo.md) (New Tab + memory beats)

---

## When to run

| Timing | Action |
| --- | --- |
| **Morning** | After `install:mac:dev`, Readiness green, disposable project on disk |
| **T−15 min** | Run this full script (browse, first task, memory, verify New Tab) |
| **T−10 min** | Send one short chat to warm the local model (repeat if the slot slips) |

---

## Prerequisites (already done from section G)

- [ ] `corepack pnpm install:mac:dev` && `open -a Kestrel`
- [ ] **Tools → Readiness** — protected store, database, local runtime, model route, packaged app all green
- [ ] Settings → Memory — **explicit capture on**; shared context injection on for the active personality
- [ ] Disposable project checkout on disk with dependencies cached (for first task / ten-minute path)

---

## Scripted warm-up (~15 minutes)

### 1. Open disposable project (2 min)

1. In Kestrel, **Add project** and grant the disposable demo checkout (read/write as rehearsed).
2. Confirm the project appears in the sidebar and workspace grants.

### 2. Browse 3–4 sites for Frequent tabs (3 min)

Open the **user browser** (not only Kestrel app pages) and visit **three or four**
distinct HTTPS sites you are comfortable showing on stage — for example a docs page,
a reference site, and one project-related URL. Stay on each page long enough for
history to record a visit.

1. Open a new browser tab for each site (or use the address bar).
2. Return to **Kestrel Home** (new tab) once — confirm **Frequent tabs** is no longer
   empty (may need a second new-tab open after history sync).

### 3. Run one read-only agent task (4 min)

Use the guided **Try a first task** path if the profile is still fresh, **or** open a
new agent chat on the disposable project and send:

```text
Inspect this project read-only. List the top-level files and read README.md or package.json. Summarize one concrete fact in one sentence. Do not edit anything.
```

Wait for completion (expect **1–2 minutes** on a cold 9B local model). This seeds
**Recent work** and suggested actions without approvals or network.

### 4. Capture one explicit memory (2 min)

In any chat, send exactly:

```text
Remember that I prefer concise status updates in demos.
```

Point at the in-thread confirmation. Optionally open **Life → Memory** and confirm
**Confirmed** status (rehearses the memory beat).

### 5. Warm local model (2 min)

Within **10 minutes of going on stage**, open a short chat:

```text
Reply with one sentence confirming you are ready.
```

Follow-ups should be much faster once the model is resident. Repeat this step if the
slot is delayed and Ollama keep-alive may have expired.

### 6. Verify New Tab home (2 min)

Open a **new browser tab** (Kestrel Home). Confirm:

- [ ] Time-of-day greeting (not generic empty shell)
- [ ] **Memory recall badge** shows at least one active memory (not only the empty prompt)
- [ ] **Frequent tabs** lists recent sites
- [ ] **Recent memories** widget shows the captured preference with **Confirmed**
- [ ] **Recent work** or **Suggested actions** reflect the read-only task (optional but ideal)

If widgets are still empty, repeat steps 2–4 once; do not reset the profile.

---

## Automated probe (optional)

Read-only checklist against the desktop profile (no secrets printed):

```bash
node scripts/presentation-warmup-check.mjs
```

Override profile location if needed:

```bash
KESTREL_PROFILE_DIR="$HOME/Library/Application Support/Kestrel" \
  node scripts/presentation-warmup-check.mjs
```

**PASS** means counts and recency look ready for stage; **FAIL** lists what to repeat
from the script above. UI verification (greeting, badge copy, widget layout) still
requires a quick visual check on New Tab.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Frequent tabs empty after browsing | Open two more external HTTPS tabs; wait 10s; open a fresh Kestrel Home tab |
| First task stalls ~3+ min | Cancel once; confirm Readiness model route; re-run step 5 warm-up |
| Memory not confirmed | Settings → Memory → explicit capture **on**; re-send the `remember that …` line |
| New Tab badge says “Say remember that …” | Step 4 did not persist — repeat memory capture |
| Probe cannot open database | Open Kestrel once (unlocks profile); if Keychain-protected legacy key, verify manually in app |

---

## After warm-up

Proceed to [ai-tinkerers-demo.md](ai-tinkerers-demo.md) for the ten-minute path and
memory beat rehearsal. Re-run step 5 (model warm) immediately before walking on stage.
