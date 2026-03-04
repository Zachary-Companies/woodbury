'use client'

import { useState, useEffect } from 'react'
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import type { Extension, Category } from '@/types/extension'
import ExtensionCard from './ExtensionCard'

export default function ExtensionGrid() {
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [activeCategory, setActiveCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch visible extensions ordered by position
        const extQuery = query(
          collection(firestore, 'extensions'),
          where('visible', '==', true),
          orderBy('order')
        )
        const extSnap = await getDocs(extQuery)
        const exts = extSnap.docs.map((doc) => ({ ...doc.data() } as Extension))

        // Fetch categories
        const catQuery = query(collection(firestore, 'categories'), orderBy('order'))
        const catSnap = await getDocs(catQuery)
        const cats = catSnap.docs.map((doc) => ({ ...doc.data() } as Category))

        setExtensions(exts)
        setCategories(cats)
      } catch (err) {
        console.error('Failed to fetch extensions:', err)
        // Fallback to static registry.json
        try {
          const res = await fetch('/registry.json')
          const data = await res.json()
          setExtensions(data.extensions)
          setCategories(data.categories)
        } catch {
          setError(true)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-slate-500">Loading extensions...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-slate-500">Failed to load extensions.</div>
      </div>
    )
  }

  const filtered = extensions.filter((ext) => {
    if (activeCategory !== 'all' && ext.category !== activeCategory) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        ext.displayName.toLowerCase().includes(q) ||
        ext.description.toLowerCase().includes(q) ||
        ext.tags.some((t) => t.toLowerCase().includes(q))
      )
    }
    return true
  })

  return (
    <div>
      {/* Filters */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Category pills */}
        <div className="flex flex-wrap gap-2">
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
            placeholder="Search extensions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-slate-900/60 py-2 pl-10 pr-4 text-sm text-white placeholder-slate-500 outline-none focus:border-purple-500/50 sm:w-64"
          />
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center text-slate-500">No extensions match your search.</div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((ext) => (
            <ExtensionCard key={ext.name} ext={ext} />
          ))}
        </div>
      )}
    </div>
  )
}
