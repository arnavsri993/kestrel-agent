# Google Workspace OAuth

Kestrel supports a user-owned Google OAuth client for Gmail send, read-only recent-message lookup, and Google Calendar events and availability checks. This is usable before Kestrel has its own publicly verified Google client registration.

## User setup

1. Create or select a project in Google Cloud Console.
2. Enable the Gmail API and Google Calendar API.
3. Configure the OAuth consent screen.
4. Create an OAuth client with application type **Desktop app**.
5. In Kestrel, open **Connections → Google Workspace**, enter the client ID, and choose **Connect with Google**.
6. Complete consent in Google's external browser. Kestrel never asks for a Google password, authorization code, access token, or refresh token.

The requested grants are deliberately narrow:

- `openid`
- `email`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.events`

The read-only Gmail grant is used only when the user asks Kestrel to find a
recent verification code for an active browser login. Kestrel returns the
short code and message metadata to the trusted desktop surface; it does not
send message bodies to the agent or store them in task history.

## Calendar availability boundary

`google.calendar.check-availability` verifies up to 20 exact candidate
intervals from one bounded 31-day window. Every candidate must include an ISO
date-time with an explicit UTC offset. The connector asks Google only for event
status, transparency, start, end, pagination, and the primary calendar time
zone. Event titles, descriptions, attendees, locations, and meeting links are
not requested or returned by this tool.

Calendar event reads are labeled as untrusted connector content before they
can influence a later mutation. Page, message, or event text is evidence, not
authorization; the existing consequential-action approval boundary still
decides whether an event may be created.

Cancelled and explicitly transparent events do not block a candidate. Opaque
timed and all-day events do. Adjacent intervals do not count as overlaps. The
connector follows bounded pagination for at most 1,000 events and fails closed
instead of claiming availability when the result is malformed, changes time
zones during pagination, or exceeds that density limit. This uses the existing
`calendar.events` grant and does not add another OAuth scope.

## Security and lifecycle

- Every sign-in uses a new high-entropy state value and PKCE S256 verifier/challenge.
- The callback server binds to `127.0.0.1` on a random port and accepts one exact callback path and state.
- Google identity and Calendar access are verified before the connection is saved.
- The refresh record is encrypted through macOS secure storage in an owner-only file.
- Access tokens are refreshed and cached only inside the isolated core process; they are not persisted or sent to the renderer/model.
- Disconnect calls Google's revocation endpoint and removes the local encrypted record even if revocation cannot be confirmed.
- Gmail sends and Calendar mutations remain approval- and idempotency-gated. Calendar creates use a deterministic provider event ID and are read back before verification.
- Availability checks are read-only, content-minimized, time-zone-aware reads. They return a verified busy/free result only after all bounded pages have been inspected.

Google recommends PKCE for installed desktop apps, secure token storage, revocation, and loopback redirects for desktop flows:

- <https://developers.google.com/identity/protocols/oauth2/native-app>
- <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>
- <https://developers.google.com/workspace/gmail/api/auth/scopes>
- <https://developers.google.com/workspace/calendar/api/auth>

## Public distribution boundary

A public Kestrel OAuth client still requires the final product identity, production domains and privacy-policy URLs, Google consent-screen configuration, API enablement, and Google's applicable verification process. Until those external release inputs exist, the app accurately presents the user-owned Desktop client path rather than shipping an unverifiable shared client ID.
