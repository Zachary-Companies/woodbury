'use client'

import { Suspense } from 'react'
import Navbar from '@/components/landing/Navbar'
import Footer from '@/components/landing/Footer'
import UserProfile from '@/components/workflows/UserProfile'

function ProfileLoader() {
  return (
    <div className="flex justify-center py-20">
      <div className="text-slate-500">Loading profile...</div>
    </div>
  )
}

export default function ProfilePage() {
  return (
    <>
      <Navbar />
      <main className="pt-32 pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <Suspense fallback={<ProfileLoader />}>
            <UserProfile />
          </Suspense>
        </div>
      </main>
      <Footer />
    </>
  )
}
