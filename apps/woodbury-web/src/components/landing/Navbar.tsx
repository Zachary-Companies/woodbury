'use client'

import { useState } from 'react'

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#0f172a]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600">
            <span className="text-lg font-bold text-white">W</span>
          </div>
          <span className="text-lg font-semibold text-white">Woodbury</span>
        </a>

        {/* Desktop Nav */}
        <div className="hidden items-center gap-8 md:flex">
          <a href="#features" className="text-sm text-slate-400 transition-colors hover:text-white">
            Features
          </a>
          <a href="#how-it-works" className="text-sm text-slate-400 transition-colors hover:text-white">
            How It Works
          </a>
          <a href="#use-cases" className="text-sm text-slate-400 transition-colors hover:text-white">
            Use Cases
          </a>
        </div>

        {/* CTA */}
        <div className="hidden md:block">
          <a
            href="https://github.com/Zachary-Companies/woodbury/releases/latest"
            className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-slate-900 transition-all hover:bg-slate-200"
          >
            Download App
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
            <a href="#features" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Features
            </a>
            <a href="#how-it-works" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              How It Works
            </a>
            <a href="#use-cases" onClick={() => setMobileOpen(false)} className="text-sm text-slate-400 hover:text-white">
              Use Cases
            </a>
            <a
              href="#"
              className="mt-2 rounded-full bg-white px-5 py-2.5 text-center text-sm font-medium text-slate-900"
            >
              Download App
            </a>
          </div>
        </div>
      )}
    </nav>
  )
}
