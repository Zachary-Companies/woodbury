import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Woodbury — Automate Your Browser, No Code Required',
  description: 'Record your actions, replay them with AI. Woodbury turns your clicks into automated workflows — no coding needed. Built for Mac + Chrome.',
  openGraph: {
    title: 'Woodbury — AI-Powered Browser Automation',
    description: 'Record your actions, replay them with AI. No coding needed.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-[#0f172a] text-white antialiased`}>{children}</body>
    </html>
  )
}
