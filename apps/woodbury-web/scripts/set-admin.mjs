/**
 * Set admin UIDs in Firestore config/admin document.
 * Usage: node scripts/set-admin.mjs <uid1> [uid2] ...
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load service account
const serviceAccountPath = resolve(__dirname, '../../..', 'woobury-ai-firebase-adminsdk.json')
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'))

const app = initializeApp({ credential: cert(serviceAccount) })
const db = getFirestore(app)

const uids = process.argv.slice(2)
if (uids.length === 0) {
  console.error('Usage: node scripts/set-admin.mjs <uid1> [uid2] ...')
  process.exit(1)
}

console.log('Setting admin UIDs:', uids)

await db.doc('config/admin').set({ adminUIDs: uids }, { merge: true })
console.log('✅ Admin UIDs written to config/admin')

process.exit(0)
