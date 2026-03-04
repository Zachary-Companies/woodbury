import { Timestamp } from 'firebase/firestore'

/** User profile stored in Firestore `users/{uid}` */
export interface UserProfile {
  uid: string
  displayName: string
  email: string
  photoURL: string | null
  bio: string
  publishedWorkflowCount: number
  totalDownloads: number
  joinedAt: Timestamp
  lastActiveAt: Timestamp
}
