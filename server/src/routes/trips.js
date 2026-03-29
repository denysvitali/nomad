const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, canAccessTrip, isOwner } = require('../db/database');
const { authenticate, demoUploadBlock } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const router = express.Router();

const coversDir = path.join(__dirname, '../../uploads/covers');
const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
    cb(null, coversDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (file.mimetype.startsWith('image/') && !file.mimetype.includes('svg') && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, png, gif, webp images allowed'));
    }
  },
});

const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

function generateDays(tripId, startDate, endDate) {
  db.prepare('DELETE FROM days WHERE trip_id = ?').run(tripId);
  if (!startDate || !endDate) {
    const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, NULL)');
    for (let i = 1; i <= 7; i++) insert.run(tripId, i);
    return;
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  const numDays = Math.min(Math.floor((end - start) / 86400000) + 1, 90);
  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  for (let i = 0; i < numDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    insert.run(tripId, i + 1, d.toISOString().split('T')[0]);
  }
}

// GET /api/trips/live/:token — public live trip view (no auth required, session token auth)
router.get('/live/:token', (req, res) => {
  const { token } = req.params;

  // Look up session
  const session = db.prepare('SELECT * FROM trip_sessions WHERE token = ?').get(token);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Check expiry
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Session has expired' });
  }

  // Check password requirement — client must send ?password=... in query
  if (session.password_hash) {
    const password = req.query.password || req.headers['x-session-password'];
    if (!password) {
      return res.status(401).json({ error: 'Password required', requires_password: true });
    }
    const bcrypt = require('bcryptjs');
    if (!bcrypt.compareSync(password, session.password_hash)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
  }

  const tripId = session.trip_id;

  // Fetch trip basic info
  const tripData = db.prepare(`
    SELECT id, title, start_date, end_date, cover_image as cover_url, description
    FROM trips WHERE id = ?
  `).get(tripId);

  if (!tripData) return res.status(404).json({ error: 'Trip not found' });

  // Fetch all days with assignments
  const days = db.prepare(`
    SELECT id, day_number, title, date
    FROM days WHERE trip_id = ?
    ORDER BY day_number ASC
  `).all(tripId);

  if (days.length === 0) {
    return res.json({
      trip: tripData,
      days: [],
      reservations: [],
      accommodations: [],
      collab: { messages: [], polls: [], notes: [] },
    });
  }

  const dayIds = days.map(d => d.id);
  const dayPlaceholders = dayIds.map(() => '?').join(',');

  // Fetch all assignments for all days
  const allAssignments = db.prepare(`
    SELECT da.id, da.day_id, da.order_index, da.assignment_time, da.reservation_status, da.reservation_notes, da.reservation_datetime,
      p.id as place_id, p.name as place_name, p.lat, p.lng,
      p.address, p.category_id, p.place_time, p.end_time, p.description as place_description,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id IN (${dayPlaceholders})
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(...dayIds);

  // Group assignments by day_id
  const assignmentsByDayId = {};
  for (const a of allAssignments) {
    if (!assignmentsByDayId[a.day_id]) assignmentsByDayId[a.day_id] = [];
    assignmentsByDayId[a.day_id].push({
      id: a.id,
      order_index: a.order_index,
      reservation_status: a.reservation_status,
      reservation_notes: a.reservation_notes,
      reservation_datetime: a.reservation_datetime,
      place: {
        id: a.place_id,
        name: a.place_name,
        lat: a.lat,
        lng: a.lng,
        address: a.address,
        description: a.place_description,
        category: a.category_id ? {
          name: a.category_name,
          color: a.category_color,
          icon: a.category_icon,
        } : null,
        place_time: a.assignment_time || a.place_time,
        end_time: a.end_time,
      },
    });
  }

  // Build days with assignments
  const daysWithAssignments = days.map(day => ({
    id: day.id,
    day_number: day.day_number,
    title: day.title,
    date: day.date,
    assignments: assignmentsByDayId[day.id] || [],
  }));

  // Fetch reservations
  const reservations = db.prepare(`
    SELECT id, type, title, status, flight_number, airline,
      departure_airport, arrival_airport, reservation_time, confirmation_number,
      location
    FROM reservations
    WHERE trip_id = ?
    ORDER BY reservation_time ASC
  `).all(tripId);

  // Fetch accommodations
  const accommodations = db.prepare(`
    SELECT da.id, da.check_in, da.check_out,
      p.name as place_name, p.address as place_address, p.lat, p.lng
    FROM day_accommodations da
    JOIN places p ON da.place_id = p.id
    WHERE da.trip_id = ?
    ORDER BY da.check_in ASC
  `).all(tripId);

  const formattedAccommodations = accommodations.map(a => ({
    id: a.id,
    check_in: a.check_in,
    check_out: a.check_out,
    place: {
      name: a.place_name,
      address: a.place_address,
      lat: a.lat,
      lng: a.lng,
    },
  }));

  // Fetch collab messages
  const messages = db.prepare(`
    SELECT m.*, u.username, u.avatar,
      rm.text AS reply_text, ru.username AS reply_username
    FROM collab_messages m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN collab_messages rm ON m.reply_to = rm.id
    LEFT JOIN users ru ON rm.user_id = ru.id
    WHERE m.trip_id = ? AND m.deleted = 0
    ORDER BY m.id DESC
    LIMIT 100
  `).all(tripId);
  messages.reverse();

  // Batch-load reactions for messages
  const msgIds = messages.map(m => m.id);
  const reactionsByMsg = {};
  if (msgIds.length > 0) {
    const allReactions = db.prepare(`
      SELECT r.message_id, r.emoji, r.user_id, u.username
      FROM collab_message_reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds);
    for (const r of allReactions) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = [];
      reactionsByMsg[r.message_id].push(r);
    }
  }

  function groupReactions(reactions) {
    const map = {};
    for (const r of reactions) {
      if (!map[r.emoji]) map[r.emoji] = [];
      map[r.emoji].push({ user_id: r.user_id, username: r.username });
    }
    return Object.entries(map).map(([emoji, users]) => ({ emoji, users, count: users.length }));
  }

  function avatarUrl(user) {
    return user?.avatar ? `/uploads/avatars/${user.avatar}` : null;
  }

  function formatMessage(msg) {
    return {
      ...msg,
      avatar_url: avatarUrl(msg),
      reactions: groupReactions(reactionsByMsg[msg.id] || []),
    };
  }

  // Fetch collab polls
  const pollRows = db.prepare('SELECT id FROM collab_polls WHERE trip_id = ? ORDER BY create_date DESC').all(tripId);

  function getPollWithVotes(pollId) {
    const poll = db.prepare(`
      SELECT p.*, u.username, u.avatar
      FROM collab_polls p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(pollId);
    if (!poll) return null;
    const options = JSON.parse(poll.options);
    const votes = db.prepare(`
      SELECT v.option_index, v.user_id, u.username, u.avatar
      FROM collab_poll_votes v
      JOIN users u ON v.user_id = u.id
      WHERE v.poll_id = ?
    `).all(pollId);
    const formattedOptions = options.map((label, idx) => ({
      label: typeof label === 'string' ? label : label.label || label,
      voters: votes.filter(v => v.option_index === idx).map(v => ({ id: v.user_id, username: v.username, avatar: v.avatar, avatar_url: avatarUrl(v) })),
    }));
    return {
      ...poll,
      avatar_url: avatarUrl(poll),
      options: formattedOptions,
      is_closed: !!poll.closed,
      multiple_choice: !!poll.multiple,
    };
  }

  const polls = pollRows.map(row => getPollWithVotes(row.id)).filter(Boolean);

  // Fetch collab notes
  const notes = db.prepare(`
    SELECT n.*, u.username, u.avatar
    FROM collab_notes n
    JOIN users u ON n.user_id = u.id
    WHERE n.trip_id = ?
    ORDER BY n.pinned DESC, n.updated_at DESC
  `).all(tripId);

  const formattedNotes = notes.map(note => ({
    ...note,
    avatar_url: avatarUrl(note),
  }));

  res.json({
    trip: tripData,
    days: daysWithAssignments,
    reservations,
    accommodations: formattedAccommodations,
    collab: {
      messages: messages.map(formatMessage),
      polls,
      notes: formattedNotes,
    },
  });
});

// GET /api/trips — active or archived, includes shared trips
router.get('/', authenticate, (req, res) => {
  const archived = req.query.archived === '1' ? 1 : 0;
  const userId = req.user.id;
  const trips = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = :archived
    ORDER BY t.created_at DESC
  `).all({ userId, archived });
  res.json({ trips });
});

