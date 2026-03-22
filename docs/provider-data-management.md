# Provider-Based Data Management

How pipeline views should manage data using the PipelineProvider system. This guide covers reading, updating, creating, and deleting entities through React context providers rather than direct API calls.

---

## Why Providers

Pipeline views render inside a shared React tree. The `PipelineProvider` owns the canonical project state — characters, locations, elements, sections, metadata — and exposes it through three split contexts:

| Context | Hook | What it holds |
|---------|------|---------------|
| `IdentityContext` | `usePipelineIdentity()` | pipelineId, name, folder, loading/saving flags |
| `ProjectContext` | `useProjectData()` | project data + mutation functions |
| `AIOperationsContext` | `useAIOperations()` | enrichment, image generation |

The legacy `usePipeline()` hook merges all three. Fine for extension views; avoid in core components (causes unnecessary re-renders).

The provider handles:
- **Fetching** project data from `/api/project/:id` on mount
- **Optimistic updates** — UI updates instantly on dispatch, before the server round-trip
- **Auto-saving** — dirty state triggers a debounced PATCH after 2 seconds
- **Reload polling** — long-running operations (headshot generation, enrichment) poll for fresh data so cards update as results arrive
- **Consistency** — every view sees the same data because they share the same context

If a view bypasses the provider and calls APIs directly, the in-memory state goes stale. Other views won't see the change until the next reload. **Always mutate through the provider.**

---

## Reading Data

```tsx
import { useProjectData } from './sdk';

function MyView() {
  const { project } = useProjectData();
  if (!project) return <div>Loading...</div>;

  const characters = project.characters || [];
  const locations = project.locations || [];
  const elements = project.elements || [];

  return (
    <div>
      {characters.map(c => <CharacterCard key={c.id} character={c} />)}
    </div>
  );
}
```

The `project` object is `ProjectData` — the full in-memory state. It updates reactively: when any mutation fires, components re-render with the new data.

### What's available on `project`

| Field | Type | Description |
|-------|------|-------------|
| `metadata` | `ScriptMetadata` | Title, author, genre, tone, logline |
| `characters` | `Character[]` | Cast with descriptions, traits, images |
| `locations` | `Location[]` | Settings with descriptions, images |
| `elements` | `Element[]` | Screenplay elements (dialogue, action, etc.) |
| `sections` | `Section[]` | Act/scene structure |
| `scenes` | `SceneData[]` | Computed scene groupings (auto-derived if absent) |
| `previsualizations` | `PrevisData` | Shot visualizations |
| `_fountainSource` | `string` | Raw .fountain text |

---

## Updating Entities

### Prefer exact updates over bulk updates

The provider exposes typed update functions that target a single entity by ID. **Always use these for single-entity changes.** They dispatch to the reducer, mark state dirty, and trigger auto-save — without replacing the entire array.

```tsx
import { useProjectData } from './sdk';

function CharacterEditor({ character }) {
  const { updateCharacter } = useProjectData();

  const handleNameChange = (newName: string) => {
    // Good — targets one character, leaves others untouched
    updateCharacter(character.id, { name: newName });
  };

  const handleTraitsChange = (traits: string[]) => {
    // Good — only the traits field on this character changes
    updateCharacter(character.id, { traits });
  };
}
```

The reducer finds the character by ID and merges only the fields you pass. Everything else stays as-is.

### Available exact update functions

| Function | Signature | What it does |
|----------|-----------|--------------|
| `updateCharacter` | `(id, Partial<Character>)` | Merges fields into the character with matching id |
| `updateLocation` | `(id, Partial<Location>)` | Merges fields into the location with matching id |
| `updateElement` | `(id, Partial<Element>)` | Merges fields into the element with matching id |

### Why exact updates matter

```tsx
// Good — exact update, only touches one character
updateCharacter(character.id, { description: 'New description' });

// Bad — replaces the entire characters array to change one field
const updated = project.characters.map(c =>
  c.id === character.id ? { ...c, description: 'New description' } : c
);
updateProject({ characters: updated });
```

Both achieve the same result, but the exact update is:
- **Safer** — no risk of accidentally dropping a character if the array is stale
- **Clearer** — the intent ("update this character's description") is obvious
- **Cheaper** — the reducer does a targeted map, not a full array replacement

### When to use `updateProject` (bulk updates)

Use `updateProject` only when the operation genuinely touches the array structure itself — not individual items within it:

