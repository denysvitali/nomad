const express = require('express');
const { db, canAccessTrip } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

// Get API key: user's own key, or fall back to any admin's key
function getAnthropicKey(userId) {
  const user = db.prepare('SELECT anthropic_api_key FROM users WHERE id = ?').get(userId);
  if (user?.anthropic_api_key) return user.anthropic_api_key;
  const admin = db.prepare("SELECT anthropic_api_key FROM users WHERE role = 'admin' AND anthropic_api_key IS NOT NULL AND anthropic_api_key != '' LIMIT 1").get();
  return admin?.anthropic_api_key || null;
}

// Nominatim lookup for coordinates (free OpenStreetMap)
async function lookupCoordinates(placeName, lang) {
  try {
    const params = new URLSearchParams({
      q: placeName,
      format: 'json',
      addressdetails: '1',
      limit: '1',
      'accept-language': lang || 'en',
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'NOMAD Travel Planner (https://github.com/mauriceboe/NOMAD)' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && data.length > 0) {
      return {
        lat: parseFloat(data[0].lat) || null,
        lng: parseFloat(data[0].lon) || null,
        address: data[0].display_name || null,
      };
    }
  } catch (err) {
    // ignore
  }
  return null;
}

// POST /api/trips/:tripId/ai/generate
// Returns generated plan without saving to DB. Client saves selected items.
router.post('/:tripId/ai/generate', authenticate, async (req, res) => {
  const { tripId } = req.params;
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Check trip access
  if (!canAccessTrip(tripId, req.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Get API key
  const apiKey = getAnthropicKey(req.user.id);
  if (!apiKey) {
    return res.status(400).json({ error: 'Anthropic API key not configured. Add your Anthropic API key in Admin Settings to use AI generation.', code: 'NO_KEY' });
  }

  // Get trip data
  const trip = db.prepare('SELECT id, title, start_date, end_date FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Get user language from settings
  let language = 'en';
  try {
    const userSetting = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(req.user.id, 'language');
    if (userSetting?.value) language = userSetting.value;
  } catch {}

  const SYSTEM_PROMPT = `You are a travel planning assistant. Generate a day-by-day itinerary for a trip.

Output ONLY valid JSON matching this schema:
{
  "days": [
    {
      "title": "Day 1: Tokyo — Temples & Tradition",
      "assignments": [
        {
          "place_name": "Senso-ji Temple",
          "category": "Attraction",
          "lat": 35.7147,
          "lng": 139.7966,
          "address": "2 Chome-3-1 Asakusa, Taito City, Tokyo",
          "place_time": "08:00",
          "end_time": "09:30",
          "duration_minutes": 90,
          "notes": "Tokyo's oldest temple, arrive early to avoid crowds"
        }
      ]
    }
  ]
}

Rules:
- Output ONLY the JSON, no preamble, no explanation
- Use real place names, real coordinates (from OpenStreetMap/Nominatim or your knowledge)
- Category must be one of: Hotel, Restaurant, Attraction, Shopping, Transport, Activity, Bar/Cafe, Beach, Nature, Other
- Times should be realistic for a traveler (morning = 7-12, afternoon = 12-17, evening = 17-21)
- Keep to 3-5 activities per day
- If multiple cities: add inter-city transport as an assignment with category "Transport"
- Duration: Attraction=90min, Restaurant=60min, Shopping=120min, Transport=varies
- Maximum 10 days`;

  const USER_PROMPT = `Generate a trip with these preferences:
${prompt}

Trip context:
- Destination: ${trip.title}
- Start date: ${trip.start_date || 'not set'}
- End date: ${trip.end_date || 'not set'}
- Language: ${language} (use place names appropriate for this language)`;

  let claude;
  try {
    claude = new Anthropic({ apiKey });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to initialize Anthropic client' });
  }

  let rawResponse;
  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: USER_PROMPT },
      ],
    });
    rawResponse = response.content[0].text;
  } catch (err) {
    console.error('Anthropic API error:', err);
    return res.status(500).json({ error: 'AI generation failed: ' + (err.message || 'Unknown error') });
  }

  // Parse JSON from response
  let parsed;
  try {
    // Try to extract JSON from the response (may have surrounding text)
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Failed to parse AI response:', rawResponse);
    return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
  }

  if (!parsed.days || !Array.isArray(parsed.days)) {
    return res.status(500).json({ error: 'Invalid AI response format. Please try again.' });
  }

  // Enrich each assignment with coordinates from Nominatim if missing
  for (const day of parsed.days) {
    for (const assignment of day.assignments || []) {
      if (!assignment.lat || !assignment.lng) {
        const coords = await lookupCoordinates(assignment.place_name, language);
        if (coords) {
          assignment.lat = coords.lat;
          assignment.lng = coords.lng;
          if (!assignment.address) assignment.address = coords.address;
        }
      }
    }
  }

  res.json({ success: true, days: parsed.days });
});

