const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { db } = require('../db/database');
const { JWT_SECRET } = require('../config');

const router = express.Router();

// In-memory state store for CSRF protection (state → { createdAt, redirectUri })
const pendingStates = new Map();
const STATE_TTL = 5 * 60 * 1000; // 5 minutes

// In-memory one-time code store for safe token handoff (code → { token, createdAt })
// Avoids embedding JWTs in URL fragments (browser history / server log exposure).
const pendingTokens = new Map();
const TOKEN_CODE_TTL = 2 * 60 * 1000; // 2 minutes

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > STATE_TTL) pendingStates.delete(state);
  }
  for (const [code, data] of pendingTokens) {
    if (now - data.createdAt > TOKEN_CODE_TTL) pendingTokens.delete(code);
  }
}, 60 * 1000);

// Read OIDC config from app_settings
function getOidcConfig() {
  const get = (key) => db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value || null;
  const issuer = get('oidc_issuer');
  const clientId = get('oidc_client_id');
  const clientSecret = get('oidc_client_secret');
  const displayName = get('oidc_display_name') || 'SSO';
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer: issuer.replace(/\/+$/, ''), clientId, clientSecret, displayName };
}

// Cache discovery document
let discoveryCache = null;
let discoveryCacheTime = 0;
const DISCOVERY_TTL = 60 * 60 * 1000; // 1 hour

async function discover(issuer) {
  if (discoveryCache && Date.now() - discoveryCacheTime < DISCOVERY_TTL && discoveryCache._issuer === issuer) {
    return discoveryCache;
  }
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error('Failed to fetch OIDC discovery document');
  const doc = await res.json();
  doc._issuer = issuer;
  discoveryCache = doc;
  discoveryCacheTime = Date.now();
  return doc;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function frontendUrl(path) {
  const base = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173';
  return base + path;
}

// GET /api/auth/oidc/login — redirect to OIDC provider
router.get('/login', async (req, res) => {
  const config = getOidcConfig();
  if (!config) return res.status(400).json({ error: 'OIDC not configured' });

  try {
    const doc = await discover(config.issuer);
    const state = crypto.randomBytes(32).toString('hex');
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${proto}://${host}/api/auth/oidc/callback`;

    pendingStates.set(state, { createdAt: Date.now(), redirectUri });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
    });

    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch (err) {
    console.error('[OIDC] Login error:', err.message);
    res.status(500).json({ error: 'OIDC login failed' });
  }
});

// GET /api/auth/oidc/callback — handle provider callback
router.get('/callback', async (req, res) => {
  const { code, state, error: oidcError } = req.query;

  if (oidcError) {
    console.error('[OIDC] Provider error:', oidcError);
    return res.redirect(frontendUrl('/login?oidc_error=' + encodeURIComponent(oidcError)));
  }

  if (!code || !state) {
    return res.redirect(frontendUrl('/login?oidc_error=missing_params'));
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.redirect(frontendUrl('/login?oidc_error=invalid_state'));
  }
  pendingStates.delete(state);

  const config = getOidcConfig();
  if (!config) return res.redirect(frontendUrl('/login?oidc_error=not_configured'));

  try {
    const doc = await discover(config.issuer);

    // Exchange code for tokens
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[OIDC] Token exchange failed:', tokenData);
      return res.redirect(frontendUrl('/login?oidc_error=token_failed'));
    }

    // Get user info
    const userInfoRes = await fetch(doc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    if (!userInfo.email) {
      return res.redirect(frontendUrl('/login?oidc_error=no_email'));
    }

    const email = userInfo.email.toLowerCase();
    const name = userInfo.name || userInfo.preferred_username || email.split('@')[0];
    const sub = userInfo.sub;

    // Find existing user by OIDC sub or email
    let user = db.prepare('SELECT * FROM users WHERE oidc_sub = ? AND oidc_issuer = ?').get(sub, config.issuer);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
    }

    if (user) {
      // Existing user — link OIDC if not already linked
      if (!user.oidc_sub) {
        db.prepare('UPDATE users SET oidc_sub = ?, oidc_issuer = ? WHERE id = ?').run(sub, config.issuer, user.id);
      }
    } else {
      // New user — check if registration is allowed
      const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      const isFirstUser = userCount === 0;

      if (!isFirstUser) {
        const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'allow_registration'").get();
        if (setting?.value === 'false') {
          return res.redirect(frontendUrl('/login?oidc_error=registration_disabled'));
        }
      }

      // Create user (first user = admin)
      const role = isFirstUser ? 'admin' : 'user';
      // Generate a random password hash (user won't use password login)
      const randomPass = crypto.randomBytes(32).toString('hex');
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(randomPass, 10);

      // Ensure unique username
      let username = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30) || 'user';
      const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
      if (existing) username = `${username}_${Date.now() % 10000}`;

      const result = db.prepare(
        'INSERT INTO users (username, email, password_hash, role, oidc_sub, oidc_issuer) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, email, hash, role, sub, config.issuer);

      user = { id: Number(result.lastInsertRowid), username, email, role };
    }

    // Update last login
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // Issue a short-lived one-time code instead of embedding the JWT in the URL fragment.
    // This prevents the token from appearing in browser history or server access logs.
    const jwtToken = generateToken(user);
    const handoffCode = crypto.randomBytes(32).toString('hex');
    pendingTokens.set(handoffCode, { token: jwtToken, createdAt: Date.now() });

    res.redirect(frontendUrl(`/login?oidc_code=${handoffCode}`));
  } catch (err) {
    console.error('[OIDC] Callback error:', err);
    res.redirect(frontendUrl('/login?oidc_error=server_error'));
  }
});

// POST /api/auth/oidc/token — exchange one-time code for JWT
// The frontend calls this immediately after receiving the oidc_code query param.
router.post('/token', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const entry = pendingTokens.get(code);
  if (!entry) return res.status(400).json({ error: 'Invalid or expired code' });

  // Enforce TTL and single-use
  if (Date.now() - entry.createdAt > TOKEN_CODE_TTL) {
    pendingTokens.delete(code);
    return res.status(400).json({ error: 'Code has expired' });
  }

  pendingTokens.delete(code);
  res.json({ token: entry.token });
});

module.exports = router;
