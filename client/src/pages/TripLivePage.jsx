import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { ChevronDown, ChevronUp, MapPin, Calendar, MessageCircle, BarChart3, Send, Users, X, Copy, Check, ExternalLink } from 'lucide-react'
import { useTranslation } from '../i18n'
import { addListener, removeListener, connect as wsConnect, joinTrip } from '../api/websocket'

// Fix default marker icons for vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
})

function createMarkerIcon(color, icon) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:32px;height:32px;border-radius:50%;
      border:2.5px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.25);
      background:${color || '#6b7280'};
      display:flex;align-items:center;justify-content:center;
      font-size:14px;cursor:pointer;
    ">${icon || '📍'}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  })
}

function parseUTC(s) {
  return new Date(s && !s.endsWith('Z') ? s + 'Z' : s)
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function formatDateFull(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatTime(isoString) {
  if (!isoString) return ''
  const d = parseUTC(isoString)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${String(h).padStart(2, '0')}:${mm}`
}

const EMOJI_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '👎', '🔥', '👏', '✅', '🎉']

export default function TripLivePage() {
  const { id: tripIdAndToken } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  // Parse tripId and token from URL: /trip/:id-live-token/live
  const [tripId, token] = tripIdAndToken ? tripIdAndToken.split('-live-') : [null, null]

  const [trip, setTrip] = useState(null)
  const [days, setDays] = useState([])
  const [reservations, setReservations] = useState([])
  const [accommodations, setAccommodations] = useState([])
  const [collab, setCollab] = useState({ messages: [], polls: [], notes: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState(false)
  const [expandedDays, setExpandedDays] = useState({})
  const [showChat, setShowChat] = useState(true)
  const [chatTab, setChatTab] = useState('chat') // 'chat' | 'polls'
  const [messageText, setMessageText] = useState('')
  const [voting, setVoting] = useState({})
  const [copied, setCopied] = useState(false)
  const messagesEndRef = useRef(null)
  const chatContainerRef = useRef(null)

  const apiClient = useRef(null)

  // Create axios client with session token
  useEffect(() => {
    if (!token) return
    const axios = require('axios')
    apiClient.current = axios.create({
      baseURL: '/api',
      headers: { 'x-session-password': password },
    })
  }, [token, password])

  // Fetch live trip data
  const fetchLiveData = useCallback((pwd = '') => {
    if (!token) return
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/trips/live/${token}${pwd ? `?password=${encodeURIComponent(pwd)}` : ''}`)
        if (res.status === 401 && (await res.clone().json()).requires_password) {
          setPasswordRequired(true)
          setLoading(false)
          return
        }
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Failed to load trip')
        }
        const data = await res.json()
        setTrip(data.trip)
        setDays(data.days)
        setReservations(data.reservations || [])
        setAccommodations(data.accommodations || [])
        setCollab(data.collab || { messages: [], polls: [], notes: [] })
        setPasswordRequired(false)
        if (data.days.length > 0) {
          setExpandedDays({ [data.days[0].id]: true })
        }
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [token])

  useEffect(() => {
    fetchLiveData()
  }, [fetchLiveData])

  const handlePasswordSubmit = (e) => {
    e.preventDefault()
    setPasswordError(false)
    fetchLiveData(password)
  }

  // WebSocket connection for real-time updates
  useEffect(() => {
    if (!token || passwordRequired || !trip) return

    wsConnect(null) // Connect without JWT - we'll auth as guest

    const handleMessage = (msg) => {
      if (msg.type === 'authenticated' || msg.type === 'welcome') return

      if (msg.type === 'collab:message:created' && msg.tripId === Number(tripId)) {
        setCollab(prev => ({
          ...prev,
          messages: [...prev.messages, msg.message],
        }))
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      }

      if (msg.type === 'collab:message:reacted' && msg.tripId === Number(tripId)) {
        setCollab(prev => ({
          ...prev,
          messages: prev.messages.map(m =>
            m.id === msg.messageId ? { ...m, reactions: msg.reactions } : m
          ),
        }))
      }

      if (msg.type === 'collab:poll:voted' && msg.tripId === Number(tripId)) {
        setCollab(prev => ({
          ...prev,
          polls: prev.polls.map(p =>
            p.id === msg.poll.id ? msg.poll : p
          ),
        }))
      }

      if (msg.type === 'collab:poll:created' && msg.tripId === Number(tripId)) {
        setCollab(prev => ({
          ...prev,
          polls: [msg.poll, ...prev.polls],
        }))
      }
    }

    addListener(handleMessage)

    // Authenticate as guest after a short delay
    const authTimer = setTimeout(() => {
      if (window.socket && window.socket.readyState === WebSocket.OPEN) {
        window.socket.send(JSON.stringify({ type: 'auth_guest', token, password: password || undefined }))
      }
    }, 500)

    // Join the trip room
    const joinTimer = setTimeout(() => {
      joinTrip(Number(tripId))
    }, 1000)

    return () => {
      clearTimeout(authTimer)
      clearTimeout(joinTimer)
      removeListener(handleMessage)
    }
  }, [token, passwordRequired, trip, tripId, password])

  // Send message
  const handleSendMessage = async (e) => {
    e.preventDefault()
    if (!messageText.trim() || !apiClient.current) return

    try {
      const res = await apiClient.current.post(`/trips/${tripId}/collab/messages`, {
        text: messageText.trim(),
      })
      // Message will come through WebSocket
      setMessageText('')
    } catch (err) {
      console.error('Failed to send message:', err)
    }
  }

  // React to message
  const handleReact = async (messageId, emoji) => {
    if (!apiClient.current) return
    try {
      await apiClient.current.post(`/trips/${tripId}/collab/messages/${messageId}/react`, { emoji })
    } catch (err) {
      console.error('Failed to react:', err)
    }
  }

  // Vote in poll
  const handleVote = async (pollId, optionIndex) => {
    if (!apiClient.current || voting[`${pollId}-${optionIndex}`]) return
    setVoting(prev => ({ ...prev, [`${pollId}-${optionIndex}`]: true }))
    try {
      await apiClient.current.post(`/trips/${tripId}/collab/polls/${pollId}/vote`, { option_index: optionIndex })
    } catch (err) {
      console.error('Failed to vote:', err)
    } finally {
      setVoting(prev => ({ ...prev, [`${pollId}-${optionIndex}`]: false }))
    }
  }

  const toggleDay = (dayId) => {
    setExpandedDays(prev => ({ ...prev, [dayId]: !prev[dayId] }))
  }

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Collect all places for map
  const allPlaces = days.flatMap(day =>
    (day.assignments || []).map(a => ({
      ...a.place,
      dayNumber: day.day_number,
      dayDate: day.date,
      reservationStatus: a.reservation_status,
    }))
  )

  const mapCenter = allPlaces.length > 0 && allPlaces.some(p => p.lat && p.lng)
    ? [
        allPlaces.filter(p => p.lat && p.lng).reduce((sum, p) => sum + p.lat, 0) / allPlaces.filter(p => p.lat && p.lng).length,
        allPlaces.filter(p => p.lat && p.lng).reduce((sum, p) => sum + p.lng, 0) / allPlaces.filter(p => p.lat && p.lng).length,
      ]
    : [48.8566, 2.3522]

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48,
            border: '4px solid rgba(255,255,255,0.3)',
            borderTopColor: 'white',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 16px',
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ fontSize: 18, fontWeight: 500 }}>Loading trip...</p>
        </div>
      </div>
    )
  }

  if (passwordRequired) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: 'white',
        fontFamily: '-apple-system, system-ui, sans-serif',
        padding: 20,
      }}>
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 24,
          padding: 48,
          maxWidth: 400,
          width: '100%',
          textAlign: 'center',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ fontSize: 48, marginBottom: 24 }}>🔒</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>{t('live.passwordRequired', 'Password Required')}</h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', marginBottom: 32 }}>
            {t('live.enterPassword', 'This trip is password protected. Enter the password to view it.')}
          </p>
          <form onSubmit={handlePasswordSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordError(false) }}
              placeholder={t('live.enterPassword', 'Enter password')}
              style={{
                width: '100%',
                padding: '14px 18px',
                borderRadius: 12,
                border: passwordError ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.1)',
                color: 'white',
                fontSize: 16,
                outline: 'none',
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
            {passwordError && (
              <p style={{ color: '#ef4444', marginBottom: 16 }}>Incorrect password</p>
            )}
            <button
              type="submit"
              style={{
                width: '100%',
                padding: '14px 24px',
                borderRadius: 12,
                border: 'none',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('live.submit', 'Submit')}
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 18, marginBottom: 16 }}>Failed to load trip</p>
          <p style={{ opacity: 0.7 }}>{error}</p>
        </div>
      </div>
    )
  }

  if (!trip) return null

  const dateRange = trip.start_date && trip.end_date
    ? `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`
    : trip.start_date
    ? `Starting ${formatDate(trip.start_date)}`
    : ''

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
      {/* Hero Section */}
      <div style={{
        background: trip.cover_url
          ? `linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,0.8)), url(${trip.cover_url}) center/cover`
          : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '48px 24px 64px',
        color: 'white',
        position: 'relative',
      }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, opacity: 0.8 }}>
            <Users size={18} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>{t('live.guestView', 'Guest View')}</span>
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 800, margin: '0 0 12px', lineHeight: 1.2 }}>
            {trip.title}
          </h1>
          {dateRange && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.9, fontSize: 18 }}>
              <Calendar size={20} />
              <span>{dateRange}</span>
            </div>
          )}
          {trip.description && (
            <p style={{ marginTop: 16, opacity: 0.8, fontSize: 16, maxWidth: 600 }}>
              {trip.description}
            </p>
          )}
          {/* Share button */}
          <button
            onClick={copyLink}
            style={{
              marginTop: 24,
              padding: '12px 20px',
              borderRadius: 12,
              border: '2px solid rgba(255,255,255,0.4)',
              background: 'rgba(255,255,255,0.15)',
              color: 'white',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              backdropFilter: 'blur(10px)',
            }}
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
            {copied ? t('live.linkCopied', 'Link copied!') : t('live.share', 'Share Trip')}
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
        {/* Map Section */}
        {allPlaces.length > 0 && allPlaces.some(p => p.lat && p.lng) && (
          <div style={{
            background: 'white',
            borderRadius: 20,
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            marginBottom: 24,
          }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
              <MapPin size={20} style={{ color: '#667eea' }} />
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Map</h2>
            </div>
            <div style={{ height: 300 }}>
              <MapContainer
                center={mapCenter}
                zoom={allPlaces.length === 1 ? 13 : 5}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom={false}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {allPlaces.filter(p => p.lat && p.lng).map((place, idx) => (
                  <Marker
                    key={`${place.id}-${idx}`}
                    position={[place.lat, place.lng]}
                    icon={createMarkerIcon(place.category?.color, place.category?.icon)}
                  >
                    <Popup>
                      <div style={{ fontFamily: '-apple-system, system-ui, sans-serif', minWidth: 150 }}>
                        <strong style={{ fontSize: 14 }}>{place.name}</strong>
                        {place.address && <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>{place.address}</p>}
                        {place.dayDate && (
                          <p style={{ margin: '4px 0 0', fontSize: 11, color: '#667eea' }}>
                            Day {place.dayNumber} · {formatDate(place.dayDate)}
                          </p>
                        )}
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          </div>
        )}

        {/* Day Timeline */}
        <div style={{
          background: 'white',
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          marginBottom: 24,
        }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={20} style={{ color: '#667eea' }} />
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Itinerary</h2>
          </div>
          <div>
            {days.map((day, dayIdx) => (
              <div key={day.id} style={{
                borderBottom: dayIdx < days.length - 1 ? '1px solid #f1f5f9' : 'none',
              }}>
                <button
                  onClick={() => toggleDay(day.id)}
                  style={{
                    width: '100%',
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 44, height: 44,
                      borderRadius: 12,
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      color: 'white',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: 16,
                    }}>
                      {day.day_number}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: '#1e293b' }}>
                        {day.title || `Day ${day.day_number}`}
                      </div>
                      {day.date && (
                        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                          {formatDateFull(day.date)}
                        </div>
                      )}
                    </div>
                  </div>
                  {expandedDays[day.id]
                    ? <ChevronUp size={20} style={{ color: '#94a3b8' }} />
                    : <ChevronDown size={20} style={{ color: '#94a3b8' }} />
                  }
                </button>
                {expandedDays[day.id] && (
                  <div style={{ padding: '0 20px 16px' }}>
                    {day.assignments && day.assignments.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {day.assignments.map((assignment, idx) => (
                          <div
                            key={assignment.id}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 12,
                              padding: '12px 14px',
                              borderRadius: 12,
                              background: '#f8fafc',
                              border: '1px solid #e2e8f0',
                            }}
                          >
                            <div style={{
                              width: 10, height: 10,
                              borderRadius: '50%',
                              background: assignment.place.category?.color || '#94a3b8',
                              marginTop: 5,
                              flexShrink: 0,
                            }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, color: '#1e293b', fontSize: 15 }}>
                                {assignment.place.name}
                              </div>
                              {assignment.place.address && (
                                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
                                  {assignment.place.address}
                                </div>
                              )}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                {assignment.place.place_time && (
                                  <span style={{ fontSize: 12, color: '#667eea', fontWeight: 500 }}>
                                    {formatTime(assignment.place.place_time)}
                                  </span>
                                )}
                                {assignment.place.category && (
                                  <span style={{
                                    fontSize: 11,
                                    padding: '2px 8px',
                                    borderRadius: 20,
                                    background: `${assignment.place.category.color}20`,
                                    color: assignment.place.category.color,
                                    fontWeight: 500,
                                  }}>
                                    {assignment.place.category.icon} {assignment.place.category.name}
                                  </span>
                                )}
                                {assignment.reservation_status && assignment.reservation_status !== 'none' && (
                                  <span style={{
                                    fontSize: 11,
                                    padding: '2px 8px',
                                    borderRadius: 20,
                                    background: assignment.reservation_status === 'confirmed' ? '#10b98120' : '#f59e0b20',
                                    color: assignment.reservation_status === 'confirmed' ? '#10b981' : '#f59e0b',
                                    fontWeight: 500,
                                  }}>
                                    {assignment.reservation_status}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p style={{ color: '#94a3b8', fontSize: 14, margin: 0 }}>No activities planned</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Reservations */}
        {reservations.length > 0 && (
          <div style={{
            background: 'white',
            borderRadius: 20,
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            marginBottom: 24,
          }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ExternalLink size={20} style={{ color: '#667eea' }} />
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Reservations</h2>
            </div>
            <div style={{ padding: 16 }}>
              {reservations.map(res => (
                <div key={res.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderBottom: '1px solid #f1f5f9',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: '#1e293b' }}>{res.title}</div>
                    {res.location && <div style={{ fontSize: 13, color: '#64748b' }}>{res.location}</div>}
                    {res.confirmation_number && (
                      <div style={{ fontSize: 12, color: '#667eea', marginTop: 2 }}>
                        Confirmation: {res.confirmation_number}
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: 12,
                    padding: '4px 10px',
                    borderRadius: 20,
                    background: res.status === 'confirmed' ? '#10b98120' : res.status === 'pending' ? '#f59e0b20' : '#e2e8f020',
                    color: res.status === 'confirmed' ? '#10b981' : res.status === 'pending' ? '#f59e0b' : '#94a3b8',
                    fontWeight: 500,
                  }}>
                    {res.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Collab Panel */}
        <div style={{
          background: 'white',
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        }}>
          <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
            <button
              onClick={() => { setChatTab('chat'); setShowChat(true) }}
              style={{
                flex: 1,
                padding: '14px',
                border: 'none',
                background: chatTab === 'chat' ? '#667eea' : 'transparent',
                color: chatTab === 'chat' ? 'white' : '#64748b',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <MessageCircle size={18} />
              Chat {collab.messages.length > 0 && `(${collab.messages.length})`}
            </button>
            <button
              onClick={() => { setChatTab('polls'); setShowChat(true) }}
              style={{
                flex: 1,
                padding: '14px',
                border: 'none',
                background: chatTab === 'polls' ? '#667eea' : 'transparent',
                color: chatTab === 'polls' ? 'white' : '#64748b',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <BarChart3 size={18} />
              Polls {collab.polls.length > 0 && `(${collab.polls.length})`}
            </button>
          </div>

          {showChat && chatTab === 'chat' && (
            <div>
              {/* Messages */}
              <div
                ref={chatContainerRef}
                style={{
                  height: 350,
                  overflowY: 'auto',
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                {collab.messages.length === 0 ? (
                  <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, marginTop: 40 }}>
                    No messages yet. Start the conversation!
                  </p>
                ) : (
                  collab.messages.map(msg => (
                    <div key={msg.id} style={{ display: 'flex', gap: 10 }}>
                      <div style={{
                        width: 36, height: 36,
                        borderRadius: '50%',
                        background: '#667eea',
                        color: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 600,
                        fontSize: 14,
                        flexShrink: 0,
                      }}>
                        {msg.username?.[0]?.toUpperCase() || '?'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>{msg.username}</span>
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>
                            {formatTime(msg.created_at)}
                          </span>
                        </div>
                        <div style={{ fontSize: 14, color: '#334155', marginTop: 2 }}>
                          {msg.text}
                        </div>
                        {/* Reactions */}
                        {msg.reactions && msg.reactions.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            {msg.reactions.map(r => (
                              <button
                                key={r.emoji}
                                onClick={() => handleReact(msg.id, r.emoji)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '2px 8px',
                                  borderRadius: 20,
                                  border: '1px solid #e2e8f0',
                                  background: '#f8fafc',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                }}
                              >
                                <span>{r.emoji}</span>
                                <span style={{ color: '#64748b' }}>{r.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {/* Quick reactions */}
                        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                          {EMOJI_REACTIONS.slice(0, 5).map(emoji => (
                            <button
                              key={emoji}
                              onClick={() => handleReact(msg.id, emoji)}
                              style={{
                                fontSize: 14,
                                padding: '2px 4px',
                                border: 'none',
                                background: 'none',
                                cursor: 'pointer',
                                opacity: 0.5,
                              }}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
              {/* Message input */}
              <form onSubmit={handleSendMessage} style={{
                padding: '12px 16px',
                borderTop: '1px solid #f1f5f9',
                display: 'flex',
                gap: 10,
              }}>
                <input
                  type="text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="Type a message..."
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    borderRadius: 24,
                    border: '1px solid #e2e8f0',
                    fontSize: 14,
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  disabled={!messageText.trim()}
                  style={{
                    width: 40, height: 40,
                    borderRadius: '50%',
                    border: 'none',
                    background: messageText.trim() ? '#667eea' : '#e2e8f0',
                    color: messageText.trim() ? 'white' : '#94a3b8',
                    cursor: messageText.trim() ? 'pointer' : 'default',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Send size={18} />
                </button>
              </form>
            </div>
          )}

          {showChat && chatTab === 'polls' && (
            <div style={{ padding: 16 }}>
              {collab.polls.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, marginTop: 20 }}>
                  No polls yet.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {collab.polls.map(poll => (
                    <div key={poll.id} style={{
                      padding: 16,
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                    }}>
                      <div style={{ fontWeight: 600, fontSize: 15, color: '#1e293b', marginBottom: 12 }}>
                        {poll.question}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {poll.options.map((option, idx) => {
                          const totalVotes = poll.options.reduce((sum, o) => sum + (o.voters?.length || 0), 0)
                          const votes = option.voters?.length || 0
                          const pct = totalVotes > 0 ? (votes / totalVotes * 100) : 0
                          const hasVoted = option.voters?.some(v => v.username === 'Guest')

                          return (
                            <button
                              key={idx}
                              onClick={() => !poll.is_closed && handleVote(poll.id, idx)}
                              disabled={poll.is_closed || voting[`${poll.id}-${idx}`]}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '10px 12px',
                                borderRadius: 8,
                                border: hasVoted ? '2px solid #667eea' : '1px solid #e2e8f0',
                                background: poll.is_closed ? '#f8fafc' : 'white',
                                cursor: poll.is_closed ? 'default' : 'pointer',
                                textAlign: 'left',
                                position: 'relative',
                                overflow: 'hidden',
                              }}
                            >
                              {hasVoted && (
                                <div style={{
                                  position: 'absolute',
                                  left: 0, top: 0, bottom: 0,
                                  width: `${pct}%`,
                                  background: '#667eea20',
                                  borderRadius: 6,
                                }} />
                              )}
                              <span style={{ position: 'relative', fontSize: 14, fontWeight: 500, flex: 1 }}>
                                {option.label}
                              </span>
                              <span style={{ position: 'relative', fontSize: 12, color: '#64748b' }}>
                                {votes} {votes === 1 ? 'vote' : 'votes'}
                              </span>
                              {hasVoted && (
                                <Check size={14} style={{ position: 'relative', color: '#667eea' }} />
                              )}
                            </button>
                          )
                        })}
                      </div>
                      {poll.is_closed && (
                        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 8, textAlign: 'center' }}>
                          Poll closed
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
