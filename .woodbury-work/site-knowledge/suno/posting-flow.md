# Suno.com Song Creation Flow

## Prerequisites
- Chrome open with Suno.com logged in
- Credits available (shown in top navigation, e.g. "11.7k")

## Login Check
```
Navigate to: https://suno.com/create
browser_query(action="find_interactive", description="Profile menu button")
→ If login form appears instead, STOP and tell the user to log in first
```

## Creating a Song

### 1. Navigate to Create Page
```
Navigate to: https://suno.com/create
Wait for page to load
```

### 2. Create Page Layout
The Create page has three main modes (tabs at top):
- **Simple** — Basic prompt-based generation
- **Custom** — Full control with lyrics, style, and more
- **Sounds** — Audio-based generation

### 3. Fill in Song Details (Custom Mode)

**Song Title (Optional):**
```
browser_query(action="find_elements", selector="input[placeholder*='Song Title']")
→ Click and type title
```

**Lyrics/Prompt:**
```
browser_query(action="find_elements", selector="textarea[placeholder*='lyrics']")
→ Click and type lyrics or prompt
→ Leave blank for instrumental
```

**Style Description:**
```
browser_query(action="find_elements", selector="textarea[placeholder*='sound you want']")
→ Type style tags like: "lo fi hip hop, piano beat, dreamy, 90 bpm"
```

**Style Tags:** Pre-made style buttons appear below the style textarea:
- Example: "woman vocal", "piano beat", "greek folk", "angelic choir"
- Click these to add them to your style

**Additional Options:**
- Audio: Upload or record audio
- Persona: Add a voice persona
- Inspo: Add inspiration from a playlist
- Exclude styles: Specify styles to avoid
- BPM: Set beats per minute (or leave "Auto")
- Workspace: Choose where to save

### 4. Generate the Song
```
browser_query(action="find_interactive", description="Create song button")
→ Look for: aria-label="Create song" button at bottom of form
→ Click it
Wait 30-60 seconds for AI to generate the song
```

### 5. Song Appears in List
After generation, the song appears in the right panel with:
- Song title
- Style tags
- Play button
- More options menu (three dots)

## Downloading a Song

### 1. Navigate to Song Page
```
Navigate to: https://suno.com/song/<song-id>
OR click on song title from Create page or Library
```

### 2. Open More Options Menu
```
browser_query(action="find_interactive", description="More menu contents button")
→ Look for: aria-label="More menu contents" (three-dot icon)
→ Click it
```

### 3. Click Download
```
browser_query(action="find_element_by_text", text="Download")
→ Click the Download button
```

### 4. Download Options
After clicking Download, the file typically downloads automatically as MP3.
If a dialog appears, select:
- Audio format (MP3)
- Video format (MP4 with visualizer)

## Menu Options Available
The three-dot menu on each song includes:
- **Remix/Edit** — Create a new version
- **Create** — Use as inspiration for new song
- **Get Stems / MIDI** (Pro) — Download individual tracks
- **Add to Queue** — Add to play queue
- **Add to Playlist** — Add to a playlist
- **Move to Workspace** — Organize songs
- **Publish** — Make song public
- **Song Details** — View/edit metadata
- **Generate Cover Art** — Create AI album art
- **Visibility & Permissions** — Control who can see/use
- **Share** — Get shareable link
- **Download** — Download audio/video file
- **Report** — Report issues
- **Move to Trash** — Delete song

## Important URLs
- Home: https://suno.com/
- Create: https://suno.com/create
- Library: https://suno.com/me
- Studio: https://suno.com/studio
- Song: https://suno.com/song/<id>
- Profile: https://suno.com/@<username>

## Verification
```
Check for song in right panel after creation
Look for play button and song title
browser_query(action="find_element_by_text", text="<song-title>")
```
