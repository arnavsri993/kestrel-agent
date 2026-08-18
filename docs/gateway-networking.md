# Gateway networking

Kestrel's remote server can be placed behind a trusted identity proxy, exposed through Tailscale, and advertised on a local macOS network. These features are opt-in and do not weaken the existing pairing, scope, TLS, host, origin, rate-limit, or revocation boundaries.

The server rejects requests whose `Host` header is not a configured local/bound host,
an IP literal on a wildcard bind, or an explicit `--allowed-hosts` entry. This is a
DNS-rebinding defense; `--allowed-origins` also contributes its exact hostname.

## Trusted identity proxy

Pass an owner-only JSON file with `--trusted-proxy-config`. The file must be a regular file, must not be a symbolic link, must be no larger than 1 MB, and must have no group or other permissions.

```json
{
  "trustedSources": ["10.42.0.0/24"],
  "userHeader": "x-auth-user",
  "requiredHeaders": ["x-forwarded-proto", "x-forwarded-host"],
  "allowUsers": ["operator@example.com"],
  "allowLoopback": false,
  "maximumScopes": ["read", "tasks"]
}
```

```sh
chmod 600 ./trusted-proxy.json
kestrel remote serve \
  --host 0.0.0.0 \
  --port 18789 \
  --trusted-proxy-config ./trusted-proxy.json \
  --proxy-terminated-tls yes \
  --allowed-hosts control.example
```

Authentication succeeds only when the socket peer matches an exact configured IP or CIDR, all required headers exist, the normalized identity is allowed, and the requested scopes fit the configured cap. A request from a non-loopback local host interface is rejected as a spoofing guard. Loopback proxy trust is denied unless `allowLoopback` is deliberately enabled. `--proxy-terminated-tls yes` is a separate acknowledgement that the trusted proxy terminates HTTPS; without that flag, the existing non-loopback TLS requirement remains in force. There is no fallback from a failed proxy identity to an unscoped request.

The proxy may send `x-workstrand-scopes: read,tasks`; absent that header, the configured maximum is used. Kestrel understands only `read`, `tasks`, and `approve`.

## Tailscale Serve and Funnel

Serve keeps the Kestrel HTTP listener on loopback while the logged-in Tailscale daemon terminates tailnet HTTPS:

```sh
kestrel remote serve \
  --host 127.0.0.1 \
  --port 18789 \
  --tailscale serve \
  --tailscale-service svc:workstrand
```

Kestrel verifies that `tailscale status --json` reports a running, online device with a MagicDNS name before changing exposure. Commands are passed as an argv array without a shell. By default, Kestrel resets only the Serve or Funnel rule it applied when the process exits; use `--tailscale-reset-on-exit no` only when a persistent operator-managed rule is intentional.

Funnel is public internet exposure and therefore requires a conspicuous acknowledgement:

```sh
kestrel remote serve \
  --host 127.0.0.1 \
  --port 18789 \
  --tailscale funnel \
  --tailscale-public-ack public
```

Funnel does not bypass Kestrel authentication. Paired bearer credentials, scope checks, origin checks, rate limits, and revocation still apply.

## Bonjour discovery

On macOS, `--bonjour minimal` registers `_workstrand-gw._tcp` through the system `/usr/bin/dns-sd`. Minimal mode publishes only the display name, port, transport role, TLS state, and optional certificate SHA-256. `--bonjour full` may additionally publish an operator-supplied tailnet DNS name, SSH port, and CLI path. Discovery defaults to off.

```sh
kestrel remote serve \
  --host 127.0.0.1 \
  --port 18789 \
  --bonjour minimal \
  --bonjour-name Kestrel
```

mDNS TXT records are unauthenticated discovery hints. A client must never let them replace stored certificate trust or the pairing boundary. The implementation deliberately does not advertise credentials, tokens, hostnames discovered from the machine, workspace paths, or other private state. Built-in advertising currently requires macOS; container multicast routing remains the operator's responsibility.

## Multi-tenant boundary

This gateway is a single-owner process. Adding a tenant identifier to requests would not create isolation and is not supported. A real multi-tenant deployment must run one complete Kestrel cell per tenant with separate processes or containers, state directories, encryption keys, credentials, workspaces, loopback ports, networks, and resource limits. Host operators remain trusted; mutually hostile tenants require separate machines or virtual machines.

`TenantFleet` now bundles the host-side isolated-cell lifecycle used by an operator plane. Every cell gets a separate hardened Docker or Podman container, private state and auth-profile mounts, user-defined network, generated gateway token, resource limits, read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, and a distinct loopback-only port. Create returns the token once; status inspects liveness; removal deletes the container and registry entry while retaining tenant data.

Docker egress blocking is deliberately rejected because an internal Docker network breaks the published loopback port; enforce it with host firewall policy. Podman can use an internal network. The fleet does not pretend that a shared gateway, session ID, or sandbox is a tenant authorization boundary, and hostile tenants still require separate VMs or machines.
