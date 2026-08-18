# Communication code recovery

Kestrel's macOS-first browser can recognize the common state where the active
website is asking for a one-time verification code. It keeps the recovery path
visible and user-controlled:

1. The visible page is inspected locally for a likely code field and a
   verification prompt.
2. Kestrel shows a corner helper in the Browser/Agent rail and, when supported,
   a native macOS notification. Detection never reads a mailbox.
3. The user selects **Find code**. Kestrel searches only the sources that are
   connected and available, looking back 30 minutes.
4. The helper shows only short candidate codes plus bounded sender, subject,
   account, source, and time metadata. Message bodies never enter the agent
   conversation or task history.
5. **Use code** is a separate explicit action. Kestrel rechecks the active tab
   and domain, focuses the likely verification field, replaces its selection,
   and inserts the code. It never submits the form.

## Sources in this increment

- **Messages on this Mac** reads the local `~/Library/Messages/chat.db` in
  read-only mode. macOS may require the user to grant Kestrel Full Disk Access
  in **System Settings → Privacy & Security**. Kestrel never sends a Message.
- **Connected Gmail** uses the existing user-owned Google Desktop OAuth flow
  with the additional `gmail.readonly` grant. The Gmail search is narrowed by
  the active website domain and code-related terms. Existing Google
  connections made before this grant must be reconnected before code lookup is
  available.

This is intentionally a first vertical slice, not a claim that every mailbox
or messaging provider is connected. Slack, Discord, Teams, Outlook, and
additional Google accounts need separate connectors and permission reviews.

## Boundaries

- Scans are explicit; page detection does not automatically search messages.
- A scan is kept in desktop memory for two minutes and is not persisted to
  encrypted task history.
- Results are bounded to ten candidates. Gmail message reads are bounded in
  count and response size; local Messages reads are bounded to recent rows.
- The website is untrusted content. Its text can trigger a prompt but cannot
  authorize a scan, reveal message data, widen permissions, or submit a form.
- The raw `communication-code-search` core request is not exposed as a direct
  renderer operation; the main process only invokes it after validating an
  active verification page.

See [Google Workspace OAuth](google-workspace-oauth.md), [the threat model](threat-model.md),
and [the permissions guide](permissions.md) for the surrounding credential and
macOS permission boundaries.