// POST /api/trips
router.post('/', authenticate, (req, res) => {
  const { title, description, start_date, end_date, currency } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, title, description || null, start_date || null, end_date || null, currency || 'EUR');

  const tripId = result.lastInsertRowid;
  generateDays(tripId, start_date, end_date);
  const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: req.user.id, tripId });
  res.status(201).json({ trip });
});

// GET /api/trips/:id
router.get('/:id', authenticate, (req, res) => {
  const userId = req.user.id;
  const trip = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
  `).get({ userId, tripId: req.params.id });
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  res.json({ trip });
});

// PUT /api/trips/:id — all members can edit; archive/cover owner-only
router.put('/:id', authenticate, (req, res) => {
  const access = canAccessTrip(req.params.id, req.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const ownerOnly = req.body.is_archived !== undefined || req.body.cover_image !== undefined;
  if (ownerOnly && !isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Only the owner can change this setting' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  const { title, description, start_date, end_date, currency, is_archived, cover_image } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  const newCover = cover_image !== undefined ? cover_image : trip.cover_image;

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, req.params.id);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: req.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id']);
});

// POST /api/trips/:id/cover
router.post('/:id/cover', authenticate, demoUploadBlock, uploadCover.single('cover'), (req, res) => {
  if (!isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Only the owner can change the cover image' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  if (trip.cover_image) {
    const oldPath = path.join(__dirname, '../../', trip.cover_image.replace(/^\//, ''));
    const resolvedPath = path.resolve(oldPath);
    const uploadsDir = path.resolve(__dirname, '../../uploads');
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  }

  const coverUrl = `/uploads/covers/${req.file.filename}`;
  db.prepare('UPDATE trips SET cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(coverUrl, req.params.id);
  res.json({ cover_image: coverUrl });
});

// DELETE /api/trips/:id — owner only
router.delete('/:id', authenticate, (req, res) => {
  if (!isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'Only the owner can delete the trip' });
  const deletedTripId = Number(req.params.id);
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
  broadcast(deletedTripId, 'trip:deleted', { id: deletedTripId }, req.headers['x-socket-id']);
});

// ── Member Management ────────────────────────────────────────────────────────

// GET /api/trips/:id/members
router.get('/:id/members', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id);
  const members = db.prepare(`
    SELECT u.id, u.username, u.email, u.avatar,
      CASE WHEN u.id = ? THEN 'owner' ELSE 'member' END as role,
      m.added_at,
      ib.username as invited_by_username
    FROM trip_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users ib ON ib.id = m.invited_by
    WHERE m.trip_id = ?
    ORDER BY m.added_at ASC
  `).all(trip.user_id, req.params.id);

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(trip.user_id);

  res.json({
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
    current_user_id: req.user.id,
  });
});

// POST /api/trips/:id/members — add by email or username
router.post('/:id/members', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const { identifier } = req.body; // email or username
  if (!identifier) return res.status(400).json({ error: 'Email or username required' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim());

  if (!target) return res.status(404).json({ error: 'User not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id);
  if (target.id === trip.user_id)
    return res.status(400).json({ error: 'Trip owner is already a member' });

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(req.params.id, target.id);
  if (existing) return res.status(400).json({ error: 'User already has access' });

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(req.params.id, target.id, req.user.id);

  res.status(201).json({ member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null } });
});

// DELETE /api/trips/:id/members/:userId — owner removes anyone; member removes self
router.delete('/:id/members/:userId', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const targetId = parseInt(req.params.userId);
  const isSelf = targetId === req.user.id;
  if (!isSelf && !isOwner(req.params.id, req.user.id))
    return res.status(403).json({ error: 'No permission' });

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

// ─── Shareable Trip Sessions ─────────────────────────────────────────────────

// POST /api/trips/:id/share — create a shareable session
router.post('/:id/share', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const { password, expires_in_days } = req.body;

  // Generate unique token
  const token = crypto.randomUUID();

  // Hash password if provided
  let passwordHash = null;
  if (password) {
    passwordHash = bcrypt.hashSync(password, 10);
  }

  // Calculate expiry date
  let expiresAt = null;
  if (expires_in_days) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + expires_in_days);
    expiresAt = expiryDate.toISOString();
  }

  // Delete any existing sessions for this trip
  db.prepare('DELETE FROM trip_sessions WHERE trip_id = ?').run(req.params.id);

  // Create new session
  const result = db.prepare(`
    INSERT INTO trip_sessions (trip_id, token, password_hash, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, token, passwordHash, req.user.id, expiresAt);

  const session = db.prepare('SELECT * FROM trip_sessions WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    url: `/trip/${req.params.id}-${token}/live`,
    token,
    expires_at: session.expires_at,
    has_password: !!passwordHash,
  });
});

// DELETE /api/trips/:id/share — revoke all shareable sessions
router.delete('/:id/share', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  db.prepare('DELETE FROM trip_sessions WHERE trip_id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/trips/:id/sessions — list all shareable sessions
router.get('/:id/sessions', authenticate, (req, res) => {
  if (!canAccessTrip(req.params.id, req.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const sessions = db.prepare(`
    SELECT id, token, created_at, expires_at,
      CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password
    FROM trip_sessions
    WHERE trip_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id);

  res.json({ sessions });
});

module.exports = router;
