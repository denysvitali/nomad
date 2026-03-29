import React, { useState } from 'react'
import Modal from '../shared/Modal'
import { useTranslation } from '../../i18n'
import { useTripStore } from '../../store/tripStore'
import { aiApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Sparkles, Loader2, ChevronDown, ChevronRight, MapPin, Clock, X, Check } from 'lucide-react'

const EXAMPLE_PROMPTS = [
  '5 days in Japan, temples in the morning, street food in the afternoon, one day for shopping in Shibuya',
  '3 days in Italy, Rome food tour, Vatican visit, Colosseum at sunset',
  '1 week road trip through California, beaches, national parks, LA to San Francisco',
]

const CATEGORY_COLORS = {
  Hotel: '#3b82f6',
  Restaurant: '#ef4444',
  Attraction: '#8b5cf6',
  Shopping: '#f59e0b',
  Transport: '#6b7280',
  Activity: '#10b981',
  'Bar/Cafe': '#f97316',
  Beach: '#06b6d4',
  Nature: '#84cc16',
  Other: '#6366f1',
}

export default function DreamTripModal({ isOpen, onClose, tripId }) {
  const { t } = useTranslation()
  const toast = useToast()
  const refreshDays = useTripStore(s => s.refreshDays)

  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [accepting, setAccepting] = useState(false)
  const [expandedDays, setExpandedDays] = useState(new Set())

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error(t('dreamTrip.errors.emptyPrompt'))
      return
    }
    setGenerating(true)
    setResult(null)
    setSelected(new Set())
    try {
      const data = await aiApi.generate(tripId, prompt)
      if (data.error) {
        if (data.code === 'NO_KEY') {
          toast.error(t('dreamTrip.errors.noKey'))
        } else {
          toast.error(data.error)
        }
        return
      }
      setResult(data.days)
      // Select all by default
      const allIndexes = new Set(data.days.flatMap((day, di) => day.assignments.map((_, ai) => `${di}-${ai}`)))
      setSelected(allIndexes)
      // Expand all days by default
      setExpandedDays(new Set(data.days.map((_, di) => di)))
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || t('dreamTrip.errors.generationFailed'))
    } finally {
      setGenerating(false)
    }
  }

  const handleAccept = async () => {
    if (!result) return
    setAccepting(true)
    try {
      // Build selections array from selected indexes
      const selections = []
      result.forEach((day, dayIndex) => {
        day.assignments.forEach((assignment, assignIndex) => {
          if (selected.has(`${dayIndex}-${assignIndex}`)) {
            selections.push({
              dayIndex,
              day_title: day.title,
              place_name: assignment.place_name,
              category: assignment.category,
              lat: assignment.lat,
              lng: assignment.lng,
              address: assignment.address,
              place_time: assignment.place_time,
              end_time: assignment.end_time,
              duration_minutes: assignment.duration_minutes,
              notes: assignment.notes,
            })
          }
        })
      })

      await aiApi.accept(tripId, selections)
      await refreshDays(tripId)
      toast.success(t('dreamTrip.toast.accepted', { count: selections.length }))
      handleClose()
    } catch (err) {
      toast.error(err.response?.data?.error || t('dreamTrip.errors.acceptFailed'))
    } finally {
      setAccepting(false)
    }
  }

  const handleClose = () => {
    setPrompt('')
    setResult(null)
    setSelected(new Set())
    setExpandedDays(new Set())
    onClose()
  }

  const toggleSelection = (key) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleDay = (dayIndex) => {
    setExpandedDays(prev => {
      const next = new Set(prev)
      if (next.has(dayIndex)) next.delete(dayIndex)
      else next.add(dayIndex)
      return next
    })
  }

  const selectedCount = selected.size

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('dreamTrip.title')}
      size="lg"
      footer={
        <div className="flex items-center justify-between">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {result ? t('dreamTrip.selectedCount', { count: selectedCount }) : ''}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50 transition-colors"
              style={{ borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}
            >
              {t('dreamTrip.discard')}
            </button>
            {result && (
              <button
                onClick={handleAccept}
                disabled={selectedCount === 0 || accepting}
                className="px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                style={{ background: selectedCount > 0 ? 'var(--accent)' : undefined, color: selectedCount > 0 ? 'var(--accent-text)' : undefined }}
              >
                {accepting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('dreamTrip.acceptSelected', { count: selectedCount })}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Prompt textarea */}
        <div>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t('dreamTrip.promptPlaceholder')}
            rows={4}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-indigo-400 focus:border-transparent resize-none"
            style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
            disabled={generating}
          />
        </div>

        {/* Example prompts */}
        {!result && (
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((example, i) => (
              <button
                key={i}
                onClick={() => setPrompt(example)}
                className="text-xs px-3 py-1.5 rounded-full border transition-colors hover:bg-slate-50"
                style={{ borderColor: 'var(--border-secondary)', color: 'var(--text-secondary)' }}
              >
                {example.length > 50 ? example.substring(0, 50) + '...' : example}
              </button>
            ))}
          </div>
        )}

        {/* Generate button */}
        {!result && (
          <button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            className="w-full py-2.5 px-4 rounded-lg font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('dreamTrip.generating')}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                {t('dreamTrip.generate')}
              </>
            )}
          </button>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-3">
            {result.length === 0 ? (
              <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                {t('dreamTrip.noResults')}
              </div>
            ) : (
              result.map((day, dayIndex) => (
                <div key={dayIndex} className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border-secondary)' }}>
                  {/* Day header */}
                  <button
                    onClick={() => toggleDay(dayIndex)}
                    className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
                    style={{ background: 'var(--bg-elevated)' }}
                  >
                    <div className="flex items-center gap-2">
                      {expandedDays.has(dayIndex) ? (
                        <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      ) : (
                        <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      )}
                      <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                        {day.title || `Day ${dayIndex + 1}`}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {day.assignments.length} places
                      </span>
                    </div>
                  </button>

                  {/* Assignments */}
                  {expandedDays.has(dayIndex) && (
                    <div className="divide-y" style={{ borderColor: 'var(--border-secondary)' }}>
                      {day.assignments.map((assignment, assignIndex) => {
                        const key = `${dayIndex}-${assignIndex}`
                        const isSelected = selected.has(key)
                        const color = CATEGORY_COLORS[assignment.category] || CATEGORY_COLORS.Other
                        return (
                          <div
                            key={key}
                            className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors cursor-pointer"
                            onClick={() => toggleSelection(key)}
                          >
                            <div
                              className="mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors"
                              style={{
                                borderColor: isSelected ? color : 'var(--border-secondary)',
                                background: isSelected ? color : 'transparent',
                              }}
                            >
                              {isSelected && <Check className="w-3 h-3 text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                                  {assignment.place_name}
                                </span>
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                                  style={{ background: color + '20', color }}
                                >
                                  {assignment.category}
                                </span>
                              </div>
                              {(assignment.place_time || assignment.address) && (
                                <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                                  {assignment.place_time && (
                                    <span className="flex items-center gap-1">
                                      <Clock className="w-3 h-3" />
                                      {assignment.place_time}
                                      {assignment.end_time && ` - ${assignment.end_time}`}
                                    </span>
                                  )}
                                  {assignment.address && (
                                    <span className="flex items-center gap-1 truncate">
                                      <MapPin className="w-3 h-3 flex-shrink-0" />
                                      <span className="truncate">{assignment.address.split(',')[0]}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                              {assignment.notes && (
                                <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                                  {assignment.notes}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
