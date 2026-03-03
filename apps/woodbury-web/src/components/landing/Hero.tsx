export default function Hero() {
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
          Automate your browser.{' '}
          <span className="bg-gradient-to-r from-purple-400 to-violet-400 bg-clip-text text-transparent">
            No code required.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-center text-lg leading-relaxed text-slate-400">
          Record your actions, replay them with AI. Woodbury turns your clicks
          into automated workflows — built for everyone, not just developers.
        </p>

        {/* CTA buttons */}
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="https://github.com/mephisto83/woodbury/releases/download/v1.0.11/Woodbury-1.0.11-arm64.dmg"
            className="rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-slate-900 shadow-lg shadow-purple-500/10 transition-all hover:bg-slate-200 hover:shadow-purple-500/20"
          >
            Download for Mac
          </a>
          <a
            href="#how-it-works"
            className="rounded-full border border-white/10 px-8 py-3.5 text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:text-white"
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
