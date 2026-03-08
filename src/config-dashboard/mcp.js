/**
 * MCP Intelligence Servers — Dashboard Tab
 *
 * Lets users view, enable, disable, and set up MCP servers
 * from the web dashboard. No JSON editing required.
 */

// ── State ────────────────────────────────────────────────────
let mcpServers = [];
let selectedMcpServer = null;
let chatProviderConfig = null; // { provider, model, available[] }

// ── API ──────────────────────────────────────────────────────

async function fetchMcpServers() {
  var res = await fetch('/api/mcp/servers');
  if (!res.ok) throw new Error('Failed to fetch MCP servers');
  var data = await res.json();
  return data.servers || [];
}

async function fetchChatProvider() {
  var res = await fetch('/api/mcp/chat-provider');
  if (!res.ok) throw new Error('Failed to fetch chat provider');
  return res.json();
}

async function saveChatProvider(provider, model) {
  var res = await fetch('/api/mcp/chat-provider', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: provider, model: model || '' }),
  });
  return res.json();
}

async function mcpEnable(name) {
  var res = await fetch('/api/mcp/servers/' + encodeURIComponent(name) + '/enable', {
    method: 'POST',
  });
  return res.json();
}

async function mcpDisable(name) {
  var res = await fetch('/api/mcp/servers/' + encodeURIComponent(name) + '/disable', {
    method: 'POST',
  });
  return res.json();
}

async function mcpReconnect(name) {
  var res = await fetch('/api/mcp/servers/' + encodeURIComponent(name) + '/reconnect', {
    method: 'POST',
  });
  return res.json();
}

// ── Render ───────────────────────────────────────────────────

function renderMcpSidebar() {
  var list = document.getElementById('mcp-list');
  if (!list) return;

  var html = '';
  html += '<div style="padding:0.75rem;display:flex;justify-content:space-between;align-items:center;">';
  html += '<span style="font-weight:600;color:#e2e8f0;font-size:0.82rem;">Servers</span>';
  html += '<button id="mcp-refresh-btn" style="font-size:0.7rem;padding:0.25rem 0.5rem;background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.1);border-radius:4px;cursor:pointer;">Refresh</button>';
  html += '</div>';

  if (mcpServers.length === 0) {
    html += '<div style="padding:1rem;color:#64748b;font-size:0.78rem;">Loading...</div>';
  } else {
    for (var i = 0; i < mcpServers.length; i++) {
      var s = mcpServers[i];
      var isActive = selectedMcpServer === s.name;
      var dotColor = s.status === 'connected' ? '#10b981' : s.status === 'failed' ? '#ef4444' : s.enabled ? '#f59e0b' : '#475569';

      html += '<div class="ext-item' + (isActive ? ' active' : '') + '" data-mcp-name="' + escAttr(s.name) + '">';
      html += '<div style="display:flex;align-items:center;gap:6px;">';
      html += '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;"></span>';
      html += '<span class="ext-item-name">' + escHtml(s.displayName) + '</span>';
      html += '</div>';
      html += '<div class="ext-item-meta">' + escHtml(s.description) + '</div>';
      html += '<div class="ext-item-badges">';
      if (s.status === 'connected') {
        html += '<span class="badge badge-ok">' + s.toolCount + ' tools</span>';
      } else if (s.status === 'failed') {
        html += '<span class="badge badge-missing">Failed</span>';
      } else if (s.enabled) {
        html += '<span class="badge badge-partial">Enabled</span>';
      } else {
        html += '<span class="badge" style="background:rgba(71,85,105,0.3);color:#64748b;">Disabled</span>';
      }
      html += '</div>';
      html += '</div>';
    }
  }

  list.innerHTML = html;

  // Bind events
  list.querySelectorAll('.ext-item[data-mcp-name]').forEach(function(el) {
    el.addEventListener('click', function() {
      selectedMcpServer = el.dataset.mcpName;
      renderMcpSidebar();
      renderMcpMain();
    });
  });

  var refreshBtn = document.getElementById('mcp-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function() {
      refreshBtn.textContent = '...';
      mcpServers = await fetchMcpServers();
      renderMcpSidebar();
      renderMcpMain();
    });
  }
}

