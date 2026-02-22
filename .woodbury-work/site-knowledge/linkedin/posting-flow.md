# LinkedIn Posting Flow

## Prerequisites
- Chrome open with LinkedIn logged in
- Post content ready (text, optionally images)

## Login Check
```
Navigate to: https://www.linkedin.com/feed/
Look for profile picture in navigation and "Start a post" area
→ If login form appears instead, STOP and tell the user to log in first
```

## Page Layout (2056x1329 screen resolution observed)
- **Navigation bar**: Top of page with LinkedIn logo, search bar, Home, My Network, Jobs, Messaging, Notifications, Profile icons
- **Left sidebar**: Profile summary, saved items, groups
- **Center column**: Main feed area, approximately x=400 to x=1100
- **Right sidebar**: LinkedIn News, trending topics, ads

## Start a Post Section
- Located at top of center column feed
- Contains: profile picture on left, rounded input box with 'Start a post' text
- Below input: Video, Photo, Write article buttons/icons
- The input box is white/light colored with rounded corners
- Estimated position: y=200-350 from top of screen (accounting for browser chrome ~125px)

## Steps

### 1. Navigate to LinkedIn Feed
```
Navigate to: https://www.linkedin.com/feed/
Wait for feed to load (look for posts and Start a post area)
```

### 2. Open Create Post Dialog
```
Find and click the "Start a post" input area in the center column
→ Look for: rounded white/gray input box with profile picture to the left
→ Alternative: click Photo or Video button below the input
Wait for post creation modal/dialog to appear
```

### 3. Enter Post Text
```
In the modal, find the text area
Type your post content
```

### 4. Upload Media (if applicable)
```
Find the media upload buttons (photo/video icons)
Click to open file picker
Select file from OS dialog
Wait for upload to complete
```

### 5. Set Audience (optional)
```
Look for audience selector ("Anyone", "Connections only", etc.)
Click to change if needed
```

### 6. Submit Post
```
Find the Post/Share button (usually blue, top right of modal)
Click it
Wait 2-3 seconds for post to publish
```

### 7. Verify Success
```
Look for the post appearing in your feed
Or look for a success notification
```

## Error Recovery
- If search bar opens instead of post dialog: press Escape, try clicking lower (y=300-350)
- If profile editor opens: press Escape, navigate back to /feed/
- If page goes blank: reload https://www.linkedin.com/feed/

## Quirks & Timing
- The search bar is near the top and easily triggered by mis-clicks
- LinkedIn is a SPA - URL changes may not cause full page reloads
- Text-only posts are supported (unlike Instagram)
- Character limit: 3,000 characters for posts, longer for articles
- Articles use a separate editor at /post/new/ - don't use for regular posts

## Alternative URLs
- https://www.linkedin.com/feed/ - main feed (preferred starting point)
- https://www.linkedin.com/feed/?shareActive=true - may auto-open share dialog
- https://www.linkedin.com/post/new/ - article editor (NOT for regular posts)
