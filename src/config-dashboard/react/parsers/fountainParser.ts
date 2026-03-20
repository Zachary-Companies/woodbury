/**
 * Fountain screenplay parser.
 * Parses Fountain-formatted text into structured screenplay data.
 * Extracted from compositions-app.js for reuse.
 */

export interface ParsedMetadata {
  title?: string;
  author?: string;
  credit?: string;
  source?: string;
  draftdate?: string;
  contact?: string;
  copyright?: string;
  notes?: string;
  revision?: string;
}

export interface ParsedCharacter {
  name: string;
  dialogueCount: number;
}

export interface ParsedSection {
  type: 'scene' | 'act';
  title: string;
  location?: string;
  timeOfDay?: string;
  depth?: number;
  elementStart?: number;
}

export interface ParsedElement {
  type: 'dialogue' | 'action' | 'transition';
  content: string;
  characterName?: string;
  lines?: string[];
  modifiers?: string[];
}

export interface ParsedScreenplay {
  metadata: ParsedMetadata;
  characters: Record<string, ParsedCharacter>;
  locations: string[];
  sections: ParsedSection[];
  elements: ParsedElement[];
}

const NON_CHAR = /^(INT|EXT|EST|FADE|CUT|DISSOLVE|THE END|FLASHBACK|CONTINUED|MORE|DING|CLICK|BANG|SLAM|CRASH|BOOM|SMASH|TITLE|SUPER|INTERCUT|MONTAGE|LATER|BACK TO|END OF|SERIES OF|BEGIN|CLOSE ON|ANGLE ON|INSERT|WIDER|REVERSE|POV|TRACKING|ESTABLISHING|AERIAL|TIME CUT|MATCH CUT|JUMP CUT|SPLIT SCREEN)/;

const LOCATION_WORDS = /\b(ROOM|HALL|STREET|OFFICE|HOUSE|BUILDING|STORE|MALL|PARKING|LOT|ELEVATOR|KITCHEN|BATHROOM|BEDROOM|LOBBY|CORRIDOR|STAIRCASE|BASEMENT|ROOF|GARDEN|PARK|BRIDGE|ALLEY|HIGHWAY|HOSPITAL|STATION|AIRPORT|RESTAURANT|BAR|CLUB|CHURCH|SCHOOL|COURT|PRISON|CELL|WAREHOUSE|FACTORY|DOCK|BEACH|FOREST|FIELD|MOUNTAIN|CAVE|TUNNEL|INSIDE|OUTSIDE|FRONT|BACK|SIDE|ENTRANCE|EXIT|GARAGE|PORCH|DECK|BALCONY|WINDOW|DOOR|GATE|FENCE|WALL|FLOOR|CEILING|ATTIC)\b/i;