| Operation | Use |
|-----------|-----|
| Edit a character's name | `updateCharacter(id, { name })` |
| Edit a character's traits | `updateCharacter(id, { traits })` |
| Set a character's image | `updateCharacter(id, { imagePath })` |
| Edit a location's description | `updateLocation(id, { description })` |
| **Reorder** characters | `updateProject({ characters: reordered })` |
| **Add** a new character | `updateProject({ characters: [...existing, newChar] })` |
| **Delete** a character | `updateProject({ characters: filtered })` |
| **Replace all** after import | `updateProject({ characters: imported })` |
| Update metadata | `updateProject({ metadata: { ...project.metadata, title } })` |

The rule: if you have an entity ID and you're changing fields on that entity, use the exact update function. If you're changing which entities exist or their order, use `updateProject`.

---

## Creating Entities

Creating requires modifying the array, so `updateProject` is correct here:

```tsx
const { project, updateProject } = useProjectData();

function addCharacter(name: string) {
  const newChar = {
    id: `char-${Date.now()}`,
    name,
    description: '',
    traits: [],
    role: 'minor',
  };
  updateProject({
    characters: [...(project.characters || []), newChar],
  });
}

function addLocation(name: string, description: string) {
  const newLoc = {
    id: `loc-${Date.now()}`,
    name,
    description,
  };
  updateProject({
    locations: [...(project.locations || []), newLoc],
  });
}
```

The reducer merges `{ characters: [...] }` into the project, marks dirty, and auto-save writes the full array to `characters/_index.json`.

### ID generation

Use `Date.now()` or a UUID for client-generated IDs. The server doesn't assign IDs — whatever the client sends is canonical. Convention: `char-`, `loc-`, `elem-`, `scene-` prefixes.

---

## Deleting Entities

Deleting also requires modifying the array:

```tsx
const { project, updateProject } = useProjectData();

function deleteCharacter(id: string) {
  updateProject({
    characters: project.characters.filter(c => c.id !== id),
  });
}

function deleteLocation(id: string) {
  updateProject({
    locations: project.locations.filter(l => l.id !== id),
  });
}
```

### Cascading deletes

When deleting a character, consider cleaning up references elsewhere. This is one of the few cases where touching multiple arrays in one `updateProject` call is correct:

```tsx
function deleteCharacterCascade(id: string) {
  // Remove character
  const characters = project.characters.filter(c => c.id !== id);

  // Remove from scene participation
  const scenes = (project.scenes || []).map(s => ({
    ...s,
    characterIds: s.characterIds.filter(cid => cid !== id),
    dialogue: s.dialogue.filter(d => d.characterId !== id),
  }));

  // One updateProject call — both arrays change atomically
  updateProject({ characters, scenes });
}
```

---

## AI Operations

Long-running operations (enrichment, image generation) live on the `AIOperationsContext` to avoid re-rendering the entire project tree during progress updates.

### Single-entity enrichment

Enrichment targets one entity. After the API call, the provider reloads and the exact entity updates:

```tsx
import { useAIOperations } from './sdk';

function EnrichButton({ characterId }) {
  const { enrichCharacter } = useAIOperations();
  const [loading, setLoading] = useState(false);

  const handleEnrich = async () => {
    setLoading(true);
    try {
      await enrichCharacter(characterId);
      // Provider auto-reloads — the enriched data appears on the card
    } catch (err) {
      console.error('Enrich failed:', err);
    }
    setLoading(false);
  };

  return (
    <button onClick={handleEnrich} disabled={loading}>
      {loading ? 'Enriching...' : 'Enrich with AI'}
    </button>
  );
}
```

### Batch image generation with progress

`generateCharacterImages` and `generateLocationImages` are the correct place for bulk operations — they're genuinely batch. They accept an optional progress callback. The backend streams ndjson progress events so the UI can show per-item progress:

```tsx
const { generateCharacterImages } = useAIOperations();
const [progress, setProgress] = useState(null);

const handleGenerate = async () => {
  const missing = characters.filter(c => !c.imagePath);
  setProgress({ current: 0, total: missing.length, name: '' });

  await generateCharacterImages((completed, name) => {
    setProgress({ current: completed, total: missing.length, name });
  });

  setProgress(null);
  // Cards have already updated via polling during generation
};
```

The provider polls `reload()` every 2 seconds during generation, so character cards update their images as each one completes — no manual refresh needed.

Note that even though this is a batch operation at the API level, the backend updates each character's `imagePath` individually via `sdk.updateProject()` + `sdk.flushProject()` after each image completes — so partial progress is persisted even if the batch is interrupted.

---

## How Auto-Save Works

```
View dispatches UPDATE_CHARACTER(id, { name: 'New Name' })
  → Reducer produces new state with dirty: true
  → React re-renders all subscribed components
  → useEffect sees dirty === true
  → Starts 2-second debounce timer
  → Timer fires → saveProject()
  → PATCH /api/project/:id with full project
  → ProjectStateManager merges + flushes to disk
  → dispatch SAVED → dirty: false
```

