-- Nutrese Milestone 1: server-side access-control foundation
-- Scope: account access tables, helper functions, RLS write/read gates, admin bootstrap.
-- This migration intentionally does not alter meal-planning data or Stripe billing semantics.

begin;

-- New registrations must not automatically start a Stripe/free trial.
-- A trial begins only through Stripe checkout or administrator-granted access.
alter table public.profiles alter column trial_start drop default;

create table if not exists public.account_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  access_type text not null check (access_type in ('administrator','professional','professional_trial')),
  access_status text not null default 'active' check (access_status in ('active','read_only','revoked')),
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text,
  constraint account_access_trial_dates_check check (
    access_type <> 'professional_trial'
    or trial_expires_at is not null
  )
);

create table if not exists public.trial_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  duration_days integer not null check (duration_days > 0),
  status text not null default 'pending' check (status in ('pending','accepted','cancelled','expired')),
  invited_by uuid references auth.users(id),
  invited_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz,
  notes text
);

create table if not exists public.access_audit_log (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid references auth.users(id),
  actor_user_id uuid references auth.users(id),
  action text not null check (action in (
    'grant_professional_trial',
    'extend_trial',
    'revoke_trial',
    'convert_to_professional',
    'set_read_only',
    'admin_bootstrap',
    'stripe_sync',
    'system'
  )),
  previous_state jsonb,
  new_state jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists account_access_email_idx on public.account_access (lower(email));
create index if not exists account_access_status_idx on public.account_access (access_type, access_status, trial_expires_at);
create index if not exists trial_invitations_email_idx on public.trial_invitations (lower(email));
create index if not exists access_audit_log_target_idx on public.access_audit_log (target_user_id, created_at desc);
create index if not exists access_audit_log_actor_idx on public.access_audit_log (actor_user_id, created_at desc);

alter table public.account_access enable row level security;
alter table public.trial_invitations enable row level security;
alter table public.access_audit_log enable row level security;

create or replace function public.is_access_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select true
    from public.account_access aa
    where aa.user_id = p_user_id
      and aa.access_type = 'administrator'
      and aa.access_status = 'active'
    limit 1
  ), false);
$$;

create or replace function public.has_paid_or_stripe_trial_access(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select true
    from public.profiles p
    where p.id = p_user_id
      and lower(coalesce(p.subscription_status, 'none')) in ('active','trialing')
      and (
        (lower(coalesce(p.subscription_status, 'none')) = 'active'
          and (p.current_period_end is null or p.current_period_end > now()))
        or (lower(coalesce(p.subscription_status, 'none')) = 'trialing'
          and coalesce(p.trial_end, p.current_period_end) is not null
          and coalesce(p.trial_end, p.current_period_end) > now())
      )
    limit 1
  ), false);
$$;

create or replace function public.has_used_free_trial(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select true
    from public.profiles p
    where p.id = p_user_id
      and (p.trial_start is not null or p.trial_end is not null)
    limit 1
  ), false)
  or coalesce((
    select true
    from public.account_access aa
    where aa.user_id = p_user_id
      and aa.access_type = 'professional_trial'
    limit 1
  ), false);
$$;

