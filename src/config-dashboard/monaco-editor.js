(function() {
  var loaderPromise = null;
  var monacoConfigured = false;
  var currentOverlay = null;

  function ensureLoader() {
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise(function(resolve, reject) {
      if (window.monaco && window.monaco.editor) {
        resolve(window.monaco);
        return;
      }

      function finishLoad() {
        if (!window.require) {
          reject(new Error('Monaco AMD loader did not initialize.'));
          return;
        }

        window.MonacoEnvironment = {
          getWorkerUrl: function(_moduleId, label) {
            if (label === 'json') return '/vendor/monaco/vs/language/json/json.worker.js';
            if (label === 'css' || label === 'scss' || label === 'less') return '/vendor/monaco/vs/language/css/css.worker.js';
            if (label === 'html' || label === 'handlebars' || label === 'razor') return '/vendor/monaco/vs/language/html/html.worker.js';
            if (label === 'typescript' || label === 'javascript') return '/vendor/monaco/vs/language/typescript/ts.worker.js';
            return '/vendor/monaco/vs/base/worker/workerMain.js';
          },
        };

        window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
        window.require(['vs/editor/editor.main'], function() {
          resolve(window.monaco);
        }, reject);
      }

      var existingLoader = document.querySelector('script[data-woodbury-monaco-loader="true"]');
      if (existingLoader) {
        if (window.require) finishLoad();
        else existingLoader.addEventListener('load', finishLoad, { once: true });
        return;
      }

      var script = document.createElement('script');
      script.src = '/vendor/monaco/vs/loader.js';
      script.async = true;
      script.setAttribute('data-woodbury-monaco-loader', 'true');
      script.addEventListener('load', finishLoad, { once: true });
      script.addEventListener('error', function() {
        reject(new Error('Failed to load Monaco assets.'));
      }, { once: true });
      document.head.appendChild(script);
    });

    return loaderPromise;
  }

  function registerWoodburySupport(monaco) {
    if (monacoConfigured) return;
    monacoConfigured = true;

    monaco.editor.defineTheme('woodbury-night', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '64748b' },
        { token: 'keyword', foreground: '93c5fd' },
        { token: 'string', foreground: '86efac' },
      ],
      colors: {
        'editor.background': '#07111f',
        'editorLineNumber.foreground': '#4b5a73',
        'editorLineNumber.activeForeground': '#cbd5e1',
        'editorGutter.background': '#07111f',
        'editor.selectionBackground': '#1d4ed833',
        'editor.inactiveSelectionBackground': '#33415555',
      },
    });

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      checkJs: true,
    });
    monaco.languages.typescript.javascriptDefaults.addExtraLib(
      [
        'declare const inputs: Record<string, any>;',
        'declare const context: {',
        '  tools: Record<string, (input?: any) => Promise<any>>;',
        '  llm?: {',
        '    generateJSON(prompt: string): Promise<any>;',
        '    generate(prompt: string): Promise<string>;',
        '  };',
        '  log?: (...args: any[]) => void;',
        '  progress?: {',
        '    start(total: number, label?: string): void;',
        '    set(completed: number, total?: number, label?: string): void;',
        '    increment(label?: string): void;',
        '    complete(label?: string): void;',
        '  };',
        '  vars?: Record<string, any>;',
        '};',
      ].join('\n'),
      'file:///woodbury-script-runtime.d.ts'
    );

    monaco.languages.registerCompletionItemProvider('javascript', {
      provideCompletionItems: function() {
        return {
          suggestions: [
            {
              label: 'woodbury-execute',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Script node skeleton with Woodbury port annotations.',
              insertText: [
                '/**',
                ' * @input input string "Primary input"',
                ' * @output result string "Primary result"',
                ' */',
                'async function execute(inputs, context) {',
                '  const { input } = inputs;',
                '  return { result: input };',
                '}',
              ].join('\n'),
            },
            {
              label: 'woodbury-llm-json',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Generate structured output with context.llm.generateJSON.',
              insertText: [
                'const result = await context.llm.generateJSON(`$1`);',
                'return { $2: result.$2 };',
              ].join('\n'),
            },
            {
              label: 'woodbury-asset-collection-create',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Use Creator Assets collection tooling from a script node.',
              insertText: [
                'const collection = await context.tools.asset_collection_create({',
                '  name: $1,',
                '  description: $2,',
                '});',
              ].join('\n'),
            },
            {
              label: 'woodbury-tool-call',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Call any Woodbury runtime tool from context.tools.',
              insertText: 'const result = await context.tools.${1:tool_name}(${2:{}});',
            },
            {
              label: 'woodbury-loop-progress',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Report loop progress to the node UI progress bar while script code is running.',
              insertText: [
                'context.progress.start(${1:items.length}, ${2:\'Processing items...\'});',
                'for (let index = 0; index < ${3:items}.length; index += 1) {',
                '  const item = ${3:items}[index];',
                '  ${4:// do work}',
                '  context.progress.set(index + 1, ${3:items}.length, \`Processed \${index + 1}\`);',
                '}',
                'context.progress.complete(${5:\'Done\'});',
              ].join('\n'),
            },
          ],
        };
      },
    });
  }

  function buildStarterCode(existingCode) {
    if (String(existingCode || '').trim()) return existingCode;
    return [
      '/**',
      ' * @input input string "Primary input"',
      ' * @output result string "Primary result"',
      ' */',
      'async function execute(inputs, context) {',
      '  const { input } = inputs;',
      '  return { result: input };',
      '}',
    ].join('\n');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function closeOverlay(result) {
    if (!currentOverlay) return;
    var overlay = currentOverlay;
    currentOverlay = null;
    if (typeof overlay.__cleanup === 'function') {
      overlay.__cleanup(result);
    }
  }

  function openScriptEditor(options) {
    if (currentOverlay) closeOverlay(undefined);

    return ensureLoader().then(function(monaco) {
      registerWoodburySupport(monaco);

      return new Promise(function(resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'woodbury-monaco-overlay';
        overlay.innerHTML = [
          '<div class="woodbury-monaco-modal">',
          '  <div class="woodbury-monaco-header">',
          '    <div>',
          '      <div class="woodbury-monaco-title">' + escapeHtml(options.title || 'Script Node Code') + '</div>',
          '      <div class="woodbury-monaco-subtitle">' + escapeHtml(options.description || 'Edit the script directly. Monaco includes Woodbury-specific snippets for execute(inputs, context), @input/@output annotations, and common context.tools calls.') + '</div>',
          '    </div>',
          '    <button class="woodbury-monaco-close" type="button" aria-label="Close">&times;</button>',
          '  </div>',
          '  <div class="woodbury-monaco-tips">',
          '    <div class="woodbury-monaco-tip"><div class="woodbury-monaco-tip-label">Contract</div><div class="woodbury-monaco-tip-text">Keep async function execute(inputs, context) and return an object matching your declared outputs.</div></div>',
          '    <div class="woodbury-monaco-tip"><div class="woodbury-monaco-tip-label">Ports</div><div class="woodbury-monaco-tip-text">Use @input and @output annotations so Woodbury can keep ports wired correctly.</div></div>',
          '    <div class="woodbury-monaco-tip"><div class="woodbury-monaco-tip-label">Tools</div><div class="woodbury-monaco-tip-text">Use context.tools for built-in capabilities like assets, collections, and other runtime tools.</div></div>',
          '    <div class="woodbury-monaco-tip"><div class="woodbury-monaco-tip-label">Progress</div><div class="woodbury-monaco-tip-text">Long-running loops can call context.progress.start/set/increment/complete to drive the node progress bar.</div></div>',
          '  </div>',
          '  <div class="woodbury-monaco-surface"><div class="woodbury-monaco-editor"></div></div>',
          '  <div class="woodbury-monaco-footer">',
          '    <div class="woodbury-monaco-status">Tip: press Ctrl/Cmd+Space for Woodbury snippets.</div>',
          '    <div class="woodbury-monaco-actions">',
          '      <button class="woodbury-monaco-btn" type="button" data-action="cancel">Cancel</button>',
          '      <button class="woodbury-monaco-btn woodbury-monaco-btn-primary" type="button" data-action="save">Save Code</button>',
          '    </div>',
          '  </div>',
          '</div>',
        ].join('');
        document.body.appendChild(overlay);
        currentOverlay = overlay;

        var statusEl = overlay.querySelector('.woodbury-monaco-status');

        var editor = monaco.editor.create(overlay.querySelector('.woodbury-monaco-editor'), {
          value: buildStarterCode(options.code),
          language: 'javascript',
          theme: 'woodbury-night',
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 14,
          lineHeight: 22,
          padding: { top: 18, bottom: 18 },
          wordWrap: 'on',
          roundedSelection: true,
          scrollBeyondLastLine: false,
          tabSize: 2,
          insertSpaces: true,
          fontLigatures: true,
        });

        function finish(result) {
          editor.dispose();
          overlay.remove();
          resolve(result);
        }

        overlay.__cleanup = finish;

        function onKeydown(event) {
          if (event.key === 'Escape' && currentOverlay === overlay) {
            event.preventDefault();
            closeOverlay(undefined);
          }
        }

        var baseCleanup = overlay.__cleanup;
        overlay.__cleanup = function(result) {
          window.removeEventListener('keydown', onKeydown);
          baseCleanup(result);
        };

        overlay.querySelector('.woodbury-monaco-close').addEventListener('click', function() {
          closeOverlay(undefined);
        });
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', function() {
          closeOverlay(undefined);
        });
        overlay.querySelector('[data-action="save"]').addEventListener('click', async function() {
          var nextCode = editor.getValue();
          if (typeof options.beforeSave === 'function') {
            var verdict = await options.beforeSave(nextCode);
            if (verdict !== true) {
              statusEl.textContent = typeof verdict === 'string'
                ? verdict
                : 'Fix the script contract before saving.';
              statusEl.style.color = '#fca5a5';
              editor.focus();
              return;
            }
          }
          closeOverlay(nextCode);
        });
        overlay.addEventListener('click', function(event) {
          if (event.target === overlay) closeOverlay(undefined);
        });
        window.addEventListener('keydown', onKeydown);

        requestAnimationFrame(function() {
          editor.focus();
        });
      });
    });
  }

  window.WoodburyMonaco = {
    openScriptEditor: openScriptEditor,
  };
})();