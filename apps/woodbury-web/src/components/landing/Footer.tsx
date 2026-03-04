export default function Footer() {
  return (
    <footer className="border-t border-white/5 py-16">
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex flex-col items-start justify-between gap-10 md:flex-row md:items-center">
          {/* Logo + tagline */}
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600">
                <span className="text-lg font-bold text-white">W</span>
              </div>
              <span className="text-lg font-semibold text-white">Woodbury</span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-500">
              AI-powered browser automation for everyone.
              Record, replay, and scale your workflows.
            </p>
          </div>

          {/* Links */}
          <div className="flex gap-12">
            <div>
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Product</h4>
              <div className="flex flex-col gap-2">
                <a href="/#features" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Features
                </a>
                <a href="/#how-it-works" className="text-sm text-slate-400 transition-colors hover:text-white">
                  How It Works
                </a>
                <a href="/#use-cases" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Use Cases
                </a>
                <a href="/extensions" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Extensions
                </a>
                <a href="/workflows" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Workflows
                </a>
              </div>
            </div>
            <div>
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Resources</h4>
              <div className="flex flex-col gap-2">
                <a href="#" className="text-sm text-slate-400 transition-colors hover:text-white">
                  GitHub
                </a>
                <a href="#" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Documentation
                </a>
                <a href="#" className="text-sm text-slate-400 transition-colors hover:text-white">
                  Chrome Extension
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 border-t border-white/5 pt-8">
          <p className="text-center text-xs text-slate-600">
            &copy; {new Date().getFullYear()} Zachary Companies. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
