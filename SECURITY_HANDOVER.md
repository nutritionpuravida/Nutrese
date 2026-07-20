# Security Handover — Anonymous Access to Protected App Shell

**Date:** 2026-07-20
**Severity:** High (public exposure of authenticated-app UI, including an admin
access-management panel, to anonymous visitors)
**Status:** Fixed — client-side rendering gap closed. See "Remaining risks"
below for what still needs follow-up.

## Summary

Anonymous visitors to `https://www.nutrese.eu` could reach and interact with
the full authenticated application shell (`<div class="app">`) — navigation,
client-profile forms, meal-planning tools, the Account/Subscription page, and
an **Access Administration panel** with "Send invite + grant trial", "Grant
trial", "Extend trial", "Convert to professional", "Set read-only", and
"Revoke" controls — without ever signing in. This was confirmed by fetching
the live homepage: the app markup for all of these screens was present and
rendered in the page delivered to an unauthenticated request.

This was **not** an authentication bypass (no session was created, Supabase
Auth showed no unexpected users, `currentUser` was correctly `null`, and
`subscriptionState` correctly reported `signed_out`) and **not** a routing
bug (Nutrese is a single static `index.html`; there is no client-side router
directing anonymous requests to protected routes). It was a **client-side
rendering / UI-gating bug**: the protected app shell was never wired into the
existing show/hide state machine that already correctly gates the marketing
site, the auth screen, and the subscription screen.

## Root cause

`index.html` has four top-level screens in the DOM:

1. `#marketing-site` — public marketing site
2. `#auth-screen` — sign-in / sign-up
3. `#subscription-screen` — subscription gate (post sign-in, pre-active
   subscription)
4. `<div class="app">` — the actual protected application

Screens 1–3 are each hidden via an explicit `.hidden { display:none }` CSS
rule scoped to their own selector, and are shown/hidden by dedicated
JS functions (`showMarketingSite()`, `showAuthScreen()`,
`showSubscriptionScreen()`, and their `hide*` counterparts) that are called
correctly throughout the sign-in/sign-out/subscription lifecycle.

**Screen 4, the app shell, had no such gate.** Its only CSS rule was
`.app { display: flex; height: 100vh; overflow: hidden; }` — visible
unconditionally — and no JS function ever added or removed a "hidden" class
on it. On page load the app's own initialization code (`calcAll()`,
`calcMacros()`, `renderDashboard()`, etc.) ran and populated the shell
regardless of auth state, before the marketing site was shown "on top" of it.

Because `#marketing-site` is `position: relative` (not a fixed, full-viewport
overlay) and sits earlier in normal document flow, it does not visually or
functionally block the `.app` div that follows it in the DOM. Anonymous
visitors could scroll past the marketing content (or reach it via any
navigation that shortened the visible marketing content) directly into the
live, interactive application shell. This was verified independently by
fetching `https://www.nutrese.eu/` as an anonymous request and confirming the
full app markup — including the admin panel — was present in the response.

In short: **the app shell was never included in the access-gating logic that
already existed for the other three screens.** It rendered by default and
was only ever visually pushed down the page, never actually hidden or
disabled.

## Fix

Minimal, three-part change, entirely in `index.html`:

1. **CSS** — added `.app.hidden { display: none; }`, following the exact
   pattern already used for `#auth-screen.hidden, #subscription-screen.hidden`.
2. **Markup** — changed `<div class="app">` to `<div class="app hidden">` so
   the shell is hidden by default, even before any JavaScript runs (fail-safe
   default).
3. **JavaScript** — added two small helpers, `showAppShell()` /
   `hideAppShell()`, and wired them into the *existing* screen-management
   functions rather than introducing new control flow:
   - `hideAppShell()` is called at the top of `showMarketingSite()`,
     `showAuthScreen()`, and `showSubscriptionScreen()` — i.e. the app is
     hidden any time one of those three screens is shown.
   - `showAppShell()` is called only inside `refreshSubscriptionGate()`, at
     the two points that already represent "access genuinely granted":
     when `SUBSCRIPTION_REQUIRED` is `false` (subscription gate disabled),
     and when `subscriptionState.active` is `true` (a real, checked
     entitlement).

No other code paths call `showAppShell()`. Every other code path in the file
that used to call `hideSubscriptionScreen()` as a reset step (e.g. before
switching to the password-recovery view, or during
`completeSignedOutUi()`/sign-out) already synchronously calls
`showMarketingSite()` or `showAuthScreen()` afterwards in the same function,
which now hides the app shell again — so the final DOM state after every
one of those functions runs is correct.

### Files changed

- `index.html` (22 lines changed: 20 insertions, 2 modifications, no
  deletions of existing logic)

