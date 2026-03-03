const useCases = [
  {
    title: 'Social Media Posting',
    description:
      'Automate posting to Instagram, Twitter, and more. Record your posting flow once, then let Woodbury handle it on schedule.',
    gradient: 'from-purple-500/20 to-pink-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    ),
  },
  {
    title: 'Data Entry & Form Filling',
    description:
      'Fill out repetitive forms, transfer data between apps, and update spreadsheets — all hands-free.',
    gradient: 'from-blue-500/20 to-cyan-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    title: 'Testing & QA',
    description:
      'Record test flows for your web applications. Replay them to catch bugs before your users do — no Selenium scripts needed.',
    gradient: 'from-emerald-500/20 to-teal-500/20',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
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
            Whether you&apos;re managing social media, processing data, or testing websites — Woodbury adapts to your workflow.
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
