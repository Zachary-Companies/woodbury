'use client'

import { useAuth, logout } from '@/hooks/useAuth'
import LoginForm from './LoginForm'
import ExtensionManager from './ExtensionManager'

export default function AdminPanel() {
  const { user, isAdmin, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0f172a]">
        <div className="text-slate-500">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0f172a]">
        <LoginForm />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0f172a]">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-800/60 p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20">
            <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          </div>
          <h2 className="mb-2 text-lg font-bold text-white">Access Denied</h2>
          <p className="mb-4 text-sm text-slate-400">
            Your account does not have admin access.
          </p>
          <div className="mb-6 rounded-lg border border-white/5 bg-slate-900/50 p-3">
            <p className="text-xs text-slate-500">Your UID:</p>
            <code className="mt-1 block break-all text-xs text-purple-300">{user.uid}</code>
          </div>
          <p className="mb-4 text-xs text-slate-500">
            Add this UID to Firestore at <code className="text-purple-300">config/admin → adminUIDs</code> to grant access.
          </p>
          <button
            onClick={logout}
            className="text-sm text-slate-400 transition-colors hover:text-white"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0f172a]">
      {/* Admin header */}
      <header className="border-b border-white/5 bg-slate-900/50">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600">
                <span className="text-lg font-bold text-white">W</span>
              </div>
              <span className="text-lg font-semibold text-white">Woodbury</span>
            </a>
            <span className="rounded-full bg-purple-600/20 px-2.5 py-0.5 text-xs font-medium text-purple-300">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">{user.email}</span>
            <button
              onClick={logout}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-400 transition-colors hover:border-white/20 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <ExtensionManager />
      </main>
    </div>
  )
}
