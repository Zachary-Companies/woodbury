// ── Chat Tab ──────────────────────────────────────────────────
// Conversational agent interface with live pipeline graph panel.
// Sends messages to POST /api/chat (SSE), streams tokens and tool
// events, and re-renders the graph when compositions change.
// Sessions are persisted to the server so they survive tab switches.

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var chatHistory = [];           // { role: 'user'|'assistant', content: string }[]
  var activeCompositionId = null;  // pipeline currently shown in graph panel
  var isSending = false;
  var abortController = null;
  var chatInitialized = false;

  // ── Markdown Rendering ────────────────────────────────────
  // Configure marked for safe, minimal rendering
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,       // Convert \n to <br>
      gfm: true,          // GitHub-flavored markdown
    });
  }

  /**
   * Render markdown text to HTML safely.
   * Falls back to textContent if marked is not loaded.
   */
  function renderMarkdown(el, text) {
    if (typeof marked !== 'undefined' && text && text.trim()) {
      try {
        el.innerHTML = marked.parse(text);
        el.classList.add('markdown-rendered');
        // Open links in new tab
        var links = el.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          links[i].setAttribute('target', '_blank');
          links[i].setAttribute('rel', 'noopener');
        }
        return;
      } catch (e) {
        // Fall through to textContent
      }
    }
    el.textContent = text || '';
    el.classList.remove('markdown-rendered');
  }

  // Session persistence
  var currentSessionId = null;
  var sessionCreatedAt = null;
  var sessionList = [];           // [{ id, title, messageCount, updatedAt }]
  var taskPanelState = createTaskPanelState();

  // Graph state (subset of compositions.js state for the read-only graph view)
  var graphData = null;            // CompositionDocument { nodes, edges, ... }
  var graphPanX = 0, graphPanY = 0, graphZoom = 1;

  function createTaskPanelState() {
    return {
      phase: 'idle',
      sessionSummary: '',
      summaryTurnCount: 0,
      selectedSkill: null,
      allowedTools: [],
      skillHandoff: null,
      skillTransitions: [],
      recoveryEvents: [],
      skillPolicyUpdates: [],
      tasks: {},
      taskOrder: [],
      verifications: [],
      reflections: [],
      beliefs: [],
      activeCompositionId: null
    };
  }

  function resetTaskPanelState() {
    taskPanelState = createTaskPanelState();
    renderTaskPanel();
  }

  function loadSkillPolicyUpdates() {
    return fetch('/api/skill-policies')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        taskPanelState.skillPolicyUpdates = data.updates || [];
        renderTaskPanel();
      })
      .catch(function () { /* silent */ });
  }

  function updateSkillPolicy(updateId, body) {
    return fetch('/api/skill-policies/' + encodeURIComponent(updateId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function () {
        return loadSkillPolicyUpdates();
      });
  }

  // ── Session API ─────────────────────────────────────────────

  function generateSessionId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function deriveTitle(history) {
    // Use first user message as title, truncated
    for (var i = 0; i < history.length; i++) {
      if (history[i].role === 'user') {
        var text = history[i].content.trim();
        return text.length > 60 ? text.slice(0, 57) + '...' : text;
      }
    }
    return 'New conversation';
  }

  function saveSession() {
    if (!currentSessionId || chatHistory.length === 0) return;
    var body = {
      title: deriveTitle(chatHistory),
      history: chatHistory,
      activeCompositionId: activeCompositionId,
      engineSessionId: currentSessionId,
      taskPanelState: taskPanelState,
      createdAt: sessionCreatedAt,
    };
    fetch('/api/chat/sessions/' + encodeURIComponent(currentSessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function () {
      refreshSessionList();
    }).catch(function () { /* silent */ });
  }

  function loadSession(sessionId) {
    return fetch('/api/chat/sessions/' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) return;
        currentSessionId = data.id;
        sessionCreatedAt = data.createdAt;
        chatHistory = data.history || [];
        activeCompositionId = data.activeCompositionId || null;
        taskPanelState = data.taskPanelState || createTaskPanelState();
        taskPanelState.sessionSummary = taskPanelState.sessionSummary || data.rollingSummary || '';
        taskPanelState.summaryTurnCount = taskPanelState.summaryTurnCount || data.summaryTurnCount || 0;
        taskPanelState.skillTransitions = taskPanelState.skillTransitions || [];
        taskPanelState.recoveryEvents = taskPanelState.recoveryEvents || [];
        taskPanelState.skillPolicyUpdates = taskPanelState.skillPolicyUpdates || [];
        taskPanelState.activeCompositionId = activeCompositionId;
        graphData = null;
        chatInitialized = false;
        initChat();
        // Re-render existing messages
        renderExistingMessages();
        if (activeCompositionId) refreshGraph(activeCompositionId);
      });
  }

  function deleteSession(sessionId) {
    return fetch('/api/chat/sessions/' + encodeURIComponent(sessionId), {
      method: 'DELETE',
    }).then(function () {
      if (currentSessionId === sessionId) {
        startNewSession();
      }
      refreshSessionList();
    });
  }

  function fetchSessionList() {
    return fetch('/api/chat/sessions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        sessionList = data.sessions || [];
        return sessionList;
      })
      .catch(function () {
        sessionList = [];
        return sessionList;
      });
  }

  function refreshSessionList() {
    fetchSessionList().then(function () {
      renderSessionSidebar();
    });
  }

  function startNewSession() {
    chatHistory = [];
    activeCompositionId = null;
    graphData = null;
    resetTaskPanelState();
    currentSessionId = generateSessionId();
    sessionCreatedAt = new Date().toISOString();
    chatInitialized = false;
    initChat();
  }

  // ── Render Session Sidebar ──────────────────────────────────

  function renderSessionSidebar() {
    var list = document.getElementById('chat-sessions-list');
    if (!list) return;

    if (sessionList.length === 0) {
      list.innerHTML = '<div style="padding:0.5rem;color:#64748b;font-size:0.75rem;">No conversations yet</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < sessionList.length; i++) {
      var s = sessionList[i];
      var isActive = s.id === currentSessionId;
      var age = formatAge(s.updatedAt);
      html += '<div class="ext-item' + (isActive ? ' active' : '') + '" data-session-id="' + escAttr(s.id) + '" style="position:relative;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;">';
      html += '<span class="ext-item-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(s.title) + '</span>';
      html += '<button class="chat-session-delete" data-del-id="' + escAttr(s.id) + '" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:0.7rem;padding:0 0.25rem;flex-shrink:0;" title="Delete">&times;</button>';
      html += '</div>';
      html += '<div class="ext-item-meta">' + s.messageCount + ' messages &middot; ' + age + '</div>';
      html += '</div>';
    }
    list.innerHTML = html;

    // Bind click-to-load
    list.querySelectorAll('.ext-item[data-session-id]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.classList.contains('chat-session-delete')) return;
        loadSession(el.dataset.sessionId);
      });
    });

    // Bind delete buttons
    list.querySelectorAll('.chat-session-delete').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteSession(btn.dataset.delId);
      });
    });
  }

  function formatAge(isoString) {
    if (!isoString) return '';
    var ms = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  // ── Render Existing Messages ────────────────────────────────

  function renderExistingMessages() {
    var messages = document.getElementById('chat-messages');
    if (!messages) return;

    // Clear welcome message
    var welcome = messages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Render all messages from history
    for (var i = 0; i < chatHistory.length; i++) {
      appendMessage(chatHistory[i].role, chatHistory[i].content);
    }
  }

  // ── Init ───────────────────────────────────────────────────

  function initChat() {
    var main = document.getElementById('main');
    if (!main) return;

    // Only inject layout once; re-entering the tab should preserve state
    if (chatInitialized && main.querySelector('.chat-split')) return;

    main.innerHTML = '';
    main.style.display = 'flex';
    main.style.flexDirection = 'column';

    var split = document.createElement('div');
    split.className = 'chat-split';
    split.innerHTML =
      '<div class="chat-panel">' +
        '<div class="chat-panel-header">Woodbury Assistant</div>' +
        '<div class="chat-messages" id="chat-messages">' +
          '<div class="chat-welcome">' +
            '<div class="chat-welcome-title">Hi! I\'m Woodbury.</div>' +
            '<div class="chat-welcome-hint">Tell me what you want to create, automate, or manage. I can build pipelines, generate content, and organize your assets.</div>' +
          '</div>' +
        '</div>' +
        '<div class="chat-input-area">' +
          '<input type="text" class="chat-input" id="chat-input" placeholder="Ask me anything..." autocomplete="off">' +
          '<button class="chat-send-btn" id="chat-send-btn">Send</button>' +
        '</div>' +
      '</div>' +
      '<div class="chat-workspace-panel">' +
        '<div class="chat-workspace-header">Agent Workspace</div>' +
        '<div class="chat-workspace-body">' +
          '<div class="chat-status-bar">' +
            '<div class="chat-status-card"><div class="chat-status-label">Phase</div><div class="chat-status-value" id="chat-status-phase">Idle</div></div>' +
            '<div class="chat-status-card"><div class="chat-status-label">Tasks</div><div class="chat-status-value" id="chat-status-task-count">0</div></div>' +
            '<div class="chat-status-card"><div class="chat-status-label">Checks</div><div class="chat-status-value" id="chat-status-check-count">0</div></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Session Context</div>' +
            '<div class="chat-panel-summary" id="chat-session-summary">No summary yet.</div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Task Execution</div>' +
            '<div class="chat-task-list" id="chat-task-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Verification</div>' +
            '<div class="chat-verification-list" id="chat-verification-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Reflections</div>' +
            '<div class="chat-reflection-list" id="chat-reflection-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Skill Transitions</div>' +
            '<div class="chat-reflection-list" id="chat-skill-transition-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Recovery Events</div>' +
            '<div class="chat-verification-list" id="chat-recovery-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section">' +
            '<div class="chat-panel-section-title">Skill Policy Review</div>' +
            '<div class="chat-task-list" id="chat-skill-policy-list"></div>' +
          '</div>' +
          '<div class="chat-panel-section chat-graph-section">' +
            '<div class="chat-panel-section-title">Pipeline Preview</div>' +
            '<div class="chat-graph-panel" id="chat-graph-panel">' +
              '<svg class="chat-graph-svg" id="chat-graph-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;">' +
                '<g id="chat-graph-edges"></g>' +
              '</svg>' +
              '<div id="chat-graph-nodes" style="position:absolute;top:0;left:0;width:0;height:0;transform-origin:0 0;"></div>' +
              '<div class="chat-graph-empty" id="chat-graph-empty">' +
                '<div class="chat-graph-empty-icon">&#x1f4ca;</div>' +
                '<div>Your pipeline preview will appear here.</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    main.appendChild(split);

    // Wire up input
    var input = document.getElementById('chat-input');
    var sendBtn = document.getElementById('chat-send-btn');

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !isSending) {
        e.preventDefault();
        sendMessage();
      }
    });
    sendBtn.addEventListener('click', function () {
      if (!isSending) sendMessage();
    });

    // Wire up sidebar "New" button
    var newBtn = document.getElementById('chat-new-btn');
    if (newBtn) {
      newBtn.addEventListener('click', function () {
        startNewSession();
      });
    }

    // Ensure we have a session ID
    if (!currentSessionId) {
      currentSessionId = generateSessionId();
      sessionCreatedAt = new Date().toISOString();
    }

    chatInitialized = true;
    renderTaskPanel();

    // Load session list for sidebar
    refreshSessionList();
    loadSkillPolicyUpdates();
  }

  // ── Send Message ───────────────────────────────────────────

  function sendMessage() {
    var input = document.getElementById('chat-input');
    var text = (input.value || '').trim();
    if (!text) return;

    input.value = '';
    appendMessage('user', text);
    chatHistory.push({ role: 'user', content: text });

    isSending = true;
    updateSendButton();

    // Create the assistant message bubble (will be streamed into)
    var assistantBubble = appendMessage('assistant', '');
    var textEl = assistantBubble.querySelector('.chat-msg-text');

    // Add typing indicator
    textEl.innerHTML =
      '<div class="chat-typing">' +
        '<div class="chat-typing-dot"></div>' +
        '<div class="chat-typing-dot"></div>' +
        '<div class="chat-typing-dot"></div>' +
      '</div>';

    var accumulatedText = '';
    var toolPills = [];

    abortController = new AbortController();

    // POST to /api/chat and read SSE stream
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: chatHistory.slice(0, -1),  // exclude current message (it's in message field)
        activeCompositionId: activeCompositionId,
        sessionId: currentSessionId,
      }),
      signal: abortController.signal,
    })
    .then(function (response) {
      if (!response.ok) {
        return response.json().then(function (err) {
          throw new Error(err.error || 'Chat request failed');
        });
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function processStream() {
        return reader.read().then(function (result) {
          if (result.done) return;

          buffer += decoder.decode(result.value, { stream: true });

          // Parse SSE events from buffer
          var lines = buffer.split('\n');
          buffer = '';

          var eventType = null;
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              var dataStr = line.slice(6);
              try {
                var data = JSON.parse(dataStr);
                handleSSEEvent(eventType || 'message', data, textEl, toolPills, function (t) {
                  accumulatedText = t;
                });
              } catch (e) {
                // partial JSON — put back in buffer
                buffer = lines.slice(i).join('\n');
                break;
              }
              eventType = null;
            } else if (line === '') {
              eventType = null;
            } else {
              // Incomplete line — put back in buffer
              buffer = lines.slice(i).join('\n');
              break;
            }
          }

          return processStream();
        });
      }

      return processStream();
    })
    .then(function () {
      finishSend(accumulatedText);
    })
    .catch(function (err) {
      if (err.name === 'AbortError') {
        finishSend(accumulatedText || '(cancelled)');
        return;
      }
      textEl.textContent = 'Error: ' + err.message;
      finishSend('Error: ' + err.message);
    });
  }

  // Strip agent XML markup from streamed text for clean display
  function stripAgentXml(text) {
    // Remove <tool_call>...</tool_call> blocks (including partial/incomplete ones)
    var cleaned = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    // Remove incomplete tool_call blocks at the end (still streaming)
    cleaned = cleaned.replace(/<tool_call>[\s\S]*$/g, '');
    // Remove <final_answer> and </final_answer> wrapper tags but keep content
    cleaned = cleaned.replace(/<\/?final_answer>/g, '');
    // Remove <name>...</name> and <parameters>...</parameters> if they appear outside tool_call
    cleaned = cleaned.replace(/<\/?(?:name|parameters)>/g, '');
    // Clean up excessive blank lines left behind
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  }

  function handleSSEEvent(type, data, textEl, toolPills, setAccumulated) {
    switch (type) {
      case 'token':
        // Remove typing indicator on first token
        var typing = textEl.querySelector('.chat-typing');
        if (typing) {
          textEl.innerHTML = '';
        }
        // Accumulate raw text, display cleaned version
        var currentRaw = textEl._rawText || '';
        currentRaw += data.token;
        textEl._rawText = currentRaw;
        var cleaned = stripAgentXml(currentRaw);
        renderMarkdown(textEl, cleaned);
        setAccumulated(cleaned);
        scrollToBottom();
        break;

      case 'tool_start':
        var pill = document.createElement('div');
        pill.className = 'chat-tool-pill active';
        pill.dataset.toolName = data.name;
        // Header row with chevron + name
        var header = document.createElement('div');
        header.className = 'tool-header';
        var chevron = document.createElement('span');
        chevron.className = 'tool-chevron';
        chevron.textContent = '\u25B6';
        header.appendChild(chevron);
        var nameSpan = document.createElement('span');
        nameSpan.className = 'tool-name';
        nameSpan.textContent = humanizeToolName(data.name);
        header.appendChild(nameSpan);
        pill.appendChild(header);
        // Detail area (hidden until expanded)
        var detail = document.createElement('div');
        detail.className = 'chat-tool-detail';
        if (data.params) {
          var paramLabel = document.createElement('div');
          paramLabel.className = 'tool-label';
          paramLabel.textContent = 'Input';
          detail.appendChild(paramLabel);
          var paramPre = document.createElement('pre');
          paramPre.textContent = typeof data.params === 'string' ? data.params : JSON.stringify(data.params, null, 2);
          detail.appendChild(paramPre);
        }
        pill.appendChild(detail);
        // Toggle expand on click
        pill.addEventListener('click', function () {
          pill.classList.toggle('expanded');
          scrollToBottom();
        });
        // Insert pill before the text content
        var messagesDiv = textEl.parentElement;
        messagesDiv.insertBefore(pill, textEl);
        toolPills.push(pill);
        scrollToBottom();
        break;

      case 'tool_end':
        // Mark the last matching pill as done and add result
        for (var i = toolPills.length - 1; i >= 0; i--) {
          if (toolPills[i].dataset.toolName === data.name && toolPills[i].classList.contains('active')) {
            toolPills[i].classList.remove('active');
            toolPills[i].classList.add(data.success ? 'done' : '');
            var nameEl = toolPills[i].querySelector('.tool-name');
            if (nameEl) {
              var statusIcon = data.success ? ' \u2713' : ' \u2717';
              var durationStr = data.duration ? ' (' + (data.duration / 1000).toFixed(1) + 's)' : '';
              nameEl.textContent = humanizeToolName(data.name) + statusIcon + durationStr;
            }
            // For composition tools, render a pipeline card instead of raw JSON
            var isCompTool = data.name === 'mcp__intelligence__generate_pipeline' ||
              data.name === 'mcp__intelligence__generate_workflow' ||
              data.name === 'mcp__intelligence__compose_tools';
            if (isCompTool && data.success && data.result) {
              try {
                var comp = JSON.parse(data.result);
                if (comp && comp.id && comp.nodes) {
                  var card = document.createElement('div');
                  card.className = 'composition-card';
                  card.innerHTML =
                    '<div class="composition-card-icon">\u26A1</div>' +
                    '<div class="composition-card-body">' +
                      '<div class="composition-card-title">' + escapeHtml(comp.name || comp.id) + '</div>' +
                      '<div class="composition-card-desc">' + escapeHtml(comp.description || '') + '</div>' +
                      '<div class="composition-card-meta">' +
                        (comp.nodes ? comp.nodes.length : 0) + ' nodes \u00B7 ' +
                        (comp.edges ? comp.edges.length : 0) + ' connections' +
                      '</div>' +
                    '</div>' +
                    '<button class="composition-card-btn" data-comp-id="' + escapeHtml(comp.id) + '">View Pipeline \u2192</button>';
                  card.querySelector('.composition-card-btn').addEventListener('click', function () {
                    var compId = this.getAttribute('data-comp-id');
                    // Switch to the full Pipelines tab and open this composition
                    if (typeof switchTab === 'function') {
                      switchTab('compositions');
                      setTimeout(function () {
                        if (typeof selectComposition === 'function') {
                          selectComposition(compId);
                        }
                      }, 300);
                    }
                  });
                  var messagesDiv = textEl.parentElement;
                  messagesDiv.insertBefore(card, textEl);
                  // Also hide the tool pill since we have the card
                  toolPills[i].style.display = 'none';
                  scrollToBottom();
                  break;
                }
              } catch (e) { /* not valid JSON, fall through to normal display */ }
            }
            // Add result to detail area (normal tools)
            var detailEl = toolPills[i].querySelector('.chat-tool-detail');
            if (detailEl && data.result) {
              var resultLabel = document.createElement('div');
              resultLabel.className = 'tool-label';
              resultLabel.textContent = 'Output';
              detailEl.appendChild(resultLabel);
              var resultPre = document.createElement('pre');
              resultPre.textContent = data.result;
              detailEl.appendChild(resultPre);
            }
            break;
          }
        }
        break;

      case 'composition_updated':
        if (data.compositionId) {
          activeCompositionId = data.compositionId;
          taskPanelState.activeCompositionId = data.compositionId;
          renderTaskPanel();
          refreshGraph(data.compositionId);
        }
        break;

      case 'session_context':
        taskPanelState.sessionSummary = data.summary || '';
        taskPanelState.summaryTurnCount = data.summaryTurnCount || 0;
        renderTaskPanel();
        break;

      case 'skill_selection':
        taskPanelState.selectedSkill = {
          name: data.name || '',
          description: data.description || '',
          whenToUse: data.whenToUse || '',
          promptGuidance: data.promptGuidance || '',
          reason: data.reason || '',
          matchedKeywords: data.matchedKeywords || []
        };
        taskPanelState.skillHandoff = {
          previousSkillName: data.previousSkillName || '',
          previousSkillReason: data.previousSkillReason || '',
          handoffRationale: data.handoffRationale || '',
          taskId: data.taskId || '',
          taskTitle: data.taskTitle || ''
        };
        taskPanelState.skillTransitions.unshift({
          from: data.previousSkillName || '',
          to: data.name || '',
          rationale: data.handoffRationale || data.reason || '',
          taskTitle: data.taskTitle || '',
          changedAt: new Date().toISOString()
        });
        taskPanelState.skillTransitions = taskPanelState.skillTransitions.slice(0, 8);
        taskPanelState.allowedTools = data.allowedTools || [];
        renderTaskPanel();
        break;

      case 'recovery':
        taskPanelState.recoveryEvents.unshift({
          taskTitle: data.taskTitle || 'Untitled task',
          strategyType: data.strategyType || 'retry',
          currentSkill: data.currentSkill || '',
          targetSkill: data.targetSkill || '',
          reason: data.reason || '',
          attempt: data.attempt || 0
        });
        taskPanelState.recoveryEvents = taskPanelState.recoveryEvents.slice(0, 8);
        if (data.strategyType === 'alternative_skill' && data.currentSkill && data.targetSkill) {
          taskPanelState.skillTransitions.unshift({
            from: data.currentSkill,
            to: data.targetSkill,
            rationale: 'Recovery switched skills: ' + (data.reason || ''),
            taskTitle: data.taskTitle || '',
            changedAt: new Date().toISOString()
          });
          taskPanelState.skillTransitions = taskPanelState.skillTransitions.slice(0, 8);
        }
        renderTaskPanel();
        break;

      case 'phase':
        taskPanelState.phase = data.to || data.from || 'idle';
        renderTaskPanel();
        break;

      case 'task_start':
        upsertTaskPanelTask(data.id, {
          id: data.id,
          title: data.title || data.description || 'Untitled task',
          description: data.description || '',
          status: data.status || 'running',
          retryCount: data.retryCount || 0,
          maxRetries: data.maxRetries || 0,
          riskLevel: data.riskLevel || ''
        });
        break;

      case 'task_end':
        upsertTaskPanelTask(data.task && data.task.id, {
          id: data.task && data.task.id,
          title: data.task && (data.task.title || data.task.description) || 'Untitled task',
          description: data.task && data.task.description || '',
          status: data.result && data.result.success ? 'done' : 'failed',
          output: data.result && data.result.output || '',
          error: data.result && data.result.error || '',
          retryCount: data.task && data.task.retryCount || 0,
          maxRetries: data.task && data.task.maxRetries || 0,
          riskLevel: data.task && data.task.riskLevel || ''
        });
        break;

      case 'verification':
        taskPanelState.verifications.unshift({
          taskTitle: data.task && (data.task.title || data.task.description) || 'Untitled task',
          status: data.status || 'unknown',
          detail: data.detail || ''
        });
        taskPanelState.verifications = taskPanelState.verifications.slice(0, 10);
        renderTaskPanel();
        break;

      case 'belief_update':
        if (typeof data.confidence === 'number' && data.confidence < 0.6 && data.claim) {
          taskPanelState.beliefs.unshift({
            claim: data.claim,
            confidence: data.confidence
          });
          taskPanelState.beliefs = taskPanelState.beliefs.slice(0, 6);
          renderTaskPanel();
        }
        break;

      case 'reflection':
        if (data.summary) {
          taskPanelState.reflections.unshift(data.summary);
          taskPanelState.reflections = taskPanelState.reflections.slice(0, 6);
          renderTaskPanel();
        }
        break;

      case 'done':
        // Final clean pass — strip any remaining XML, render final markdown
        if (data.content) {
          var finalClean = stripAgentXml(data.content);
          renderMarkdown(textEl, finalClean);
          setAccumulated(finalClean);
        } else if (textEl._rawText) {
          var finalClean2 = stripAgentXml(textEl._rawText);
          renderMarkdown(textEl, finalClean2);
          setAccumulated(finalClean2);
        }
        break;

      case 'error':
        var typingEl = textEl.querySelector('.chat-typing');
        if (typingEl) textEl.innerHTML = '';
        textEl.textContent += '\n\nError: ' + data.error;
        setAccumulated(textEl.textContent);
        break;
    }
  }

  function finishSend(finalText) {
    if (finalText) {
      chatHistory.push({ role: 'assistant', content: finalText });
    }
    isSending = false;
    abortController = null;
    updateSendButton();
    var input = document.getElementById('chat-input');
    if (input) input.focus();

    // Persist session after each exchange
    saveSession();
  }

  // ── UI Helpers ─────────────────────────────────────────────

  function appendMessage(role, text) {
    var messages = document.getElementById('chat-messages');
    if (!messages) return null;

    // Remove welcome message on first interaction
    var welcome = messages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    var msg = document.createElement('div');
    msg.className = 'chat-msg chat-msg-' + role;

    var roleLabel = document.createElement('div');
    roleLabel.className = 'chat-msg-role';
    roleLabel.textContent = role === 'user' ? 'You' : 'Woodbury';
    msg.appendChild(roleLabel);

    var textDiv = document.createElement('div');
    textDiv.className = 'chat-msg-text';
    if (role === 'assistant') {
      renderMarkdown(textDiv, text);
    } else {
      textDiv.textContent = text;
    }
    msg.appendChild(textDiv);

    messages.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function scrollToBottom() {
    var messages = document.getElementById('chat-messages');
    if (messages) {
      messages.scrollTop = messages.scrollHeight;
    }
  }

  function updateSendButton() {
    var btn = document.getElementById('chat-send-btn');
    if (btn) {
      btn.disabled = isSending;
      btn.textContent = isSending ? '...' : 'Send';
    }
  }

  function humanizeToolName(name) {
    // Convert tool_name to "Tool Name"
    return name
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function humanizePhaseName(name) {
    return String(name || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function appendSystemEvent(textEl, label) {
    var messagesDiv = textEl && textEl.parentElement;
    if (!messagesDiv || !label) return;
    var eventEl = document.createElement('div');
    eventEl.className = 'chat-tool-pill';
    eventEl.innerHTML = '<div class="tool-header"><span class="tool-name">' + escapeHtml(label) + '</span></div>';
    messagesDiv.insertBefore(eventEl, textEl);
    scrollToBottom();
  }

  function upsertTaskPanelTask(taskId, taskData) {
    if (!taskId) return;
    if (!taskPanelState.tasks[taskId]) {
      taskPanelState.taskOrder.unshift(taskId);
    }
    taskPanelState.tasks[taskId] = Object.assign({}, taskPanelState.tasks[taskId] || {}, taskData);
    taskPanelState.taskOrder = taskPanelState.taskOrder.slice(0, 12);
    renderTaskPanel();
  }

  function renderTaskPanel() {
    var phaseEl = document.getElementById('chat-status-phase');
    var taskCountEl = document.getElementById('chat-status-task-count');
    var checkCountEl = document.getElementById('chat-status-check-count');
    var summaryEl = document.getElementById('chat-session-summary');
    var taskListEl = document.getElementById('chat-task-list');
    var verificationEl = document.getElementById('chat-verification-list');
    var reflectionEl = document.getElementById('chat-reflection-list');
    var transitionEl = document.getElementById('chat-skill-transition-list');
    var recoveryEl = document.getElementById('chat-recovery-list');
    var policyEl = document.getElementById('chat-skill-policy-list');

    if (phaseEl) phaseEl.textContent = humanizePhaseName(taskPanelState.phase || 'idle');
    if (taskCountEl) taskCountEl.textContent = String(taskPanelState.taskOrder.length);
    if (checkCountEl) checkCountEl.textContent = String(taskPanelState.verifications.length);

    if (summaryEl) {
      var summaryLines = [];
      if (taskPanelState.selectedSkill && taskPanelState.selectedSkill.name) {
        summaryLines.push('Skill: ' + taskPanelState.selectedSkill.name);
        if (taskPanelState.selectedSkill.reason) summaryLines.push('Why: ' + taskPanelState.selectedSkill.reason);
        if (taskPanelState.skillHandoff && taskPanelState.skillHandoff.previousSkillName) {
          summaryLines.push('Previous skill: ' + taskPanelState.skillHandoff.previousSkillName);
        }
        if (taskPanelState.skillHandoff && taskPanelState.skillHandoff.handoffRationale) {
          summaryLines.push('Handoff: ' + taskPanelState.skillHandoff.handoffRationale);
        }
        if (taskPanelState.skillHandoff && taskPanelState.skillHandoff.taskTitle) {
          summaryLines.push('Current task: ' + taskPanelState.skillHandoff.taskTitle);
        }
        if (taskPanelState.allowedTools && taskPanelState.allowedTools.length > 0) {
          summaryLines.push('Allowed tools: ' + taskPanelState.allowedTools.slice(0, 10).join(', '));
        }
      }
      if (taskPanelState.sessionSummary) {
        summaryLines.push(taskPanelState.sessionSummary + (taskPanelState.summaryTurnCount ? ' (' + taskPanelState.summaryTurnCount + ' earlier turns compressed)' : ''));
      }
      summaryEl.textContent = summaryLines.length > 0 ? summaryLines.join('\n\n') : 'No compressed session summary yet.';
    }

    if (taskListEl) {
      if (taskPanelState.taskOrder.length === 0) {
        taskListEl.innerHTML = '<div class="chat-panel-empty">No tasks yet.</div>';
      } else {
        var taskHtml = '';
        for (var i = 0; i < taskPanelState.taskOrder.length; i++) {
          var task = taskPanelState.tasks[taskPanelState.taskOrder[i]];
          if (!task) continue;
          taskHtml +=
            '<div class="chat-task-item ' + escapeHtml(task.status || 'pending') + '">' +
              '<div class="chat-task-title-row">' +
                '<div class="chat-task-title">' + escapeHtml(task.title || 'Untitled task') + '</div>' +
                '<div class="chat-task-status">' + escapeHtml(humanizePhaseName(task.status || 'pending')) + '</div>' +
              '</div>' +
              (task.description ? '<div class="chat-task-desc">' + escapeHtml(task.description) + '</div>' : '') +
              ((task.error || task.output) ? '<div class="chat-task-detail">' + escapeHtml(task.error || task.output) + '</div>' : '') +
            '</div>';
        }
        taskListEl.innerHTML = taskHtml;
      }
    }

    if (verificationEl) {
      if (taskPanelState.verifications.length === 0) {
        verificationEl.innerHTML = '<div class="chat-panel-empty">No verification results yet.</div>';
      } else {
        verificationEl.innerHTML = taskPanelState.verifications.map(function (item) {
          return '<div class="chat-check-item ' + escapeHtml(item.status || 'unknown') + '">' +
            '<div class="chat-check-title">' + escapeHtml(item.taskTitle) + '</div>' +
            '<div class="chat-check-detail">' + escapeHtml(item.detail || item.status) + '</div>' +
          '</div>';
        }).join('');
      }
    }

    if (reflectionEl) {
      if (taskPanelState.reflections.length === 0 && taskPanelState.beliefs.length === 0) {
        reflectionEl.innerHTML = '<div class="chat-panel-empty">No reflections yet.</div>';
      } else {
        var reflectionHtml = taskPanelState.reflections.map(function (item) {
          return '<div class="chat-reflection-item">' + escapeHtml(item) + '</div>';
        }).join('');
        if (taskPanelState.beliefs.length > 0) {
          reflectionHtml += taskPanelState.beliefs.map(function (belief) {
            return '<div class="chat-reflection-item warning">Low-confidence belief: ' + escapeHtml(belief.claim) + ' (' + Math.round((belief.confidence || 0) * 100) + '%)</div>';
          }).join('');
        }
        reflectionEl.innerHTML = reflectionHtml;
      }
    }

    if (transitionEl) {
      if (!taskPanelState.skillTransitions || taskPanelState.skillTransitions.length === 0) {
        transitionEl.innerHTML = '<div class="chat-panel-empty">No skill transitions yet.</div>';
      } else {
        transitionEl.innerHTML = taskPanelState.skillTransitions.map(function (item) {
          return '<div class="chat-reflection-item">' +
            '<div class="chat-check-title">' + escapeHtml((item.from || 'start') + ' -> ' + (item.to || 'unknown')) + '</div>' +
            (item.taskTitle ? '<div class="chat-check-detail">Task: ' + escapeHtml(item.taskTitle) + '</div>' : '') +
            (item.rationale ? '<div class="chat-check-detail">' + escapeHtml(item.rationale) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    }

    if (recoveryEl) {
      if (!taskPanelState.recoveryEvents || taskPanelState.recoveryEvents.length === 0) {
        recoveryEl.innerHTML = '<div class="chat-panel-empty">No recovery events yet.</div>';
      } else {
        recoveryEl.innerHTML = taskPanelState.recoveryEvents.map(function (item) {
          var detail = item.strategyType === 'alternative_skill'
            ? 'Recovery switched from ' + (item.currentSkill || 'unknown') + ' to ' + (item.targetSkill || 'unknown')
            : (item.reason || item.strategyType);
          return '<div class="chat-check-item failed">' +
            '<div class="chat-check-title">' + escapeHtml(item.taskTitle) + '</div>' +
            '<div class="chat-check-detail">' + escapeHtml(detail) + '</div>' +
          '</div>';
        }).join('');
      }
    }

    if (policyEl) {
      if (!taskPanelState.skillPolicyUpdates || taskPanelState.skillPolicyUpdates.length === 0) {
        policyEl.innerHTML = '<div class="chat-panel-empty">No skill policy updates yet.</div>';
      } else {
        policyEl.innerHTML = taskPanelState.skillPolicyUpdates.map(function (item) {
          return '<div class="chat-task-item" data-skill-policy-id="' + escapeHtml(item.id) + '">' +
            '<div class="chat-task-title-row">' +
              '<div class="chat-task-title">' + escapeHtml(item.skillName + ' [' + item.reviewStatus + ']') + '</div>' +
              '<div class="chat-task-status">' + escapeHtml(item.updateType) + '</div>' +
            '</div>' +
            '<div class="chat-task-desc">Pattern</div>' +
            '<textarea class="chat-policy-input chat-policy-pattern">' + escapeHtml(item.applicabilityPattern || '') + '</textarea>' +
            '<div class="chat-task-desc">Guidance</div>' +
            '<textarea class="chat-policy-input chat-policy-guidance">' + escapeHtml(item.guidance || '') + '</textarea>' +
            '<div class="chat-policy-actions">' +
              '<button class="chat-policy-btn" data-action="approve">Approve</button>' +
              '<button class="chat-policy-btn" data-action="reject">Reject</button>' +
              '<button class="chat-policy-btn" data-action="save">Save</button>' +
            '</div>' +
          '</div>';
        }).join('');

        policyEl.querySelectorAll('.chat-policy-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var card = btn.closest('[data-skill-policy-id]');
            if (!card) return;
            var updateId = card.getAttribute('data-skill-policy-id');
            var pattern = card.querySelector('.chat-policy-pattern').value;
            var guidance = card.querySelector('.chat-policy-guidance').value;
            var action = btn.getAttribute('data-action');
            var body = {
              applicabilityPattern: pattern,
              guidance: guidance,
            };
            if (action === 'approve') body.reviewStatus = 'approved';
            if (action === 'reject') body.reviewStatus = 'rejected';
            updateSkillPolicy(updateId, body);
          });
        });
      }
    }
  }

  // ── Graph Panel ────────────────────────────────────────────

  function refreshGraph(compositionId) {
    fetch('/api/compositions/' + encodeURIComponent(compositionId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.composition) {
          graphData = data.composition;
          renderGraph();
        }
      })
      .catch(function () {
        // Silently fail — graph is supplementary
      });
  }

  function renderGraph() {
    var nodesLayer = document.getElementById('chat-graph-nodes');
    var edgesGroup = document.getElementById('chat-graph-edges');
    var emptyState = document.getElementById('chat-graph-empty');

    if (!nodesLayer || !edgesGroup || !graphData) return;

    // Hide empty state
    if (emptyState) emptyState.style.display = 'none';

    var nodes = graphData.nodes || [];
    var edges = graphData.edges || [];

    // Auto-layout if positions are all 0,0
    autoLayoutNodes(nodes);

    // Render nodes
    var nodesHtml = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var nodeType = getNodeTypeClass(node.workflowId);
      var label = node.label || node.workflowId || 'Node';
      nodesHtml +=
        '<div class="chat-graph-node ' + nodeType + '" ' +
          'style="position:absolute;left:' + (node.position?.x || 0) + 'px;top:' + (node.position?.y || 0) + 'px;">' +
          '<div class="chat-graph-node-label">' + escapeHtml(label) + '</div>' +
        '</div>';
    }
    nodesLayer.innerHTML = nodesHtml;

    // Center the view
    if (nodes.length > 0) {
      centerGraph(nodes);
    }

    // Render edges after a frame (need node positions)
    requestAnimationFrame(function () {
      renderGraphEdges(nodes, edges, edgesGroup);
    });
  }

  function autoLayoutNodes(nodes) {
    // Simple left-to-right layout if nodes lack meaningful positions
    var needsLayout = nodes.length > 1 && nodes.every(function (n) {
      return (!n.position || (n.position.x === 0 && n.position.y === 0));
    });
    if (!needsLayout) return;

    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].position) nodes[i].position = {};
      nodes[i].position.x = 50 + i * 250;
      nodes[i].position.y = 100 + (i % 2) * 60;  // slight stagger
    }
  }

  function centerGraph(nodes) {
    var panel = document.getElementById('chat-graph-panel');
    var nodesLayer = document.getElementById('chat-graph-nodes');
    var edgesGroup = document.getElementById('chat-graph-edges');
    if (!panel || !nodesLayer) return;

    // Find bounding box
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var x = nodes[i].position?.x || 0;
      var y = nodes[i].position?.y || 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + 180 > maxX) maxX = x + 180;  // estimated node width
      if (y + 60 > maxY) maxY = y + 60;     // estimated node height
    }

    var pw = panel.clientWidth;
    var ph = panel.clientHeight;
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;

    graphPanX = pw / 2 - cx * graphZoom;
    graphPanY = ph / 2 - cy * graphZoom;

    nodesLayer.style.transform = 'translate(' + graphPanX + 'px,' + graphPanY + 'px) scale(' + graphZoom + ')';
    if (edgesGroup) {
      edgesGroup.setAttribute('transform', 'translate(' + graphPanX + ',' + graphPanY + ') scale(' + graphZoom + ')');
    }
  }

  function renderGraphEdges(nodes, edges, group) {
    var html = '';
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      var srcNode = findNode(nodes, edge.sourceNodeId);
      var tgtNode = findNode(nodes, edge.targetNodeId);
      if (!srcNode || !tgtNode) continue;

      var sx = (srcNode.position?.x || 0) + 180;  // right side of source
      var sy = (srcNode.position?.y || 0) + 30;    // middle of node
      var tx = tgtNode.position?.x || 0;            // left side of target
      var ty = (tgtNode.position?.y || 0) + 30;

      var dx = Math.abs(tx - sx) * 0.5;
      var d = 'M' + sx + ',' + sy + ' C' + (sx + dx) + ',' + sy + ' ' + (tx - dx) + ',' + ty + ' ' + tx + ',' + ty;

      html += '<path d="' + d + '" fill="none" stroke="#475569" stroke-width="2" />';
    }
    group.innerHTML = html;
  }

  function findNode(nodes, id) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return nodes[i];
    }
    return null;
  }

  function getNodeTypeClass(workflowId) {
    if (!workflowId) return 'chat-graph-node-default';
    if (workflowId === '__script__') return 'chat-graph-node-script';
    if (workflowId === '__output__') return 'chat-graph-node-output';
    if (workflowId === '__approval_gate__') return 'chat-graph-node-gate';
    if (workflowId === '__branch__' || workflowId === '__switch__') return 'chat-graph-node-branch';
    if (workflowId === '__delay__') return 'chat-graph-node-delay';
    if (workflowId === '__for_each__') return 'chat-graph-node-loop';
    if (workflowId.startsWith('comp:')) return 'chat-graph-node-composition';
    return 'chat-graph-node-workflow';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Chat Logs Viewer ───────────────────────────────────────

  var chatLogsView = false;

  function initChatLogs() {
    var main = document.getElementById('main');
    if (!main) return;
    chatLogsView = true;
    main.innerHTML = '';
    main.style.display = 'flex';
    main.style.flexDirection = 'column';

    var container = document.createElement('div');
    container.style.cssText = 'flex:1;overflow:auto;padding:1.5rem;';
    container.innerHTML =
      '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.25rem;">' +
        '<button id="chat-logs-back" style="background:none;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.75rem;">← Back to Chat</button>' +
        '<h2 style="color:#e2e8f0;font-size:1.1rem;font-weight:600;margin:0;">Chat Logs</h2>' +
      '</div>' +
      '<div id="chat-logs-content" style="color:#cbd5e1;font-size:0.82rem;">Loading...</div>';
    main.appendChild(container);

    document.getElementById('chat-logs-back').addEventListener('click', function () {
      chatLogsView = false;
      chatInitialized = false;
      initChat();
      if (chatHistory.length > 0) renderExistingMessages();
    });

    loadLogDays();
  }

  function loadLogDays() {
    fetch('/api/chat/logs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var el = document.getElementById('chat-logs-content');
        if (!el) return;
        var days = data.days || [];
        if (days.length === 0) {
          el.innerHTML = '<div style="color:#64748b;padding:2rem;text-align:center;">No chat logs yet. Logs are recorded automatically when you use the chat.</div>';
          return;
        }
        var html = '<div style="display:flex;flex-direction:column;gap:0.5rem;">';
        for (var i = 0; i < days.length; i++) {
          var d = days[i];
          html += '<button class="chat-log-day-btn" data-date="' + escAttr(d.date) + '" ' +
            'style="display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:0.6rem 0.85rem;cursor:pointer;color:#e2e8f0;font-size:0.82rem;text-align:left;">' +
            '<span>' + escHtml(d.date) + '</span>' +
            '<span style="color:#64748b;font-size:0.75rem;">' + d.entries + ' request' + (d.entries !== 1 ? 's' : '') + '</span>' +
          '</button>';
        }
        html += '</div>';
        el.innerHTML = html;

        el.querySelectorAll('.chat-log-day-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            loadLogDay(btn.dataset.date);
          });
        });
      })
      .catch(function (err) {
        var el = document.getElementById('chat-logs-content');
        if (el) el.innerHTML = '<div style="color:#ef4444;">Failed to load logs: ' + escHtml(err.message) + '</div>';
      });
  }

  function loadLogDay(date) {
    var el = document.getElementById('chat-logs-content');
    if (!el) return;
    el.innerHTML = 'Loading ' + escHtml(date) + '...';

    fetch('/api/chat/logs/' + encodeURIComponent(date))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var entries = data.entries || [];
        var html = '<div style="margin-bottom:0.75rem;">' +
          '<button id="chat-logs-back-to-days" style="background:none;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;padding:0.3rem 0.6rem;border-radius:4px;cursor:pointer;font-size:0.75rem;">← All Days</button>' +
          '<span style="color:#e2e8f0;font-weight:600;margin-left:0.75rem;">' + escHtml(date) + '</span>' +
          '<span style="color:#64748b;margin-left:0.5rem;font-size:0.75rem;">' + entries.length + ' request' + (entries.length !== 1 ? 's' : '') + '</span>' +
        '</div>';

        if (entries.length === 0) {
          html += '<div style="color:#64748b;padding:1rem;">No entries for this day.</div>';
        } else {
          html += '<div style="display:flex;flex-direction:column;gap:0.75rem;">';
          for (var i = 0; i < entries.length; i++) {
            html += renderLogEntry(entries[i]);
          }
          html += '</div>';
        }

        el.innerHTML = html;
        document.getElementById('chat-logs-back-to-days').addEventListener('click', function () {
          loadLogDays();
        });

        // Wire up expand/collapse
        el.querySelectorAll('.chat-log-entry-header').forEach(function (header) {
          header.addEventListener('click', function () {
            var body = header.nextElementSibling;
            var arrow = header.querySelector('.chat-log-arrow');
            if (body.style.display === 'none') {
              body.style.display = 'block';
              arrow.textContent = '▼';
            } else {
              body.style.display = 'none';
              arrow.textContent = '▶';
            }
          });
        });
      })
      .catch(function (err) {
        el.innerHTML = '<div style="color:#ef4444;">Failed to load log: ' + escHtml(err.message) + '</div>';
      });
  }

  function renderLogEntry(entry) {
    var time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '?';
    var toolCount = (entry.toolCalls || []).length;
    var hasError = !!entry.error;
    var statusColor = hasError ? '#ef4444' : (entry.aborted ? '#f59e0b' : '#22c55e');
    var statusText = hasError ? 'error' : (entry.aborted ? 'aborted' : 'ok');
    var duration = entry.durationMs ? (entry.durationMs / 1000).toFixed(1) + 's' : '?';

    var html = '<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;overflow:hidden;">';

    // Header (clickable to expand)
    html += '<div class="chat-log-entry-header" style="display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.85rem;cursor:pointer;user-select:none;">' +
      '<span class="chat-log-arrow" style="color:#64748b;font-size:0.65rem;width:0.75rem;">▶</span>' +
      '<span style="color:#64748b;font-size:0.75rem;min-width:5rem;">' + escHtml(time) + '</span>' +
      '<span style="color:' + statusColor + ';font-size:0.7rem;padding:0.1rem 0.35rem;border:1px solid ' + statusColor + ';border-radius:3px;">' + statusText + '</span>' +
      '<span style="flex:1;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(entry.message || '') + '</span>' +
      '<span style="color:#64748b;font-size:0.7rem;">' + toolCount + ' tool' + (toolCount !== 1 ? 's' : '') + '</span>' +
      '<span style="color:#64748b;font-size:0.7rem;">' + duration + '</span>' +
    '</div>';

    // Body (collapsed by default)
    html += '<div style="display:none;border-top:1px solid rgba(255,255,255,0.06);padding:0.85rem;">';

    // User message
    html += '<div style="margin-bottom:0.75rem;">' +
      '<div style="color:#7c3aed;font-size:0.7rem;font-weight:600;margin-bottom:0.25rem;">USER MESSAGE</div>' +
      '<div style="color:#e2e8f0;background:rgba(124,58,237,0.08);padding:0.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:0.8rem;">' + escHtml(entry.message || '') + '</div>' +
    '</div>';

    // Tool calls
    if (toolCount > 0) {
      html += '<div style="margin-bottom:0.75rem;">' +
        '<div style="color:#7c3aed;font-size:0.7rem;font-weight:600;margin-bottom:0.25rem;">TOOL CALLS (' + toolCount + ')</div>';
      for (var t = 0; t < entry.toolCalls.length; t++) {
        var tc = entry.toolCalls[t];
        var tcColor = tc.success ? '#22c55e' : '#ef4444';
        var tcDur = tc.durationMs ? (tc.durationMs / 1000).toFixed(2) + 's' : '?';
        html += '<div style="background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06);border-radius:4px;padding:0.5rem;margin-bottom:0.35rem;font-size:0.78rem;">' +
          '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem;">' +
            '<span style="color:#e2e8f0;font-weight:600;">' + escHtml(tc.name) + '</span>' +
            '<span style="color:' + tcColor + ';font-size:0.65rem;">' + (tc.success ? 'OK' : 'FAIL') + '</span>' +
            '<span style="color:#64748b;font-size:0.65rem;margin-left:auto;">' + tcDur + '</span>' +
          '</div>';
        if (tc.params) {
          var paramStr = typeof tc.params === 'string' ? tc.params : JSON.stringify(tc.params, null, 2);
          html += '<div style="color:#94a3b8;font-size:0.72rem;margin-bottom:0.2rem;">' +
            '<span style="color:#64748b;">Params:</span> <pre style="margin:0.2rem 0;white-space:pre-wrap;word-break:break-all;color:#94a3b8;background:rgba(0,0,0,0.3);padding:0.3rem;border-radius:3px;max-height:200px;overflow:auto;">' + escHtml(paramStr.slice(0, 1000)) + '</pre></div>';
        }
        if (tc.result) {
          html += '<div style="color:#94a3b8;font-size:0.72rem;">' +
            '<span style="color:#64748b;">Result:</span> <pre style="margin:0.2rem 0;white-space:pre-wrap;word-break:break-all;color:#94a3b8;background:rgba(0,0,0,0.3);padding:0.3rem;border-radius:3px;max-height:200px;overflow:auto;">' + escHtml(tc.result.slice(0, 1000)) + '</pre></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // Response
    if (entry.response) {
      html += '<div style="margin-bottom:0.75rem;">' +
        '<div style="color:#7c3aed;font-size:0.7rem;font-weight:600;margin-bottom:0.25rem;">RESPONSE</div>' +
        '<div style="color:#e2e8f0;background:rgba(34,197,94,0.06);padding:0.5rem;border-radius:4px;white-space:pre-wrap;word-break:break-word;font-size:0.8rem;">' + escHtml(entry.response) + '</div>' +
      '</div>';
    }

    // Error
    if (entry.error) {
      html += '<div style="margin-bottom:0.75rem;">' +
        '<div style="color:#ef4444;font-size:0.7rem;font-weight:600;margin-bottom:0.25rem;">ERROR</div>' +
        '<div style="color:#fca5a5;background:rgba(239,68,68,0.1);padding:0.5rem;border-radius:4px;font-size:0.8rem;">' + escHtml(entry.error) + '</div>' +
      '</div>';
    }

    // Metadata row
    html += '<div style="display:flex;gap:1rem;flex-wrap:wrap;color:#64748b;font-size:0.7rem;">' +
      '<span>Duration: ' + duration + '</span>' +
      '<span>History: ' + (entry.historyLength || 0) + ' turns</span>' +
      (entry.iterations ? '<span>Iterations: ' + entry.iterations + '</span>' : '') +
      (entry.activeCompositionId ? '<span>Pipeline: ' + escHtml(entry.activeCompositionId) + '</span>' : '') +
      '<span>ID: ' + escHtml(entry.id || '') + '</span>' +
    '</div>';

    html += '</div></div>';
    return html;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Wire up logs button when chat initializes
  var _origInitChat = initChat;
  initChat = function () {
    _origInitChat();
    var logsBtn = document.getElementById('chat-logs-btn');
    if (logsBtn && !logsBtn._wired) {
      logsBtn._wired = true;
      logsBtn.addEventListener('click', function () {
        chatInitialized = false;
        initChatLogs();
      });
    }
  };

  // ── Exports ────────────────────────────────────────────────
  window.initChat = initChat;
  window.initChatLogs = initChatLogs;
})();
