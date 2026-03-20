/**
 * Shared API helpers for the pipeline app.
 * Extracted from compositions-app.js for use in React components.
 */

const enc = encodeURIComponent;

export async function fetchAppSchema(pipelineId: string) {
  const res = await fetch(`/api/app/${enc(pipelineId)}/schema`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchAppState(pipelineId: string) {
  const res = await fetch(`/api/app/${enc(pipelineId)}/state`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchAppNodeData(pipelineId: string, nodeId: string) {
  const res = await fetch(`/api/app/${enc(pipelineId)}/node/${enc(nodeId)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveAppNodeState(pipelineId: string, nodeId: string, outputs: any) {
  const res = await fetch(`/api/app/${enc(pipelineId)}/state/${enc(nodeId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputs }),
  });
  if (!res.ok) throw new Error('Failed to save');
  return res.json();
}

export async function fetchAppBindings(pipelineId: string) {
  try {
    const res = await fetch(`/api/app/${enc(pipelineId)}/bindings`);
    if (!res.ok) return { version: '1.0', pipelineId, bindings: [] };
    return res.json();
  } catch {
    return { version: '1.0', pipelineId, bindings: [] };
  }
}

export async function createAppBinding(pipelineId: string, binding: any) {
  const res = await fetch(`/api/compositions/${enc(pipelineId)}/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(binding),
  });
  if (!res.ok) throw new Error('Failed to create binding');
  return res.json();
}

export async function deleteAppBinding(pipelineId: string, bindingId: string) {
  const res = await fetch(`/api/compositions/${enc(pipelineId)}/bindings/${enc(bindingId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete binding');
  return res.json();
}

export async function refreshAppFromRun(pipelineId: string) {
  const res = await fetch(`/api/app/${enc(pipelineId)}/refresh-from-run`, { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Load pipeline-local custom views.
 * Discovers views from the server, loads their JS/CSS dynamically.
 */
export async function loadPipelineCustomViews(pipelineId: string): Promise<any[]> {
  try {
    const res = await fetch(`/api/app/${enc(pipelineId)}/views`);
    if (!res.ok) return [];
    const data = await res.json();
    const views = data.views || [];
    if (views.length === 0) return [];

    // Load CSS (scoped)
    for (const v of views) {
      if (v.hasCSS) {
        const cssId = `pipeline-view-css-${v.name}`;
        if (document.getElementById(cssId)) continue;
        try {
          const cssRes = await fetch(`/api/app/${enc(pipelineId)}/view-file/${enc(v.name)}/view.css`);
          const css = await cssRes.text();
          const scope = `.pipeline-view-scope[data-pipeline-view="${v.name}"]`;
          const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
          let scoped = '';
          let depth = 0;
          let buf = '';
          let inRule = false;
          for (let i = 0; i < stripped.length; i++) {
            const ch = stripped[i];
            if (ch === '{') {
              if (depth === 0) {
                const sels = buf.split(',').map(s => {
                  s = s.trim();
                  if (!s || s.startsWith('@')) return s;
                  return `${scope} ${s}`;
                }).join(', ');
                scoped += `${sels} {`;
                buf = '';
                inRule = true;
              } else {
                scoped += ch;
              }
              depth++;
            } else if (ch === '}') {
              depth--;
              if (depth <= 0) {
                scoped += `${buf}}`;
                buf = '';
                inRule = false;
                depth = 0;
              } else {
                scoped += ch;
              }
            } else {
              buf += ch;
            }
          }
          const style = document.createElement('style');
          style.id = cssId;
          style.textContent = scoped;
          document.head.appendChild(style);
        } catch {}
      }
    }

    // Load JS
    await Promise.all(views.map((v: any) => new Promise<void>(resolve => {
      const scriptId = `pipeline-view-js-${v.name}`;
      if (document.getElementById(scriptId)) { resolve(); return; }
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = `/api/app/${enc(pipelineId)}/view-file/${enc(v.name)}/view.js`;
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.body.appendChild(script);
    })));

    return views;
  } catch {
    return [];
  }
}

/** Hash-based character color (for dialogue edit modal, etc.) */
export function charColor(name: string): string {
  const colors = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d19a66'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}
