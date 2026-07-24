const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Service-role client. This bypasses Row Level Security, so it must only be
// used from trusted server-side code (queue workers, admin-only endpoints,
// webhook handlers) - never exposed to the mobile client.
const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

module.exports = supabaseAdmin;
