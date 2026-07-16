import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function addDaysIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function findAuthUserByEmail(adminClient: any, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((user: { email?: string }) => normalizeEmail(user.email || "") === email);
    if (found) return found;
    if (data.users.length < 1000) break;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Server configuration missing" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "Unauthorized" }, 401);
  const actor = authData.user;

  const { data: isAdmin, error: adminError } = await adminClient.rpc("is_access_admin", { p_user_id: actor.id });
  if (adminError) return json({ error: "Admin check failed", detail: adminError.message }, 500);
  if (!isAdmin) return json({ error: "Forbidden" }, 403);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = requireString(payload.action, "action");

  try {
    if (action === "list") {
      const { data, error } = await adminClient.from("account_access").select("user_id,email,access_type,access_status,trial_started_at,trial_expires_at,granted_by,granted_at,updated_at,notes").order("updated_at", { ascending: false });
      if (error) throw error;
      const { data: invitations, error: invitationsError } = await adminClient.from("trial_invitations").select("id,email,duration_days,status,invited_by,invited_user_id,created_at,accepted_at,expires_at,notes").order("created_at", { ascending: false }).limit(50);
      if (invitationsError) throw invitationsError;
      return json({ records: data || [], invitations: invitations || [] });
    }

    if (action === "invite_professional_trial") {
      const email = normalizeEmail(requireString(payload.email, "email"));
      const durationDays = Number(payload.duration_days || 14);
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 365) throw new Error("duration_days must be 1-365");
      const redirectTo = Deno.env.get("APP_URL") || Deno.env.get("SITE_URL") || "https://www.nutrese.eu";
      let invitedUser = await findAuthUserByEmail(adminClient, email);
      let inviteStatus = invitedUser ? "accepted" : "pending";
      if (!invitedUser) {
        const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
          redirectTo,
          data: { nutrese_access: "professional_trial", trial_duration_days: durationDays },
        });
        if (inviteError) throw inviteError;
        invitedUser = inviteData.user;
      }
      if (!invitedUser?.id) throw new Error("Could not create or find invited user");
      const targetUserId = invitedUser.id;
      const { data: previous } = await adminClient.from("account_access").select("*").eq("user_id", targetUserId).maybeSingle();
      const next = { user_id: targetUserId, email, access_type: "professional_trial", access_status: "active", trial_started_at: new Date().toISOString(), trial_expires_at: addDaysIso(durationDays), granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
      const { data: saved, error: saveError } = await adminClient.from("account_access").upsert(next, { onConflict: "user_id" }).select("*").single();
      if (saveError) throw saveError;
      const { data: invitation, error: invitationError } = await adminClient.from("trial_invitations").insert({ email, duration_days: durationDays, status: inviteStatus, invited_by: actor.id, invited_user_id: targetUserId, expires_at: saved.trial_expires_at, notes: reason }).select("*").single();
      if (invitationError) throw invitationError;
      const { error: auditError } = await adminClient.from("access_audit_log").insert({ target_user_id: targetUserId, actor_user_id: actor.id, action, previous_state: previous || null, new_state: { access: saved, invitation }, reason });
      if (auditError) throw auditError;
      return json({ record: saved, invitation, invited: inviteStatus === "pending" });
    }

    const targetUserId = requireString(payload.user_id, "user_id");
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    const { data: previous } = await adminClient.from("account_access").select("*").eq("user_id", targetUserId).maybeSingle();
    let next: Record<string, unknown> | null = null;

    if (action === "grant_professional_trial") {
      const durationDays = Number(payload.duration_days || 14);
      if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 365) throw new Error("duration_days must be 1-365");
      next = { user_id: targetUserId, email: typeof payload.email === "string" ? payload.email : null, access_type: "professional_trial", access_status: "active", trial_started_at: new Date().toISOString(), trial_expires_at: addDaysIso(durationDays), granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
    } else if (action === "extend_trial") {
      const durationDays = Number(payload.duration_days || 14);
      if (!previous || previous.access_type !== "professional_trial") throw new Error("Target does not have a professional trial");
      if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 365) throw new Error("duration_days must be 1-365");
      const base = previous.trial_expires_at && new Date(previous.trial_expires_at) > new Date() ? new Date(previous.trial_expires_at) : new Date();
      base.setUTCDate(base.getUTCDate() + durationDays);
      next = { ...previous, access_status: "active", trial_expires_at: base.toISOString(), granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
    } else if (action === "revoke_trial") {
      if (!previous) throw new Error("No access record exists for target");
      next = { ...previous, access_status: "revoked", granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
    } else if (action === "convert_to_professional") {
      next = { user_id: targetUserId, email: typeof payload.email === "string" ? payload.email : previous?.email || null, access_type: "professional", access_status: "active", trial_started_at: previous?.trial_started_at || null, trial_expires_at: previous?.trial_expires_at || null, granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
    } else if (action === "set_read_only") {
      if (!previous) throw new Error("No access record exists for target");
      next = { ...previous, access_status: "read_only", granted_by: actor.id, updated_at: new Date().toISOString(), notes: reason };
    } else {
      return json({ error: "Unsupported action" }, 400);
    }

    const { data: saved, error: saveError } = await adminClient.from("account_access").upsert(next, { onConflict: "user_id" }).select("*").single();
    if (saveError) throw saveError;

    const { error: auditError } = await adminClient.from("access_audit_log").insert({ target_user_id: targetUserId, actor_user_id: actor.id, action, previous_state: previous || null, new_state: saved, reason });
    if (auditError) throw auditError;
    return json({ record: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ error: message }, 400);
  }
});
