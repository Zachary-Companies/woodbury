/**
 * OverviewView — pipeline overview showing stats, sections, and quick actions.
 */
import React from 'react';
import { usePipeline } from '../stores/PipelineProvider';

interface OverviewViewProps {
  schema: any | null;
  appState: any | null;
}

export function OverviewView({ schema, appState }: OverviewViewProps) {
  const { project: projectData, pipelineName, projectFolder } = usePipeline();

  const title = projectData?.metadata?.title || pipelineName || 'Pipeline';
  const characters = projectData?.characters || [];
  const locations = projectData?.locations || [];
  const elements = projectData?.elements || [];
  const sections = projectData?.sections || [];

  // Count scenes
  let sceneCount = 0;
  function countScenes(secs: any[]) {
    for (const s of secs) {
      if (s.type === 'scene') sceneCount++;
      if (s.children) countScenes(s.children);
    }
  }
  countScenes(sections);

  // Count previs shots
  const previsShots = projectData?.previsualizations?.shots?.length || 0;

  // Node stats from appState
  const nodeData = appState?.nodeData || {};
  const nodeCount = Object.keys(nodeData).length;
  const staleNodes = appState?.staleNodes || [];

  // Schema sections
  const schemaSections = schema?.sections || [];

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      {/* Title */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">{title}</h1>
        {projectData?.metadata?.logline && (
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">{projectData.metadata.logline}</p>
        )}
        {projectFolder && (
          <div className="text-xs text-indigo-400/50 mt-1">📁 {projectFolder}</div>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label="Scenes" value={sceneCount} icon="🎬" />
        <StatCard label="Characters" value={characters.length} icon="👥" />
        <StatCard label="Locations" value={locations.length} icon="📍" />
        <StatCard label="Elements" value={elements.length} icon="📝" />
        <StatCard label="Previs Shots" value={previsShots} icon="🖼" />
      </div>

      {/* Pipeline nodes */}
      {schemaSections.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 mb-3">Pipeline Nodes</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {schemaSections.map((section: any) => {
              const hasData = !!(section.nodeId && nodeData[section.nodeId]);
              const isStale = staleNodes.includes(section.nodeId);
              const outputs = hasData ? nodeData[section.nodeId].outputs : null;
              const edited = hasData && nodeData[section.nodeId].manuallyEdited;

              let itemCount = '';
              if (outputs) {
                const firstKey = Object.keys(outputs)[0];
                const firstVal = firstKey ? outputs[firstKey] : null;
                if (Array.isArray(firstVal)) itemCount = `${firstVal.length} items`;
                else if (firstVal && typeof firstVal === 'object') itemCount = `${Object.keys(firstVal).length} fields`;
              }

              return (
                <div
                  key={section.id}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                    hasData
                      ? 'bg-white/[0.02] border-white/5'
                      : 'bg-white/[0.01] border-white/[0.03] opacity-50'
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isStale ? 'bg-amber-400' : hasData ? 'bg-emerald-400' : 'bg-slate-600'
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-300 truncate">{section.label}</div>
                    <div className="text-[10px] text-slate-600">
                      {isStale ? '⚠ Stale' : hasData ? itemCount || 'Has data' : 'No data'}
                      {edited && ' • ✎ Edited'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Metadata */}
      {projectData?.metadata && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-slate-400 mb-3">Metadata</h2>
          <div className="bg-white/[0.02] rounded-lg border border-white/5 p-4">
            <MetadataGrid metadata={projectData.metadata} />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-white/[0.02] border border-white/5">
      <span className="text-lg">{icon}</span>
      <div>
        <div className="text-lg font-bold text-white">{value}</div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</div>
      </div>
    </div>
  );
}

function MetadataGrid({ metadata }: { metadata: any }) {
  const fields = [
    ['Title', metadata.title],
    ['Subtitle', metadata.subtitle],
    ['Logline', metadata.logline],
    ['Author', metadata.author?.map?.((a: any) => a.name).join(', ')],
    ['Genre', metadata.genre?.join?.(', ')],
    ['Tone', metadata.tone?.join?.(', ')],
    ['Runtime', metadata.runtimeMinutes ? `${metadata.runtimeMinutes} min` : null],
    ['Pages', metadata.estimatedPages],
    ['Draft Date', metadata.draftDate],
    ['Language', metadata.language],
  ].filter(([, v]) => v);

  if (fields.length === 0) return <p className="text-xs text-slate-600">No metadata</p>;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
      {fields.map(([label, value]) => (
        <div key={label as string} className="flex gap-2">
          <span className="text-[10px] text-slate-500 w-16 flex-shrink-0">{label}</span>
          <span className="text-xs text-slate-300">{value as string}</span>
        </div>
      ))}
    </div>
  );
}
