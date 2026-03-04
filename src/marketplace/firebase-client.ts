/**
 * Marketplace Firebase Client
 *
 * Firebase JS SDK client for the Electron app to interact with the
 * workflow marketplace. Handles authentication, publishing, downloading,
 * and update checking.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
  increment,
  type Firestore,
  type QueryConstraint,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  type FirebaseStorage,
} from 'firebase/storage';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { WorkflowDocument } from '../workflow/types.js';
import type { PublishMetadata, PublishResult, DownloadResult, UpdateInfo } from './types.js';
import { sanitizeWorkflow, extractStepTypes, countSteps, countVariables } from './sanitize.js';
import { trackInstall, getInstalledVersionMap } from './manifest.js';

// Firebase config — same project as the website
const firebaseConfig = {
  apiKey: 'AIzaSyDBXxreEDbtvi8nD2KNp64YL17_0PbE-w0',
  authDomain: 'woobury-ai.firebaseapp.com',
  projectId: 'woobury-ai',
  storageBucket: 'woobury-ai.firebasestorage.app',
  messagingSenderId: '824143171411',
  appId: '1:824143171411:web:3f0a186067a58050c25ba6',
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseDb: Firestore | null = null;
let firebaseStorage: FirebaseStorage | null = null;

/** Initialize Firebase (idempotent) */
export function initFirebase(): {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
} {
  if (!firebaseApp) {
    firebaseApp =
      getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
    firebaseAuth = getAuth(firebaseApp);
    firebaseDb = getFirestore(firebaseApp);
    firebaseStorage = getStorage(firebaseApp);
  }
  return {
    app: firebaseApp,
    auth: firebaseAuth!,
    db: firebaseDb!,
    storage: firebaseStorage!,
  };
}

/** Get the current marketplace user, or null */
export function getCurrentUser(): User | null {
  const { auth } = initFirebase();
  return auth.currentUser;
}

/**
 * Sign in with a Google OAuth ID token (obtained from Electron BrowserWindow).
 * The Electron app opens a Google OAuth popup, gets the token, and passes it here.
 */
