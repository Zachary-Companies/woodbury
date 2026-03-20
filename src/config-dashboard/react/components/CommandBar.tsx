/**
 * CommandBar — AI chat input that sends commands to the pipeline agent.
 * Streams SSE responses and shows tool usage + rendered text.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';

interface CommandBarProps {
  pipelineId: string;
}

export function CommandBar({ pipelineId }: CommandBarProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<{ tools: string[]; text: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setInput('');
    setBusy(true);
    setResponse({ tools: [], text: '' });

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: [],
          activeCompositionId: pipelineId,
        }),
      });

      if (!resp.ok) {
        const errData = await resp.json();
        setResponse({ tools: [], text: `Error: ${errData.error || 'Request failed'}` });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accText = '';
      let tools: string[] = [];

      const processChunk = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = '';

        let eventType: string | null = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'token' && data.token) {
                accText += data.token;
              } else if (eventType === 'tool_start' && data.tool) {
                tools = [...tools, data.tool];
              } else if (eventType === 'done' && data.fullText) {
                accText = data.fullText;
              }
            } catch {}
          }
        }

        setResponse({ tools: [...tools], text: accText || (tools.length > 0 ? 'Working...' : '') });
        return processChunk();
      };

      await processChunk();

      if (!accText && tools.length > 0) {
        setResponse({ tools, text: 'Done. Changes applied.' });
      } else {
        setResponse({ tools, text: accText });
      }
    } catch (err: any) {
      setResponse({ tools: [], text: `Error: ${err.message}` });
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  }, [input, busy, pipelineId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = '';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Auto-scroll response
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [response]);

  return (
    <div className="border-t border-white/5 bg-[#0a0f1a]">
      {/* Response area */}
      {response && (response.text || response.tools.length > 0) && (
        <div
          ref={responseRef}
          className="px-3 py-2 max-h-32 overflow-y-auto text-[10px] border-b border-white/5"
        >
          {response.tools.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {response.tools.map((t, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 text-[9px]">
                  {t}
                </span>
              ))}
            </div>
          )}
          {response.text && (
            <div
              className="text-slate-400 whitespace-pre-wrap break-words"
              dangerouslySetInnerHTML={{
                __html: escapeHtml(response.text)
                  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                  .replace(/`([^`]+)`/g, '<code class="text-indigo-300">$1</code>')
                  .replace(/\n/g, '<br>'),
              }}
            />
          )}
        </div>
      )}

      {/* Input */}
      <div className="relative px-2 py-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          rows={2}
          placeholder="Ask the AI to change something..."
          className="w-full px-2.5 py-1.5 rounded-md text-[11px] bg-white/[0.03] border border-white/5 text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/20 resize-none disabled:opacity-50"
        />
        {busy && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
