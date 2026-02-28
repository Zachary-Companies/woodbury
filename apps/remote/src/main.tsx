import { render } from 'preact';
import Router from 'preact-router';
import { useState, useEffect } from 'preact/hooks';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { ref, get, set } from 'firebase/database';
import { auth, db } from './firebase';
import { Login } from './pages/Login';
import { Connect } from './pages/Connect';
import { Dashboard } from './pages/Dashboard';
import './index.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoDiscoverDone, setAutoDiscoverDone] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setLoading(false);
        setAutoDiscoverDone(true);
      }
    });
    return () => unsub();
  }, []);

  // Auto-discover paired instances when user logs in
  useEffect(() => {
    if (!user) return;

    async function discover() {
      try {
        const snap = await get(ref(db, `users/${user!.uid}/instances`));
        if (snap.exists()) {
          const instances = snap.val() as Record<string, {
            instanceId: string;
            name: string;
            secretKey: string;
            connectedAt: string;
          }>;

          const stored: Array<{ instanceId: string; name: string; pairedAt: string }> = [];

          for (const [id, inst] of Object.entries(instances)) {
            // Ensure access is granted
            await set(ref(db, `access/${user!.uid}/${id}`), inst.secretKey);
            stored.push({
              instanceId: id,
              name: inst.name || 'Woodbury Instance',
              pairedAt: inst.connectedAt || new Date().toISOString(),
            });
          }

          if (stored.length > 0) {
            localStorage.setItem('woodbury_instances', JSON.stringify(stored));
            // Auto-select the most recently connected instance
            if (!localStorage.getItem('woodbury_instance')) {
              localStorage.setItem('woodbury_instance', stored[0].instanceId);
            }
          }
        }
      } catch (err) {
        console.error('Auto-discover failed:', err);
      }
      setAutoDiscoverDone(true);
      setLoading(false);
    }

    discover();
  }, [user]);

  if (loading || !autoDiscoverDone) {
    return (
      <div class="flex items-center justify-center min-h-screen">
        <div class="spinner" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  // Check if we have a paired instance
  const pairedInstance = localStorage.getItem('woodbury_instance');

  return (
    <Router>
      <Connect path="/connect" user={user} />
      <Connect path="/c/:connectionParam" user={user} />
      {pairedInstance ? (
        <Dashboard path="/" user={user} default />
      ) : (
        <Connect path="/" user={user} default />
      )}
      <Dashboard path="/dashboard" user={user} />
      <Dashboard path="/dashboard/:tab" user={user} />
    </Router>
  );
}

render(<App />, document.getElementById('app')!);
