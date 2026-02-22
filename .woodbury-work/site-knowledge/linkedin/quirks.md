# LinkedIn Quirks & Notes

## Timing
- Page load: 3-5 seconds
- Post submission: 2-3 seconds
- Modal animations: ~300ms

## Character Limits
- Regular posts: 3,000 characters
- Articles: Much longer (separate editor)
- Comments: 1,250 characters

## Media Requirements
- Images: JPEG, PNG, GIF supported
- Videos: MP4 preferred, max 10 minutes for most accounts
- Documents: PDF, DOC, PPT supported
- Max images per post: 9 (carousel)

## Known Issues
- **Search bar interference**: The search bar at the top is easily triggered when trying to click "Start a post". The search bar appears to extend lower than expected. Try clicking y=300+ to avoid it.
- **SPA Navigation**: LinkedIn is a single-page app. URL changes don't always trigger full reloads.
- **Profile editor modal**: Clicking on profile picture area opens profile editor, not post dialog.
- **Article vs Post confusion**: /post/new/ opens the article editor, not the regular post dialog.

## Tips
- Navigate directly to https://www.linkedin.com/feed/ to ensure you're on the main feed
- Press Escape to close any unwanted dialogs/modals
- The "Start a post" area is in the CENTER column - not left sidebar
- Video and Photo buttons below the input box also open the post creation modal
- Browser extension (Woodbury Bridge) provides more reliable DOM queries when connected

## Session Observations (2024)
- Screen resolution: 2056x1329
- Browser chrome offset: ~125px
- Center column approximate X range: 400-1100px
- Start a post element approximate Y: 200-350px from screen top
