import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '202607160001_access_control_milestone1.sql'), 'utf8');
const inviteMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '202607160002_trial_invite_audit_action.sql'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'admin-access-management', 'index.ts'), 'utf8');
const checkout = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-checkout-session', 'index.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

for (const needle of [
  'create table if not exists public.account_access',
  'create table if not exists public.trial_invitations',
  'create table if not exists public.access_audit_log',
  'create or replace function public.is_access_admin',
  'create or replace function public.has_read_access',
  'create or replace function public.has_write_access',
  "lower(coalesce(p.subscription_status, 'none')) in ('active','trialing')",
  'public.has_paid_or_stripe_trial_access(p_user_id)',
  'Users can read own clients with access',
  'Users can insert own clients with write access',
  'Bootstrap owner administrator',
  'nutrition.puravida@gmail.com',
  'create or replace function public.has_used_free_trial'
]) assert.ok(migration.includes(needle), `migration is missing: ${needle}`);

assert.ok(!app.includes('OWNER_ADMIN_EMAIL'), 'frontend owner email bypass must not remain');
assert.ok(!app.includes('isOwnerAdminUser'), 'frontend owner admin function must not remain');
assert.ok(!app.includes('ownerBypass'), 'frontend owner bypass state must not remain');
assert.ok(app.includes('Complimentary Access'), 'subscription screen must mention Complimentary Access');
assert.ok(app.includes('Start Free Trial'), 'subscription screen must offer Start Free Trial');
assert.ok(!app.includes('Owner admin access'), 'old owner-bypass wording must not remain');
assert.ok(!app.includes('Start 7-day trial'), 'old trial checkout wording must not remain');
assert.ok(app.includes("subscription_status:'none'"), 'new profiles must default to subscription_status none');
assert.ok(app.includes('allow_trial:!subscriptionState?.freeTrialUsed'), 'checkout payload must avoid requesting a second free trial');
assert.ok(app.includes("subscription_status:'none',trial_start:null,trial_end:null"), 'new profiles must not start a trial automatically');
assert.ok(migration.includes('alter table public.profiles alter column trial_start drop default'), 'profile trial_start default must be removed');
assert.ok(app.includes('freeTrialUsed'), 'frontend should consume server free-trial-used state');
assert.ok(app.includes('<div id="account-admin-access-panel"'), 'minimal admin access panel must exist');
assert.ok(app.includes("adminAccessAction('invite_professional_trial')"), 'admin panel must expose email trial invitations');
assert.ok(app.includes('Email is required for invitations.'), 'invite action must not require a user id');
assert.ok(app.includes('\u0394\u03b9\u03b1\u03c7\u03b5\u03af\u03c1\u03b9\u03c3\u03b7 \u03c0\u03c1\u03cc\u03c3\u03b2\u03b1\u03c3\u03b7\u03c2'), 'admin access Greek label must not be corrupted');
assert.ok(app.includes('\u03ba\u03b1\u03c4\u03b1\u03b3\u03c1\u03ac\u03c6\u03bf\u03bd\u03c4\u03b1\u03b9 server-side'), 'admin access audit copy must not be corrupted');
assert.ok(edge.includes('adminClient.rpc("is_access_admin"'), 'edge function must verify admin server-side');
assert.ok(edge.includes('access_audit_log'), 'edge function must write audit log');
assert.ok(edge.includes('inviteUserByEmail'), 'edge function must send Supabase invite emails');
assert.ok(edge.includes('findAuthUserByEmail'), 'edge function should handle existing invited users');
assert.ok(edge.includes('trial_invitations'), 'edge function must record invitation rows');
assert.ok(edge.includes('invite_professional_trial'), 'edge function must support email trial invitations');
assert.ok(edge.includes('grant_professional_trial'), 'edge function must support trial grant');
assert.ok(edge.includes('extend_trial'), 'edge function must support trial extension');
assert.ok(edge.includes('revoke_trial'), 'edge function must support revocation');
assert.ok(edge.includes('convert_to_professional'), 'edge function must support conversion');
assert.ok(checkout.includes('rpc("has_used_free_trial"'), 'checkout function must verify free-trial usage server-side');
assert.ok(checkout.includes('allow_trial !== false && !freeTrialUsed'), 'checkout function must honor frontend no-trial flag and server trial history');
assert.ok(checkout.includes('subscriptionData.trial_period_days = 7'), 'checkout function should only assign Stripe trial days conditionally');
assert.ok(!checkout.includes('subscription_data: {\n        trial_period_days: 7'), 'checkout function must not create unconditional Stripe trials');
console.log('Access-control static regression checks passed.');
