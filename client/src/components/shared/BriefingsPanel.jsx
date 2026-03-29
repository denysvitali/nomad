import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../i18n'
import { Bell, X, Plane, Building2, Calendar, MapPin, ChevronRight } from 'lucide-react'

function getDaysUntil(dateStr) {
  if (!dateStr) return ''
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr)
  target.setHours(0, 0, 0, 0)
  const diff = Math.round((target - today) / (1000 * 60 * 60 * 24))
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  return `${diff} days`
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function WeatherIcon({ code }) {
  // WMO weather codes mapped to simple icons
  if (code === undefined || code === null) return null
  if (code === 0) return <span>☀️</span>
  if (code <= 3) return <span>⛅</span>
  if (code <= 49) return <span>🌫️</span>
  if (code <= 69) return <span>🌧️</span>
  if (code <= 79) return <span>🌨️</span>
  if (code <= 82) return <span>🌧️</span>
  if (code <= 86) return <span>🌨️</span>
  if (code >= 95) return <span>⛈️</span>
  return <span>🌤️</span>
}

export default function BriefingsPanel({ pendingBriefings, onDismiss }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [viewedId, setViewedId] = useState(null)
  const panelRef = useRef(null)
  const dark = document.documentElement.classList.contains('dark')

  // Close panel when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen])

  if (pendingBriefings.length === 0) return null

  const handleView = (briefing) => {
    setViewedId(briefing.tripId)
    setIsOpen(false)
    navigate(`/trip/${briefing.tripId}`)
  }

  const handleDismiss = (e, tripId) => {
    e.stopPropagation()
    onDismiss(tripId)
  }

  return (
    <div ref={panelRef} className="fixed top-[calc(var(--nav-h)+8px)] right-4 z-[200]" style={{ marginTop: 0 }}>
      {/* Bell Icon Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative flex items-center justify-center w-10 h-10 rounded-full shadow-lg transition-all hover:scale-105"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <Bell className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
        {/* Badge */}
        <span
          className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white rounded-full"
          style={{ background: '#ef4444', minWidth: 20, minHeight: 20 }}
        >
          {pendingBriefings.length}
        </span>
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl shadow-xl border"
          style={{
            background: 'var(--bg-card)',
            borderColor: 'var(--border-primary)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: 'var(--border-secondary)' }}
          >
            <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              {t('briefing.title')}
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>

          <div className="py-1">
            {pendingBriefings.map((item) => {
              const { briefing, tripId, receivedAt } = item
              const trip = briefing?.trip
              const summary = briefing?.summary
              const daysUntil = getDaysUntil(trip?.start_date)
              const isViewed = viewedId === tripId

              return (
                <div
                  key={`${tripId}-${receivedAt}`}
                  onClick={() => handleView(item)}
                  className="mx-2 my-1 p-3 rounded-lg cursor-pointer transition-all hover:scale-[1.02] relative"
                  style={{
                    background: isViewed ? 'var(--bg-tertiary)' : 'var(--bg-hover)',
                    border: '1px solid var(--border-primary)',
                    opacity: isViewed ? 0.7 : 1,
                  }}
                >
                  {/* Dismiss button */}
                  <button
                    onClick={(e) => handleDismiss(e, tripId)}
                    className="absolute top-2 right-2 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                  >
                    <X className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
                  </button>

                  {/* Trip title and dates */}
                  <div className="pr-6">
                    <p className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                      {trip?.title || 'Trip Briefing'}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {trip?.start_date && trip?.end_date
                        ? `${formatDate(trip.start_date)} – ${formatDate(trip.end_date)}`
                        : ''}
                    </p>
                  </div>

                  {/* Days until departure */}
                  {daysUntil && (
                    <div className="mt-2">
                      <span
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                      >
                        <Calendar className="w-3 h-3" />
                        {daysUntil}
                      </span>
                    </div>
                  )}

                  {/* Summary stats */}
                  <div className="flex items-center gap-3 mt-2">
                    {summary?.flight_count > 0 && (
                      <span
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}
                      >
                        <Plane className="w-3 h-3" />
                        {t('briefing.flights', { count: summary.flight_count })}
                      </span>
                    )}
                    {summary?.hotel_count > 0 && (
                      <span
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' }}
                      >
                        <Building2 className="w-3 h-3" />
                        {t('briefing.hotels', { count: summary.hotel_count })}
                      </span>
                    )}
                  </div>

                  {/* Days summary */}
                  {briefing?.days?.length > 0 && (
                    <div className="mt-2 flex items-center gap-1 flex-wrap">
                      {briefing.days.slice(0, 3).map((day, i) => (
                        <div key={day.id || i} className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" style={{ color: 'var(--text-faint)' }} />
                          <span className="text-xs truncate max-w-[100px]" style={{ color: 'var(--text-muted)' }}>
                            {day.assignments?.[0]?.place_name || day.title || `Day ${day.day_number}`}
                          </span>
                          {day.assignments?.[0]?.weather && (
                            <WeatherIcon code={day.assignments[0].weather.code} />
                          )}
                        </div>
                      ))}
                      {briefing.days.length > 3 && (
                        <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                          +{briefing.days.length - 3} more
                        </span>
                      )}
                    </div>
                  )}

                  {/* View button */}
                  <div
                    className="mt-2 flex items-center justify-end gap-1 text-xs font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <span>{t('briefing.view')}</span>
                    <ChevronRight className="w-3 h-3" />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Empty state */}
          {pendingBriefings.length === 0 && (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('briefing.noBriefings')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
