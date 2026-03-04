'use client'

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, firestore } from '@/lib/firebase'
import type { UserProfile } from '@/types/user'

interface AuthState {
  user: User | null
  userProfile: UserProfile | null
  isAdmin: boolean
  loading: boolean
}

const AuthContext = createContext<AuthState>({
  user: null,
  userProfile: null,
  isAdmin: false,
  loading: true,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        try {
          // Check admin status
          const adminDoc = await getDoc(doc(firestore, 'config', 'admin'))
          if (adminDoc.exists()) {
            const adminUIDs: string[] = adminDoc.data().adminUIDs || []
            setIsAdmin(adminUIDs.includes(u.uid))
          }

          // Upsert user profile (non-anonymous users only)
          if (!u.isAnonymous) {
            const userRef = doc(firestore, 'users', u.uid)
            const existingProfile = await getDoc(userRef)

            const profileData: Record<string, unknown> = {
              uid: u.uid,
              displayName: u.displayName || '',
              email: u.email || '',
              photoURL: u.photoURL || null,
              lastActiveAt: serverTimestamp(),
            }

            // Only set defaults on first create
            if (!existingProfile.exists()) {
              profileData.bio = ''
              profileData.publishedWorkflowCount = 0
              profileData.totalDownloads = 0
              profileData.joinedAt = serverTimestamp()
            }

            await setDoc(userRef, profileData, { merge: true })

            // Read back the full profile
            const updatedDoc = await getDoc(userRef)
            if (updatedDoc.exists()) {
              setUserProfile(updatedDoc.data() as UserProfile)
            }
          } else {
            setUserProfile(null)
          }
        } catch {
          setIsAdmin(false)
          setUserProfile(null)
        }
      } else {
        setIsAdmin(false)
        setUserProfile(null)
      }
      setLoading(false)
    })
    return () => unsub()
  }, [])

  return (
    <AuthContext.Provider value={{ user, userProfile, isAdmin, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
