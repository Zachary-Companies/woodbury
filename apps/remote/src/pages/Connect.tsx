import { useState, useEffect, useRef } from 'preact/hooks';
import { route } from 'preact-router';
import { ref, set, get, remove } from 'firebase/database';
import { db } from '../firebase';
import type { User } from 'firebase/auth';

interface Props {
  path?: string;
  default?: boolean;
  user: User;
  connectionParam?: string;
}

function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function Connect({ user, connectionParam }: Props) {
  const [mode, setMode] = useState<'home' | 'pairing' | 'manual'>('home');
  const [pairingCode, setPairingCode] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [pairedInstances, setPairedInstances] = useState<
    Array<{ instanceId: string; name: string; pairedAt: string }>
  >([]);
  const listenerRef = useRef<(() => void) | null>(null);

  // Load existing paired instances from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('woodbury_instances');
      if (stored) setPairedInstances(JSON.parse(stored));
    } catch {}
  }, []);

  // Auto-connect if URL contains connection param (e.g. /c/{instanceId}-{secretKey})
  useEffect(() => {
    if (connectionParam) {
      const fullUrl = `https://woobury-ai.web.app/c/${connectionParam}`;
      setMode('manual');
      setUrlInput(fullUrl);
      connectWithUrl(fullUrl);
    }
  }, [connectionParam]);

  // Check for auto-discovered instances from /users/{uid}/instances/
  useEffect(() => {
    if (!user) return;
    autoDiscoverInstances();
  }, [user]);

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (listenerRef.current) listenerRef.current();
    };
  }, []);

  async function autoDiscoverInstances() {
    try {
      const snap = await get(ref(db, `users/${user.uid}/instances`));
      if (!snap.exists()) return;

      const instances = snap.val() as Record<string, {
        instanceId: string;
        name: string;
        secretKey: string;
        connectedAt: string;
      }>;

      const discovered: Array<{ instanceId: string; name: string; pairedAt: string }> = [];

      for (const [id, inst] of Object.entries(instances)) {
        // Grant access to this instance
        await set(ref(db, `access/${user.uid}/${id}`), inst.secretKey);
        discovered.push({
          instanceId: id,
          name: inst.name || 'Woodbury Instance',
          pairedAt: inst.connectedAt || new Date().toISOString(),
        });
      }

      if (discovered.length > 0) {
        // Merge with existing, avoiding duplicates
        const existingIds = new Set(pairedInstances.map((p) => p.instanceId));
        const merged = [...pairedInstances];
        for (const d of discovered) {
          if (!existingIds.has(d.instanceId)) {
            merged.push(d);
          }
        }
        setPairedInstances(merged);
        localStorage.setItem('woodbury_instances', JSON.stringify(merged));
      }
    } catch (err) {
      console.error('Auto-discover failed:', err);
    }
  }

  async function startPairing() {
    setError('');
    setMode('pairing');
    setWaiting(true);

    const code = generateCode();
    setPairingCode(code);

    // Snapshot instance IDs we already know about BEFORE pairing
    const knownIds = new Set<string>();
    try {
      const stored = localStorage.getItem('woodbury_instances');
      if (stored) {
        for (const inst of JSON.parse(stored)) knownIds.add(inst.instanceId);
      }
    } catch {}

    try {
      // Write pairing code to Firebase
      await set(ref(db, `pairing_codes/${code}`), {
        uid: user.uid,
        createdAt: Date.now(),
      });

      // Poll every 3s for new instances under our account
      const pollInterval = setInterval(async () => {
        try {
          const snap = await get(ref(db, `users/${user.uid}/instances`));
          if (!snap.exists()) return;

          const instances = snap.val() as Record<string, {
            instanceId: string;
            name: string;
            secretKey: string;
            connectedAt: string;
          }>;

          for (const [id, inst] of Object.entries(instances)) {
            if (!knownIds.has(id)) {
              // New instance found! Grant ourselves access and navigate
              clearInterval(pollInterval);
              listenerRef.current = null;

              try {
                await set(ref(db, `access/${user.uid}/${id}`), inst.secretKey);
              } catch (e) {
                console.error('Failed to write access grant:', e);
              }

              const newInst = {
                instanceId: id,
                name: inst.name || 'Woodbury Instance',
                pairedAt: inst.connectedAt || new Date().toISOString(),
              };

              const currentStored = localStorage.getItem('woodbury_instances');
              const current = currentStored ? JSON.parse(currentStored) : [];
              const updated = [newInst, ...current.filter((p: any) => p.instanceId !== id)];
              localStorage.setItem('woodbury_instances', JSON.stringify(updated));
              localStorage.setItem('woodbury_instance', id);

              setWaiting(false);
              route('/dashboard');
              return;
            }
          }
        } catch (e) {
          console.error('Poll check failed:', e);
        }
      }, 3000);

      // Store cleanup function
      listenerRef.current = () => clearInterval(pollInterval);

      // Auto-expire after 10 minutes
      setTimeout(() => {
        if (listenerRef.current) {
          listenerRef.current();
          listenerRef.current = null;
        }
        remove(ref(db, `pairing_codes/${code}`)).catch(() => {});
        setWaiting(false);
        setError('Pairing code expired. Tap "Generate Code" to try again.');
        setPairingCode('');
      }, 10 * 60_000);
    } catch (err) {
      setWaiting(false);
      setError((err as Error).message || 'Failed to generate pairing code');
    }
  }

  function cancelPairing() {
    if (listenerRef.current) {
      listenerRef.current();
      listenerRef.current = null;
    }
    if (pairingCode) {
      remove(ref(db, `pairing_codes/${pairingCode}`)).catch(() => {});
    }
    setWaiting(false);
    setPairingCode('');
    setMode('home');
    setError('');
  }

  // Manual URL connection (advanced)
  function parseConnectionUrl(url: string): { instanceId: string; secretKey: string } | null {
    const match = url.match(
      /(?:\/c\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    if (!match) return null;
    return { instanceId: match[1], secretKey: match[2] };
  }

  async function connectWithUrl(url: string) {
    setError('');
    setConnecting(true);

    const parsed = parseConnectionUrl(url);
    if (!parsed) {
      setError('Invalid connection URL.');
      setConnecting(false);
      return;
    }

    const { instanceId, secretKey } = parsed;

    try {
      const metaSnap = await get(ref(db, `instances/${instanceId}/meta`));
      if (!metaSnap.exists()) {
        setError('Instance not found. Make sure Woodbury is running.');
        setConnecting(false);
        return;
      }

      await set(ref(db, `access/${user.uid}/${instanceId}`), secretKey);

      const meta = metaSnap.val();
      const instance = {
        instanceId,
        name: meta.name || 'Woodbury Instance',
        pairedAt: new Date().toISOString(),
      };

      const existing = pairedInstances.filter((p) => p.instanceId !== instanceId);
      const updated = [instance, ...existing];
      setPairedInstances(updated);
      localStorage.setItem('woodbury_instances', JSON.stringify(updated));
      localStorage.setItem('woodbury_instance', instanceId);

      route('/dashboard');
    } catch (err: unknown) {
      setError((err as Error).message || 'Connection failed');
    }

    setConnecting(false);
  }

  function selectInstance(instanceId: string) {
    localStorage.setItem('woodbury_instance', instanceId);
    route('/dashboard');
  }

  function removeInstance(instanceId: string) {
    const updated = pairedInstances.filter((p) => p.instanceId !== instanceId);
    setPairedInstances(updated);
    localStorage.setItem('woodbury_instances', JSON.stringify(updated));
    if (localStorage.getItem('woodbury_instance') === instanceId) {
      localStorage.removeItem('woodbury_instance');
    }
  }

  // ── Pairing Code View ──────────────────────────────────

  if (mode === 'pairing') {
    return (
      <div class="min-h-screen px-6 py-8">
        <div class="max-w-sm mx-auto">
          <div class="text-center mb-8">
            <div class="text-3xl mb-2">{'\u{1F517}'}</div>
            <h1 class="text-xl font-bold text-white">Pairing Code</h1>
          </div>

          {pairingCode && waiting ? (
            <div class="text-center space-y-6">
              {/* Big code display */}
              <div class="bg-dark-800 border-2 border-cyan-500 rounded-2xl py-8 px-6">
                <div class="text-5xl font-mono font-bold text-cyan-400 tracking-[0.3em]">
                  {pairingCode}
                </div>
              </div>

              <div class="space-y-2">
                <p class="text-gray-300 text-sm">
                  On your computer, type this in Woodbury:
                </p>
                <div class="bg-dark-800 border border-dark-700 rounded-xl px-4 py-3 font-mono text-cyan-300 text-sm">
                  /pair {pairingCode}
                </div>
              </div>

              <div class="flex items-center justify-center gap-2 text-gray-400 text-sm">
                <div class="spinner-sm" />
                <span>Waiting for connection...</span>
              </div>

              <p class="text-xs text-gray-600">
                Code expires in 10 minutes
              </p>

              <button
                onClick={cancelPairing}
                class="text-sm text-gray-400 hover:text-gray-300 underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div class="text-center space-y-4">
              {error && (
                <div class="text-sm text-red-400">{error}</div>
              )}
              <button
                onClick={startPairing}
                class="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-3 px-4 rounded-xl transition"
              >
                Generate New Code
              </button>
              <button
                onClick={() => { setMode('home'); setError(''); }}
                class="text-sm text-gray-400 hover:text-gray-300 underline"
              >
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Manual URL View ────────────────────────────────────

  if (mode === 'manual') {
    return (
      <div class="min-h-screen px-6 py-8">
        <div class="max-w-sm mx-auto">
          <div class="text-center mb-8">
            <div class="text-3xl mb-2">{'\u{1F50C}'}</div>
            <h1 class="text-xl font-bold text-white">Manual Connection</h1>
            <p class="text-gray-400 text-sm mt-1">
              Paste the connection URL from your terminal
            </p>
          </div>

          <div class="space-y-3 mb-6">
            <textarea
              value={urlInput}
              onInput={(e) => setUrlInput((e.target as HTMLTextAreaElement).value)}
              placeholder="Paste your connection URL here..."
              rows={3}
              class="w-full bg-dark-800 border border-dark-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none font-mono"
            />
            <button
              onClick={() => connectWithUrl(urlInput)}
              disabled={connecting || !urlInput.trim()}
              class="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-3 px-4 rounded-xl transition disabled:opacity-50"
            >
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>

          {error && (
            <div class="text-center text-sm text-red-400 mb-6">{error}</div>
          )}

          <button
            onClick={() => { setMode('home'); setError(''); }}
            class="block mx-auto text-sm text-gray-400 hover:text-gray-300 underline"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Home View ──────────────────────────────────────────

  return (
    <div class="min-h-screen px-6 py-8">
      <div class="max-w-sm mx-auto">
        {/* Header */}
        <div class="text-center mb-8">
          <div class="text-4xl mb-3">{'\u{1F30D}'}</div>
          <h1 class="text-xl font-bold text-white">Connect to Woodbury</h1>
          <p class="text-gray-400 text-sm mt-1">
            Link your phone to your computer
          </p>
        </div>

        {/* Primary action — Pairing */}
        <div class="space-y-3 mb-6">
          <button
            onClick={startPairing}
            class="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-semibold py-4 px-4 rounded-xl transition text-base"
          >
            {'\u{1F517}'} Generate Pairing Code
          </button>
          <p class="text-center text-xs text-gray-500">
            Get a code, then type <span class="font-mono text-cyan-400">/pair</span> in your terminal
          </p>
        </div>

        {/* Divider */}
        <div class="flex items-center gap-3 my-6">
          <div class="flex-1 border-t border-dark-700" />
          <span class="text-xs text-gray-600">OR</span>
          <div class="flex-1 border-t border-dark-700" />
        </div>

        {/* Advanced — URL */}
        <button
          onClick={() => setMode('manual')}
          class="w-full bg-dark-800 border border-dark-700 hover:border-dark-600 text-gray-300 font-medium py-3 px-4 rounded-xl transition text-sm"
        >
          Connect with URL (Advanced)
        </button>

        {error && (
          <div class="text-center text-sm text-red-400 mt-4">{error}</div>
        )}

        {/* Paired Instances */}
        {pairedInstances.length > 0 && (
          <div class="mt-8">
            <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
              Your Instances
            </h2>
            <div class="space-y-2">
              {pairedInstances.map((inst) => (
                <div
                  key={inst.instanceId}
                  class="flex items-center justify-between bg-dark-800 border border-dark-700 rounded-xl px-4 py-3"
                >
                  <button
                    onClick={() => selectInstance(inst.instanceId)}
                    class="flex-1 text-left"
                  >
                    <div class="text-sm font-medium text-gray-200">
                      {inst.name}
                    </div>
                    <div class="text-xs text-gray-500 font-mono">
                      {inst.instanceId.slice(0, 8)}...
                    </div>
                  </button>
                  <button
                    onClick={() => removeInstance(inst.instanceId)}
                    class="text-gray-500 hover:text-red-400 ml-3 text-lg"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Help text */}
        <div class="mt-8 text-center text-xs text-gray-600">
          <p>Run Woodbury on your computer first.</p>
          <p class="mt-1">Then generate a code here and pair from your terminal.</p>
        </div>
      </div>
    </div>
  );
}
