'use client'

import { useState, useEffect } from 'react'
import {
  collection,
  query,
  orderBy,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import type { Extension } from '@/types/extension'
import ToggleSwitch from './ToggleSwitch'
import ExtensionForm from './ExtensionForm'

export default function ExtensionManager() {
  const [extensions, setExtensions] = useState<Extension[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Extension | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const fetchExtensions = async () => {
    try {
      const q = query(collection(firestore, 'extensions'), orderBy('order'))
      const snap = await getDocs(q)
      setExtensions(snap.docs.map((d) => ({ ...d.data() } as Extension)))
    } catch (err) {
      console.error('Failed to fetch extensions:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchExtensions()
  }, [])

  const handleToggle = async (name: string, field: 'visible' | 'featured', value: boolean) => {
    try {
      await updateDoc(doc(firestore, 'extensions', name), {
        [field]: value,
        updatedAt: serverTimestamp(),
      })
      setExtensions((prev) =>
        prev.map((ext) => (ext.name === name ? { ...ext, [field]: value } : ext))
      )
    } catch (err) {
      console.error(`Failed to toggle ${field}:`, err)
    }
  }

  const handleSave = async (data: Partial<Extension>) => {
    const name = data.name!
    const docData = {
      ...data,
      updatedAt: serverTimestamp(),
    }

    if (editing) {
      await updateDoc(doc(firestore, 'extensions', name), docData)
    } else {
      await setDoc(doc(firestore, 'extensions', name), {
        ...docData,
        createdAt: serverTimestamp(),
      })
    }

    await fetchExtensions()
  }

  const handleDelete = async (name: string) => {
    try {
      await deleteDoc(doc(firestore, 'extensions', name))
      setExtensions((prev) => prev.filter((ext) => ext.name !== name))
      setDeleteConfirm(null)
    } catch (err) {
      console.error('Failed to delete extension:', err)
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-slate-500">Loading extensions...</div>
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Extensions</h1>
          <p className="text-sm text-slate-400">{extensions.length} total extensions</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:from-purple-500 hover:to-violet-500"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Extension
        </button>
      </div>

      {/* Extension list */}
      <div className="space-y-2">
        {extensions.map((ext) => (
          <div
            key={ext.name}
            className={`flex items-center gap-4 rounded-xl border p-4 transition-all ${
              ext.visible
                ? 'border-white/10 bg-slate-800/40'
                : 'border-white/5 bg-slate-900/40 opacity-60'
            }`}
          >
            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-white">{ext.displayName}</h3>
                <span className="text-xs text-slate-500">v{ext.version}</span>
                {ext.featured && (
                  <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-[10px] font-medium text-yellow-300">
                    Featured
                  </span>
                )}
                {!ext.visible && (
                  <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-300">
                    Hidden
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-sm text-slate-400">{ext.description}</p>
            </div>

            {/* Toggles */}
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Visible</span>
                <ToggleSwitch
                  enabled={ext.visible}
                  onChange={(v) => handleToggle(ext.name, 'visible', v)}
                  label="Toggle visibility"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Featured</span>
                <ToggleSwitch
                  enabled={ext.featured}
                  onChange={(v) => handleToggle(ext.name, 'featured', v)}
                  label="Toggle featured"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEditing(ext)}
                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                title="Edit"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={() => setDeleteConfirm(ext.name)}
                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                title="Delete"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {extensions.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-slate-500">No extensions yet. Add one to get started.</p>
        </div>
      )}

      {/* Edit/Create form modal */}
      {(editing || creating) && (
        <ExtensionForm
          extension={editing}
          onSave={handleSave}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-800 p-6 shadow-2xl">
            <h3 className="mb-2 text-lg font-bold text-white">Delete Extension</h3>
            <p className="mb-6 text-sm text-slate-400">
              Are you sure you want to delete <strong className="text-white">{deleteConfirm}</strong>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-400 hover:border-white/20 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
