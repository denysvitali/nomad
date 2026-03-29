const { db } = require('../db/database');
const { broadcastToUser } = require('../websocket');

// Fetches weather for a place using Open-Meteo API
async function getWeatherForPlace(lat, lng, date) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&start_date=${date}&end_date=${date}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.daily) {
      return {
        temp: Math.round((data.daily.temperature_2m_max[0] + data.daily.temperature_2m_min[0]) / 2),
        code: data.daily.weathercode[0],
        precipitation: data.daily.precipitation_sum[0],
      };
    }
  } catch { return null; }
}

module.exports = async function runBriefingJob() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

  // Find all trips starting tomorrow that haven't been briefed yet
  const trips = db.prepare(`
    SELECT t.*, u.id as owner_id FROM trips t
    JOIN trip_members tm ON t.id = tm.trip_id
    JOIN users u ON tm.user_id = u.id
    WHERE date(t.start_date) = date(?)
    AND (t.briefing_sent_at IS NULL OR t.briefing_sent_at = '')
    GROUP BY t.id
  `).all(tomorrowStr);

  for (const trip of trips) {
    try {
      // 1. Gather all reservations (flights, hotels, etc.)
      const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ?').all(trip.id);

      // 2. Gather all day assignments with places
      const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(trip.id);
      const enrichedDays = [];
      for (const day of days) {
        const assignments = db.prepare(`
          SELECT da.*, p.name as place_name, p.lat, p.lng, p.category_id
          FROM day_assignments da
          JOIN places p ON da.place_id = p.id
          WHERE da.day_id = ?
          ORDER BY da.order_index
        `).all(day.id);

        // Pre-fetch weather for each place (skip if too slow)
        const weatherPromises = assignments.map(async (a) => {
          if (a.lat && a.lng) {
            const w = await getWeatherForPlace(a.lat, a.lng, day.date);
            return { ...a, weather: w };
          }
          return { ...a, weather: null };
        });

        const withWeather = await Promise.all(weatherPromises);
        enrichedDays.push({ ...day, assignments: withWeather });
      }

      // 3. Build briefing payload
      const briefing = {
        generated_at: new Date().toISOString(),
        trip: { id: trip.id, title: trip.title, start_date: trip.start_date, end_date: trip.end_date },
        summary: {
          total_days: enrichedDays.length,
          flight_count: reservations.filter(r => r.type === 'flight').length,
          hotel_count: reservations.filter(r => r.type === 'hotel').length,
        },
        days: enrichedDays,
        flights: reservations.filter(r => r.type === 'flight').map(f => ({
          flight_number: f.flight_number,
          airline: f.airline,
          departure: f.departure_airport,
          arrival: f.arrival_airport,
          time: f.reservation_time,
          confirmation: f.confirmation_number,
        })),
        hotels: reservations.filter(r => r.type === 'hotel').map(h => ({
          title: h.title,
          location: h.location,
          confirmation: h.confirmation_number,
          time: h.reservation_time,
        })),
      };

      // 4. Store in DB
      db.prepare('UPDATE trips SET briefing_sent_at = ?, briefing_payload_json = ? WHERE id = ?')
        .run(new Date().toISOString(), JSON.stringify(briefing), trip.id);

      // 5. Broadcast to all trip members via WebSocket
      // Get all user IDs for this trip
      const members = db.prepare('SELECT user_id FROM trip_members WHERE trip_id = ?').all(trip.id);
      const payload = { type: 'trip_briefing', tripId: trip.id, briefing };

      for (const member of members) {
        broadcastToUser(member.user_id, payload);
      }

      console.log(`[Briefing] Sent for trip ${trip.id}: ${trip.title}`);
    } catch (err) {
      console.error(`[Briefing] Failed for trip ${trip.id}:`, err);
    }
  }
};
