# Enterprise deployment

Kestrel supports company-managed policy through an owner-signed Ed25519
envelope. The app does not invent an organization, collect a private signing
key, or silently enable enterprise controls. Without a valid policy, Settings
shows `Unmanaged` and the local-first product remains usable.

## What the organization supplies

The managed launch environment must provide both absolute paths:

- `KESTREL_MANAGED_POLICY`: owner-only JSON envelope, no larger than 1 MB.
- `KESTREL_MANAGED_POLICY_KEY`: bounded public-key file containing the Ed25519
  verification key.

Both variables are required together. The policy envelope has this shape:

```json
{
  "algorithm": "Ed25519",
  "policy": {
    "organizationId": "org-example",
    "version": 1,
    "allowedProviders": ["local"],
    "deniedTools": ["shell.run"],
    "maximumWorkers": 4,
    "retentionDays": 30,
    "analyticsEnabled": false
  },
  "signatureBase64": "<signature over the canonical policy JSON>"
}
```

The private signing key stays in the organization's signing system and is
never shipped to Kestrel or to end-user Macs. Policy updates must use a higher
`version`. Worker limits are 1–64 and retention is 1–3650 days. Optional SSO
must use an HTTPS issuer, audience, Ed25519 public key, and any approved email
domains.

The app rejects missing pairs, symlinks, permissive policy files, malformed
envelopes, invalid signatures, and policy values outside those bounds. MDM
should provision the files with the intended owner-only permissions and supply
the two variables through the organization's managed launch environment.

## Release and rollout sequence

1. Obtain Developer ID Application and Developer ID Installer certificates and
   Apple notarization credentials owned by the organization.
2. Run the tagged macOS release workflow. It produces a signed/notarized DMG
   and ZIP for direct distribution plus a signed PKG for MDM.
3. Install the PKG on one clean enrolled Apple Silicon test Mac.
4. Provision the policy files and launch environment on that test Mac.
5. Open Settings → Advanced and confirm the organization ID, policy version,
   worker limit, retention, and `Managed` status.
6. Exercise one local model route, one approval boundary, backup/recovery, and
   the organization's intended SSO/member workflow before widening the MDM
   scope.

This repository provides the signed-policy contract and PKG target; it does
not provide a company-specific MDM configuration profile, identity-provider
registration, enrollment scope, or private signing credentials.
