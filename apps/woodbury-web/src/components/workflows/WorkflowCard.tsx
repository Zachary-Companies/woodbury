'use client'

import type { SharedWorkflow } from '@/types/workflow'

/** Step type badge labels */
const stepTypeLabels: Record<string, string> = {
  navigate: 'Navigate',
  click: 'Click',
  type: 'Type',
  wait: 'Wait',
  assert: 'Assert',
  scroll: 'Scroll',
  keyboard: 'Keyboard',
  download: 'Download',
  fileDialog: 'File Dialog',
  moveFile: 'Move File',
  conditional: 'If/Else',
  loop: 'Loop',
  tryCatch: 'Try/Catch',
  setVariable: 'Variable',
  subWorkflow: 'Sub-Workflow',
  desktopLaunchApp: 'Launch App',
  desktopClick: 'Desktop Click',
  desktopType: 'Desktop Type',
  desktopKeyboard: 'Desktop Key',
  captureDownload: 'Capture DL',
}

/** Star rating display */
function Stars({ rating, count }: { rating: number; count: number }) {
  if (count === 0) return <span className="text-xs text-slate-600">No ratings</span>
  const full = Math.floor(rating)
  const half = rating - full >= 0.5
  return (
    <span className="flex items-center gap-1 text-xs text-amber-400">
      {Array.from({ length: 5 }, (_, i) => (
        <svg
          key={i}
          className={`h-3.5 w-3.5 ${i < full ? 'fill-amber-400' : i === full && half ? 'fill-amber-400/50' : 'fill-slate-700'}`}
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
      <span className="ml-1 text-slate-500">({count})</span>
    </span>
  )
}

export default function WorkflowCard({ workflow }: { workflow: SharedWorkflow }) {
  const wf = workflow

  return (
    <a
      href={`/workflows/view?id=${wf.id}`}
      className="landing-card flex flex-col transition-all hover:border-purple-500/30 hover:shadow-lg hover:shadow-purple-500/5"
    >
      {/* Screenshot preview */}
      {wf.screenshotURLs?.[0] ? (
        <div className="mb-4 overflow-hidden rounded-lg border border-white/5">
          <img
            src={wf.screenshotURLs[0]}
            alt={wf.name}
            className="aspect-video w-full object-cover"
          />
        </div>
      ) : (
        <div className="mb-4 flex aspect-video items-center justify-center rounded-lg border border-white/5 bg-slate-800/50">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-600/20 text-purple-400">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-white">{wf.name}</h3>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>v{wf.currentVersion}</span>
            <span>·</span>
            <span>{wf.site}</span>
          </div>
        </div>
        {wf.hasModel && (
          <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
            AI Visual
          </span>
        )}
      </div>

      {/* Description */}
      <p className="mb-4 flex-1 text-sm leading-relaxed text-slate-400 line-clamp-2">
        {wf.description}
      </p>

      {/* Step type badges */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {wf.stepTypes?.slice(0, 4).map((type) => (
          <span
            key={type}
            className="rounded-full border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-xs text-purple-300"
          >
            {stepTypeLabels[type] || type}
          </span>
        ))}
        {wf.stepTypes?.length > 4 && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-slate-500">
            +{wf.stepTypes.length - 4}
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="mb-4 flex items-center gap-4 text-sm text-slate-500">
        <span className="flex items-center gap-1">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          {wf.downloadCount.toLocaleString()}
        </span>
        <span className="flex items-center gap-1">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
          </svg>
          {wf.stepCount} steps
        </span>
        <Stars rating={wf.rating} count={wf.ratingCount} />
      </div>

      {/* Author */}
      <div className="flex items-center gap-2 border-t border-white/5 pt-3">
        {wf.authorPhotoURL ? (
          <img
            src={wf.authorPhotoURL}
            alt={wf.authorName}
            className="h-5 w-5 rounded-full"
          />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-xs text-slate-400">
            {wf.authorName?.[0] || '?'}
          </div>
        )}
        <span className="text-xs text-slate-500">{wf.authorName}</span>
      </div>
    </a>
  )
}
