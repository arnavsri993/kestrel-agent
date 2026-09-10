# Provider accounts and model catalogs

Kestrel treats a model route as a specific account-backed endpoint, not as a
vendor label. The runtime hierarchy is:

```text
Provider -> Account -> Authentication transport -> Capabilities -> Models
```

`ProviderAccountStore` keeps account metadata in the desktop profile and puts
keys, header values, and other credentials behind the credential broker. The
renderer receives summaries only; it never receives an API key, OAuth token,
or CLI credential path that could be used as a secret.

## Adding an adapter

Add a `ProviderAccountAdapter` in `packages/shared-types/src/contracts.ts`,
then implement its account-aware `ModelProvider` construction in
`packages/agent-core/src/providers/account-providers.ts`. An adapter must:

- declare the supported transport rather than accepting arbitrary auth types;
- use `providerFetch` for remote discovery so redirects, response size, and
  error handling remain bounded;
- implement `discoverModels` when its supported public API or CLI can list the
  caller's models;
- report only capability fields that the discovery response actually confirms;
- supply a labelled fallback model only when discovery is unavailable, never
  merely because a request failed.

Every account gets an independent endpoint ID. Requests carry that endpoint
ID through the provider pool, preserving account choice even when two accounts
offer a model with the same name.

## Catalog truthfulness

`ModelCatalog` caches each endpoint's discovered records privately and marks a
catalog stale when a refresh is overdue. A failed refresh retains the last
usable catalog as stale and exposes a safe diagnostic; it does not discard a
known model list or expose raw upstream errors. Successful empty discovery
means the provider removed or no longer entitles the account to those models.

Capability provenance is intentional. Automatic routing considers an account
model only after discovery marks it `available`. For a task that needs tools,
vision, or structured output, its capabilities must be `confirmed` at the
model level. `transport` records are documented fallback behavior and
`unknown` records are available for explicit user selection; neither is
silently chosen for a task requiring a capability Kestrel cannot verify.
Pre-account static provider configurations retain their existing compatibility
behavior until they are migrated into an account catalog.

The official Codex app-server adapter uses its stable `model/list` protocol
call for each isolated ChatGPT/Codex profile. Those protocol records reflect
the models the signed-in account currently exposes, rather than Kestrel's
fallback default. Kestrel records the advertised reasoning levels and image
modality. It forwards current-message images as bounded inline data URLs only
when the selected model advertises image input; it does not claim shell,
file-editing, browser mutation, raw document/video input, or model tool
capabilities that the adapter cannot execute. HEIC and HEIF image attachments
are normalized locally to JPEG for the Codex image-input format.

## UI and routing boundary

Model selectors group entries as Provider -> Account -> Model and retain the
account ID beside the executable endpoint ID. Automatic routing resolves from
the dynamic catalog. An explicit manual selection pins the exact account and
model; it never turns a provider-wide display label into a routing target.

When **Balanced** sees the same available model at equal score and cost on two
or more account-specific endpoints, it rotates those endpoints. Health,
concurrency, quota, capability, latency, and cost differences remain more
important than rotation, so an account under pressure is not selected merely
to keep the count even.

When adding a new surface that runs a model, consume `providerAccounts` from
`runtime-list-providers` and use the same account-aware selector utilities.
Do not recreate a static vendor/model array or special-case a local provider.

## Security boundary

Use official provider APIs, documented CLIs, or supported protocols only.
Kestrel must not scrape browser profiles, tokens, cookies, or private vendor
endpoints. If a CLI has no documented isolated-profile flow, expose its
existing detected profile honestly instead of inventing an isolation mechanism.

## Explicitly unsupported subscription connectors

This build does not expose Cursor or Google AI subscription profiles as account
connection types. There is no tested, account-isolated Kestrel transport for
those subscriptions yet, so the settings screen marks them unsupported rather
than accepting a browser profile, copied token, cookie, or an undocumented
endpoint. A Gemini API account remains supported through Google's public API;
a self-hosted service can use the OpenAI-compatible loopback or HTTPS adapter.
