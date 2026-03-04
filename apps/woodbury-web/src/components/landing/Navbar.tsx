'use client'

import { useState } from 'react'
import { useOS, getDownloadLabel } from '@/hooks/useOS'
import { useAuth } from '@/hooks/useAuth'

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const os = useOS()
  const { isAdmin } = useAuth()

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#0f172a]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600">
            <span className="text-lg font-bold text-white">W</span>
          </div>
          <span className="text-lg font-semibold text-white">Woodbury</span>
        </a>

        {/* Desktop Nav */}
        <div className="hidden items-center gap-8 md:flex">
          <a href="/#features" className="text-sm text-slate-400 transition-colors hover:text-white">
            Features
          </a>
          <a href="/#how-it-works" className="text-sm text-slate-400 transition-colors hover:text-white">
            How It Works
          </a>
          <a href="/#use-cases" className="text-sm text-slate-400 transition-colors hover:text-white">
            Use Cases
          </a>
          <a href="/extensions" className="text-sm text-slate-400 transition-colors hover:text-white">
            Extensions
          </a>
          <a href="/workflows" className="text-sm text-slate-400 transition-colors hover:text-white">
            Workflows
          </a>
          {isAdmin && (
            <a href="/admin" className="text-sm text-purple-400 transition-colors hover:text-purple-300">
              Admin
            </a>
          )}
        </div>

        {/* CTA */}
        <div className="hidden md:block">
          <a
            href="https://github.com/Zachary-Companies/woodbury/releases/latest"
            className="group flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:scale-[1.02] hover:from-purple-500 hover:to-violet-500 hover:shadow-purple-500/30"
          >
            <svg className="h-4 w-4 transition-transform group-hover:translate-y-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {getDownloadLabel(os, 'Download')}
          </a>
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-white md:hidden"
        >
          {mobileOpen ? (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="border-t border-white/5 px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <a href="/#features" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Features
            </a>
            <a href="/#how-it-works" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              How It Works
            </a>
            <a href="/#use-cases" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Use Cases
            </a>
            <a href="/extensions" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Extensions
            </a>
            <a href="/workflows" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Workflows
            </a>
            {isAdmin && (
              <a href="/admin" onClick={() => setMobileOpen(false)} className="text-sm text-purple-400 hover:text-purple-300">
                Admin
              </a>
            )}
            <a
              href="https://github.com/Zachary-Companies/woodbury/releases/latest"
              className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-6 py-3 text-sm font-semibold text-white"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {getDownloadLabel(os, 'Download')}
            </a>
          </div>
        </div>
      )}
    </nav>
  )
}
