const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const env = require('./config/env');
const supabaseAdmin = require('./config/supabaseAdmin');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const transactionsRoutes = require('./routes/transactions');
const housesRoutes = require('./routes/houses');
const membersRoutes = require('./routes/members');
const societyRoutes = require('./routes/society');
const assignmentsRoutes = require('./routes/assignments');
const paysharpWebhookRoutes = require('./routes/paysharpWebhook');

const app = express();

// Security hygiene finding (Low, 2026-09-13 audit): no security headers,
// no explicit body size limit. contentSecurityPolicy/crossOriginEmbedderPolicy
// are disabled here rather than left at helmet's own defaults - both would
// otherwise risk breaking the Expo web PWA served below (inline
// styles/scripts, cross-origin PaySharp UPI intent redirects, etc.), which
// was never designed against a strict CSP. Every OTHER helmet default
// (X-Content-Type-Options, X-Frame-Options, HSTS once on HTTPS, etc.)
// still applies - cheap defense-in-depth with no functional risk.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors());
// 1mb comfortably covers every real request body in this app (JSON only -
// receipts/proofs are uploaded to Supabase Storage separately, never
// inlined as base64 here) while still bounding worst-case memory/CPU from
// an oversized or abusive request body.
app.use(express.json({ limit: '1mb' }));

app.use('/auth', authRoutes);
app.use('/me', meRoutes);
app.use('/transactions', transactionsRoutes);
app.use('/houses', housesRoutes);
app.use('/members', membersRoutes);
app.use('/society', societyRoutes);
app.use('/assignments', assignmentsRoutes);
// Not behind authenticate - server-to-server call from PaySharp, protected
// by its own ?secret= query param instead (see routes/paysharpWebhook.js).
app.use('/webhooks/paysharp', paysharpWebhookRoutes);

// Confirms the server can reach the linked Supabase project using the
// service-role key. Does not expose the key or any row data in the response.
app.get('/health', async (_req, res) => {
  try {
    const { error, count } = await supabaseAdmin
      .from('societies')
      .select('id', { count: 'exact', head: true });

    if (error) {
      return res.status(503).json({
        status: 'error',
        database: 'unreachable',
        message: error.message,
      });
    }

    res.json({
      status: 'ok',
      database: 'connected',
      societiesCount: count,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Serves the mobile app's static web build (mobile/dist, produced by
// `npx expo export -p web` - see PERSONAL_LAPTOP_SETUP_AND_TESTING.md
// Section 3) so the whole app - frontend AND API - is reachable through a
// single host/port/ngrok tunnel. This also makes the app same-origin with
// its own API in real usage (no cross-origin requests once deployed
// somewhere real), and is the same pattern a cheap single-service
// production host (Render/Railway/etc.) would use later - one process,
// one URL, nothing app-store-related. Placed after every API route above
// so those always take priority over the static/catch-all behavior below;
// only requests nothing above matched reach this point.
const webBuildDir = path.join(__dirname, '..', '..', 'mobile', 'dist');
if (fs.existsSync(webBuildDir)) {
  app.use(express.static(webBuildDir));
  // Single-page app with no URL-based routing (no expo-router) - any
  // unmatched GET just gets the same index.html and the app's own
  // in-memory navigation takes it from there. API-style paths that
  // simply don't exist (typos, removed routes, etc.) still fall through
  // to Express's normal 404 instead of silently returning the app shell.
  const apiPrefixes = ['/auth', '/me', '/transactions', '/houses', '/members', '/society', '/assignments', '/webhooks', '/health'];
  app.get('*', (req, res, next) => {
    if (apiPrefixes.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }
    res.sendFile(path.join(webBuildDir, 'index.html'));
  });
  console.log(`Serving mobile web build from ${webBuildDir}`);
} else {
  console.log('No mobile/dist found - running API-only (run `npx expo export -p web` in mobile/ to also serve the web app from here).');
}

app.listen(env.port, () => {
  console.log(`society-app-backend listening on http://localhost:${env.port}`);
});
