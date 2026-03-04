import Navbar from '@/components/landing/Navbar'
import Footer from '@/components/landing/Footer'
import WorkflowGrid from '@/components/workflows/WorkflowGrid'

export const metadata = {
  title: 'Workflows — Woodbury',
  description: 'Browse, download, and share browser automation workflows for Woodbury.',
}

export default function WorkflowsPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-20">
        {/* Hero */}
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-16 text-center">
            <span className="pill mb-6 inline-block">Community Workflows</span>
            <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Workflow Marketplace
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-slate-400">
              Browse automation workflows shared by the community. Download and run them instantly,
              with AI-powered screen adaptation that works on any screen size.
            </p>
          </div>

          {/* Workflow Grid */}
          <WorkflowGrid />

          {/* Publish CTA */}
          <div className="mt-20 rounded-2xl border border-purple-500/15 bg-slate-900/60 p-8 text-center sm:p-12">
            <h2 className="text-2xl font-semibold text-white">Share Your Workflows</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Built a great workflow? Publish it to the marketplace directly from the Woodbury
              dashboard. Include your trained AI model so it works on any screen.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="https://github.com/Zachary-Companies/woodbury/releases/latest"
                className="rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white transition-all hover:from-purple-500 hover:to-violet-500"
              >
                Download Woodbury
              </a>
              <a
                href="https://github.com/Zachary-Companies/woodbury/blob/main/docs/workflows.md"
                className="rounded-lg border border-white/10 px-6 py-2.5 text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:text-white"
              >
                Learn More
              </a>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  )
}