// POST /api/trips/:tripId/ai/accept
// Saves selected assignments to the DB
router.post('/:tripId/ai/accept', authenticate, async (req, res) => {
  const { tripId } = req.params;
  const { selections } = req.body;

  if (!selections || !Array.isArray(selections)) {
    return res.status(400).json({ error: ' selections array is required' });
  }

  // Check trip access
  if (!canAccessTrip(tripId, req.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Category name to ID mapping
  const categoryCache = {};
  function getCategoryId(categoryName) {
    if (!categoryName) return null;
    if (categoryCache[categoryName]) return categoryCache[categoryName];
    const category = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(categoryName);
    categoryCache[categoryName] = category?.id || null;
    return categoryCache[categoryName];
  }

  const trip = db.prepare('SELECT id, title, start_date, end_date FROM trips WHERE id = ?').get(tripId);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Get existing days for the trip
  const existingDays = db.prepare('SELECT id, day_number, title, date FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId);
  const dayNumbersMap = {};
  for (const day of existingDays) {
    dayNumbersMap[day.day_number] = day.id;
  }

  const savedAssignments = [];

  for (const selection of selections) {
    const { dayIndex, place_name, category, lat, lng, address, place_time, end_time, duration_minutes, notes } = selection;
    const dayNumber = dayIndex + 1;

    // Find or create the day
    let dayId = dayNumbersMap[dayNumber];
    if (!dayId) {
      // Create a new day
      let date = null;
      if (trip.start_date) {
        const startDate = new Date(trip.start_date);
        startDate.setDate(startDate.getDate() + dayIndex);
        date = startDate.toISOString().split('T')[0];
      }
      const dayTitle = selection.day_title || `Day ${dayNumber}`;
      const result = db.prepare(
        'INSERT INTO days (trip_id, day_number, date, title) VALUES (?, ?, ?, ?)'
      ).run(tripId, dayNumber, date, dayTitle);
      dayId = result.lastInsertRowid;
      dayNumbersMap[dayNumber] = dayId;
    }

    // Create the place
    const categoryId = getCategoryId(category);
    const placeResult = db.prepare(`
      INSERT INTO places (trip_id, name, lat, lng, address, category_id, place_time, end_time, duration_minutes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tripId,
      place_name,
      lat || null,
      lng || null,
      address || null,
      categoryId,
      place_time || null,
      end_time || null,
      duration_minutes || 60,
      notes || null
    );

    const placeId = placeResult.lastInsertRowid;

    // Create the day assignment
    const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM day_assignments WHERE day_id = ?').get(dayId);
    const orderIndex = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

    db.prepare(
      'INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)'
    ).run(dayId, placeId, orderIndex);

    savedAssignments.push({ dayId, placeId, place_name, dayNumber });
  }

  res.json({ success: true, saved: savedAssignments });
});

module.exports = router;
