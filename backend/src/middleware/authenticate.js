const { createUserScopedClient } = require('../config/supabaseClient');

// Verifies the bearer token with Supabase Auth and attaches a request-scoped
// Supabase client (req.supabase) that carries the same token, so every
// downstream query is subject to RLS as that specific user - never the
// service-role key.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header. Expected: Bearer <access_token>.' });
  }

  const scopedClient = createUserScopedClient(token);
  const { data, error } = await scopedClient.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  req.user = data.user;
  req.supabase = scopedClient;
  next();
}

module.exports = authenticate;
