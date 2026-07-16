# Access Control Milestone 1

This folder covers the first server-side access-control milestone.

Scope:
- Account access tables live separately from Stripe billing data.
- Active Stripe subscribers and Stripe trialing users remain valid via `profiles.subscription_status`.
- Complimentary professional trials live in `account_access` and do not create fake Stripe subscriptions.
- Expired trials are read-only through `has_read_access()` and blocked from writes by `has_write_access()`.
- Administrator authority is enforced server-side through `is_access_admin()`.

Run:

```bash
node tests/access-control/access-control-static.test.mjs
node tests/phase0/compare-baseline.mjs
```

These checks do not deploy migrations or Edge Functions. They verify the repository contract before manual Supabase deployment.
