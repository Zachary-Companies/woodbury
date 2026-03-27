const features = [
  {
    title: 'AI Chat Assistant',
    description:
      'Describe what you want in plain language. The built-in AI generates images, writes scripts, builds pipelines, and manages your content — 55 tools at your fingertips.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    title: 'Visual Pipelines',
    description:
      'Build multi-step automations visually. Connect AI generation, browser actions, scripts, and API calls into a pipeline that runs with one click.',
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
    title: 'Content Generation',
    description:
      'Generate images, videos, voiceovers, and social posts with AI. Create complete content packages — from screenplay to final render — in a single pipeline.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
  {
    title: 'Extensions & Marketplace',
    description:
      'Install tools for image generation, video clipping, voice cloning, hashtags, and more. One-click install from the marketplace or paste a link.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    title: 'Browser & Desktop Automation',
    description:
      'Record browser actions and replay them with visual AI that adapts to page changes. Automate desktop apps with mouse, keyboard, and screen recognition.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="12" cy="12" r="3" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
    ),
  },
  {
    title: 'Scheduling & Social Posting',
    description:
      'Schedule pipelines to run daily, weekly, or on demand. Queue social media posts, review before publishing, and track performance across platforms.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12,6 12,12 16,14" />
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
            A complete creative
            <br className="hidden sm:block" /> automation studio
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
