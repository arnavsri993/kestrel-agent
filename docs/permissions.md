# Permissions and approvals

## Action levels

- Level 0: read-only analysis and drafts.
- Level 1: reversible local/tentative changes, configurable.
- Level 2: external communication, approval by default.
- Level 3: sensitive submissions, explicit review every time.
- Level 4: high-consequence actions, strong confirmation and reauthentication.

Policies are scoped by capability, connector, relationship, recipient, and purpose. External content can never create or widen a permission. Every persistent allow rule is visible and revocable.

macOS permissions are requested at use, not in a blanket onboarding screen. Selected folders are allowlisted; Accessibility, Screen Recording, microphone, camera, and Apple Events remain off unless their capability is invoked. Launch at Login is opt-in and the UI distinguishes the user's preference from macOS's actual registration state.

Whole-desktop computer use is a separate, explicit opt-in in Settings → Agent →
Permissions & sandbox and is disabled by default. Kestrel's status check is
non-prompting: it reports the current Screen Recording and Accessibility state,
while buttons open the matching macOS Privacy & Security pane. The native
checks remain authoritative, so capture and input fail closed when either the
preference or the required permission is missing. Existing isolated and
user-visible browser flows remain separate from whole-desktop control.

Structured commerce-style results (lists, comparisons, plans, and outcomes)
are presentation-only. Links are credential-free HTTP(S), open only after a
person clicks them, and remain untrusted; the presentation surface does not
add cart, checkout, payment, account-creation, or purchase authority.
