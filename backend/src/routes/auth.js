const express = require('express');
const { supabaseAnon, createUserScopedClient } = require('../config/supabaseClient');

const router = express.Router();

// The mobile client will eventually call Supabase Auth directly with the
// anon key. This endpoint exists so the same login flow can be exercised
// and tested from the backend before the mobile app exists.
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error) {
    return res.status(401).json({ error: error.message });
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
