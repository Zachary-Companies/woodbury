'use client'

import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import type { SharedWorkflow, WorkflowCategory } from '@/types/workflow'
import WorkflowCard from './WorkflowCard'

type SortOption = 'downloadCount' | 'publishedAt' | 'rating'

export default function WorkflowGrid() {
  const [workflows, setWorkflows] = useState<SharedWorkflow[]>([])
  const [categories, setCategories] = useState<WorkflowCategory[]>([])
  const [activeCategory, setActiveCategory] = useState('all')
  const [sortBy, setSortBy] = useState<SortOption>('downloadCount')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch published, visible workflows
        const wfQuery = query(
          collection(firestore, 'shared-workflows'),
          where('visible', '==', true),
          where('status', '==', 'published'),
          orderBy('downloadCount', 'desc'),
        )
        const wfSnap = await getDocs(wfQuery)
        const wfs = wfSnap.docs.map((doc) => ({ ...doc.data(), id: doc.id } as SharedWorkflow))

        // Fetch workflow categories
        const catQuery = query(collection(firestore, 'workflow-categories'), orderBy('order'))
        const catSnap = await getDocs(catQuery)
        const cats = catSnap.docs.map((doc) => ({ ...doc.data() } as WorkflowCategory))

        setWorkflows(wfs)
        setCategories(cats)
      } catch (err) {
        console.error('Failed to fetch workflows:', err)
        setError(true)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-slate-500">Loading workflows...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-slate-500">No workflows published yet. Be the first to share one!</p>
      </div>
    )
  }

  // Client-side filtering and sorting
  let filtered = workflows.filter((wf) => {
    if (activeCategory !== 'all' && wf.category !== activeCategory) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        wf.name.toLowerCase().includes(q) ||
        wf.description.toLowerCase().includes(q) ||
        wf.site.toLowerCase().includes(q) ||
        wf.tags.some((t) => t.toLowerCase().includes(q))
      )
    }
    return true
  })

  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'downloadCount') return b.downloadCount - a.downloadCount
    if (sortBy === 'rating') return b.rating - a.rating
    if (sortBy === 'publishedAt') {
      const aTime = a.publishedAt?.toDate?.()?.getTime?.() || 0
      const bTime = b.publishedAt?.toDate?.()?.getTime?.() || 0
      return bTime - aTime
    }
    return 0
  })

  return (
    <div>
      {/* Filters */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Category pills */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveCategory('all')}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              activeCategory === 'all'
                ? 'bg-purple-600 text-white'
                : 'border border-white/10 text-slate-400 hover:border-white/20 hover:text-white'
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                activeCategory === cat.id
                  ? 'bg-purple-600 text-white'
                  : 'border border-white/10 text-slate-400 hover:border-white/20 hover:text-white'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          {/* Sort */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white outline-none focus:border-purple-500/50"
          >
            <option value="downloadCount">Most Downloaded</option>
            <option value="publishedAt">Newest</option>
            <option value="rating">Highest Rated</option>
          </select>

          {/* Search */}
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search workflows..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-900/60 py-2 pl-10 pr-4 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50 sm:w-64"
            />
          </div>
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center text-slate-500">
          {search ? 'No workflows match your search.' : 'No workflows published yet.'}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((wf) => (
            <WorkflowCard key={wf.id} workflow={wf} />
          ))}
        </div>
      )}
    </div>
  )
}
