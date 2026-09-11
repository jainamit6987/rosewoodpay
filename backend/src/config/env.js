require('dotenv').config();

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill in your Supabase project's values.`
  );
}

module.exports = {
  port: process.env.PORT || 4000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  // PaySharp UPI Intent API - deliberately NOT in `required` above. A
  // missing value here should never stop the whole backend from booting;
  // only the new POST /transactions/upi-intent and POST /webhooks/paysharp
  // routes need these, and they each fail cleanly (503 / ignored) when
  // unconfigured - see services/paysharp.js's isConfigured().
  paysharpBaseUrl: process.env.PAYSHARP_BASE_URL || null,
  paysharpApiToken: process.env.PAYSHARP_API_TOKEN || null,
  // Our own secret (e.g. `openssl rand -hex 32`), appended as `?secret=...`
  // on the webhook URL registered with PaySharp. PaySharp does not sign/
  // HMAC its webhook payloads, so this is the only thing stopping a
  // stranger from POSTing a fake "payment succeeded" event - see
  // routes/paysharpWebhook.js.
  paysharpWebhookSecret: process.env.PAYSHARP_WEBHOOK_SECRET || null,
};
