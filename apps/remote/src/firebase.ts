/**
 * Firebase SDK initialization for the remote web app.
 */
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyCJqvdjlTvh7uvZKRtN0fSHgjJVJtvMEvw',
  authDomain: 'woobury-ai.firebaseapp.com',
  databaseURL: 'https://woobury-ai-default-rtdb.firebaseio.com',
  projectId: 'woobury-ai',
  storageBucket: 'woobury-ai.firebasestorage.app',
  messagingSenderId: '824143171411',
  appId: '1:824143171411:web:3f0a186067a58050c25ba6',
  measurementId: 'G-Q73W3SE08T',
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