function renderMcpMain() {
  var main = document.getElementById('main');
  if (!main) return;

  // No server selected — show overview
  if (!selectedMcpServer) {
    renderMcpOverview(main);
    return;
  }

  var server = mcpServers.find(function(s) { return s.name === selectedMcpServer; });
  if (!server) {
    renderMcpOverview(main);
    return;
  }

  renderMcpDetail(main, server);
}

function renderMcpOverview(main) {
  var connected = mcpServers.filter(function(s) { return s.status === 'connected'; });
  var failed = mcpServers.filter(function(s) { return s.status === 'failed'; });
  var totalTools = connected.reduce(function(sum, s) { return sum + (s.toolCount || 0); }, 0);

  var html = '';
  html += '<div class="ext-header">';
  html += '<h2>MCP Intelligence Servers</h2>';
  html += '<div class="ext-header-meta">Connect AI-powered tools to extend Woodbury\'s capabilities</div>';
  html += '</div>';

  // Status summary
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem;">';

  html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;">';
  html += '<div style="font-size:2rem;font-weight:700;color:#10b981;">' + connected.length + '</div>';
  html += '<div style="font-size:0.8rem;color:#64748b;">Connected</div>';
  html += '</div>';

  html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;">';
  html += '<div style="font-size:2rem;font-weight:700;color:#7c3aed;">' + totalTools + '</div>';
  html += '<div style="font-size:0.8rem;color:#64748b;">Tools Available</div>';
  html += '</div>';

  if (failed.length > 0) {
    html += '<div style="background:#1e293b;border:1px solid #ef444444;border-radius:8px;padding:1.25rem;">';
    html += '<div style="font-size:2rem;font-weight:700;color:#ef4444;">' + failed.length + '</div>';
    html += '<div style="font-size:0.8rem;color:#64748b;">Failed</div>';
    html += '</div>';
  }

  html += '</div>';

  // Chat Provider selector
  html += renderChatProviderSection();

  // Server cards
  html += '<div style="font-size:1.1rem;font-weight:600;color:#e2e8f0;margin-bottom:1rem;">MCP Tool Servers</div>';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem;">';
  for (var i = 0; i < mcpServers.length; i++) {
    var s = mcpServers[i];
    html += renderMcpCard(s);
  }
  html += '</div>';

  main.innerHTML = html;

  // Bind card buttons
  main.querySelectorAll('[data-mcp-action]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleMcpAction(btn.dataset.mcpAction, btn.dataset.mcpServer);
    });
  });

  main.querySelectorAll('[data-mcp-select]').forEach(function(el) {
    el.addEventListener('click', function() {
      selectedMcpServer = el.dataset.mcpSelect;
      renderMcpSidebar();
      renderMcpMain();
    });
  });

  // Bind provider selector
  bindProviderSelector(main);
}

