# Paired node protocol

Kestrel's authenticated remote gateway includes a bounded extension protocol for
operator-supplied paired nodes. Kestrel itself ships only as a direct-download
Apple Silicon macOS application; the repository does not ship or advertise an
iOS, Android, App Store, or Google Play companion.

An external node may beacon a stable ID, user-visible label, platform, version,
supported capabilities, and optional idle duration. Presence excludes IP
addresses, input events, foreground applications, window titles, and
coordinates.

Authenticated node routes support polling, bounded results, foreground Talk
transcripts, wake-phrase configuration, and permission-gated location command
contracts. These routes exist so a separately developed signed extension can
interoperate without being bundled into Kestrel. Consequential work still
returns to the desktop approval boundary.

The server implementation and protocol tests live in
`packages/agent-core/src/native-nodes.ts`,
`packages/agent-core/src/native-nodes.test.ts`, and
`packages/agent-core/src/remote-http.test.ts`.
