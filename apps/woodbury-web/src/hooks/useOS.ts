'use client'

import { useState, useEffect } from 'react'

type OS = 'Mac' | 'Windows' | null

export function useOS(): OS {
  const [os, setOS] = useState<OS>(null)

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('mac')) {
      setOS('Mac')
    } else if (ua.includes('win')) {
      setOS('Windows')
    }
  }, [])

  return os
}

export function getDownloadLabel(os: OS, base: string = 'Download'): string {
  if (os) return `${base} for ${os}`
  return base
}
