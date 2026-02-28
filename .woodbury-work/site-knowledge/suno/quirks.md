# Suno.com Quirks & Notes

## Timing
- Page load: 2-3 seconds
- Song generation: 30-60 seconds (depends on complexity)
- Download: Usually instant (auto-downloads)
- UI transitions: ~500ms

## Credits System
- Songs cost credits to generate
- Credit balance shown in top nav (e.g. "11.7k")
- Check credits before generating: `[aria-label="Credits remaining: <number>"]`
- Pro features (like stems/MIDI) require subscription

## Character/Content Limits
- Song title: Optional, no strict limit observed
- Lyrics: Can be substantial (multiple verses, chorus, bridge)
- Style tags: Multiple can be combined (comma-separated or button clicks)
- BPM range: Auto or manual (typical range 60-180)

## Known Issues
- **Emoji picker can block interactions** — Dismiss with Escape key before clicking other elements
- **Multiple "More menu contents" buttons** — The main song's menu is usually the first one (leftmost position)
- **Menu may not visually open** — Click the three-dot button and then look for menu items by text search
- **Downloads auto-start** — No confirmation dialog; file downloads immediately to browser's download folder

## Common Overlays/Dialogs
- **Privacy Policy Update** — May appear on first visit. Look for close button: `[aria-label="Close"]` in `[role="dialog"]`
- **Emoji Picker** — Appears in song pages for comments. Dismiss with Escape
- **Profile Menu** — Opens on profile button click. Dismiss by clicking elsewhere

## Tips
- **Direct URL navigation is reliable** — Use `/create`, `/song/<id>`, `/me` instead of clicking sidebar links
- **Style tags are clickable** — Pre-suggested style buttons are faster than typing
- **Custom mode gives most control** — Use "Custom" tab for full lyrics + style control
- **Check for existing songs first** — Songs appear in right panel on Create page
- **ARIA labels are consistent** — Use `aria-label` selectors for reliable element targeting

## Song Workflow
1. Go to /create
2. Select mode (Simple/Custom/Sounds)
3. Fill in lyrics (or leave blank for instrumental)
4. Add style description or click style tags
5. Click Create
6. Wait for generation
7. Song appears in right panel
8. Click song title to go to song page
9. Use three-dot menu → Download

## Download Formats
- **Audio** — Downloads as MP3
- **Video** — Downloads as MP4 (includes visualizer)
- **Stems/MIDI** — Pro feature only

## URL Patterns
```
https://suno.com/                    → Home/Feed
https://suno.com/create              → Create new song
https://suno.com/studio              → Studio workspace
https://suno.com/me                  → Your library
https://suno.com/search              → Search
https://suno.com/song/<uuid>         → Individual song page
https://suno.com/@<username>         → User profile
https://suno.com/style/<style-name>  → Songs with this style
https://suno.com/hooks               → Hooks feature
https://suno.com/labs                → Labs (experimental)
https://suno.com/notifications       → Your notifications
https://suno.com/account             → Account/subscription
```

## React/SPA Behavior
- Page uses Next.js (SPA navigation)
- URL changes don't always trigger full page load
- Content loads asynchronously — wait for elements to appear
- Use `wait_for_element` for dynamically loaded content

## Creation Modes
| Mode | Description | Best For |
|------|-------------|----------|
| Simple | Basic prompt → song | Quick generation, less control |
| Custom | Lyrics + Style + Options | Full creative control |
| Sounds | Audio-based generation | Remixing, audio-to-music |

## Common Style Tags
- Genres: lo fi hip hop, pop, rock, jazz, classical, electronic, folk
- Mood: dreamy, dark, epic, cinematic, chill, energetic
- Vocals: woman vocal, male voice, angelic choir, no vocals
- Instruments: piano, guitar, synth, drums, bass
- BPM: 60 bpm, 90 bpm, 120 bpm, etc.
