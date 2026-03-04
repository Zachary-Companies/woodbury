'use client'

import { useState, useEffect } from 'react'

interface VersionInfo {
  version: string
  releaseDate: string
}

export function useVersion(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null)

  useEffect(() => {
    fetch('/version.json')
      .then((r) => r.json())
      .then((data) => setInfo({ version: data.version, releaseDate: data.releaseDate }))
      .catch(() => {})
  }, [])

  return info
}
