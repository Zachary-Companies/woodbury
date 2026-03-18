/**
 * Voices — ElevenLabs Voice Browser
 *
 * Browse, search, filter, and preview ElevenLabs voices.
 * Voices are fetched from /api/elevenlabs/voices and previewed via audio playback.
 */

/* global $, switchTab */

let voicesData = [];
let voicesLoaded = false;
let currentAudio = null;
let currentPlayBtn = null;
let voiceSearchTimeout = null;

function initVoices() {
  const main = $('#main');
  main.innerHTML = `
    <div style="max-width:960px;margin:0 auto;padding:1.5rem;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.2rem;">
        <div>
          <h2 style="font-size:1.2rem;font-weight:600;color:#f1f5f9;margin:0;">Voice Browser</h2>
          <p style="font-size:0.75rem;color:#64748b;margin:4px 0 0;">Browse and preview ElevenLabs voices</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="voice-search" placeholder="Search voices..."
            style="padding:6px 12px;background:#1e2433;border:1px solid #2d3748;border-radius:6px;color:#e2e8f0;font-size:0.78rem;width:220px;outline:none;" />
          <select id="voice-category" style="padding:6px 10px;background:#1e2433;border:1px solid #2d3748;border-radius:6px;color:#e2e8f0;font-size:0.78rem;outline:none;">
            <option value="">All Categories</option>
            <option value="premade">Premade</option>
            <option value="cloned">Cloned</option>
            <option value="generated">Generated</option>
            <option value="professional">Professional</option>
          </select>
          <button id="voice-refresh-btn" style="padding:6px 12px;background:#7c3aed;color:#fff;border:none;border-radius:6px;font-size:0.75rem;cursor:pointer;">Refresh</button>
        </div>
      </div>
      <div id="voices-status" style="font-size:0.75rem;color:#64748b;margin-bottom:0.8rem;"></div>
      <div id="voices-grid"></div>
    </div>
  `;

  document.getElementById('voice-search').addEventListener('input', () => {
    clearTimeout(voiceSearchTimeout);
    voiceSearchTimeout = setTimeout(renderVoiceGrid, 200);
  });
  document.getElementById('voice-category').addEventListener('change', renderVoiceGrid);
  document.getElementById('voice-refresh-btn').addEventListener('click', () => {
    voicesLoaded = false;
    loadVoices();
  });

  loadVoices();
}

async function loadVoices() {
  const grid = document.getElementById('voices-grid');
  const status = document.getElementById('voices-status');
  if (!grid) return;

  if (voicesLoaded && voicesData.length > 0) {
    renderVoiceGrid();
    return;
  }

  grid.innerHTML = '<div style="text-align:center;padding:3rem;color:#64748b;"><div class="spinner" style="margin:0 auto 1rem;"></div>Loading voices from ElevenLabs...</div>';
  status.textContent = '';

  try {
    const res = await fetch('/api/elevenlabs/voices');
    const data = await res.json();

    if (!res.ok || data.error) {
      grid.innerHTML = `<div style="text-align:center;padding:3rem;">
        <div style="color:#f87171;font-size:0.85rem;margin-bottom:0.5rem;">${data.error || 'Failed to load voices'}</div>
        <div style="color:#64748b;font-size:0.75rem;">Make sure ELEVENLABS_API_KEY is set in Model &rarr; API Keys with <code>voices_read</code> permission.</div>
      </div>`;
      return;
    }

    voicesData = data.voices || [];
    voicesLoaded = true;
    status.textContent = `${voicesData.length} voices available`;
    renderVoiceGrid();
  } catch (err) {
    grid.innerHTML = `<div style="text-align:center;padding:3rem;color:#f87171;">${err.message}</div>`;
  }
}

