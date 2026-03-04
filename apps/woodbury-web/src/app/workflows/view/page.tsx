'use client'

import { Suspense } from 'react'
import Navbar from '@/components/landing/Navbar'
import Footer from '@/components/landing/Footer'
import WorkflowDetail from '@/components/workflows/WorkflowDetail'

function WorkflowDetailLoader() {
  return (
    <div className="flex justify-center py-20">
      <div className="text-slate-500">Loading workflow...</div>
    </div>
  )
}

export default function WorkflowViewPage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <Suspense fallback={<WorkflowDetailLoader />}>
            <WorkflowDetail />
          </Suspense>
        </div>
      </main>
      <Footer />
    </>
  )
}