function renderMcpCard(server) {
  var borderColor = server.status === 'connected' ? '#10b98144' : server.status === 'failed' ? '#ef444444' : '#334155';
  var statusColor = server.status === 'connected' ? '#10b981' : server.status === 'failed' ? '#ef4444' : server.enabled ? '#f59e0b' : '#64748b';
  var statusLabel = server.status === 'connected' ? 'Connected' : server.status === 'failed' ? 'Failed' : server.enabled ? 'Enabled' : 'Disabled';
  var catLabel = server.category === 'ai-agent' ? 'AI Agent' : server.category === 'intelligence' ? 'Intelligence' : 'Tools';

  var html = '';
  html += '<div data-mcp-select="' + escAttr(server.name) + '" style="background:#1e293b;border:1px solid ' + borderColor + ';border-radius:8px;padding:1.25rem;cursor:pointer;transition:border-color 0.15s;">';

  // Header
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">';
  html += '<div>';
  html += '<div style="font-size:1rem;font-weight:600;color:#e2e8f0;">' + escHtml(server.displayName) + '</div>';
  html += '<div style="font-size:0.7rem;color:#64748b;margin-top:2px;">' + escHtml(catLabel) + '</div>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:6px;">';
  html += '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor + ';"></span>';
  html += '<span style="font-size:0.75rem;color:' + statusColor + ';">' + statusLabel + '</span>';
  html += '</div>';
  html += '</div>';

  // Description
  html += '<div style="font-size:0.8rem;color:#94a3b8;margin-bottom:1rem;line-height:1.4;">' + escHtml(server.description) + '</div>';

  // Tools info
  if (server.status === 'connected' && server.toolCount > 0) {
    html += '<div style="font-size:0.75rem;color:#64748b;margin-bottom:0.75rem;">' + server.toolCount + ' tools available</div>';
  }

  // Action button
  html += '<div style="display:flex;gap:0.5rem;">';
  if (server.status === 'connected') {
    html += '<button data-mcp-action="disable" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:transparent;color:#ef4444;border:1px solid #ef444444;border-radius:6px;cursor:pointer;font-size:0.78rem;">Disable</button>';
    html += '<button data-mcp-action="reconnect" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;font-size:0.78rem;">Reconnect</button>';
  } else if (server.status === 'failed') {
    html += '<button data-mcp-action="reconnect" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.78rem;">Retry</button>';
    html += '<button data-mcp-action="disable" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;cursor:pointer;font-size:0.78rem;">Disable</button>';
  } else if (server.enabled) {
    html += '<button data-mcp-action="disable" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:transparent;color:#f59e0b;border:1px solid #f59e0b44;border-radius:6px;cursor:pointer;font-size:0.78rem;">Disable</button>';
  } else {
    html += '<button data-mcp-action="enable" data-mcp-server="' + escAttr(server.name) + '" style="flex:1;padding:0.5rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.78rem;">Enable</button>';
  }
  html += '</div>';

  html += '</div>';
  return html;
}

