const steps = [
  {
    number: '01',
    title: 'Describe or Record',
    description:
      'Tell the AI what you want to build, or record your actions in the browser. Woodbury can generate full pipelines from a description or learn by watching you work.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <circle cx="12" cy="12" r="10" strokeWidth={1.5} />
        <circle cx="12" cy="12" r="4" fill="currentColor" />
      </svg>
    ),
  },
  {
    number: '02',
    title: 'Build Your Pipeline',
    description:
      'Connect workflows, AI scripts, and tools into a visual pipeline. Add nodes for image generation, video, voiceovers, social posting, and more.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <rect x="2" y="2" width="7" height="7" rx="1.5" strokeWidth={1.5} />
        <rect x="15" y="15" width="7" height="7" rx="1.5" strokeWidth={1.5} />
        <path d="M9 5.5h6M5.5 9v6M18.5 9v6" strokeWidth={1.5} />
      </svg>
    ),
  },
  {
    number: '03',
    title: 'Run and Schedule',
    description:
      'Run your pipeline on demand or schedule it to repeat daily, weekly, or on any cadence. Review outputs, approve content, and publish automatically.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-24">
      <div className="section-glow pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mb-16 text-center">
          <span className="pill">How it works</span>
          <h2 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            From idea to automated pipeline
            <br className="hidden sm:block" /> in minutes
          </h2>
        </div>

        {/* Steps */}
        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((step) => (
            <div key={step.number} className="landing-card group">
              {/* Icon */}
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 transition-colors group-hover:bg-purple-500/20">
                {step.icon}
              </div>

              {/* Step number */}
              <div className="mb-2 text-xs font-medium uppercase tracking-widest text-purple-500">
                Step {step.number}
              </div>

              {/* Title */}
              <h3 className="mb-3 text-xl font-semibold text-white">{step.title}</h3>

              {/* Description */}
              <p className="leading-relaxed text-slate-400">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