export function parseFountainText(text: string): ParsedScreenplay {
  const lines = text.split('\n');
  const metadata: ParsedMetadata = {};
  const characters: Record<string, ParsedCharacter> = {};
  const locations: string[] = [];
  const sections: ParsedSection[] = [];
  const elements: ParsedElement[] = [];
  let currentSection: ParsedSection | null = null;
  let i = 0;

  // Title page (key: value pairs at the start, with multi-line support)
  // Fountain spec: title page ends at the first blank line after at least one key:value pair
  let lastKey = '';
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(Title|Author|Credit|Source|Draft date|Contact|Copyright|Notes|Revision)\s*:\s*(.*)/i);
    if (match) {
      lastKey = match[1].toLowerCase().replace(/\s+/g, '');
      (metadata as any)[lastKey] = match[2].trim();
      i++;
    } else if (line.trim() === '') {
      i++;
      if (Object.keys(metadata).length > 0) break;
    } else if (lastKey && (line.startsWith('   ') || line.startsWith('\t'))) {
      // Multi-line continuation (indented lines belong to the last key)
      const existing = (metadata as any)[lastKey] || '';
      (metadata as any)[lastKey] = existing ? existing + '\n' + line.trim() : line.trim();
      i++;
    } else {
      break;
    }
  }

  // Body
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Scene heading
    if (/^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]/i.test(trimmed) || /^\.[A-Z]/.test(trimmed)) {
      const heading = trimmed.replace(/^\./, '');
      const locMatch = heading.match(/^(?:INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]+([^-–]+)/i);
      if (locMatch) {
        const locName = locMatch[1].trim().replace(/\s*[-–].*$/, '').trim();
        if (locName && !locations.includes(locName)) locations.push(locName);
      }
      const timeMatch = heading.match(/[-–]\s*(DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|LATER|CONTINUOUS|SAME)/i);
      currentSection = {
        type: 'scene',
        title: heading,
        location: locMatch ? locMatch[1].trim().replace(/\s*[-–].*$/, '').trim() : heading,
        timeOfDay: timeMatch ? timeMatch[1].toUpperCase() : '',
        elementStart: elements.length,
      };
      sections.push(currentSection);
      continue;
    }

    // Secondary scene heading — ONLY if it looks like a proper scene slug
    // Must have INT/EXT prefix OR be forced with a period. Don't auto-detect
    // random ALL CAPS lines as scenes (they're usually sub-locations or action).
    // This is intentionally conservative — only forced scene headings (. prefix) qualify.

    // Transition
    if (/^(FADE IN|FADE OUT|FADE TO|CUT TO|DISSOLVE TO|SMASH CUT|MATCH CUT).*:?\s*$/i.test(trimmed) || /^>\s/.test(trimmed)) {
      elements.push({ type: 'transition', content: trimmed.replace(/^>\s*/, '') });
      continue;
    }

    // Character name detection
    const prevLineBlank = (i === 0) || !lines[i - 1].trim();
    const isAllCaps = /^[A-Z][A-Z0-9\s.\-']+(\s*\(.*\))?\s*$/.test(trimmed);
    let hasDialogueNext = false;
    if (isAllCaps && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      hasDialogueNext = nextLine.length > 0 && (/^\(/.test(nextLine) || !/^[A-Z][A-Z0-9\s.\-']+$/.test(nextLine));
    }

    if (prevLineBlank && isAllCaps && hasDialogueNext && trimmed.length > 1 && trimmed.length < 40 && !NON_CHAR.test(trimmed)) {
      const charName = trimmed.replace(/\s*\(.*\)$/, '').trim();
      const wordCount = charName.split(/\s+/).length;
      const looksLikeLocation = wordCount >= 3 && LOCATION_WORDS.test(charName);

      if (!looksLikeLocation) {
        if (!characters[charName]) {
          characters[charName] = { name: charName, dialogueCount: 0 };
        }
        characters[charName].dialogueCount++;

        const dialogueLines: string[] = [];
        let parenthetical = '';
        let j = i + 1;
        while (j < lines.length && lines[j].trim()) {
          const dline = lines[j].trim();
          if (/^\(.*\)$/.test(dline)) {
            parenthetical = dline.replace(/^\(|\)$/g, '');
          } else if (/^[A-Z][A-Z0-9\s.\-']+$/.test(dline) && dline.length < 40 && !NON_CHAR.test(dline)) {
            break;
          } else {
            dialogueLines.push(dline);
          }
          j++;
        }

        if (dialogueLines.length > 0) {
          elements.push({
            type: 'dialogue',
            characterName: charName,
            content: dialogueLines.join(' '),
            lines: dialogueLines,
            modifiers: parenthetical ? [parenthetical] : [],
          });
          i = j - 1;
          continue;
        } else {
          characters[charName].dialogueCount--;
          if (characters[charName].dialogueCount <= 0) delete characters[charName];
        }
      }
    }

    // Section header
    if (/^#{1,6}\s+/.test(trimmed)) {
      const depth = trimmed.match(/^(#+)/)![1].length;
      sections.push({ type: 'act', title: trimmed.replace(/^#+\s+/, ''), depth });
      continue;
    }

    // Action
    elements.push({ type: 'action', content: trimmed });
  }

  return { metadata, characters, locations, sections, elements };
}

// ── Scene Builder ─────────────────────────────────────────────
// Takes parsed screenplay data + resolved characters/locations and produces
// a scene-grouped data model where each scene contains its own dialogue,
// actions, shots, and character list.

import type { SceneData, SceneDialogue, SceneShot, Character, Location } from '../stores/pipeline-store';

export interface BuildScenesInput {
  sections: ParsedSection[];
  elements: Array<ParsedElement & { id?: string; characterId?: string; characterIds?: string[] }>;
  characters: Array<{ id: string; name: string; displayName?: string }>;
  locations: Array<{ id: string; name: string }>;
}

export function buildScenes(input: BuildScenesInput): SceneData[] {
  const { sections, elements, characters, locations } = input;
  const scenes: SceneData[] = [];

  // Build character name→id map
  const charNameToId: Record<string, string> = {};
  for (const c of characters) {
    if (c.name) charNameToId[c.name.toUpperCase()] = c.id;
    if (c.displayName) charNameToId[c.displayName.toUpperCase()] = c.id;
  }

  // Build location name→id map
  const locNameToId: Record<string, string> = {};
  for (const l of locations) {
    if (l.name) locNameToId[l.name.toUpperCase()] = l.id;
  }

  // Collect scene-type sections (flatten acts→scenes)
  let sceneSections: Array<ParsedSection & { actTitle?: string }> = [];
  function flatten(secs: ParsedSection[], actTitle?: string) {
    for (const s of secs) {
      if (s.type === 'scene') sceneSections.push({ ...s, actTitle });
      // Acts with children
      if ((s as any).children) flatten((s as any).children, s.type === 'act' ? s.title : actTitle);
    }
  }
  flatten(sections);

  // If no scene-type sections, auto-detect from elements
  if (sceneSections.length === 0) {
    const locationSet = new Set(locations.map(l => l.name.toUpperCase()));
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      if (e.type !== 'action' || !e.content) continue;
      const text = e.content.trim();

      // Standard scene heading: INT./EXT.
      const isStandard = /^(INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]/i.test(text) || /^\.[A-Z]/.test(text);

      // Non-standard: ALL-CAPS short line that matches a known location or contains location words
      const isLocationHeading = !isStandard &&
        text === text.toUpperCase() &&
        text.length >= 3 && text.length <= 50 &&
        !/^(WIDE|MEDIUM|CLOSE|EXTREME|TWO SHOT|INSERT|ANGLE|POV|TRACKING|ESTABLISHING|AERIAL)/i.test(text) &&
        !/^(FADE|CUT|DISSOLVE|SMASH|MATCH|JUMP|SPLIT|TITLE|SUPER|INTERCUT|MONTAGE)/i.test(text) &&
        (locationSet.has(text) || LOCATION_WORDS.test(text));

      if (isStandard || isLocationHeading) {
        const locMatch = text.match(/^(?:INT|EXT|EST|INT\.?\/?EXT|I\/E)[.\s]+([^-–]+)/i);
        const locName = locMatch ? locMatch[1].trim().replace(/\s*[-–].*$/, '').trim() : text;
        const timeMatch = text.match(/[-–]\s*(DAY|NIGHT|MORNING|EVENING|AFTERNOON|DAWN|DUSK|LATER|CONTINUOUS|SAME)/i);

        sceneSections.push({
          type: 'scene',
          title: text,
          location: locName,
          timeOfDay: timeMatch ? timeMatch[1].toUpperCase() : undefined,
          elementStart: i + 1,
        });
      }
    }
  }

  if (sceneSections.length === 0) return [];

  // Build scenes from sections
  for (let si = 0; si < sceneSections.length; si++) {
    const sec = sceneSections[si];
    const start = sec.elementStart ?? 0;
    const end = si + 1 < sceneSections.length ? (sceneSections[si + 1].elementStart ?? elements.length) : elements.length;

    const sceneId = `scene-${si}`;
    const charIds = new Set<string>();
    const dialogue: SceneDialogue[] = [];
    const actions: string[] = [];
    const shots: SceneShot[] = [];

    for (let ei = start; ei < end && ei < elements.length; ei++) {
      const e = elements[ei];

      if (e.type === 'dialogue') {
        const cid = e.characterId || charNameToId[(e.characterName || '').toUpperCase()] || '';
        if (cid) charIds.add(cid);
        dialogue.push({
          elementId: e.id || `elem-${ei}`,
          characterId: cid,
          characterName: e.characterName || '',
          lines: e.lines || [e.content],
          modifiers: e.modifiers,
        });
      } else if (e.type === 'action' && e.content) {
        // Check if this is a shot description (from previous generation)
        const shotMatch = e.content.match(/^(WIDE SHOT|MEDIUM SHOT|CLOSE-UP|EXTREME CLOSE-UP|TWO SHOT|INSERT|ANGLE ON|POV|TRACKING SHOT|ESTABLISHING SHOT|AERIAL SHOT|MEDIUM CLOSE-UP)\s*[—–-]\s*(.*)/i);
        if (shotMatch) {
          const shotCharIds = (e as any).characterIds || [];
          shotCharIds.forEach((id: string) => charIds.add(id));
          shots.push({
            id: e.id || `shot-${sceneId}-${shots.length}`,
            shotType: shotMatch[1].toUpperCase(),
            description: shotMatch[2] || e.content,
            characterIds: shotCharIds,
            previsPath: undefined,
          });
        } else {
          actions.push(e.content);
        }
      }
    }

    // Resolve location ID
    const locKey = (sec.location || '').toUpperCase();
    const locationId = locNameToId[locKey] || undefined;

    scenes.push({
      id: sceneId,
      title: sec.title,
      location: sec.location || '',
      locationId,
      timeOfDay: sec.timeOfDay,
      actTitle: (sec as any).actTitle,
      characterIds: [...charIds],
      dialogue,
      actions,
      shots,
      elementRange: [start, end],
    });
  }

  // Link previs paths from previsualizations if available
  // (caller should do this after buildScenes with project.previsualizations)

  return scenes;
}
