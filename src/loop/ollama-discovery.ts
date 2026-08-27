/**
 * Automatic Ollama endpoint discovery via mDNS/Bonjour.
 *
 * Discovers Ollama servers on the local network by browsing for
 * `_ollama._tcp` services. Falls back to `_http._tcp` services on
 * port 11434 (Ollama's default port).
 *
 * Discovery is lazy — only triggered when an Ollama model is used and
 * `OLLAMA_BASE_URL` is not set. Results are cached so repeated calls
 * don't re-scan the network.
 *
 * Ported from @zachary/llm-service (Zachary-Companies/llm-service).
 */

export interface OllamaEndpoint {
  host: string;
  port: number;
  baseUrl: string;
  name: string;
  /** Model name from the mDNS TXT record, if advertised. */
  model?: string;
}

let cachedEndpoints: OllamaEndpoint[] | null = null;
let discoveryPromise: Promise<OllamaEndpoint[]> | null = null;

/**
 * Discover Ollama endpoints on the local network via mDNS.
 * Returns cached results on subsequent calls. Use `clearDiscoveryCache()`
 * to force a re-scan.
 *
 * @param timeoutMs How long to listen for services (default: 3000ms).
 *   Longer timeouts find more services but delay the first Ollama call.
 */
export async function discoverOllamaEndpoints(timeoutMs = 3000): Promise<OllamaEndpoint[]> {
  if (cachedEndpoints) return cachedEndpoints;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = runDiscovery(timeoutMs)
    .then((endpoints) => {
      cachedEndpoints = endpoints;
      discoveryPromise = null;
      return endpoints;
    })
    .catch(() => {
      discoveryPromise = null;
      cachedEndpoints = [];
      return [];
    });

  return discoveryPromise;
}

/** Clear the cached discovery results, forcing the next call to re-scan. */
export function clearDiscoveryCache(): void {
  cachedEndpoints = null;
  discoveryPromise = null;
}

async function runDiscovery(timeoutMs: number): Promise<OllamaEndpoint[]> {
  // Lazy-load bonjour-service so it's only pulled in when discovery is
  // actually used (headless/server environments may not ship it).
  let Bonjour: any;
  try {
    const mod = require('bonjour-service');
    Bonjour = mod.Bonjour;
  } catch {
    return [];
  }

  const endpoints: OllamaEndpoint[] = [];
  const seen = new Set<string>();
  const bonjour = new Bonjour();

  const addEndpoint = (service: any) => {
    const host = service.host || service.addresses?.[0];
    const port = service.port;
    if (!host || !port) return;

    const key = `${host}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);

    const txt = service.txt || {};
    const model = txt.model || undefined;

    endpoints.push({
      host,
      port,
      baseUrl: `http://${host}:${port}/v1`,
      name: service.name || key,
      model,
    });
  };

  return new Promise<OllamaEndpoint[]>((resolve) => {
    // Browse for the Ollama-specific service type first
    const ollamaBrowser = bonjour.find({ type: 'ollama' }, (service: any) => {
      addEndpoint(service);
    });

    // Also browse HTTP services and filter for Ollama's default port
    const httpBrowser = bonjour.find({ type: 'http' }, (service: any) => {
      if (service.port === 11434) {
        addEndpoint(service);
      }
    });

    setTimeout(() => {
      try {
        ollamaBrowser.stop();
        httpBrowser.stop();
        bonjour.destroy();
      } catch {
        // ignore cleanup errors
      }
      resolve(endpoints);
    }, timeoutMs);
  });
}

/**
 * Get the best Ollama base URL: explicit env var first, then auto-discovery.
 * Returns undefined if no Ollama server is found.
 */
export async function resolveOllamaBaseUrl(): Promise<string | undefined> {
  // Explicit config always wins
  const envUrl = process.env.OLLAMA_BASE_URL;
  if (envUrl) return envUrl;

  // Try auto-discovery
  const endpoints = await discoverOllamaEndpoints();
  if (endpoints.length > 0) {
    return endpoints[0].baseUrl;
  }

  return undefined;
}

/**
 * Return true if a model string is an Ollama reference (prefixed with `ollama/`).
 */
export function isOllamaModel(model: string): boolean {
  return typeof model === 'string' && model.startsWith('ollama/');
}

/**
 * Strip the `ollama/` prefix to get the model name as the Ollama server knows it.
 */
export function getOllamaModelName(model: string): string {
  return model.replace(/^ollama\//, '');
}
