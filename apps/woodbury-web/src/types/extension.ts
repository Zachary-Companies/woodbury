/** Extension metadata stored in Firestore (and shown in the marketplace) */
export interface Extension {
  name: string
  displayName: string
  description: string
  version: string
  author: string
  category: string
  provides: string[]
  gitUrl: string
  repoUrl: string
  icon: string
  tags: string[]
  platforms: string[]
  featured: boolean
  visible: boolean
  order: number
}

/** Category for filtering extensions */
export interface Category {
  id: string
  label: string
  order: number
}