create or replace function public.has_read_access(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_paid_or_stripe_trial_access(p_user_id)
  or coalesce((
    select true
    from public.account_access aa
    where aa.user_id = p_user_id
      and aa.access_status in ('active','read_only')
      and aa.access_type in ('administrator','professional','professional_trial')
    limit 1
  ), false);
$$;

create or replace function public.has_write_access(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_paid_or_stripe_trial_access(p_user_id)
  or coalesce((
    select true
    from public.account_access aa
    where aa.user_id = p_user_id
      and aa.access_status = 'active'
      and (
        aa.access_type in ('administrator','professional')
        or (
          aa.access_type = 'professional_trial'
          and aa.trial_expires_at is not null
          and aa.trial_expires_at > now()
        )
      )
    limit 1
  ), false);
$$;

create or replace function public.get_effective_access(p_user_id uuid default auth.uid())
returns table (
  user_id uuid,
  access_type text,
  access_status text,
  can_read boolean,
  can_write boolean,
  is_admin boolean,
  trial_expires_at timestamptz,
  stripe_subscription_status text,
  free_trial_used boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p_user_id,
    case
      when public.is_access_admin(p_user_id) then 'administrator'
      when public.has_paid_or_stripe_trial_access(p_user_id) then 'professional'
      when aa.access_type = 'professional_trial' and aa.trial_expires_at <= now() then 'expired_trial'
      else coalesce(aa.access_type, 'none')
    end as access_type,
    case
      when aa.access_status = 'revoked' then 'revoked'
      when public.has_write_access(p_user_id) then 'active'
      when public.has_read_access(p_user_id) then 'read_only'
      else 'none'
    end as access_status,
    public.has_read_access(p_user_id) as can_read,
    public.has_write_access(p_user_id) as can_write,
    public.is_access_admin(p_user_id) as is_admin,
    aa.trial_expires_at,
    coalesce(p.subscription_status, 'none') as stripe_subscription_status,
    public.has_used_free_trial(p_user_id) as free_trial_used
  from (select p_user_id as id) u
  left join public.account_access aa on aa.user_id = u.id
  left join public.profiles p on p.id = u.id;
$$;

insert into public.account_access (user_id, email, access_type, access_status, granted_by, notes)
select id, email, 'administrator', 'active', id, 'Bootstrap owner administrator'
from auth.users
where lower(email) = 'nutrition.puravida@gmail.com'
on conflict (user_id) do update set
  email = excluded.email,
  access_type = 'administrator',
  access_status = 'active',
  updated_at = now(),
  notes = 'Bootstrap owner administrator';

insert into public.access_audit_log (target_user_id, actor_user_id, action, new_state, reason)
select id, id, 'admin_bootstrap', jsonb_build_object('email', email, 'access_type', 'administrator', 'access_status', 'active'), 'Milestone 1 administrator bootstrap'
from auth.users
where lower(email) = 'nutrition.puravida@gmail.com';

drop policy if exists "Users can view their own access" on public.account_access;
drop policy if exists "Admins can view account access" on public.account_access;
drop policy if exists "Admins can manage account access" on public.account_access;
create policy "Users can view their own access" on public.account_access for select to authenticated using (user_id = auth.uid());
create policy "Admins can view account access" on public.account_access for select to authenticated using (public.is_access_admin(auth.uid()));
create policy "Admins can manage account access" on public.account_access for all to authenticated using (public.is_access_admin(auth.uid())) with check (public.is_access_admin(auth.uid()));

drop policy if exists "Admins can manage trial invitations" on public.trial_invitations;
create policy "Admins can manage trial invitations" on public.trial_invitations for all to authenticated using (public.is_access_admin(auth.uid())) with check (public.is_access_admin(auth.uid()));

drop policy if exists "Admins can view audit log" on public.access_audit_log;
drop policy if exists "Users can view own audit log" on public.access_audit_log;
create policy "Admins can view audit log" on public.access_audit_log for select to authenticated using (public.is_access_admin(auth.uid()));
create policy "Users can view own audit log" on public.access_audit_log for select to authenticated using (target_user_id = auth.uid());

drop policy if exists "Users can manage their own clients" on public.clients;
create policy "Users can read own clients with access" on public.clients for select to authenticated using (user_id = auth.uid() and public.has_read_access(auth.uid()));
create policy "Users can insert own clients with write access" on public.clients for insert to authenticated with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can update own clients with write access" on public.clients for update to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid())) with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can delete own clients with write access" on public.clients for delete to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid()));

drop policy if exists "Users can manage their own recipes" on public.recipes;
create policy "Users can read own recipes with access" on public.recipes for select to authenticated using (user_id = auth.uid() and public.has_read_access(auth.uid()));
create policy "Users can insert own recipes with write access" on public.recipes for insert to authenticated with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can update own recipes with write access" on public.recipes for update to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid())) with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can delete own recipes with write access" on public.recipes for delete to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid()));

drop policy if exists "Users can manage their own custom meals" on public.custom_meals;
create policy "Users can read own custom meals with access" on public.custom_meals for select to authenticated using (user_id = auth.uid() and public.has_read_access(auth.uid()));
create policy "Users can insert own custom meals with write access" on public.custom_meals for insert to authenticated with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can update own custom meals with write access" on public.custom_meals for update to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid())) with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can delete own custom meals with write access" on public.custom_meals for delete to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid()));

drop policy if exists "Users can manage their own appointments" on public.appointments;
create policy "Users can read own appointments with access" on public.appointments for select to authenticated using (user_id = auth.uid() and public.has_read_access(auth.uid()));
create policy "Users can insert own appointments with write access" on public.appointments for insert to authenticated with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can update own appointments with write access" on public.appointments for update to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid())) with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can delete own appointments with write access" on public.appointments for delete to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid()));

drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can manage their own profile" on public.profiles;
drop policy if exists "Users can select their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can select own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Users can insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "Users can update own profile with write access" on public.profiles for update to authenticated using (id = auth.uid() and public.has_write_access(auth.uid())) with check (id = auth.uid() and public.has_write_access(auth.uid()));

drop policy if exists "Users can insert their own feedback" on public.feedback;
create policy "Authenticated users can insert feedback" on public.feedback for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users can view their own calendar tokens" on public.google_calendar_tokens;
create policy "Users can view own calendar tokens with access" on public.google_calendar_tokens for select to authenticated using (user_id = auth.uid() and public.has_read_access(auth.uid()));
create policy "Users can insert own calendar tokens with write access" on public.google_calendar_tokens for insert to authenticated with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can update own calendar tokens with write access" on public.google_calendar_tokens for update to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid())) with check (user_id = auth.uid() and public.has_write_access(auth.uid()));
create policy "Users can delete own calendar tokens with write access" on public.google_calendar_tokens for delete to authenticated using (user_id = auth.uid() and public.has_write_access(auth.uid()));

commit;
