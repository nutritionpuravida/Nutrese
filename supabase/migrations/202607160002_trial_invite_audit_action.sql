-- Nutrese Milestone 2: audited professional trial invitation action.
-- Allows the admin Edge Function to record invite_professional_trial audit events.

begin;

alter table public.access_audit_log
  drop constraint if exists access_audit_log_action_check;

alter table public.access_audit_log
  add constraint access_audit_log_action_check check (action in (
    'grant_professional_trial',
    'invite_professional_trial',
    'extend_trial',
    'revoke_trial',
    'convert_to_professional',
    'set_read_only',
    'admin_bootstrap',
    'stripe_sync',
    'system'
  ));

commit;
