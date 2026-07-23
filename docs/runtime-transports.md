# Runtime transports

## Web access

Web tools are disabled by default. Configure exact fetch/result hosts with
`KESTREL_WEB_ALLOWED_HOSTS=docs.example.com,api.example.com`. To permit any
public HTTPS host after DNS/private-address checks, explicitly set
`KESTREL_WEB_ALLOW_PUBLIC=true`.

Set `BRAVE_SEARCH_API_KEY` to enable the Brave Search adapter. The key remains
inside the CLI process or isolated desktop utility process and is never sent to
the renderer. Search and fetch output is bounded and labeled untrusted.

## Channels

Set `KESTREL_CHANNEL_CONFIG` to an owner-only (`0600`) JSON file:

```json
{
  "version": 1,
  "channels": [
    {
      "id": "support",
      "outbound": {
        "url": "https://hooks.example.com/kestrel",
        "authorizationHeader": "Bearer replace-me"
      },
      "inboundSecretBase64": "replace-with-32-to-64-random-bytes-in-base64",
      "sessionId": "runtime-session-id"
    }
  ]
}
```

Outbound delivery requires tool approval and an idempotency key. Inbound
messages enter through `POST /v1/channels/inbound`, require an HMAC-SHA256 of
the canonical JSON envelope in `x-kestrel-signature`, are deduplicated, and are
routed to the configured server-side session. The sender cannot select a
session.

## Remote host

Create an expiring pairing code locally, then launch the host:

```sh
kestrel remote pair --label phone --scopes read,tasks,approve
kestrel remote serve --host 127.0.0.1 --port 0
```

Plain HTTP is restricted to loopback. Non-loopback binds require both
`--tls-key` and `--tls-cert`. Use `--allowed-origins` for browser clients.
Revoke a paired device locally with `kestrel remote revoke --device <id>`.