No other files were touched. No styling, copy, layout, meal-planning logic,
Stripe integration, or Supabase auth flow was modified — only the
visibility/gating of the existing `.app` container.

### Verification performed

- Traced every call site of `showMarketingSite`, `showAuthScreen`,
  `showSubscriptionScreen`, `hideMarketingSite`, `hideAuthScreen`,
  `hideSubscriptionScreen`, and `refreshSubscriptionGate` to confirm the app
  shell ends up hidden in every non-entitled code path and shown only when
  entitlement is confirmed.
- `node --check` against the extracted inline JavaScript — no syntax errors.
- Confirmed via a fresh anonymous fetch of the production markup (prior to
  deployment of this fix) that the app shell, including the admin panel, was
  present in the HTML returned to unauthenticated requests — reproducing the
  reported issue at its source.
- App fingerprint (per `AGENTS.md` reporting convention) after this change:
  `6630AFE3`.

## Remaining risks / follow-up recommended

This fix closes the **client-side rendering gap** — the primary reported
symptom (anonymous visitors seeing and interacting with the app UI). It does
not, by itself, constitute a full security audit. Recommended follow-ups for
future development:

1. **Server-side authorization is the real boundary, not this UI gate.**
   This fix hides the UI from anonymous users; it does not and cannot
   substitute for row-level security (RLS) policies and server-side checks
   in Supabase / Stripe. Anyone with browser dev tools can still remove the
   `hidden` class locally and see the *static* markup (with no live data,
   since no session exists) — that's expected and fine. Confirm that every
   Supabase table/RPC involved (clients, plans, appointments, admin
   access-grant actions, etc.) enforces RLS and role checks independent of
   this client-side gate, so that even a modified/compromised client cannot
   read or write data without a valid, entitled session. This should be
   audited explicitly; it was out of scope for this fix.
2. **Admin panel exposure.** The Access Administration panel
   ("Send invite + grant trial", "Grant trial", "Extend trial", "Convert to
   professional", "Set read-only", "Revoke") was part of the exposed markup.
   Confirm the underlying admin actions are gated server-side on the
   `isAdmin` role (referenced in `updateAccountPage()` /
   `subscriptionState.isAdmin`) and not just on `subscriptionState.isAdmin`
   controlling client-side visibility of the panel's *contents* — the panel
   container itself is now hidden along with the rest of `.app` for
   unauthenticated users, but its buttons should be re-verified against a
   role check server-side regardless of what the client renders.
3. **No automated regression test currently guards this behavior.** Consider
   adding a Phase-0-style regression check (per `AGENTS.md` conventions,
   `tests/access-control`) that loads the page with no Supabase session and
   asserts `.app` has `class="hidden"` and is not present in the accessible
   (interactive/focusable) DOM tree. This would catch any future regression
   where a new "hide the gate" call is added without a corresponding
   `hideAppShell()`/`showAppShell()` pairing.
4. **This change modifies auth-adjacent UI code**, which `AGENTS.md` flags as
   requiring approval outside ordinary Phase 0 work. It was made under this
   explicit, scoped security request from the user; it does not touch
   Supabase auth configuration, Stripe integration, or planning-engine logic.
   Flagging here for the record per the project's own change-control rules.
5. **Recommend a manual smoke test in a real browser** (anonymous/private
   window) against staging before/after deploying this change to confirm:
   - Marketing site loads and scrolls normally with no app content visible
     at any scroll position or viewport size.
   - Sign-in → subscription-gate → active-subscription flow still reveals
     the app shell correctly for a real paying/trialing user.
   - Sign-out correctly hides the app shell again.
   - Browser back/forward and `#hash` marketing navigation still behave as
     before.

## Quick reference for future developers

The screen-visibility state machine now has **four** screens, all gated the
same way:

| Screen | Show function | Hide function | Hidden-by-default in markup |
|---|---|---|---|
| Marketing site | `showMarketingSite()` | `hideMarketingSite()` | via `.hidden` CSS class, added by `hideMarketingSite()` |
| Auth screen | `showAuthScreen()` | `hideAuthScreen()` | `class="hidden"` in markup |
| Subscription gate | `showSubscriptionScreen()` | `hideSubscriptionScreen()` | `class="hidden"` in markup |
| **App shell** | `showAppShell()` | `hideAppShell()` | `class="hidden"` in markup (new) |

**Rule of thumb for any future change to this flow:** any code path that
does *not* end in a call to `showAppShell()` must end in a call to one of
`showMarketingSite()`, `showAuthScreen()`, or `showSubscriptionScreen()` (all
three now call `hideAppShell()`). Do not add new logic that shows or hides
`.app` directly with `classList` — always go through `showAppShell()` /
`hideAppShell()` so this table stays accurate.
