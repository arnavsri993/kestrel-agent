# Token Arena & Competitive Leaderboard

Kestrel provides built-in, local-first **Token Usage Tracking** and a competitive **Community Leaderboard & Arena** allowing developers and teams to benchmark throughput, optimize prompt caching efficiency, and compete for tier ranks.

---

## 1. Core Architecture & Local-First Philosophy

All token counting, prompt cache tracking, reasoning token attribution, and cost estimation are performed **on-device** using SQLite audits (`model_call_audits` and `user_token_streaks`).

```
┌─────────────────────────────────────────────────────────────┐
│                    Kestrel Local Runtime                    │
├──────────────────────────┬──────────────────────────────────┤
│ Model Call Audits        │ Token Usage Aggregator           │
│ Daily Streak Counter     │ Prompt Efficiency ROI Engine     │
└────────────┬─────────────┴────────────────┬─────────────────┘
             │                              │
             ▼                              ▼
 ┌──────────────────────┐       ┌────────────────────────┐
 │ Desktop Arena Panel  │       │  CLI (kestrel tokens / │
 │ & Local Analytics    │       │  kestrel leaderboard)  │
 └──────────────────────┘       └────────────────────────┘
             │
   (Opt-in Verification)
             ▼
 ┌───────────────────────────────────────────────────────┐
 │       Kestrel Web Arena (/leaderboard)                │
 │  • Top-3 Podium Champions                             │
 │  • 4 Competitive Categories (Volume, Efficiency, ...) │
 │  • Pseudonymous & Anonymous Handle Support            │
 └───────────────────────────────────────────────────────┘
```

### Privacy & Anti-Leakage Boundary

- **Zero Prompt Leakage**: Prompts, tool arguments, workspace file paths, and conversation contents never leave the user's machine.
- **Opt-In Competition**: Leaderboard participation is strictly opt-in.
- **Pseudonymous Handles**: Users can compete under a custom handle or as `Anonymous Agent`.

---

## 2. Scoring & Competitive Categories

### Competitive Categories

| Category | Description | Primary Metric |
| :--- | :--- | :--- |
| **🏆 Token Titans** | High-volume builders and extensive multi-agent runs | `totalTokens` (Input + Output) |
| **⚡ Efficiency Architects** | Highest task completion and cache hit ratio per token | `efficiencyScore` (%) |
| **🔥 Streak Masters** | Consistency and active builder momentum | `streakDays` (consecutive days) |
| **🧠 Deep Reasoning** | Utilization of thinking/reasoning models on complex jobs | `reasoningTokens` |

### Prompt ROI & Efficiency Formula

The Efficiency Score evaluates how effectively an agent converts tokens into verified task completions while maximizing prompt caching:

$$\text{ROI} = \min\left(100, 45 + \left(\frac{\text{Tasks Completed}}{\text{Tokens} / 10\,000} \times 22\right) + \left(\frac{\text{Cached Tokens}}{\text{Total Tokens}} \times 35\right) + \min(15, \text{Streak} \times 1.5)\right)$$

### Competitive Tiers

| Tier | Badge | Criteria |
| :--- | :---: | :--- |
| **Grandmaster** | 👑 | 5,000,000+ total tokens **OR** 92%+ efficiency with 14+ day streak |
| **Titan** | ⚡ | 3,000,000+ total tokens **OR** 85%+ efficiency with 10+ day streak |
| **Architect** | 🎨 | 1,000,000+ total tokens **OR** 75%+ efficiency |
| **Specialist** | 🎯 | 300,000+ total tokens **OR** 60%+ efficiency |
| **Apprentice** | 🌱 | Initial starter tier (< 300,000 tokens) |

---

## 3. Web & Desktop Interfaces

### Website (`/leaderboard`)

- **Podium Showcase**: Top 3 ranking builders with animated tier badges, handles, and live stats.
- **Interactive Rankings Table**: Filterable by category, timeframe, and tier; searchable by handle or model.
- **Token Efficiency & Savings Calculator**: Interactive sliders to estimate monthly volume, cache hit savings, and projected arena rank.
- **Local Stats Sync**: Connect local Kestrel instances to the community board.

### Desktop Workbench

- In-app **Arena** tab in the main navigation sidebar.
- Displays personal token odometer (Today, Week, Total, Streak, Tier Badge).
- Live community standings with one-click preferences for anonymous/pseudonymous participation.

---

## 4. CLI Usage

### View Community Leaderboard

```bash
# View weekly volume standings
kestrel leaderboard

# Filter by category and timeframe
kestrel leaderboard --category efficiency --timeframe month
kestrel leaderboard --category streak --timeframe all_time
```

### Inspect Local Token Metrics

```bash
kestrel tokens
kestrel tokens --timeframe today
```

---

## 5. IPC Contract Reference

```typescript
// Request
{
  type: "token-leaderboard-get",
  category?: "volume" | "efficiency" | "streak" | "reasoning",
  timeframe?: "today" | "week" | "month" | "all_time"
}

// Response
{
  ok: true,
  tokenLeaderboard: {
    category: "volume",
    timeframe: "week",
    entries: TokenLeaderboardEntry[],
    currentUserEntry?: TokenLeaderboardEntry,
    totalParticipants: number,
    updatedAt: string
  }
}
```
