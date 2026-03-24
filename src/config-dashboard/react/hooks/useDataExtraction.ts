/**
 * useDataExtraction — extracts editor clips, scenes, characters, and assets
 * from the pipeline's ProjectData. React equivalent of the vanilla extractDataFromState().
 *
 * All data is sourced from project.json (ProjectData) — NOT from nodeData.
 * nodeData is only used for persisted user clips (_editor node).
 */
import { useMemo } from 'react';
import type { ProjectData, SceneShot } from '../../../dashboard/project-types.js';
import {
  type Clip, type EditorScene, type EditorCharacter, type EditorAsset, type Track,
  DEFAULT_TRACKS, charColor, stableId,
} from '../stores/editorStore';

interface ExtractionResult {
  clips: Clip[];
  scenes: EditorScene[];
  characters: EditorCharacter[];
  assets: EditorAsset[];
  tracks: Track[];
  duration: number;
  previsMap: Record<string, string>;
  dialogAudioMap: Record<string, string>;
  dialogDurationMap: Record<string, number>;
  userClips: Clip[];
}

export function useDataExtraction(
  project: ProjectData | null,
  appState: any | null,
  fillGaps: boolean,
  extraDurations?: Record<string, number>,
): ExtractionResult {
  return useMemo(() => {
    if (!project) {
      return {
        clips: [], scenes: [], characters: [], assets: [],
        tracks: DEFAULT_TRACKS.map(t => ({ ...t })),
        duration: 120, previsMap: {}, dialogAudioMap: {}, dialogDurationMap: {}, userClips: [],
      };
    }

    const scenes: EditorScene[] = [];
    const characters: EditorCharacter[] = [];
    const assets: EditorAsset[] = [];
    const clips: Clip[] = [];
    const previsShots: any[] = [];
    const sceneGroupedShots: SceneShot[] = [];
    let timeOffset = 0;

    // ── Pre-build audio duration map from dialogue-audio assets ──
    // This must happen BEFORE element processing so clip durations can use actual audio lengths.
    const dialogAudioMap: Record<string, string> = {};
    const dialogDurationMap: Record<string, number> = {};
    const rawAssets = (project as any).assets;
    const assetArray = Array.isArray(rawAssets) ? rawAssets : (rawAssets?.assets || []);
    const allAssetSources = [
      ...assetArray,
      ...((project as any).dialogueAudio?.assets || []),
    ];
    for (const a of allAssetSources) {
      if (!a) continue;
      if (a.type === 'dialogue-audio' && a.filePath && a.metadata?.dialogueElementId) {
        dialogAudioMap[a.metadata.dialogueElementId] = a.filePath;
        if (a.metadata.duration && typeof a.metadata.duration === 'number' && a.metadata.duration > 0) {
          dialogDurationMap[a.metadata.dialogueElementId] = a.metadata.duration;
        }
      }
    }

    // Merge in client-detected durations (from Audio element probing)
    if (extraDurations) {
      for (const [elemId, dur] of Object.entries(extraDurations)) {
        if (dur > 0) {
          dialogDurationMap[elemId] = dur;
        }
      }
    }

    // ── Characters ──────────────────────────────────────────
    if (project.characters) {
      for (const c of project.characters) {
        if (c && c.name) characters.push(c as EditorCharacter);
      }
    }

    // ── Sections → scenes ───────────────────────────────────
    if (project.sections) {
      project.sections.forEach((sec, si) => {
        const secName = (sec as any).heading || sec.title;
        if (secName) {
          scenes.push({
            id: sec.id || ('scene-' + si),
            name: secName,
            duration: 0,
            startTime: 0,
            children: (sec.children || []).map((c: any) => c.id || c),
            color: ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981'][si % 5],
          });
        }
      });
    }

    // ── Scene-based time budgeting ─────────────────────────
    //   Each scene gets a time budget based on its content.
    //   If dialogue has rendered audio, the audio duration drives the timeline.
    //   Otherwise, a compact fixed budget keeps things manageable.
    const DEFAULT_SCENE_BUDGET = 8; // seconds per scene when no audio
    const DIALOG_GAP = 0.3;         // gap between dialogue clips
    const SCENE_GAP = 0.5;          // gap between scenes

    // Build scene element ranges from project.scenes (authoritative) or sections
    interface SceneRange { sceneId: string; start: number; end: number; }
    const sceneRanges: SceneRange[] = [];

    if (project.scenes && project.scenes.length > 0) {
      for (const sc of project.scenes) {
        if (sc && sc.elementRange) {
          sceneRanges.push({ sceneId: sc.id, start: sc.elementRange[0], end: sc.elementRange[1] });
        }
      }
    }

    // If no scene ranges, treat all elements as one block
    if (sceneRanges.length === 0 && project.elements) {
      sceneRanges.push({ sceneId: 'all', start: 0, end: project.elements.length });
    }

    // Process elements scene by scene
    if (project.elements) {
      for (const range of sceneRanges) {
        const sceneStart = timeOffset;

        // First pass: compute natural weights and find audio-driven durations
        interface ElemInfo { idx: number; weight: number; audioDur: number | null; }
        const elems: ElemInfo[] = [];
        let totalWeight = 0;
        let totalAudioDur = 0;
        let audioCount = 0;

        for (let ei = range.start; ei < Math.min(range.end, project.elements.length); ei++) {
          const elem = project.elements[ei];
          if (!elem) continue;
          let w = 0;
          if (elem.type === 'dialogue') {
            w = Math.max(1, (elem.lines || []).join(' ').length / 15);
            const audioDur = dialogDurationMap[elem.id] || null;
            if (audioDur) { totalAudioDur += audioDur + DIALOG_GAP; audioCount++; }
            elems.push({ idx: ei, weight: w, audioDur });
            totalWeight += w;
          } else if (elem.type === 'action') {
            w = Math.max(0.5, (elem.content || '').length / 25);
            elems.push({ idx: ei, weight: w, audioDur: null });
            totalWeight += w;
          } else if (elem.type === 'shot') {
            w = Math.max(1, ((elem.content || elem.shotText || '').length / 20));
            elems.push({ idx: ei, weight: w, audioDur: null });
            totalWeight += w;
          } else if (elem.type === 'scene-heading') {
            const matchScene = scenes.find(s =>
              s.children && s.children.indexOf(elem.id) !== -1
            );
            if (matchScene) matchScene.startTime = sceneStart;
            continue;
          } else {
            continue; // transition, etc.
          }
        }

        if (elems.length === 0) {
          timeOffset += SCENE_GAP;
          continue;
        }

        // Compute scene budget:
        // - If any dialogue has audio, use audio durations as the driver.
        //   Non-audio elements get proportional time within remaining budget.
        // - If no audio, use DEFAULT_SCENE_BUDGET.
        const hasAudio = audioCount > 0;
        let budget: number;

        if (hasAudio) {
          // Audio-driven: total audio time + proportional time for non-dialog elements
          const nonDialogWeight = elems.filter(e => e.audioDur === null && project.elements![e.idx].type !== 'dialogue').reduce((sum, e) => sum + e.weight, 0);
          const unrenderedDialogWeight = elems.filter(e => e.audioDur === null && project.elements![e.idx].type === 'dialogue').reduce((sum, e) => sum + e.weight, 0);
          // Give non-audio elements proportional time based on how much audio there is
          const avgAudioPerWeight = totalWeight > 0 ? totalAudioDur / (totalWeight - nonDialogWeight - unrenderedDialogWeight || 1) : 1;
          const nonAudioTime = (nonDialogWeight + unrenderedDialogWeight) * avgAudioPerWeight;
          budget = totalAudioDur + nonAudioTime;
        } else {
          budget = DEFAULT_SCENE_BUDGET;
        }

        // Second pass: place clips
        let localOffset = 0;

        for (const { idx, weight, audioDur } of elems) {
          const elem = project.elements[idx];

          // Determine clip duration
          let clipDur: number;
          if (audioDur !== null) {
            // Audio-driven: use actual audio duration
            clipDur = audioDur;
          } else if (hasAudio) {
            // Scene has some audio — scale non-audio elements proportionally
            const audioElemWeight = elems.filter(e => e.audioDur !== null).reduce((sum, e) => sum + e.weight, 0);
            const nonAudioBudget = budget - totalAudioDur;
            const nonAudioWeight = totalWeight - audioElemWeight;
            clipDur = nonAudioWeight > 0 ? (weight / nonAudioWeight) * nonAudioBudget : 1;
          } else {
            // No audio — distribute proportionally within default budget
            clipDur = totalWeight > 0 ? (weight / totalWeight) * budget : budget / elems.length;
          }

          if (elem.type === 'dialogue') {
            clips.push({
              id: stableId('dialog', elem.id),
              elementId: elem.id,
              trackId: 'dialog',
              type: 'dialog',
              name: (elem.characterName || 'UNKNOWN') + ': ' + ((elem.lines || [])[0] || '').slice(0, 40),
              startTime: sceneStart + localOffset,
              duration: clipDur,
              characterName: elem.characterName,
              characterId: elem.characterId,
              lines: elem.lines || [],
              color: charColor(elem.characterName || ''),
            });
            localOffset += clipDur + (audioDur !== null ? DIALOG_GAP : 0);
          } else if (elem.type === 'action') {
            clips.push({
              id: stableId('caption', elem.id),
              elementId: elem.id,
              trackId: 'subtitles',
              type: 'caption',
              name: (elem.content || '').slice(0, 50),
              startTime: sceneStart + localOffset,
              duration: clipDur,
              content: elem.content,
            });
            localOffset += clipDur;
          } else if (elem.type === 'shot') {
            clips.push({
              id: stableId('shot', elem.id),
              elementId: elem.id,
              trackId: 'visuals',
              type: 'image',
              name: (elem.shotText || elem.content || '').slice(0, 50),
              startTime: sceneStart + localOffset,
              duration: clipDur,
              content: elem.shotText || elem.content,
            });
            localOffset += clipDur;
          }
        }

        timeOffset += Math.max(localOffset, budget) + SCENE_GAP;
      }

      // Handle any elements outside scene ranges (orphans before first scene, etc.)
      const coveredIndices = new Set<number>();
      for (const r of sceneRanges) {
        for (let i = r.start; i < r.end; i++) coveredIndices.add(i);
      }
      for (let ei = 0; ei < project.elements.length; ei++) {
        if (coveredIndices.has(ei)) continue;
        const elem = project.elements[ei];
        if (!elem) continue;
        if (elem.type === 'dialogue') {
          const clipDur = 1;
          clips.push({
            id: stableId('dialog', elem.id),
            elementId: elem.id,
            trackId: 'dialog',
            type: 'dialog',
            name: (elem.characterName || 'UNKNOWN') + ': ' + ((elem.lines || [])[0] || '').slice(0, 40),
            startTime: timeOffset,
            duration: clipDur,
            characterName: elem.characterName,
            characterId: elem.characterId,
            lines: elem.lines || [],
            color: charColor(elem.characterName || ''),
          });
          timeOffset += clipDur;
        } else if (elem.type === 'action') {
          const clipDur = 0.5;
          clips.push({
            id: stableId('caption', elem.id),
            elementId: elem.id,
            trackId: 'subtitles',
            type: 'caption',
            name: (elem.content || '').slice(0, 50),
            startTime: timeOffset,
            duration: clipDur,
            content: elem.content,
          });
          timeOffset += clipDur;
        }
      }
    }

    // ── Scene-grouped shots from project.scenes[] ───────────
    if (project.scenes) {
      for (const scene of project.scenes) {
        if (!scene || !scene.shots) continue;
        for (const shot of scene.shots) {
          if (shot && shot.id) sceneGroupedShots.push(shot);
        }
      }
    }

    // ── Previsualizations from project ──────────────────────
    if ((project as any).previsualizations?.shots) {
      for (const s of (project as any).previsualizations.shots) {
        previsShots.push(s);
      }
    }

    // ── Assets from project ─────────────────────────────────
    const projectAssets = Array.isArray((project as any).assets)
      ? (project as any).assets
      : ((project as any).assets?.assets || []);
    for (const a of projectAssets) {
      if (a && (a.name || a.filePath)) assets.push(a);
    }

    // ── Dialogue audio assets from project.dialogueAudio ───
    const daAssets = (project as any).dialogueAudio?.assets;
    if (Array.isArray(daAssets)) {
      for (const a of daAssets) {
        if (a && a.filePath) assets.push(a);
      }
    }

    // ── If no scenes from sections, build from project.scenes ──
    if (scenes.length === 0 && project.scenes) {
      project.scenes.forEach((sc, si) => {
        if (!sc || !sc.title) return;
        scenes.push({
          id: sc.id || ('scene-' + si),
          name: sc.title,
          duration: 0,
          startTime: 0,
          children: [],
          color: ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981'][si % 5],
        });
      });
    }

    // ── Update scene durations from clips ─────────────────
    // Compute each scene's actual duration from the clips it contains.
    for (const s of scenes) {
      const sceneClips = clips.filter(c => c.startTime >= s.startTime);
      if (sceneClips.length > 0) {
        const sceneEnd = Math.max(...sceneClips.filter(c => c.startTime < s.startTime + DEFAULT_SCENE_BUDGET * 3).map(c => c.startTime + c.duration));
        s.duration = Math.max(sceneEnd - s.startTime, DEFAULT_SCENE_BUDGET);
      } else {
        s.duration = DEFAULT_SCENE_BUDGET;
      }
    }

    // ── Deduplicate characters ──────────────────────────────
    const charMap: Record<string, EditorCharacter> = {};
    for (const c of characters) { if (!charMap[c.id]) charMap[c.id] = c; }
    const dedupedCharacters = Object.values(charMap);

    // ── Build previs map ────────────────────────────────────
    const previsMap: Record<string, string> = {};

    // 1) Assets of type previs-frame (baseline)
    for (const a of assets) {
      if (a.type === 'previs-frame' && a.filePath && a.metadata?.shotElementId) {
        const eid = a.metadata.shotElementId;
        if (!previsMap[eid] || (previsMap[eid].startsWith('/tmp/') && !a.filePath.startsWith('/tmp/'))) {
          previsMap[eid] = a.filePath;
        }
      }
    }

    // 2) Previs shots with _generatedFilePath (regenerated images)
    for (const pv of previsShots) {
      if (!pv.shotElementId) continue;
      if (pv._generatedFilePath) {
        previsMap[pv.shotElementId] = pv._generatedFilePath;
      }
    }

    // 3) Scene-grouped shots (most authoritative — has previsPath and generations)
    //    Build a map of scene → shots, then place shots at the correct scene time
    //    instead of appending at the end of the timeline.

    // First: build previsMap entries from scene-grouped shots
    for (const shot of sceneGroupedShots) {
      if (shot.previsPath) {
        previsMap[shot.id] = shot.previsPath;
      }
      if (shot.generations && shot.generations.length > 0) {
        const selected = shot.selectedGenerationId
          ? shot.generations.find(g => g.id === shot.selectedGenerationId)
          : shot.generations[shot.generations.length - 1];
        if (selected?.filePath) {
          previsMap[shot.id] = selected.filePath;
        }
      }
    }

    // Second: build a map from scene id to its timeline startTime.
    //   Use actual clip positions from the element processing pass above,
    //   since scene budgets can vary (audio-driven vs default).
    const sceneStartTimeMap: Record<string, number> = {};
    if (project.scenes) {
      for (const sc of project.scenes) {
        if (!sc) continue;
        // Find the earliest clip in this scene's element range
        if (sc.elementRange) {
          const rangeStart = sc.elementRange[0];
          const rangeEnd = sc.elementRange[1];
          const elements = project.elements || [];
          let earliestTime = Infinity;
          let latestEnd = 0;
          for (let ei = rangeStart; ei < Math.min(rangeEnd, elements.length); ei++) {
            const elem = elements[ei];
            if (!elem) continue;
            const matchClip = clips.find(c => c.elementId === elem.id);
            if (matchClip) {
              if (matchClip.startTime < earliestTime) earliestTime = matchClip.startTime;
              const clipEnd = matchClip.startTime + matchClip.duration;
              if (clipEnd > latestEnd) latestEnd = clipEnd;
            }
          }
          if (earliestTime < Infinity) {
            sceneStartTimeMap[sc.id] = earliestTime;
          }
        }
        // Fallback: find by matching EditorScene
        if (sceneStartTimeMap[sc.id] === undefined) {
          const edScene = scenes.find(s => s.name === sc.title || s.id === sc.id);
          if (edScene) sceneStartTimeMap[sc.id] = edScene.startTime;
        }
      }
    }

    // Third: create visual clips ONLY for shots that have a previs image.
    //   Distribute them evenly across their parent scene's duration.
    if (project.scenes) {
      for (const sc of project.scenes) {
        if (!sc || !sc.shots || sc.shots.length === 0) continue;
        const shotsWithPrevis = sc.shots.filter(shot => shot && shot.id && previsMap[shot.id]);
        if (shotsWithPrevis.length === 0) continue;

        const sceneStart = sceneStartTimeMap[sc.id] ?? 0;
        // Find scene duration from clips in this scene's range
        let sceneDur = DEFAULT_SCENE_BUDGET;
        if (sc.elementRange) {
          const elements = project.elements || [];
          let latestEnd = sceneStart;
          for (let ei = sc.elementRange[0]; ei < Math.min(sc.elementRange[1], elements.length); ei++) {
            const elem = elements[ei];
            if (!elem) continue;
            const matchClip = clips.find(c => c.elementId === elem.id);
            if (matchClip) {
              const clipEnd = matchClip.startTime + matchClip.duration;
              if (clipEnd > latestEnd) latestEnd = clipEnd;
            }
          }
          sceneDur = Math.max(latestEnd - sceneStart, DEFAULT_SCENE_BUDGET);
        }
        // Calculate shot durations: honor user-set durations, distribute remaining time
        const userSetTotal = shotsWithPrevis.reduce((sum, s) => sum + (s.duration || 0), 0);
        const autoCount = shotsWithPrevis.filter(s => !s.duration).length;
        const remainingTime = Math.max(sceneDur - userSetTotal, autoCount * 1);
        const autoShotDur = autoCount > 0 ? remainingTime / autoCount : sceneDur / shotsWithPrevis.length;

        let shotOffset = 0;
        for (let si = 0; si < shotsWithPrevis.length; si++) {
          const shot = shotsWithPrevis[si];
          const dur = shot.duration || autoShotDur;
          const hasVisualClip = clips.find(c => c.elementId === shot.id && c.trackId === 'visuals');
          if (!hasVisualClip) {
            clips.push({
              id: stableId('shot', shot.id),
              elementId: shot.id,
              trackId: 'visuals',
              type: 'image',
              name: (shot.shotType || '') + ' — ' + (shot.description || '').slice(0, 40),
              startTime: sceneStart + shotOffset,
              duration: dur,
              content: shot.description,
              filePath: previsMap[shot.id],
            });
          }
          shotOffset += dur;
        }
      }
    }

    // ── Ensure no visual clips overlap ──────────────────────
    //   Sort visual clips by startTime, then if any overlap the next,
    //   trim the earlier clip's duration so it ends at the next clip's start.
    const visualClips = clips.filter(c => c.trackId === 'visuals');
    visualClips.sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < visualClips.length - 1; i++) {
      const clipEnd = visualClips[i].startTime + visualClips[i].duration;
      if (clipEnd > visualClips[i + 1].startTime) {
        visualClips[i].duration = visualClips[i + 1].startTime - visualClips[i].startTime;
      }
    }

    // ── Fill gaps: stretch each visual clip to reach the next ──
    //   Cap stretch so clips don't extend across huge gaps between scenes.
    if (fillGaps) {
      const maxStretch = 60;
      for (let i = 0; i < visualClips.length - 1; i++) {
        const gap = visualClips[i + 1].startTime - (visualClips[i].startTime + visualClips[i].duration);
        if (gap > 0) {
          const stretch = Math.min(gap, maxStretch);
          visualClips[i].duration += stretch;
        }
      }
    }

    // ── Load persisted user clips from nodeData _editor node ──
    let loadedUserClips: Clip[] = [];
    if (appState?.nodeData?.['_editor']) {
      const edOut = appState.nodeData['_editor'].outputs || appState.nodeData['_editor'];
      if (edOut._editorUserClips && Array.isArray(edOut._editorUserClips)) {
        loadedUserClips = edOut._editorUserClips;
      }
    }

    // Merge user clips into clips
    for (const uc of loadedUserClips) {
      if (!clips.find(c => c.id === uc.id)) {
        clips.push(uc);
      }
    }

    const tracks = DEFAULT_TRACKS.map(t => ({ ...t }));
    const duration = Math.max(60, timeOffset + 10);

    return {
      clips,
      scenes,
      characters: dedupedCharacters,
      assets,
      tracks,
      duration,
      previsMap,
      dialogAudioMap,
      dialogDurationMap,
      userClips: loadedUserClips,
    };
  }, [project, appState, fillGaps, extraDurations]);
}
