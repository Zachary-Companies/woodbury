/**
 * FolderPicker — modal to browse and select a folder.
 * Uses Electron native dialog when available, falls back to custom browser.
 */
import React, { useState, useCallback, useEffect } from 'react';

interface FolderPickerProps {
  onSelect: (path: string) => void;
  onClose: () => void;
  initialPath?: string;
}

interface DirEntry {
  name: string;
  path: string;
}

export function FolderPicker({ onSelect, onClose, initialPath }: FolderPickerProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);

  const browseTo = useCallback(async (dir: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir || undefined }),
      });
      const data = await res.json();
      setCurrentPath(data.current || dir);
      setParentPath(data.parent && data.parent !== (data.current || dir) ? data.parent : null);
      setDirs(data.dirs || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { browseTo(initialPath || ''); }, [browseTo, initialPath]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName?.trim()) return;
    try {
      const res = await fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, createDir: newFolderName.trim() }),
      });
      const data = await res.json();
      if (data.created) {
        browseTo(data.created);
      }
    } catch {}
    setNewFolderName(null);
  }, [newFolderName, currentPath, browseTo]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[450px] max-h-[70vh] bg-[#1a1f2e] border border-white/10 rounded-xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 flex-shrink-0">
          <h3 className="text-sm font-semibold text-white">Choose Folder</h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 text-lg">&times;</button>
        </div>

        {/* Current path */}
        <div className="px-4 py-2 bg-black/20 text-[10px] text-indigo-300 font-mono truncate flex-shrink-0">
          {currentPath || '/'}
        </div>

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* New folder input */}
          {newFolderName !== null && (
            <div className="flex gap-1.5 px-3 py-2 bg-indigo-500/5 border-b border-indigo-500/15">
              <input
                type="text"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderName(null); }}
                placeholder="Folder name..."
                autoFocus
                className="flex-1 px-2 py-1 rounded text-xs bg-[#0f1219] border border-indigo-500/30 text-slate-300 outline-none"
              />
              <button onClick={handleCreateFolder} className="px-2 py-1 rounded text-[10px] bg-indigo-500/20 text-indigo-300">Create</button>
              <button onClick={() => setNewFolderName(null)} className="px-1.5 py-1 rounded text-[10px] text-slate-500">&times;</button>
            </div>
          )}

          {loading ? (
            <div className="px-4 py-6 text-xs text-slate-600 text-center">Loading...</div>
          ) : (
            <>
              {parentPath && (
                <button
                  onClick={() => browseTo(parentPath)}
                  className="w-full text-left px-4 py-2 text-xs text-slate-400 hover:text-white hover:bg-white/5 border-b border-white/[0.02]"
                >
                  📁 ..
                </button>
              )}
              {dirs.length === 0 && !parentPath && (
                <div className="px-4 py-4 text-[10px] text-slate-600 italic">No subdirectories</div>
              )}
              {dirs.map(d => (
                <button
                  key={d.path}
                  onClick={() => browseTo(d.path)}
                  className="w-full text-left px-4 py-2 text-xs text-slate-400 hover:text-white hover:bg-white/5 border-b border-white/[0.02] truncate"
                >
                  📁 {d.name}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-white/5 flex-shrink-0">
          <button
            onClick={() => setNewFolderName('')}
            className="text-xs text-indigo-400 hover:text-indigo-300 mr-auto"
          >
            ➕ New Folder
          </button>
          <button onClick={onClose} className="px-4 py-1.5 rounded-md text-xs text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={() => { if (currentPath) { onSelect(currentPath); onClose(); } }}
            disabled={!currentPath}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Open a folder picker — uses Electron native dialog when available,
 * otherwise returns false so the caller can show the React FolderPicker.
 */
export function tryNativeFolderPicker(): Promise<string | null> | false {
  if ((window as any).woodburyElectron?.selectFolder) {
    return (window as any).woodburyElectron.selectFolder();
  }
  return false;
}
