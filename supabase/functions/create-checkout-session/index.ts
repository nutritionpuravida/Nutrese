import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SERVICE_ROLE_KEY") || "",
);

const SUCCESS_URL = "https://nutritionpuravida.github.io/NutriFlow?checkout=success&session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL = "https://nutritionpuravida.github.io/NutriFlow";
const ALLOWED_PRICE_IDS = new Set([
  "price_1ToMPVDwBpsAKvLemjXMV2Rg",
  "price_1ToMPWDwBpsAKvLe4Ial8JRS",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData.user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { price_id, user_id, email, allow_trial } = await req.json();
    if (!price_id || !ALLOWED_PRICE_IDS.has(price_id)) {
      return jsonResponse({ error: "Invalid price_id" }, 400);
    }
    if (user_id !== authData.user.id) {
      return jsonResponse({ error: "User mismatch" }, 403);
    }

    const userEmail = email || authData.user.email;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id,email,stripe_customer_id")
      .eq("id", user_id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id;

    if (!customerId && userEmail) {
      const existingCustomers = await stripe.customers.list({
        email: userEmail,
        limit: 1,
      });
      const existingCustomer = existingCustomers.data[0];
      if (existingCustomer) {
        customerId = existingCustomer.id;
        await supabaseAdmin.from("profiles").upsert({
          id: user_id,
          email: userEmail,
          stripe_customer_id: customerId,
        }, { onConflict: "id" });
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { user_id },
      });
      customerId = customer.id;
      await supabaseAdmin.from("profiles").upsert({
        id: user_id,
        email: userEmail,
        stripe_customer_id: customerId,
        subscription_status: "none",
      }, { onConflict: "id" });
    }

    const { data: freeTrialUsed, error: freeTrialError } = await supabaseAdmin
      .rpc("has_used_free_trial", { p_user_id: user_id });
    if (freeTrialError) {
      console.error("[create-checkout-session] free trial eligibility check failed", freeTrialError);
      return jsonResponse({ error: "Could not verify trial eligibility" }, 500);
    }

    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: { user_id },
    };
    if (allow_trial !== false && !freeTrialUsed) {
      subscriptionData.trial_period_days = 7;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user_id,
      line_items: [{ price: price_id, quantity: 1 }],
      payment_method_collection: "always",
      subscription_data: subscriptionData,
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { user_id, trial_included: String(Boolean(subscriptionData.trial_period_days)) },
    });

    return jsonResponse({ url: session.url });
  } catch (error) {
    console.error("[create-checkout-session]", error);
    return jsonResponse({ error: error?.message || "Checkout session failed" }, 500);
  }
});


