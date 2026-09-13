const express = require('express');
const { supabaseAnon, createUserScopedClient } = require('../config/supabaseClient');
const { loginRateLimiter, authRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(authRateLimiter);

// The mobile client will eventually call Supabase Auth directly with the
// anon key. This endpoint exists so the same login flow can be exercised
// and tested from the backend before the mobile app exists.
router.post('/login', loginRateLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error) {
    // Security audit finding (Low, 2026-09-13): previously passed
    // Supabase's own error.message straight through, which can in theory
    // distinguish account states (e.g. unconfirmed vs. wrong password) and
    // help enumerate valid emails. Always the same generic message to the
    // client now; the real reason is still logged server-side for support/
    // debugging.
    console.error(`login failed for ${email}: ${error.message}`);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  res.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  });
});

router.post('/logout', async (req, res) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(400).json({ error: 'Missing Authorization header.' });
  }

  const scopedClient = createUserScopedClient(token);
  const { error } = await scopedClient.auth.signOut();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.json({ status: 'signed_out' });
});

module.exports = router;
