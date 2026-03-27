const useCases = [
  {
    title: 'Content Production',
    description:
      'Build a pipeline that generates screenplays, storyboards, voiceovers, and video — from a single prompt to a finished package ready to publish.',
    gradient: 'from-purple-500/20 to-pink-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
  {
    title: 'Social Media at Scale',
    description:
      'Generate AI-written posts with matching images, schedule them across platforms, and review everything before it goes live. Automate your entire content calendar.',
    gradient: 'from-blue-500/20 to-cyan-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    title: 'Brand Asset Management',
    description:
      'Store characters, logos, templates, and brand elements in a central asset library. Reuse them consistently across every pipeline and generated piece of content.',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    ),
  },
]

export default function UseCases() {
  return (
    <section id="use-cases" className="relative py-24">
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mb-16 text-center">
          <span className="pill">Use cases</span>
          <h2 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Built for how you work
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
            From solo creators to production teams — Woodbury handles the repetitive work so you can focus on the creative decisions.
          </p>
        </div>

        {/* Use case cards */}
        <div className="grid gap-8 md:grid-cols-3">
          {useCases.map((useCase) => (
            <div
              key={useCase.title}
              className="group relative overflow-hidden rounded-2xl border border-purple-500/10 bg-slate-900/60 p-8 transition-all duration-300 hover:border-purple-500/25"
            >
              {/* Background gradient */}
              <div
                className={`absolute inset-0 bg-gradient-to-br ${useCase.gradient} opacity-0 transition-opacity duration-300 group-hover:opacity-100`}
              />

              <div className="relative">
                {/* Icon */}
                <div className="mb-6 text-purple-400">{useCase.icon}</div>

                {/* Title */}
                <h3 className="mb-3 text-xl font-semibold text-white">{useCase.title}</h3>

                {/* Description */}
                <p className="leading-relaxed text-slate-400">{useCase.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
