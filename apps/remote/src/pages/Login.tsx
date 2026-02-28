import { useState } from 'preact/hooks';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
} from 'firebase/auth';
import { auth } from '../firebase';

const googleProvider = new GoogleAuthProvider();

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleGoogle() {
    setError('');
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      setError((err as Error).message || 'Google sign-in failed');
    }
    setLoading(false);
  }

  async function handleEmail(e: Event) {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: unknown) {
      const msg = (err as Error).message || 'Auth failed';
      if (msg.includes('auth/user-not-found') || msg.includes('auth/invalid-credential')) {
        setError('Invalid email or password');
      } else if (msg.includes('auth/email-already-in-use')) {
        setError('Account already exists. Try signing in.');
      } else if (msg.includes('auth/weak-password')) {
        setError('Password must be at least 6 characters');
      } else {
        setError(msg);
      }
    }
    setLoading(false);
  }

  return (
    <div class="flex items-center justify-center min-h-screen px-6">
      <div class="w-full max-w-sm">
        {/* Logo */}
        <div class="text-center mb-8">
          <div class="text-4xl mb-2">W</div>
          <h1 class="text-2xl font-bold text-white">Woodbury</h1>
          <p class="text-gray-400 text-sm mt-1">Remote Control</p>
        </div>

        {/* Google Sign In */}
        <button
          onClick={handleGoogle}
          disabled={loading}
          class="w-full flex items-center justify-center gap-3 bg-white text-gray-800 font-medium py-3 px-4 rounded-xl hover:bg-gray-100 transition disabled:opacity-50 mb-4"
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>

        {/* Divider */}
        <div class="flex items-center gap-3 my-6">
          <div class="flex-1 h-px bg-dark-700" />
          <span class="text-xs text-gray-500">or</span>
          <div class="flex-1 h-px bg-dark-700" />
        </div>

        {/* Email form */}
        <form onSubmit={handleEmail} class="space-y-3">
          <input
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            placeholder="Email"
            class="w-full bg-dark-800 border border-dark-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
          <input
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            placeholder="Password"
            class="w-full bg-dark-800 border border-dark-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
          <button
            type="submit"
            disabled={loading}
            class="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-3 px-4 rounded-xl transition disabled:opacity-50"
          >
            {loading ? 'Loading...' : isSignUp ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        {/* Error */}
        {error && (
          <div class="mt-4 text-center text-sm text-red-400">{error}</div>
        )}

        {/* Toggle */}
        <div class="text-center mt-6">
          <button
            onClick={() => { setIsSignUp(!isSignUp); setError(''); }}
            class="text-sm text-purple-400 hover:text-purple-300"
          >
            {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}
