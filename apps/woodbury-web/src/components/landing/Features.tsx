const features = [
  {
    title: 'Browser Automation',
    description:
      'Record clicks, form fills, navigation, and more. Woodbury captures everything you do in Chrome and replays it perfectly.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="12" cy="12" r="3" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
    ),
  },
  {
    title: 'Desktop Automation',
    description:
      'Go beyond the browser. Automate any desktop application — move your mouse, type text, and press keys across your entire Mac.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    title: 'Visual AI',
    description:
      'Woodbury uses visual recognition to find elements even when pages change. It sees the page like you do — not just the code behind it.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    title: 'Visual Pipelines',
    description:
      'Connect multiple workflows together visually. Drag, drop, and wire up complex automations — like building with blocks.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="2" y="2" width="7" height="7" rx="1.5" />
        <rect x="15" y="2" width="7" height="7" rx="1.5" />
        <rect x="8" y="15" width="7" height="7" rx="1.5" />
        <path d="M9 5.5h6M5.5 9v3.5a2 2 0 002 2H11.5M18.5 9v3.5a2 2 0 01-2 2H12.5" />
      </svg>
    ),
  },
  {
    title: 'Scheduling',
    description:
      'Set your workflows to run on a schedule — every hour, every day, or whenever you need. Woodbury keeps working while you don\'t.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12,6 12,12 16,14" />
      </svg>
    ),
  },
  {
    title: 'No Code Required',
    description:
      'Everything is point-and-click. If you can use a web browser, you can build automations. No programming, no scripts, no terminal.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
]

export default function Features() {
  return (
    <section id="features" className="relative py-24">
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mb-16 text-center">
          <span className="pill">Features</span>
          <h2 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Everything you need
            <br className="hidden sm:block" /> to automate
          </h2>
        </div>

        {/* Feature grid */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="landing-card group">
              {/* Icon */}
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 transition-colors group-hover:bg-purple-500/20">
                {feature.icon}
              </div>

              {/* Title */}
              <h3 className="mb-3 text-lg font-semibold text-white">{feature.title}</h3>

              {/* Description */}
              <p className="leading-relaxed text-slate-400">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
