/**
 * GitStatus — git repo status with commit & push. Uses .app-action-btn CSS classes.
 */
import React, { useState, useCallback, useEffect } from 'react';

interface GitStatusProps {
  pipelineId: string;
}

interface GitData {
  isRepo: boolean;
  dirty: boolean;
  branch: string;
  recentCommits: string[];
}

export function GitStatus({ pipelineId }: GitStatusProps) {
  const [data, setData] = useState<GitData | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}/git-status`);
      setData(await res.json());
    } catch {
      setData(null);
    }
  }, [pipelineId]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleCommit = useCallback(async () => {
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}/git-smart-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Commit failed');
      if (!result.committed) {
        setCommitResult(result.message || 'Nothing to commit');
      } else {
        setCommitResult(result.pushed ? 'Committed & pushed!' : 'Committed!');
        setTimeout(fetchStatus, 2000);
      }
    } catch (err: any) {
      setCommitResult(`Failed: ${err.message}`);
    }
    setCommitting(false);
  }, [pipelineId, fetchStatus]);

  const handleOpenGitHub = useCallback(async () => {
    try {
      await fetch(`/api/compositions/${encodeURIComponent(pipelineId)}/open-github-desktop`, { method: 'POST' });
    } catch {}
  }, [pipelineId]);

  if (!data) return null;

  if (!data.isRepo) {
    return (
      <button onClick={handleOpenGitHub} className="app-action-btn app-action-secondary">
        💻 Open in GitHub Desktop
      </button>
    );
  }

  return (
    <div className="app-git-section">
      {/* Status line */}
      <div className="app-git-status-line" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.72rem', marginBottom: 4 }}>
        <span style={{ color: data.dirty ? '#f59e0b' : '#10b981' }}>
          {data.dirty ? '● Uncommitted changes' : '✓ Clean'}
        </span>
        {data.branch && (
          <span style={{ color: '#64748b', fontSize: '0.68rem' }}>on {data.branch}</span>
        )}
      </div>

      {/* Commit button */}
      {data.dirty && (
        <button onClick={handleCommit} disabled={committing} className="app-action-btn" style={{ marginBottom: 4 }}>
          {committing ? '🤖 Generating message...' : '📝 Commit & Push'}
        </button>
      )}

      {commitResult && (
        <div style={{ fontSize: '0.68rem', color: '#94a3b8', padding: '2px 0' }}>{commitResult}</div>
      )}

      {/* GitHub Desktop */}
      <button onClick={handleOpenGitHub} className="app-action-btn app-action-secondary">
        💻 Open in GitHub Desktop
      </button>

      {/* Recent commits */}
      {data.recentCommits && data.recentCommits.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {data.recentCommits.slice(0, 3).map((c, i) => (
            <div key={i} style={{ fontSize: '0.6rem', color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.5 }}>{c}</div>
          ))}
        </div>
      )}
    </div>
  );
}
