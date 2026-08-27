'use client'

import { useState, useEffect } from 'react'

interface VersionInfo {
  version: string
  releaseDate: string
  /** The mac build is not notarized yet; the UI shows a first-launch note. */
  macUnsigned?: boolean
  macInstallNote?: string
}

export function useVersion(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null)

  useEffect(() => {
    fetch('/version.json')
      .then((r) => r.json())
      .then((data) =>
        setInfo({
          version: data.version,
          releaseDate: data.releaseDate,
          macUnsigned: data.macUnsigned,
          macInstallNote: data.macInstallNote,
        })
      )
      .catch(() => {})
  }, [])

  return info
}
