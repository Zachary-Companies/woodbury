import Navbar from '@/components/landing/Navbar'
import Footer from '@/components/landing/Footer'
import ExtensionGrid from '@/components/extensions/ExtensionGrid'

export const metadata = {
  title: 'Extensions — Woodbury',
  description: 'Browse and install extensions to add new capabilities to Woodbury.',
}

export default function ExtensionsPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-20">
        {/* Hero */}
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-16 text-center">
            <span className="pill mb-6 inline-block">Extend Woodbury</span>
            <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Extensions
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
              Add new capabilities to Woodbury with one click. Browse extensions for image generation,
              text-to-speech, social media automation, and more.
            </p>
          </div>

          {/* Extension Grid */}
          <ExtensionGrid />

          {/* Build your own CTA */}
          <div className="mt-20 rounded-2xl border border-purple-500/15 bg-slate-900/60 p-8 text-center sm:p-12">
            <h2 className="text-2xl font-semibold text-white">Build Your Own Extension</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Woodbury extensions are simple JavaScript modules. Register tools, commands, and prompts
              to give the AI agent new capabilities.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="https://github.com/Zachary-Companies/woodbury/blob/main/docs/extension-development.md"
                className="rounded-lg border border-white/10 px-6 py-2.5 text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:text-white"
              >
                Read the Docs
              </a>
              <a
                href="https://github.com/Zachary-Companies/woodbury"
                className="rounded-lg border border-white/10 px-6 py-2.5 text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:text-white"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  )
}
