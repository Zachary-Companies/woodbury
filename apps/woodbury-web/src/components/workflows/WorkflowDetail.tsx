'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { doc, getDoc } from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import type { SharedWorkflow } from '@/types/workflow'

export default function WorkflowDetail() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  const [workflow, setWorkflow] = useState<SharedWorkflow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAllVersions, setShowAllVersions] = useState(false)

  useEffect(() => {
    if (!id) {
      setError('No workflow ID provided')
      setLoading(false)
      return
    }

    async function fetchWorkflow() {
      try {
        const docRef = doc(firestore, 'shared-workflows', id!)
        const docSnap = await getDoc(docRef)
        if (!docSnap.exists()) {
          setError('Workflow not found')
        } else {
          setWorkflow({ ...docSnap.data(), id: docSnap.id } as SharedWorkflow)
        }
      } catch (err) {
        console.error('Failed to fetch workflow:', err)
        setError('Failed to load workflow')
      } finally {
        setLoading(false)
      }
    }

    fetchWorkflow()
  }, [id])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-slate-500">Loading workflow...</div>
      </div>
    )
  }

  if (error || !workflow) {
    return (
      <div className="py-20 text-center">
        <h2 className="text-xl font-semibold text-white">{error || 'Workflow not found'}</h2>
        <a href="/workflows" className="mt-4 inline-block text-sm text-purple-400 hover:text-purple-300">
          &larr; Back to marketplace
        </a>
      </div>
    )
  }

  const wf = workflow
  const visibleVersions = showAllVersions ? wf.versions : wf.versions?.slice(-3)

  return (
    <div>
      {/* Back link */}
      <a href="/workflows" className="mb-8 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to marketplace
      </a>

      {/* Header */}
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{wf.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <span>v{wf.currentVersion}</span>
            <span>·</span>
            <span>{wf.site}</span>
            <span>·</span>
            <span>{wf.stepCount} steps</span>
            {wf.variableCount > 0 && (
              <>
                <span>·</span>
                <span>{wf.variableCount} variables</span>
              </>
            )}
          </div>
          {/* Author */}
          <a
            href={`/profile?uid=${wf.authorId}`}
            className="mt-3 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"
          >
            {wf.authorPhotoURL ? (
              <img src={wf.authorPhotoURL} alt={wf.authorName} className="h-6 w-6 rounded-full" />
            ) : (
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-xs text-slate-400">
                {wf.authorName?.[0] || '?'}
              </div>
            )}
            {wf.authorName}
          </a>
        </div>

        {/* Install button */}
        <div className="flex flex-col items-end gap-2">
          <a
            href={`woodbury://workflow/install/${wf.id}`}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-6 py-3 text-sm font-semibold text-white transition-all hover:from-purple-500 hover:to-violet-500"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Open in Woodbury
          </a>
          {wf.hasModel && (
            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
              Includes AI Visual Matching Model
            </span>
          )}
        </div>
      </div>

      {/* Badges */}
      <div className="mb-8 flex flex-wrap gap-2">
        {wf.tags?.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-400"
          >
            {tag}
          </span>
        ))}
        {wf.stepTypes?.map((type) => (
          <span
            key={type}
            className="rounded-full border border-purple-500/20 bg-purple-500/10 px-3 py-1 text-xs text-purple-300"
          >
            {type}
          </span>
        ))}
      </div>

      {/* Stats bar */}
      <div className="mb-8 flex flex-wrap gap-6 rounded-xl border border-white/5 bg-slate-900/60 p-4">
        <div className="text-center">
          <div className="text-2xl font-bold text-white">{wf.downloadCount.toLocaleString()}</div>
          <div className="text-xs text-slate-500">Downloads</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-white">
            {wf.ratingCount > 0 ? wf.rating.toFixed(1) : '—'}
          </div>
          <div className="text-xs text-slate-500">
            Rating{wf.ratingCount > 0 ? ` (${wf.ratingCount})` : ''}
          </div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-white">{wf.stepCount}</div>
          <div className="text-xs text-slate-500">Steps</div>
        </div>
        {wf.versions && (
          <div className="text-center">
            <div className="text-2xl font-bold text-white">{wf.versions.length}</div>
            <div className="text-xs text-slate-500">Versions</div>
          </div>
        )}
      </div>

      {/* Screenshots */}
      {wf.screenshotURLs?.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-white">Screenshots</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {wf.screenshotURLs.map((url, i) => (
              <div key={i} className="overflow-hidden rounded-lg border border-white/5">
                <img src={url} alt={`Screenshot ${i + 1}`} className="w-full" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      <div className="mb-8">
        <h2 className="mb-4 text-lg font-semibold text-white">Description</h2>
        <div className="rounded-xl border border-white/5 bg-slate-900/60 p-6">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{wf.description}</p>
        </div>
      </div>

      {/* Version History */}
      {wf.versions && wf.versions.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold text-white">Version History</h2>
          <div className="rounded-xl border border-white/5 bg-slate-900/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left text-xs text-slate-500">
                  <th className="px-4 py-3">Version</th>
                  <th className="px-4 py-3">Changes</th>
                  <th className="px-4 py-3">Steps</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {visibleVersions?.map((v) => (
                  <tr key={v.version} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3 font-mono text-purple-300">v{v.version}</td>
                    <td className="px-4 py-3 text-slate-400">{v.changelog || '—'}</td>
                    <td className="px-4 py-3 text-slate-400">{v.stepCount}</td>
                    <td className="px-4 py-3">
                      {v.modelStoragePath ? (
                        <span className="text-emerald-400">Yes</span>
                      ) : (
                        <span className="text-slate-600">No</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!showAllVersions && wf.versions.length > 3 && (
              <button
                onClick={() => setShowAllVersions(true)}
                className="w-full border-t border-white/5 px-4 py-3 text-center text-xs text-slate-500 hover:text-white"
              >
                Show all {wf.versions.length} versions
              </button>
            )}
          </div>
        </div>
      )}

      {/* Compatibility */}
      <div className="mb-8">
        <h2 className="mb-4 text-lg font-semibold text-white">Compatibility</h2>
        <div className="rounded-xl border border-white/5 bg-slate-900/60 p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs text-slate-500">Target Site</div>
              <div className="mt-1 text-sm text-white">{wf.site || 'Any'}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Recorded Viewport</div>
              <div className="mt-1 text-sm text-white">
                {wf.recordedViewportWidth && wf.recordedViewportHeight
                  ? `${wf.recordedViewportWidth} × ${wf.recordedViewportHeight}`
                  : 'Not specified'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Platforms</div>
              <div className="mt-1 flex gap-2">
                {(wf.platforms || ['Mac', 'Windows']).map((p) => (
                  <span
                    key={p}
                    className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-slate-400"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