Multiple rapid edits (e.g., typing in a text field) are batched by the debounce. Only one PATCH fires after the user stops editing.

### Force-saving

If you need immediate persistence (e.g., before navigating away):

```tsx
const { saveProject } = usePipelineIdentity();
await saveProject(); // Flushes immediately, no debounce
```

---

## Server-Side Routes and the Provider

Pipeline routes (`routes/index.ts`) access the same project data through the `PipelineRouteSdk`. The same exact-update principle applies here — prefer targeted mutations:

```typescript
// Good — update one character's imagePath
const project = sdk.getProject();
const char = project.characters.find(c => c.id === charId);
char.imagePath = newPath;
sdk.updateProject({ characters: project.characters });
await sdk.flushProject();

// Bad — rebuild the entire characters array unnecessarily
const project = sdk.getProject();
const newChars = project.characters.map(c =>
  c.id === charId ? { ...c, imagePath: newPath, name: c.name, /* re-specifying everything */ } : c
);
sdk.updateProject({ characters: newChars });
```

When a route mutates data, the frontend picks it up on the next `reload()` call. If the view is polling (during generation), updates appear automatically. Otherwise, call `reload()` after the API response.

### Keeping frontend and backend in sync

| Scenario | Pattern |
|----------|---------|
| User edits a field in the UI | `updateCharacter()` → auto-save → server has it in ~2s |
| Backend generates an image | `sdk.updateProject()` + `sdk.flushProject()` → frontend polls and picks it up |
| View needs immediate fresh data | `await reload()` after the API call returns |
| Long-running batch operation | Backend streams ndjson progress, frontend reads it + polls every 2s |

---

## Patterns to Follow

### Do: Use exact updates for single entities
```tsx
// Good — surgical, safe, clear intent
updateCharacter(id, { name: 'New Name' });
updateLocation(id, { mood: 'ominous' });
updateElement(id, { text: 'Revised dialogue' });
```

### Don't: Use updateProject for single-entity changes
```tsx
// Bad — replaces entire array to change one field on one entity
const chars = project.characters.map(c =>
  c.id === id ? { ...c, name: 'New Name' } : c
);
updateProject({ characters: chars });
```

### Do: Use updateProject for structural changes
```tsx
// Good — adding, deleting, reordering are array-level operations
updateProject({ characters: [...project.characters, newChar] });
updateProject({ characters: project.characters.filter(c => c.id !== id) });
```

### Do: Mutate through the provider
```tsx
// Good — provider handles optimistic update + auto-save
updateCharacter(id, { name: 'New Name' });
```

### Don't: Call APIs directly for mutations
```tsx
// Bad — in-memory state is now stale, other views show old data
await fetch(`/api/project/${pipelineId}`, {
  method: 'PATCH',
  body: JSON.stringify({ characters: modifiedChars }),
});
```

### Do: Show loading/error states for async operations
```tsx
const [loading, setLoading] = useState(false);
const [error, setError] = useState(null);

try {
  setLoading(true);
  await generateCharacterImages(onProgress);
} catch (err) {
  setError(err.message);
} finally {
  setLoading(false);
}
```

### Don't: Swallow errors silently
```tsx
// Bad — user has no idea what happened
try { await generateCharacterImages(); } catch {}
```

### Do: Use the specific context hooks in core components
```tsx
// Good — only re-renders when project data changes
const { project, updateCharacter } = useProjectData();
```

### Fine: Use `usePipeline()` in extension views
```tsx
// Fine for extension views — simplicity over render optimization
const pipeline = usePipeline();
```

---

## Quick Reference

| Operation | Code |
|-----------|------|
| Read characters | `const { project } = useProjectData(); project.characters` |
| Update a character field | `updateCharacter(id, { name: 'New' })` |
| Update a location field | `updateLocation(id, { description: 'Dark alley' })` |
| Update an element | `updateElement(id, { text: 'Revised line' })` |
| Add a character | `updateProject({ characters: [...project.characters, newChar] })` |
| Delete a character | `updateProject({ characters: project.characters.filter(c => c.id !== id) })` |
| Reorder characters | `updateProject({ characters: reordered })` |
| Update metadata | `updateProject({ metadata: { ...project.metadata, title: 'X' } })` |
| Enrich a character | `await enrichCharacter(id)` |
| Generate all headshots | `await generateCharacterImages(onProgress)` |
| Force save | `await saveProject()` |
| Refresh from server | `await reload()` |
