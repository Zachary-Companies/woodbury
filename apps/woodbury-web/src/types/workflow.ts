import { Timestamp } from 'firebase/firestore'

/** A workflow shared on the marketplace, stored in Firestore `shared-workflows/{id}` */
export interface SharedWorkflow {
  id: string
  slug: string
  name: string
  description: string
  site: string // Target domain (e.g. "suno.com")

  authorId: string
  authorName: string
  authorPhotoURL: string | null

  category: string
  tags: string[]

  currentVersion: string // SemVer
  versions: WorkflowVersionSummary[]

  hasModel: boolean
  modelVersion: string | null

  stepCount: number
  stepTypes: string[] // Unique step types used (for badges)
  variableCount: number
  screenshotURLs: string[]

  downloadCount: number
  rating: number // Average 1-5, 0 if unrated
  ratingCount: number

  visible: boolean
  featured: boolean
  status: 'published' | 'under_review' | 'unlisted' | 'removed'

  recordedViewportWidth: number | null
  recordedViewportHeight: number | null
  platforms: string[]

  publishedAt: Timestamp
  updatedAt: Timestamp
}

/** Summary of a single version, embedded in the SharedWorkflow versions array */
export interface WorkflowVersionSummary {
  version: string
  changelog: string
  publishedAt: string
  workflowStoragePath: string // Storage path to workflow.json
  modelStoragePath: string | null // Storage path to encoder_quantized.onnx
  stepCount: number
}

/** Category for filtering shared workflows */
export interface WorkflowCategory {
  id: string
  label: string
  icon: string
  order: number
}

/** Review of a shared workflow, stored in `shared-workflows/{id}/reviews/{uid}` */
export interface WorkflowReview {
  authorId: string
  authorName: string
  authorPhotoURL: string | null
  rating: number // 1-5
  comment: string
  createdAt: Timestamp
  updatedAt: Timestamp
}