export async function signInWithGoogleToken(idToken: string): Promise<User> {
  const { auth } = initFirebase();
  const credential = GoogleAuthProvider.credential(idToken);
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

/** Sign out of the marketplace */
export async function signOut(): Promise<void> {
  const { auth } = initFirebase();
  await auth.signOut();
}

/**
 * Publish a workflow to the marketplace.
 *
 * Steps:
 * 1. Sanitize the workflow (strip local paths, training metadata)
 * 2. Upload workflow.json to Storage
 * 3. Upload ONNX model to Storage (if included)
 * 4. Upload screenshots to Storage
 * 5. Create/update Firestore shared-workflows document
 */
export async function publishWorkflow(
  workflow: WorkflowDocument,
  metadata: PublishMetadata,
  existingWorkflowId?: string,
): Promise<PublishResult> {
  const { db, storage } = initFirebase();
  const user = getCurrentUser();
  if (!user) {
    return { success: false, workflowId: '', version: '', url: '', error: 'Not signed in' };
  }

  try {
    // Sanitize the workflow
    const sanitized = sanitizeWorkflow(workflow);

    // Determine workflow ID (reuse existing or create new)
    const workflowId = existingWorkflowId || doc(collection(db, 'shared-workflows')).id;
    const version = metadata.version;
    const storagePath = `workflows/${user.uid}/${workflowId}/v${version}`;

    // 1. Upload workflow.json
    const workflowJson = JSON.stringify(sanitized, null, 2);
    const workflowRef = ref(storage, `${storagePath}/workflow.json`);
    await uploadBytes(workflowRef, new TextEncoder().encode(workflowJson), {
      contentType: 'application/json',
    });

    // 2. Upload model if included
    let modelStoragePath: string | null = null;
    if (metadata.includeModel && workflow.metadata?.modelPath) {
      try {
        const modelData = await fs.readFile(workflow.metadata.modelPath);
        const modelRef = ref(storage, `${storagePath}/encoder_quantized.onnx`);
        await uploadBytes(modelRef, modelData, {
          contentType: 'application/octet-stream',
        });
        modelStoragePath = `${storagePath}/encoder_quantized.onnx`;
      } catch (modelErr) {
        console.warn('[marketplace] Failed to upload model:', modelErr);
      }
    }

    // 3. Upload screenshots
    const screenshotURLs: string[] = [];
    for (let i = 0; i < metadata.screenshotPaths.length; i++) {
      try {
        const screenshotData = await fs.readFile(metadata.screenshotPaths[i]);
        const screenshotRef = ref(
          storage,
          `workflows/${user.uid}/${workflowId}/screenshots/preview-${i + 1}.png`,
        );
        await uploadBytes(screenshotRef, screenshotData, {
          contentType: 'image/png',
        });
        const url = await getDownloadURL(screenshotRef);
        screenshotURLs.push(url);
      } catch (screenshotErr) {
        console.warn(`[marketplace] Failed to upload screenshot ${i + 1}:`, screenshotErr);
      }
    }

    // 4. Create/update Firestore document
    const slug = metadata.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const versionSummary = {
      version,
      changelog: metadata.changelog,
      publishedAt: new Date().toISOString(),
      workflowStoragePath: `${storagePath}/workflow.json`,
      modelStoragePath,
      stepCount: countSteps(workflow),
    };

    const docRef = doc(db, 'shared-workflows', workflowId);
    const existingDoc = existingWorkflowId ? await getDoc(docRef) : null;

    if (existingDoc?.exists()) {
      // Update existing workflow
      const existingData = existingDoc.data();
      const versions = existingData.versions || [];
      versions.push(versionSummary);

      await updateDoc(docRef, {
        name: metadata.name,
        description: metadata.description,
        category: metadata.category,
        tags: metadata.tags,
        currentVersion: version,
        versions,
        hasModel: metadata.includeModel && !!modelStoragePath,
        modelVersion: metadata.includeModel ? workflow.metadata?.modelVersion || null : null,
        stepCount: countSteps(workflow),
        stepTypes: extractStepTypes(workflow),
        variableCount: countVariables(workflow),
        screenshotURLs: screenshotURLs.length > 0 ? screenshotURLs : existingData.screenshotURLs || [],
        status: 'published',
        recordedViewportWidth: workflow.metadata?.environment?.viewportWidth || null,
        recordedViewportHeight: workflow.metadata?.environment?.viewportHeight || null,
        updatedAt: serverTimestamp(),
      });
    } else {
      // Create new workflow
      await setDoc(docRef, {
        id: workflowId,
        slug,
        name: metadata.name,
        description: metadata.description,
        site: workflow.site || '',
        authorId: user.uid,
        authorName: user.displayName || '',
        authorPhotoURL: user.photoURL || null,
        category: metadata.category,
        tags: metadata.tags,
        currentVersion: version,
        versions: [versionSummary],
        hasModel: metadata.includeModel && !!modelStoragePath,
        modelVersion: metadata.includeModel ? workflow.metadata?.modelVersion || null : null,
        stepCount: countSteps(workflow),
        stepTypes: extractStepTypes(workflow),
        variableCount: countVariables(workflow),
        screenshotURLs,
        downloadCount: 0,
        rating: 0,
        ratingCount: 0,
        visible: true,
        featured: false,
        status: 'published' as const,
        recordedViewportWidth: workflow.metadata?.environment?.viewportWidth || null,
        recordedViewportHeight: workflow.metadata?.environment?.viewportHeight || null,
        platforms: ['Mac', 'Windows'],
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    return {
      success: true,
      workflowId,
      version,
      url: `https://woodbury.bot/workflows/view?id=${workflowId}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, workflowId: '', version: '', url: '', error: message };
  }
}

/**
 * Download and install a shared workflow from the marketplace.
 */
export async function downloadSharedWorkflow(
  workflowId: string,
  version?: string,
): Promise<DownloadResult> {
  const { db, storage } = initFirebase();

  try {
    // Fetch the workflow document
    const docRef = doc(db, 'shared-workflows', workflowId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      return { success: false, workflowPath: '', modelPath: null, error: 'Workflow not found' };
    }

    const data = docSnap.data();
    const targetVersion = version || data.currentVersion;
    const versionInfo = data.versions?.find((v: { version: string }) => v.version === targetVersion);
    if (!versionInfo) {
      return { success: false, workflowPath: '', modelPath: null, error: `Version ${targetVersion} not found` };
    }

    // Create local directory
    const localDir = join(homedir(), '.woodbury', 'workflows');
    await fs.mkdir(localDir, { recursive: true });

    // Download workflow.json
    const workflowRef = ref(storage, versionInfo.workflowStoragePath);
    const workflowUrl = await getDownloadURL(workflowRef);
    const workflowResponse = await fetch(workflowUrl);
    const workflowJson = await workflowResponse.text();
    const localWorkflowPath = join(localDir, `${workflowId}.workflow.json`);
    await fs.writeFile(localWorkflowPath, workflowJson, 'utf-8');

    // Download model if available
    let localModelPath: string | null = null;
    if (versionInfo.modelStoragePath) {
      try {
        const modelDir = join(
          homedir(),
          '.woodbury',
          'data',
          'workflows',
          workflowId,
          'model',
        );
        await fs.mkdir(modelDir, { recursive: true });
        const modelRef = ref(storage, versionInfo.modelStoragePath);
        const modelUrl = await getDownloadURL(modelRef);
        const modelResponse = await fetch(modelUrl);
        const modelBuffer = Buffer.from(await modelResponse.arrayBuffer());
        localModelPath = join(modelDir, 'encoder_quantized.onnx');
        await fs.writeFile(localModelPath, modelBuffer);
      } catch (modelErr) {
        console.warn('[marketplace] Failed to download model:', modelErr);
      }
    }

    // Increment download count
    await updateDoc(docRef, { downloadCount: increment(1) });

    // Track in manifest
    await trackInstall({
      workflowId,
      name: data.name,
      installedVersion: targetVersion,
      authorId: data.authorId,
      authorName: data.authorName,
      site: data.site,
      hasModel: !!localModelPath,
      localWorkflowPath,
      localModelPath,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return { success: true, workflowPath: localWorkflowPath, modelPath: localModelPath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, workflowPath: '', modelPath: null, error: message };
  }
}

/**
 * Check for updates to installed shared workflows.
 * Compares local manifest versions against Firestore.
 */
export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const { db } = initFirebase();
  const installedMap = await getInstalledVersionMap();
  const updates: UpdateInfo[] = [];

  for (const [workflowId, installedVersion] of Object.entries(installedMap)) {
    try {
      const docRef = doc(db, 'shared-workflows', workflowId);
      const docSnap = await getDoc(docRef);
      if (!docSnap.exists()) continue;

      const data = docSnap.data();
      if (data.currentVersion && data.currentVersion !== installedVersion) {
        // Simple version comparison — newer if different
        const latestVersionInfo = data.versions?.find(
          (v: { version: string }) => v.version === data.currentVersion,
        );
        updates.push({
          workflowId,
          name: data.name,
          installedVersion,
          latestVersion: data.currentVersion,
          changelog: latestVersionInfo?.changelog || '',
          hasModelUpdate: !!latestVersionInfo?.modelStoragePath,
        });
      }
    } catch {
      // Skip individual failures
    }
  }

  return updates;
}

/**
 * Browse shared workflows from Firestore (for Electron marketplace tab).
 */
export async function browseWorkflows(options?: {
  category?: string;
  sortBy?: 'downloadCount' | 'publishedAt' | 'rating';
  maxResults?: number;
}): Promise<Record<string, unknown>[]> {
  const { db } = initFirebase();
  const constraints: QueryConstraint[] = [
    where('visible', '==', true),
    where('status', '==', 'published'),
  ];

  if (options?.category) {
    constraints.push(where('category', '==', options.category));
  }

  const sortField = options?.sortBy || 'downloadCount';
  constraints.push(orderBy(sortField, 'desc'));
  constraints.push(limit(options?.maxResults || 50));

  const q = query(collection(db, 'shared-workflows'), ...constraints);
  const snapshot = await getDocs(q);

  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}
