'use client'

import { useOS, getDownloadLabel } from '@/hooks/useOS'
import { useVersion } from '@/hooks/useVersion'

export default function CTASection() {
  const os = useOS()
  const versionInfo = useVersion()

  return (
    <section className="relative py-24">
      <div className="mx-auto max-w-7xl px-6">
        <div className="cta-gradient relative overflow-hidden rounded-3xl border border-purple-500/20 px-8 py-20 text-center sm:px-16">
          {/* Background glow */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-purple-500/10 via-transparent to-transparent" />

          <div className="relative">
            {/* Pill */}
            <span className="pill mb-6 inline-block">Get started</span>

            {/* Heading */}
            <h2 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Ready to automate your workflow?
            </h2>

            {/* Subtitle */}
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-slate-400">
              Download Woodbury and start automating in minutes. No account needed, no credit card, no code.
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
                href="https://github.com/Zachary-Companies/woodbury"
                className="flex w-full max-w-md items-center justify-center rounded-xl border border-white/10 px-10 py-5 text-lg font-medium text-slate-300 transition-all hover:border-white/25 hover:text-white"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
