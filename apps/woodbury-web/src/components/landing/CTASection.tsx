export default function CTASection() {
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
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <a
                href="https://github.com/Zachary-Companies/woodbury/releases/latest"
                className="rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-slate-900 shadow-lg shadow-purple-500/10 transition-all hover:bg-slate-200 hover:shadow-purple-500/20"
              >
                Download
              </a>
              <a
                href="https://github.com/Zachary-Companies/woodbury"
                className="rounded-full border border-white/10 px-8 py-3.5 text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:text-white"
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
