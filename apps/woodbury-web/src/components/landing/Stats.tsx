const stats = [
  {
    value: '100+',
    label: 'Workflow Steps',
    description: 'Record complex multi-step automations with no limits',
  },
  {
    value: '5 min',
    label: 'Average Setup',
    description: 'From download to your first automation in minutes',
  },
  {
    value: 'Zero',
    label: 'Code Required',
    description: 'Point and click — no programming knowledge needed',
  },
  {
    value: 'Mac + Chrome',
    label: 'Platform Support',
    description: 'Native desktop app with Chrome extension included',
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
