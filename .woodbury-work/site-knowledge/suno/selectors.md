# Suno.com Selectors

## Navigation (Sidebar)
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Logo/Home | `a[href="/"]` | Suno logo in top left |
| Home | Link with text "Home" | Feed page |
| Create | `a[href="/create"]` | Song creation page |
| Studio | `a[href="/studio"]` | Studio workspace |
| Library | `[data-testid="navbar-library-tab"]` or `a[href="/me"]` | Your songs |
| Search | `a[href="/search"]` | Search page |
| Hooks | `a[href="/hooks"]` | Hooks feature |
| Notifications | Link with text "Notifications" | Activity feed |
| Labs | `a[href="/labs"]` | Experimental features |
| Profile Menu | `[aria-label="Profile menu button"]` | Opens profile dropdown |

## Create Page
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Mode Tabs | Buttons: "Simple", "Custom", "Sounds" | Switch creation modes |
| Model Version | Button with "v5" | Select AI model version |
| Song Title | `input[placeholder*="Song Title"]` | Optional title input |
| Lyrics Textarea | `textarea[placeholder*="lyrics"]` | Write lyrics or leave blank |
| Style Textarea | `textarea[placeholder*="sound you want"]` | Describe style |
| Exclude Styles | `input[placeholder="Exclude styles"]` | Styles to avoid |
| BPM Input | `input[type="number"][placeholder="Auto"]` | Beats per minute |
| Audio Button | `[aria-label="Add audio - upload or record"]` | Upload/record audio |
| Persona Button | `[aria-label="Add Persona"]` | Add voice persona |
| Inspo Button | `[aria-label="Add inspiration from a playlist"]` | Add playlist inspiration |
| Create Button | `[aria-label="Create song"]` | Generate the song |
| Clear Button | `[aria-label="Clear all form inputs"]` | Reset form |
| Workspace Dropdown | `[aria-label="Open workspace dropdown"]` | Choose save location |

## Style Tags (Pre-made buttons)
| Element | Selector Pattern | Notes |
|---------|-----------------|-------|
| Style Tag Button | `[aria-label="Add style: <style-name>"]` | Click to add style |
| Example Tags | "woman vocal", "piano beat", "greek folk", etc. | Suggested styles |

## Song Page
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Song Title | Link in main content area | Song name |
| Artist Link | `a[href="/@<username>"]` | Creator profile link |
| Style Tags | Links to `/style/<style-name>` | Clickable style labels |
| Play Button | Play icon in song area | Start playback |
| Like Button | `[aria-label="Like"]` | Upvote song |
| Dislike Button | `[aria-label="Dislike"]` | Downvote song |
| Comment Link | `[aria-label="Comment"]` | Open comments |
| More Menu | `[aria-label="More menu contents"]` | Three-dot options menu |

## More Menu Options
| Element | How to Find | Notes |
|---------|------------|-------|
| Remix/Edit | `find_element_by_text("Remix/Edit")` | |
| Create | `find_element_by_text("Create")` | |
| Get Stems / MIDI | `find_element_by_text("Get Stems")` | Pro feature |
| Add to Queue | `find_element_by_text("Add to Queue")` | |
| Add to Playlist | `find_element_by_text("Add to Playlist")` | |
| Move to Workspace | `find_element_by_text("Move to Workspace")` | |
| Publish | `find_element_by_text("Publish")` | |
| Song Details | `find_element_by_text("Song Details")` | |
| Generate Cover Art | `find_element_by_text("Generate Cover Art")` | |
| Visibility & Permissions | `find_element_by_text("Visibility")` | |
| Share | `find_element_by_text("Share")` | |
| Download | `find_element_by_text("Download")` | Download audio/video |
| Report | `find_element_by_text("Report")` | |
| Move to Trash | `find_element_by_text("Move to Trash")` | |

## Playbar (Bottom)
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Shuffle | `[aria-label="Playbar: Toggle shuffle button"]` | |
| Previous | `[aria-label="Playbar: Previous Song button"]` | |
| Play/Pause | `[aria-label="Playbar: Play button"]` | |
| Next | `[aria-label="Playbar: Next Song button"]` | |
| Repeat | `[aria-label="Playbar: Toggle repeat button"]` | |
| Progress | `[aria-label="Playback progress"]` | Range input |

## Search/Filter
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Workspace Search | `[aria-label="Search workspaces"]` | Search in create page |
| Clips Search | `[aria-label="Search clips"]` | Search generated clips |
| Page Number | `[aria-label="Current page number"]` | Pagination |

## Profile Menu Items
| Element | Selector / Description | Notes |
|---------|----------------------|-------|
| Profile | `[role="menuitem"]` with text "Profile" | View profile |
| Manage Subscription | `[role="menuitem"]` with text "Manage Subscription" | Account settings |
| Theme | `[role="menuitem"]` with text "Theme" | Toggle dark/light |
| Sign Out | `[role="menuitem"]` with text "Sign Out" | Logout |
