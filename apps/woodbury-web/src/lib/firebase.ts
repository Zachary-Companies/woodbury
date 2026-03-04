/**
 * Firebase SDK initialization for the Woodbury website.
 * Provides Auth (Google Sign-In) and Firestore for the extension registry.
 *
 * Firebase API keys are public identifiers — security is enforced by Firestore rules.
 */
import { initializeApp, getApps } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: 'AIzaSyDBXxreEDbtvi8nD2KNp64YL17_0PbE-w0',
  authDomain: 'woobury-ai.firebaseapp.com',
  projectId: 'woobury-ai',
  storageBucket: 'woobury-ai.firebasestorage.app',
  messagingSenderId: '824143171411',
  appId: '1:824143171411:web:3f0a186067a58050c25ba6',
  measurementId: 'G-Q73W3SE08T',
}

// Prevent re-initialization during Next.js hot reloads
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]

export const firestore = getFirestore(app)
export const auth = getAuth(app)
export const storage = getStorage(app)
