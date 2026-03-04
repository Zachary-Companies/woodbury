'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { doc, getDoc, collection, query, where, orderBy, getDocs } from 'firebase/firestore'
import { firestore } from '@/lib/firebase'
import type { UserProfile as UserProfileType } from '@/types/user'
import type { SharedWorkflow } from '@/types/workflow'
import WorkflowCard from './WorkflowCard'

export default function UserProfile() {
  const searchParams = useSearchParams()
  const uid = searchParams.get('uid')
  const [profile, setProfile] = useState<UserProfileType | null>(null)
  const [workflows, setWorkflows] = useState<SharedWorkflow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) {
      setError('No user ID provided')
      setLoading(false)
      return
    }

    async function fetchProfile() {
      try {
        // Fetch user profile
        const userDoc = await getDoc(doc(firestore, 'users', uid!))
        if (!userDoc.exists()) {
          setError('User not found')
          setLoading(false)
          return
        }
        setProfile(userDoc.data() as UserProfileType)

        // Fetch their published workflows
        const wfQuery = query(
          collection(firestore, 'shared-workflows'),
          where('authorId', '==', uid),
          where('visible', '==', true),
          where('status', '==', 'published'),
          orderBy('downloadCount', 'desc'),
        )
        const wfSnap = await getDocs(wfQuery)
        const wfs = wfSnap.docs.map((d) => ({ ...d.data(), id: d.id } as SharedWorkflow))
        setWorkflows(wfs)
      } catch (err) {
        console.error('Failed to fetch profile:', err)
        setError('Failed to load profile')
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [uid])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-slate-500">Loading profile...</div>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="py-20 text-center">
        <h2 className="text-xl font-semibold text-white">{error || 'User not found'}</h2>
        <a href="/workflows" className="mt-4 inline-block text-sm text-purple-400 hover:text-purple-300">
          &larr; Back to marketplace
        </a>
      </div>
    )
  }

  const totalDownloads = workflows.reduce((sum, wf) => sum + wf.downloadCount, 0)
  const avgRating = workflows.length > 0
    ? workflows.reduce((sum, wf) => sum + wf.rating * wf.ratingCount, 0) /
      Math.max(1, workflows.reduce((sum, wf) => sum + wf.ratingCount, 0))
    : 0

  return (
    <div>
      {/* Profile header */}
      <div className="mb-12 flex flex-col items-center text-center sm:flex-row sm:items-start sm:text-left">
        {profile.photoURL ? (
          <img
            src={profile.photoURL}
            alt={profile.displayName}
            className="h-20 w-20 rounded-full border-2 border-purple-500/30"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-700 text-2xl font-bold text-slate-400">
            {profile.displayName?.[0] || '?'}
          </div>
        )}
        <div className="mt-4 sm:ml-6 sm:mt-0">
          <h1 className="text-2xl font-bold text-white">{profile.displayName}</h1>
          {profile.bio && (
            <p className="mt-2 max-w-lg text-sm text-slate-400">{profile.bio}</p>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-4 text-sm text-slate-500 sm:justify-start">
            <span>{workflows.length} workflows</span>
            <span>·</span>
            <span>{totalDownloads.toLocaleString()} total downloads</span>
            {avgRating > 0 && (
              <>
                <span>·</span>
                <span>Avg rating: {avgRating.toFixed(1)}/5</span>
              </>
            )}
            {profile.joinedAt && (
              <>
                <span>·</span>
                <span>Joined {profile.joinedAt.toDate?.()?.toLocaleDateString?.() || ''}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Published workflows */}
      <h2 className="mb-6 text-lg font-semibold text-white">Published Workflows</h2>
      {workflows.length === 0 ? (
        <div className="py-12 text-center text-slate-500">
          No published workflows yet.
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((wf) => (
            <WorkflowCard key={wf.id} workflow={wf} />
          ))}
        </div>
      )}
    </div>
  )
}