function renderVoiceGrid() {
  const grid = document.getElementById('voices-grid');
  const status = document.getElementById('voices-status');
  if (!grid) return;

  const searchTerm = (document.getElementById('voice-search')?.value || '').toLowerCase();
  const category = document.getElementById('voice-category')?.value || '';

  let filtered = voicesData;

  if (category) {
    filtered = filtered.filter(v => v.category === category);
  }

  if (searchTerm) {
    filtered = filtered.filter(v => {
      const haystack = [
        v.name,
        v.description || '',
        v.category || '',
        ...Object.values(v.labels || {}),
      ].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  status.textContent = `${filtered.length} of ${voicesData.length} voices`;

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="text-align:center;padding:3rem;color:#64748b;">No voices match your search.</div>';
    return;
  }

  grid.innerHTML = filtered.map((v, idx) => {
    const labels = v.labels ? Object.entries(v.labels).map(([k, val]) => val).filter(Boolean) : [];
    const labelBadges = labels.slice(0, 4).map(l =>
      `<span style="display:inline-block;padding:1px 6px;background:rgba(124,58,237,0.12);color:#a78bfa;border:1px solid rgba(124,58,237,0.2);border-radius:3px;font-size:0.62rem;white-space:nowrap;">${escHtml(l)}</span>`
    ).join(' ');
    const categoryColor = {
      premade: '#60a5fa',
      cloned: '#34d399',
      generated: '#fbbf24',
      professional: '#f472b6',
    }[v.category] || '#94a3b8';

    return `<div class="voice-card" data-idx="${idx}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#161b26;border:1px solid #1e2937;border-radius:8px;margin-bottom:6px;transition:border-color 0.15s;">
      <button class="voice-play-btn" data-preview="${escAttr(v.preview_url || '')}" data-vid="${escAttr(v.voice_id)}"
        style="width:36px;height:36px;min-width:36px;border-radius:50%;border:1.5px solid #2d3748;background:#0f1117;color:#e2e8f0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;flex-shrink:0;"
        title="Play preview">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
          <span style="font-size:0.82rem;font-weight:500;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(v.name)}</span>
          <span style="font-size:0.6rem;color:${categoryColor};background:${categoryColor}15;border:1px solid ${categoryColor}30;padding:1px 5px;border-radius:3px;white-space:nowrap;">${escHtml(v.category || 'unknown')}</span>
        </div>
        ${v.description ? `<div style="font-size:0.7rem;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;">${escHtml(v.description)}</div>` : ''}
        <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
          ${labelBadges}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
        <button class="voice-copy-btn" data-vid="${escAttr(v.voice_id)}"
          style="padding:3px 8px;background:#1e2433;border:1px solid #2d3748;border-radius:4px;color:#94a3b8;font-size:0.62rem;cursor:pointer;white-space:nowrap;font-family:'SF Mono','Fira Code',monospace;transition:all 0.15s;"
          title="Copy voice ID">${escHtml(v.voice_id)}</button>
        <button class="voice-use-btn" data-vid="${escAttr(v.voice_id)}" data-vname="${escAttr(v.name)}"
          style="padding:3px 10px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);border-radius:4px;color:#6ee7b7;font-size:0.65rem;cursor:pointer;white-space:nowrap;transition:all 0.15s;">Set as Default</button>
      </div>
    </div>`;
  }).join('');

  // Attach event listeners
  grid.querySelectorAll('.voice-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playVoicePreview(btn);
    });
  });

  grid.querySelectorAll('.voice-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      navigator.clipboard.writeText(vid).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.color = '#6ee7b7';
        setTimeout(() => { btn.textContent = orig; btn.style.color = '#94a3b8'; }, 1200);
      });
    });
  });

  grid.querySelectorAll('.voice-use-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      const vname = btn.dataset.vname;
      try {
        const res = await fetch('/api/elevenlabs/default-voice', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice_id: vid }),
        });
        if (res.ok) {
          btn.textContent = 'Default!';
          btn.style.background = 'rgba(16,185,129,0.25)';
          // Reset other buttons
          grid.querySelectorAll('.voice-use-btn').forEach(b => {
            if (b !== btn) { b.textContent = 'Set as Default'; b.style.background = 'rgba(16,185,129,0.1)'; }
          });
          setTimeout(() => { btn.textContent = 'Default'; }, 2000);
        }
      } catch { /* ignore */ }
    });
  });
}

function playVoicePreview(btn) {
  const previewUrl = btn.dataset.preview;
  if (!previewUrl) {
    // No preview URL — try generating a quick sample via the API
    btn.style.color = '#f87171';
    setTimeout(() => { btn.style.color = '#e2e8f0'; }, 1000);
    return;
  }

  // If currently playing this voice, stop it
  if (currentAudio && currentPlayBtn === btn) {
    currentAudio.pause();
    currentAudio = null;
    currentPlayBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    currentPlayBtn.style.borderColor = '#2d3748';
    currentPlayBtn.style.color = '#e2e8f0';
    currentPlayBtn = null;
    return;
  }

  // Stop any currently playing audio
  if (currentAudio) {
    currentAudio.pause();
    if (currentPlayBtn) {
      currentPlayBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      currentPlayBtn.style.borderColor = '#2d3748';
      currentPlayBtn.style.color = '#e2e8f0';
    }
  }

  // Play new preview
  currentAudio = new Audio(previewUrl);
  currentPlayBtn = btn;

  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  btn.style.borderColor = '#7c3aed';
  btn.style.color = '#a78bfa';

  currentAudio.addEventListener('ended', () => {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    btn.style.borderColor = '#2d3748';
    btn.style.color = '#e2e8f0';
    currentAudio = null;
    currentPlayBtn = null;
  });

  currentAudio.addEventListener('error', () => {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    btn.style.borderColor = '#f87171';
    btn.style.color = '#f87171';
    setTimeout(() => { btn.style.borderColor = '#2d3748'; btn.style.color = '#e2e8f0'; }, 1500);
    currentAudio = null;
    currentPlayBtn = null;
  });

  currentAudio.play().catch(() => {
    btn.style.color = '#f87171';
    setTimeout(() => { btn.style.color = '#e2e8f0'; }, 1000);
  });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
