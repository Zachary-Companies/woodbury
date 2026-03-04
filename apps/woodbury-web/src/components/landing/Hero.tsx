'use client'

import { useOS, getDownloadLabel } from '@/hooks/useOS'
import { useVersion } from '@/hooks/useVersion'

export default function Hero() {
  const os = useOS()
  const versionInfo = useVersion()

  return (
    <section className="relative overflow-hidden pt-32 pb-20">
      {/* Purple glow */}
      <div className="hero-glow pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-7xl px-6">
        {/* Pill badge */}
        <div className="mb-8 flex justify-center">
          <span className="pill">AI-Powered Automation</span>
        </div>

        {/* Heading */}
        <h1 className="mx-auto max-w-4xl text-center text-5xl font-semibold leading-tight tracking-tight text-white sm:text-6xl lg:text-7xl">
          Automate anything.{' '}
          <span className="bg-gradient-to-r from-purple-400 to-violet-400 bg-clip-text text-transparent">
            No code required.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-center text-lg leading-relaxed text-slate-400">
          Record your actions, replay them with AI. Woodbury turns your workflows
          into automated pipelines — built for everyone, not just developers.
        </p>

        {/* CTA buttons */}
        <div className="mt-12 flex flex-col items-center gap-4">
          <a
            href="https://github.com/Zachary-Companies/woodbury/releases/latest"
            className="download-btn group flex w-full max-w-md items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-purple-600 to-violet-600 px-10 py-5 text-lg font-bold text-white shadow-2xl shadow-purple-500/25 transition-all hover:scale-[1.02] hover:from-purple-500 hover:to-violet-500 hover:shadow-purple-500/40"
          >
            <svg className="h-5 w-5 transition-transform group-hover:translate-y-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {getDownloadLabel(os)}
          </a>
          {versionInfo && (
            <span className="text-xs text-slate-500">v{versionInfo.version}</span>
          )}
          <a
            href="#how-it-works"
            className="flex w-full max-w-md items-center justify-center rounded-xl border border-white/10 px-10 py-5 text-lg font-medium text-slate-300 transition-all hover:border-white/25 hover:text-white"
          >
            See how it works
          </a>
        </div>

        {/* Product screenshot */}
        <div className="mt-20">
          <div className="screenshot-container mx-auto max-w-5xl">
            <img
              src="/screenshots/dashboard-pipelines.png"
              alt="Woodbury Dashboard — Visual pipeline builder for automating browser workflows"
              className="w-full"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
