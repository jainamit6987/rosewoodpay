const rateLimit = require('express-rate-limit');

// Security audit finding (Medium, 2026-09-13): POST /auth/login had no
// rate limiting at all - real accounts with real money attached are
// exposed to password spraying / credential stuffing straight against
// Supabase Auth's own signInWithPassword. Supabase Auth has its own
// internal limits, but those are tuned for Supabase's whole platform, not
// this specific app, so they are a secondary layer only - this is the
// primary one.
//
// Keyed on IP + the attempted email together (not IP alone) so one
// resident mistyping their own password repeatedly cannot get a whole
// shared IP (a society's own wifi/NAT, a corporate VPN, etc.) rate-limited
// for everyone else trying to log in from it at the same time.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 FAILED attempts per window per IP+email
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase().trim()}`,
  // Only count attempts that end in a 4xx/5xx (i.e. a real failed login)
  // against the limit - a resident/admin who legitimately logs in
  // frequently (or the same account being used across many separate test
  // scripts, as in this codebase's own backend/scripts/test-*.js suite)
  // must never be throttled just for repeatedly succeeding. This is what
  // actually targets password spraying/credential stuffing specifically,
  // rather than "using the app a lot".
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes and try again.' });
  },
});

// Looser, IP-only limiter applied to the rest of /auth (currently just
// /logout) - mainly a cheap backstop against generic request flooding,
// not targeting a specific credential-guessing risk the way the login
// limiter above is.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  },
});

module.exports = { loginRateLimiter, authRateLimiter };
