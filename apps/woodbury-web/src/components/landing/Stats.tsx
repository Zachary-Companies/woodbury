const stats = [
  {
    value: '55+',
    label: 'Built-in Tools',
    description: 'Image generation, video, voice, web scraping, file management, and more',
  },
  {
    value: '15+',
    label: 'Extensions',
    description: 'Install from the marketplace with one click — or build your own',
  },
  {
    value: 'Zero',
    label: 'Code Required',
    description: 'Describe what you want in plain language — the AI builds it for you',
  },
  {
    value: 'Mac + Win',
    label: 'Platform Support',
    description: 'Native desktop app for macOS and Windows with Chrome extension',
  },
]

export default function Stats() {
  return (
    <section className="relative py-24">
      <div className="section-glow pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mb-16 text-center">
          <span className="pill">By the numbers</span>
        </div>

        {/* Stats grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="stat-card text-center">
              <div className="mb-2 bg-gradient-to-r from-purple-400 to-violet-300 bg-clip-text text-4xl font-bold text-transparent">
                {stat.value}
              </div>
              <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-white">
                {stat.label}
              </div>
              <p className="text-sm leading-relaxed text-slate-500">
                {stat.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