function renderMcpDetail(main, server) {
  var statusColor = server.status === 'connected' ? '#10b981' : server.status === 'failed' ? '#ef4444' : server.enabled ? '#f59e0b' : '#64748b';
  var statusLabel = server.status === 'connected' ? 'Connected' : server.status === 'failed' ? 'Failed' : server.enabled ? 'Enabled' : 'Disabled';

  var html = '';
  html += '<div class="ext-header">';
  html += '<div style="display:flex;align-items:center;gap:0.75rem;">';
  html += '<button id="mcp-back-btn" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:1.2rem;padding:0.25rem;" title="Back">&larr;</button>';
  html += '<div>';
  html += '<h2>' + escHtml(server.displayName) + '</h2>';
  html += '<div class="ext-header-meta">' + escHtml(server.description) + '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // Status card
  html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:1.5rem;">';
  html += '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">';
  html += '<span style="width:12px;height:12px;border-radius:50%;background:' + statusColor + ';"></span>';
  html += '<span style="font-size:1rem;font-weight:600;color:' + statusColor + ';">' + statusLabel + '</span>';
  html += '</div>';

  if (server.status === 'connected' && server.toolCount > 0) {
    html += '<div style="font-size:0.85rem;color:#94a3b8;margin-bottom:0.5rem;">' + server.toolCount + ' tools registered</div>';
  }

  if (server.status === 'failed' && server.failureReason) {
    html += '<div style="background:#ef444422;border:1px solid #ef444444;border-radius:6px;padding:0.75rem;margin-bottom:0.75rem;">';
    html += '<div style="font-size:0.75rem;color:#ef4444;font-weight:600;margin-bottom:0.25rem;">Error</div>';
    html += '<div style="font-size:0.8rem;color:#fca5a5;">' + escHtml(server.failureReason) + '</div>';
    html += '</div>';
  }

  // Action buttons
  html += '<div style="display:flex;gap:0.5rem;margin-top:1rem;">';
  if (server.enabled) {
    html += '<button data-mcp-action="disable" data-mcp-server="' + escAttr(server.name) + '" style="padding:0.5rem 1.25rem;background:transparent;color:#ef4444;border:1px solid #ef444444;border-radius:6px;cursor:pointer;font-size:0.8rem;">Disable</button>';
    html += '<button data-mcp-action="reconnect" data-mcp-server="' + escAttr(server.name) + '" style="padding:0.5rem 1.25rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;">Reconnect</button>';
  } else {
    html += '<button data-mcp-action="enable" data-mcp-server="' + escAttr(server.name) + '" style="padding:0.5rem 1.25rem;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.8rem;">Enable</button>';
  }
  html += '</div>';
  html += '</div>';

  // Availability check
  if (server.availability) {
    html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:1.5rem;">';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#e2e8f0;margin-bottom:0.75rem;">Requirements</div>';
    if (server.availability.available) {
      html += '<div style="display:flex;align-items:center;gap:0.5rem;color:#10b981;font-size:0.85rem;">';
      html += '<span style="font-size:1.1rem;">&#x2713;</span> All requirements met';
      html += '</div>';
    } else {
      for (var m = 0; m < server.availability.missing.length; m++) {
        html += '<div style="display:flex;align-items:center;gap:0.5rem;color:#ef4444;font-size:0.85rem;margin-bottom:0.4rem;">';
        html += '<span style="font-size:1.1rem;">&#x2717;</span> ' + escHtml(server.availability.missing[m]);
        html += '</div>';
      }
    }
    html += '</div>';
  }

  // Setup guide
  if (server.setupGuide && server.setupGuide.length > 0) {
    html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:1.5rem;">';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#e2e8f0;margin-bottom:0.75rem;">Setup Guide</div>';
    for (var g = 0; g < server.setupGuide.length; g++) {
      var line = server.setupGuide[g];
      if (line === '') {
        html += '<div style="height:0.5rem;"></div>';
      } else if (line.match(/^\d+\./)) {
        html += '<div style="font-size:0.85rem;color:#7c3aed;font-weight:600;margin-top:0.5rem;">' + escHtml(line) + '</div>';
      } else if (line.startsWith('   ')) {
        html += '<div style="font-size:0.8rem;color:#94a3b8;font-family:monospace;margin-left:1rem;">' + escHtml(line.trim()) + '</div>';
      } else {
        html += '<div style="font-size:0.8rem;color:#94a3b8;">' + escHtml(line) + '</div>';
      }
    }
    html += '</div>';
  }

  // Connected tools list
  if (server.status === 'connected' && server.toolNames && server.toolNames.length > 0) {
    html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;">';
    html += '<div style="font-size:0.9rem;font-weight:600;color:#e2e8f0;margin-bottom:0.75rem;">Available Tools (' + server.toolNames.length + ')</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:0.4rem;">';
    for (var t = 0; t < server.toolNames.length; t++) {
      var toolName = server.toolNames[t];
      // Strip the mcp__serverName__ prefix for readability
      var shortName = toolName.replace(/^mcp__[^_]+__/, '');
      html += '<div style="font-size:0.78rem;color:#94a3b8;padding:0.35rem 0.5rem;background:#0f172a;border-radius:4px;font-family:monospace;">' + escHtml(shortName) + '</div>';
    }
    html += '</div>';
    html += '</div>';
  }

  main.innerHTML = html;

  // Bind events
  var backBtn = document.getElementById('mcp-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', function() {
      selectedMcpServer = null;
      renderMcpSidebar();
      renderMcpMain();
    });
  }

  main.querySelectorAll('[data-mcp-action]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleMcpAction(btn.dataset.mcpAction, btn.dataset.mcpServer);
    });
  });
}

// ── Actions ──────────────────────────────────────────────────

async function handleMcpAction(action, serverName) {
  try {
    var result;
    if (action === 'enable') {
      result = await mcpEnable(serverName);
      if (result.error) {
        toast(result.error, 'error');
      } else {
        toast(result.message || 'Enabled', 'success');
      }
    } else if (action === 'disable') {
      result = await mcpDisable(serverName);
      toast(result.message || 'Disabled', 'success');
    } else if (action === 'reconnect') {
      toast('Reconnecting...', 'info');
      result = await mcpReconnect(serverName);
      if (result.error) {
        toast(result.error, 'error');
      } else {
        toast(result.message || 'Reconnected', 'success');
      }
    }

    // Refresh state
    mcpServers = await fetchMcpServers();
    renderMcpSidebar();
    renderMcpMain();
  } catch (err) {
    toast('Action failed: ' + err.message, 'error');
  }
}

// ── Chat Provider ────────────────────────────────────────────

