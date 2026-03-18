# Change Log — 2026-03-17

## Summary

Major session focused on media generation integration, API key management, pipeline git workflow, chat agent context improvements, and pipeline views documentation. **+4,360 lines across 15 files.**

---

## New Features

### ElevenLabs TTS Tool (`src/loop/tools/elevenlabs.ts`)
- Built-in ElevenLabs integration — no extension install needed
- Actions: `speak` (text-to-speech), `voices` (list available), `clone` (create voice from samples), `sound-effect` (generate SFX)
- Supports all ElevenLabs voice settings: stability, similarity_boost, style, speed
- Auto-saves audio to `~/.woodbury/data/audio/` with descriptive filenames
- Registered in tool index alongside nanobanana

### Voice Browser (`src/config-dashboard/voices.js`)
- New "Voices" tab in dashboard sidebar (microphone icon)
- Fetches all voices from ElevenLabs API via `/api/elevenlabs/voices`
- Search by name, filter by category (premade, cloned, generated, professional)
- Play audio previews directly in the browser
- Shows voice metadata: labels (accent, age, gender, use case), description, category badge
- Empty states for no API key, no voices found, and loading

### API Keys Manager (`electron/main.js`)
- **Model menu → API Keys...** opens a popup window
- Manages keys for: Anthropic, OpenAI, Groq, Google Gemini (Nanobanana), ElevenLabs
- Grouped into "LLM Providers" and "Media Generation" sections
- Shows masked current values with ✓ Set / Not set badges
- "Get key ↗" links to each provider's key management page
- **Hot-reload**: saves to `~/.woodbury/.env` and updates `process.env` immediately — no restart needed
- On close, auto-refreshes the model list so newly configured providers appear

### API Endpoints (`src/dashboard/routes/mcp.ts`)
- `GET /api/env-keys` — returns masked status of all known API keys
- `PUT /api/env-keys` — writes keys to `~/.woodbury/.env`, hot-updates `process.env`
- `GET /api/elevenlabs/voices` — proxies ElevenLabs voice listing
- `GET /api/elevenlabs/preview-url` — proxies voice preview audio (avoids CORS)

### Git Integration in Pipeline App Sidebar
- Detects if pipeline folder is a git repo
- Shows current branch name and git status indicator (green dot for uncommitted changes)
- **Commit & Push** button with auto-generated commit messages (uses AI via chat agent)
- **Open in GitHub Desktop** button
- Shows recent commit history (last 2-3 commits, truncated)
- Uses `execFile` instead of `execSync` with proper `maxBuffer` (10MB) to avoid ENOBUFS errors

### Pipeline Views Documentation (`docs/pipeline-views.md`)
- Comprehensive architecture doc explaining how the Screenplay view works
- Step-by-step guide for creating alternative custom views
- Covers: detection functions, stitch/transform functions, render functions
- Documents the data flow: detect → stitch → render → wire events
- Full reference implementation walkthrough of the Screenplay view
- Data shape specifications, CSS conventions, key principles
- 8-step tutorial with code examples for adding a new view type

---

## Enhancements

### Chat Agent Context (`src/dashboard/routes/chat.ts`)
- Chat agent now loads the pipeline's `CLAUDE.md` as part of its system prompt
- Up to 4000 chars included, truncated with notice if longer
- This gives the chat agent knowledge of the pipeline's file structure, action configs, and conventions
- Enables non-technical users to describe behavior changes in natural language

### Chat UI Indicators (`src/config-dashboard/chat.js`)
- Added spinner/thinking indicators when the agentic loop is running
- Shows tool-use activity so users know the agent is working

### Screenplay View (`src/config-dashboard/compositions-app.js`)
- Scene navigation strip with act headers and clickable scene thumbnails
- Reference image resolution now checks bindings first, falls back to previs metadata
- Inline element editing with contenteditable
- Beat rendering with two-column layout (visual + text)
- Prompt editing area with "Regenerate with changes" button

### Nanobanana (`src/loop/tools/nanobanana.ts`)
- Updated default model name

---

## Files Changed

| File | Changes | Purpose |
|------|---------|---------|
| `electron/main.js` | +347 | API Keys popup window, menu item |
| `src/loop/tools/elevenlabs.ts` | +new | ElevenLabs TTS tool |
| `src/config-dashboard/voices.js` | +new | Voice Browser UI |
| `docs/pipeline-views.md` | +new | Pipeline views architecture doc |
| `src/dashboard/routes/mcp.ts` | +220 | API keys & ElevenLabs endpoints |
| `src/dashboard/routes/pipeline-app.ts` | +444 | Git integration, generate-previs enhancements |
| `src/config-dashboard/compositions-app.js` | +1197 | Screenplay view, git sidebar, voice browser |
| `src/config-dashboard/styles.css` | +948 | Styling for all new UI components |
| `src/dashboard/routes/chat.ts` | +88 | CLAUDE.md context loading |
| `src/dashboard/routes/compositions.ts` | +168 | Pipeline composition enhancements |
| `src/config-dashboard/chat.js` | +50 | Thinking/tool-use indicators |
| `src/config-dashboard/index.html` | +7 | Voice browser script tag |
| `src/config-dashboard/app.js` | +5 | Voices tab registration |
| `src/loop/tools/index.ts` | +8 | ElevenLabs tool registration |
| `src/loop/tools/nanobanana.ts` | +2/-2 | Model name update |

---

## Known Issues / Follow-ups

- **API Keys "Failed to fetch"**: The popup uses a hardcoded port from `dashboardPort` at window creation time. If the dashboard port changes or isn't set yet, the fetch fails. Need to verify port is available before opening.
- **ElevenLabs key permissions**: The voice browser requires `voices_read` permission on the API key. Keys with restricted scopes will get an empty list.
- **Pipeline git commit ENOBUFS**: Fixed by switching to `execFile` with `maxBuffer: 10MB`, but very large repos with huge diffs could still hit limits.
- **Per-shot auto-binding check**: The auto-run check in pipeline-app.ts still checks globally (any depicts binding exists → skip) instead of per-shot. The chat agent's attempted fix from the previous session didn't land due to MCP Edit tool error.
- **rules.json matchField**: Currently `"name"` but should be `"displayName"` for character matching in shot descriptions.
