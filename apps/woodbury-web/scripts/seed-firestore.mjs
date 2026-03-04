/**
 * One-time migration script: reads public/registry.json and seeds Firestore.
 *
 * Prerequisites:
 *   1. npm install firebase-admin (in this directory or globally)
 *   2. Download a Firebase Admin service account key from:
 *      Firebase Console > Project Settings > Service Accounts > Generate New Private Key
 *   3. Save it as scripts/service-account.json
 *
 * Usage:
 *   node scripts/seed-firestore.mjs
 */

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Initialize Firebase Admin
const serviceAccountPath = join(__dirname, '..', '..', '..', 'woobury-ai-firebase-adminsdk.json')
let serviceAccount
try {
  serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'))
} catch {
  console.error('Missing woobury-ai-firebase-adminsdk.json at repo root.')
  process.exit(1)
}

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'woobury-ai',
})

const db = getFirestore()

async function seed() {
  // Read the existing registry
  const registryPath = join(__dirname, '..', 'public', 'registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))

  console.log(`Seeding ${registry.extensions.length} extensions and ${registry.categories.length} categories...\n`)

  // Seed extensions
  for (let i = 0; i < registry.extensions.length; i++) {
    const ext = registry.extensions[i]
    await db.collection('extensions').doc(ext.name).set({
      ...ext,
      visible: true,
      order: i,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    console.log(`  ✓ Extension: ${ext.displayName}`)
  }

  // Seed categories
  for (let i = 0; i < registry.categories.length; i++) {
    const cat = registry.categories[i]
    await db.collection('categories').doc(cat.id).set({
      ...cat,
      order: i,
    })
    console.log(`  ✓ Category: ${cat.label}`)
  }

  // Skip admin config — preserve existing admin UIDs
  console.log(`  ⏭ Skipping admin config (preserving existing adminUIDs)`)

  console.log('\nDone! To add yourself as admin:')
  console.log('  1. Visit woodbury.bot/admin and sign in with Google')
  console.log('  2. Note the UID shown on the "Access Denied" page')
  console.log('  3. Add that UID to Firestore: config/admin → adminUIDs array')
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