function renderChatProviderSection() {
  if (!chatProviderConfig) {
    return '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:2rem;">' +
      '<div style="font-size:1rem;font-weight:600;color:#e2e8f0;margin-bottom:0.5rem;">Chat Provider</div>' +
      '<div style="color:#64748b;font-size:0.8rem;">Loading...</div></div>';
  }

  var current = chatProviderConfig.provider || 'auto';
  var available = chatProviderConfig.available || [];

  var html = '';
  html += '<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem;margin-bottom:2rem;">';
  html += '<div style="font-size:1rem;font-weight:600;color:#e2e8f0;margin-bottom:0.25rem;">Chat Provider</div>';
  html += '<div style="font-size:0.78rem;color:#64748b;margin-bottom:1rem;">Choose which AI model powers the chat</div>';

  // Provider cards
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0.75rem;">';

  // Auto option
  var autoActive = current === 'auto';
  var autoBorder = autoActive ? '#7c3aed' : '#334155';
  var autoBg = autoActive ? 'rgba(124,58,237,0.1)' : 'transparent';
  html += '<div class="provider-option" data-provider="auto" style="background:' + autoBg + ';border:2px solid ' + autoBorder + ';border-radius:8px;padding:1rem;cursor:pointer;transition:all 0.15s;">';
  html += '<div style="font-size:0.85rem;font-weight:600;color:#e2e8f0;">Auto-detect</div>';
  html += '<div style="font-size:0.72rem;color:#64748b;margin-top:0.25rem;">Uses first available API key</div>';
  if (autoActive) html += '<div style="font-size:0.7rem;color:#7c3aed;margin-top:0.5rem;font-weight:600;">Active</div>';
  html += '</div>';

  // Provider options
  for (var i = 0; i < available.length; i++) {
    var p = available[i];
    var isActive = current === p.id;
    var borderCol = isActive ? '#7c3aed' : '#334155';
    var bgCol = isActive ? 'rgba(124,58,237,0.1)' : 'transparent';
    var opacity = p.hasKey ? '1' : '0.5';

    html += '<div class="provider-option" data-provider="' + escAttr(p.id) + '" style="background:' + bgCol + ';border:2px solid ' + borderCol + ';border-radius:8px;padding:1rem;cursor:pointer;transition:all 0.15s;opacity:' + opacity + ';">';
    html += '<div style="font-size:0.85rem;font-weight:600;color:#e2e8f0;">' + escHtml(p.name) + '</div>';
    html += '<div style="font-size:0.72rem;color:#64748b;margin-top:0.25rem;">' + escHtml(p.defaultModel) + '</div>';

    if (!p.hasKey) {
      html += '<div style="font-size:0.7rem;color:#ef4444;margin-top:0.5rem;">API key not set</div>';
    } else if (isActive) {
      html += '<div style="font-size:0.7rem;color:#7c3aed;margin-top:0.5rem;font-weight:600;">Active</div>';
    } else {
      html += '<div style="font-size:0.7rem;color:#10b981;margin-top:0.5rem;">Ready</div>';
    }

    html += '</div>';
  }

  html += '</div>';
  html += '</div>';
  return html;
}

function bindProviderSelector(container) {
  container.querySelectorAll('.provider-option').forEach(function(el) {
    el.addEventListener('click', async function() {
      var provider = el.dataset.provider;

      // Check if this provider has an API key (unless it's auto)
      if (provider !== 'auto' && chatProviderConfig) {
        var p = chatProviderConfig.available.find(function(a) { return a.id === provider; });
        if (p && !p.hasKey) {
          toast('Set the API key first (check your .env file)', 'error');
          return;
        }
      }

      try {
        var result = await saveChatProvider(provider, '');
        if (result.error) {
          toast(result.error, 'error');
        } else {
          toast(result.message || 'Provider updated', 'success');
          chatProviderConfig = await fetchChatProvider();
          renderMcpMain();
        }
      } catch (err) {
        toast('Failed to save: ' + err.message, 'error');
      }
    });
  });
}

// ── Init ─────────────────────────────────────────────────────

async function initMcp() {
  renderMcpSidebar();

  try {
    var results = await Promise.all([
      fetchMcpServers().catch(function() { return []; }),
      fetchChatProvider().catch(function() { return null; }),
    ]);
    mcpServers = results[0];
    chatProviderConfig = results[1];
  } catch (err) {
    mcpServers = [];
  }

  renderMcpSidebar();
  renderMcpMain();
}
