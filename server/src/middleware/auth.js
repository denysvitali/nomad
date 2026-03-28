const jwt = require('jsonwebtoken');
const { db } = require('../db/database');
const { JWT_SECRET } = require('../config');

const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Check token revocation list
    if (decoded.jti) {
      const revoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(decoded.jti);
      if (revoked) return res.status(401).json({ error: 'Token has been revoked' });
    }

    const user = db.prepare(
      'SELECT id, username, email, role, is_demo FROM users WHERE id = ?'
    ).get(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Check token revocation list
    if (decoded.jti) {
      const revoked = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?').get(decoded.jti);
      if (revoked) {
        req.user = null;
        return next();
      }
    }

    const user = db.prepare(
      'SELECT id, username, email, role, is_demo FROM users WHERE id = ?'
    ).get(decoded.id);
    req.user = user || null;
  } catch (err) {
    req.user = null;
  }
  next();
};

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const demoUploadBlock = (req, res, next) => {
  if (process.env.DEMO_MODE === 'true' && req.user?.is_demo === 1) {
    return res.status(403).json({ error: 'Uploads are disabled in demo mode. Self-host NOMAD for full functionality.' });
  }
  next();
};

module.exports = { authenticate, optionalAuth, adminOnly, demoUploadBlock };
