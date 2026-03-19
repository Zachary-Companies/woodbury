const pipelines = [
  {
    name: 'Comprehensive Screenplay Generator',
    description:
      'Generate complete screenplay packages with metadata, characters, locations, scenes, elements, assets, and previsualization. Includes a built-in NLE editor with timeline, audio mixing, and render output.',
    tags: ['AI Generation', 'Video', 'Screenwriting', 'TTS', 'NLE Editor'],
    nodes: 14,
    views: ['Data', 'Screenplay', 'Editor', 'Voices'],
    gradient: 'from-violet-600/30 to-indigo-600/30',
    icon: (
      <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
    ),
  },
]

const upcomingPipelines = [
  {
    name: 'Social Content Calendar',
    description: 'Plan, generate, and schedule social media posts across platforms with AI-written copy and generated images.',
    tags: ['Social Media', 'Scheduling', 'AI Copy'],
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    name: 'Brand Asset Generator',
    description: 'Create consistent brand assets — logos, color palettes, typography sets, and social templates from a single brief.',
    tags: ['Branding', 'Design', 'AI Generation'],
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
      </svg>
    ),
  },
  {
    name: 'Podcast Producer',
    description: 'Record, transcribe, edit, and publish podcast episodes with AI-generated show notes, chapters, and social clips.',
    tags: ['Audio', 'Transcription', 'Publishing'],
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
      </svg>
    ),
  },
]

export default function Pipelines() {
  return (
    <section id="pipelines" className="relative py-24">
      <div className="section-glow pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-7xl px-6">
        {/* Header */}
        <div className="mb-16 text-center">
          <span className="pill">Pipelines</span>
          <h2 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Ready-to-use AI pipelines
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
            Install complete creative pipelines with one click. Each pipeline comes with a custom app interface, AI nodes, and everything you need to start producing.
          </p>
        </div>

        {/* Featured pipeline */}
        {pipelines.map((pipeline) => (
          <div
            key={pipeline.name}
            className="group relative mb-12 overflow-hidden rounded-2xl border border-purple-500/15 bg-slate-900/80 transition-all duration-300 hover:border-purple-500/30"
          >
            <div className={`absolute inset-0 bg-gradient-to-br ${pipeline.gradient} opacity-50`} />
            <div className="relative flex flex-col gap-8 p-8 md:flex-row md:items-start md:p-10">
              {/* Icon + info */}
              <div className="flex-1">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/15 text-purple-400">
                    {pipeline.icon}
                  </div>
                  <div>
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                      Available Now
                    </span>
                  </div>
                </div>

                <h3 className="mb-3 text-2xl font-semibold text-white">{pipeline.name}</h3>
                <p className="mb-6 max-w-xl leading-relaxed text-slate-400">{pipeline.description}</p>

                {/* Tags */}
                <div className="mb-6 flex flex-wrap gap-2">
                  {pipeline.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-white/5 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Stats */}
                <div className="flex items-center gap-6 text-sm text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <rect x="2" y="2" width="7" height="7" rx="1.5" />
                      <rect x="15" y="2" width="7" height="7" rx="1.5" />
                      <rect x="8" y="15" width="7" height="7" rx="1.5" />
                      <path d="M9 5.5h6M5.5 9v3.5a2 2 0 002 2H11.5M18.5 9v3.5a2 2 0 01-2 2H12.5" />
                    </svg>
                    {pipeline.nodes} nodes
                  </span>
                  <span className="flex items-center gap-1.5">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                      <path d="M3 9h18M9 3v18" />
                    </svg>
                    {pipeline.views.length} views
                  </span>
                </div>
              </div>

              {/* Right side — Views preview */}
              <div className="flex-shrink-0 md:w-72">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Built-in Views</p>
                <div className="grid grid-cols-2 gap-2">
                  {pipeline.views.map((view) => (
                    <div
                      key={view}
                      className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5 text-sm text-slate-300"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                      {view}
                    </div>
                  ))}
                </div>
                <div className="mt-6">
                  <a
                    href="https://github.com/Zachary-Companies/woodbury/releases/latest"
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:scale-[1.02] hover:from-purple-500 hover:to-violet-500"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Woodbury
                  </a>
                  <p className="mt-2 text-center text-[11px] text-slate-600">Pipeline included with install</p>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Coming soon */}
        <div className="mt-12">
          <h3 className="mb-6 text-center text-lg font-medium text-slate-500">Coming Soon</h3>
          <div className="grid gap-4 md:grid-cols-3">
            {upcomingPipelines.map((p) => (
              <div
                key={p.name}
                className="group relative overflow-hidden rounded-xl border border-white/5 bg-slate-900/40 p-6 transition-all duration-300 hover:border-white/10"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-slate-500 transition-colors group-hover:text-slate-400">
                  {p.icon}
                </div>
                <h4 className="mb-2 text-sm font-semibold text-slate-300">{p.name}</h4>
                <p className="mb-4 text-xs leading-relaxed text-slate-500">{p.description}</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-600">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
