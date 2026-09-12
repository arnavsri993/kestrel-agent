# Browser autofill validation

Kestrel's autofill is a local protected-store implementation for its Electron browser views. It is not Microsoft Edge's native password manager, and a passing fixture suite does not establish equivalent website coverage.

## Verified behavior

Run `corepack pnpm build:desktop && corepack pnpm test:desktop-autofill` for real Electron preload and complete desktop checks. CI runs this suite after the visible browser smoke.

The suite covers:

- Exact-origin login fill, typed-value preservation, section-prefixed autocomplete tokens, and separation between existing and generated passwords.
- Scripted and form-less login buttons, standard submissions, username-first flow context, and controls associated with a form through `form=`.
- Same-document login completion, repeated completion notifications, and rejection when password controls are hidden or return during loading. Same-document success requires a second scan after at least 600 ms of absence.
- Protected profile persistence, serial merging, clearing independently of passwords, and rejecting arbitrary secret keys.
- Name, address, birthday, dropdown, and below-viewport form filling through the actual isolated preload. Shipping/billing sections and separate forms remain isolated.
- Open Shadow DOM discovery, focus and filling; inherited visibility, inert containers, and disabled fieldsets.
- Same-origin HTTPS iframe discovery, nested frames, embedded submission capture, frame-relative popup coordinates, and revalidation after frame navigation. Cross-origin, opaque sandbox, hidden, and detached frames are excluded. Embedded save confirmation fails closed when the submitted document is replaced.
- Login/sign-up form isolation, focused controls beyond the first 32 fields, password-change capture of the new password, and field IDs that expire after semantic changes or document navigation.
- Payment scan/save/fill share one classifier and run in a dedicated isolated JavaScript world. Stable element IDs survive insertions and expire after field changes. Tests cover PAN/company disambiguation, CVV/OTP exclusion, inherited hidden/disabled/read-only fields, month/year dropdowns, form and shipping/billing isolation, preservation of nonempty values, and accurate fill failure reporting.
- Rechecking the active tab, page, and suggestion after protected storage access; cancellation during a saved-login lookup prevents filling and discards the secret.
- Stable field identity when the page inserts other fields; refused values do not count as successful fills.
- Main-frame and active-tab restrictions, stale navigation rejection, personal-info settings, and native popup-to-form filling in the full desktop app.

The tests use synthetic fixture values and isolated profiles. They do not submit real credentials to providers.

## Remaining differences from Edge

- Kestrel currently stores one personal-info profile, rather than an address book of multiple selectable people/addresses.
- No cloud synchronization, password-breach monitoring, or Edge/Chrome password import is included in this feature.
- Closed shadow roots, cross-origin embedded frames, `srcdoc`/`about:blank` frames, arbitrary custom form controls, and multilingual field inference are not covered.
- Payment-card detection currently covers top-level standard controls; the nested-frame and Shadow DOM traversal applies to passwords and personal info. Payment controls below the viewport must be scrolled into view.
- Sign-in success remains an inference from form disappearance and a trusted navigation relationship, not confirmation from a provider's authentication response. Sites that retain a password control may require manual saving support in a future iteration.
- Fixture coverage is not a measured comparison against Edge on a representative live-site corpus.

Microsoft documents Edge's saved address selection and password management at https://www.microsoft.com/en-us/edge/features/autofill and its broader data handling at https://learn.microsoft.com/en-us/legal/microsoft-edge/privacy. These are comparison references, not guarantees about Kestrel.
