const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

// Plain anon-key client for stateless auth operations (login/logout).
// The backend does not persist sessions - the mobile client owns the
// access/refresh tokens once issued.
const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Per-request client scoped to the caller's access token, so every query
// made with it runs through PostgREST as that authenticated user and is
// subject to the same Row Level Security policies the mobile app would get.
// This must never use the service-role key.
function createUserScopedClient(accessToken) {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

module.exports = { supabaseAnon, createUserScopedClient };
