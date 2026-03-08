# Releasing a New Version

This document covers the complete steps to release a new version of Woodbury and make it available for update.

## How Updates Work

The Electron app checks `https://woodbury.bot/version.json` on launch. If the version in that file is newer than the running app, it shows an update prompt with a download link pointing to the GitHub release assets. Updating `version.json` and deploying it to Firebase is what makes the update visible to users.

## Release Steps

### 1. Commit your changes

```bash
cd ~/Documents/GitHub/woodbury
git add <files>
git commit -m "Description of changes"
```

### 2. Bump the version

```bash
npm version patch --no-git-tag-version   # 1.1.8 -> 1.1.9
```

This updates `package.json` and `package-lock.json`. For larger changes use `minor` or `major` instead of `patch`.

### 3. Update version.json

Edit `apps/woodbury-web/public/version.json` with:

- `version` — the new version string
- `releaseDate` — today's date (YYYY-MM-DD)
- `downloadUrls.mac` — update the version in the DMG filename
- `downloadUrls.windows` — update the version in the exe filename
- `releaseNotes` — short description of what changed

Example:

```json
{
  "version": "1.1.9",
  "releaseDate": "2026-03-03",
  "downloadUrls": {
    "mac": "https://github.com/Zachary-Companies/woodbury/releases/latest/download/Woodbury-1.1.9-arm64.dmg",
    "windows": "https://github.com/Zachary-Companies/woodbury/releases/latest/download/Woodbury-Setup-1.1.9.exe"
  },
  "releaseNotes": "Go menu shortcuts, dashboard UI improvements, Chrome focus fix for workflows.",
  "releaseUrl": "https://github.com/Zachary-Companies/woodbury/releases/latest"
}
```

### 4. Commit the version bump and push

```bash
git add package.json package-lock.json apps/woodbury-web/public/version.json
git commit -m "Update version.json to X.Y.Z"
git push origin main
```

### 5. Create a GitHub release

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "Release notes here"
```

The `v`-prefixed tag triggers the CI workflow (`.github/workflows/build.yml`) which:

- Builds the macOS DMG on `macos-latest`
- Builds the Windows installer on `windows-latest`
- Uploads both to the GitHub release as assets

Wait for CI to finish before deploying the website:

```bash
gh run list --limit 1          # check status
gh run watch <run-id>          # wait for completion
```

### 6. Deploy to woodbury.bot

Build the Next.js marketing site and deploy to Firebase:

```bash
cd apps/woodbury-web
npm run build
npx firebase deploy --only hosting --project woobury-ai
```

This publishes the updated `version.json` to `https://woodbury.bot/version.json`, which is what the desktop app checks for updates.

### 7. Publish to npm (optional)

```bash
cd ~/Documents/GitHub/woodbury
npm run build
npm publish
```

Requires a valid npm auth token. Run `npm login` if the token has expired.

## Quick Reference

| Step | Command | Purpose |
|------|---------|---------|
| Build | `npm run build` | Compile TypeScript |
| Version bump | `npm version patch --no-git-tag-version` | Bump version in package.json |
| Push | `git push origin main` | Push commits |
| Release | `gh release create vX.Y.Z` | Create GitHub release (triggers CI) |
| Wait for CI | `gh run watch <id>` | Wait for installers to build |
| Deploy site | `cd apps/woodbury-web && npm run build && npx firebase deploy --only hosting --project woobury-ai` | Update woodbury.bot |
| Publish npm | `npm publish` | Publish to npm registry |

## CI Workflow Details

The `Build Installers` workflow (`.github/workflows/build.yml`) runs on:

- **Push of a `v*` tag** (created by `gh release create`)
- **Manual dispatch** (`workflow_dispatch`)

It runs two parallel jobs:

- **build-mac** — `macos-latest`, runs `electron-builder --mac`, uploads DMG
- **build-windows** — `windows-latest`, runs `electron-builder --win`, uploads exe

Both jobs use `GH_TOKEN` to publish assets directly to the GitHub release.

## Extension Releases

Extensions in `~/.woodbury/extensions/` are separate git repos. If an extension was changed, commit and push it independently before releasing the main app:

```bash
cd ~/.woodbury/extensions/<extension-name>
git add <files>
git commit -m "Description"
git push origin main
```
