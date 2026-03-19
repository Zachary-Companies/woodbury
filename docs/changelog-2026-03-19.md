# Change Log — March 19, 2026

## Major: React Dashboard Architecture

Migrated the pipeline app view from vanilla JS string concatenation to React components. All 5 pipeline app tabs are now functional:

- **Screenplay** (React) — scene cards, character avatars, location banners, inline dialogue editing, search, scene strip navigation
- **Data** (React) — character/location card grids with filter, enrich buttons, generate buttons, metadata view, sections tree
- **Voices** (React) — ElevenLabs voice assignment per character with preview playback
- **Editor** (Vanilla bridge) — existing NLE timeline editor loaded via React bridge
- **Script** (Vanilla bridge) — existing Monaco Fountain editor loaded via React bridge

### React Infrastructure
- React 19 + ReactDOM 19 bundled via esbuild
- Pipeline store with pub/sub state management + React hooks
- Tailwind CSS via CDN with scoped configuration
- `WoodburyReact` global API for vanilla JS integration

## Major: Project-Folder-Based Data Architecture

Pipeline project data now lives in `{projectFolder}/project.json` instead of 14+ separate node files:
- Single source of truth for all structured data
- Portable projects (move the folder, everything travels)
- `loadAppState()` checks project folder first, falls back to node files
- Auto-migration from old node files on first load
- `PUT /api/app/:id/project` endpoint for direct project.json writes

## Import System

Complete screenplay import flow:
- Import modal with Paste Text / Upload File tabs
- PDF text extraction with spatial formatting awareness (pdfjs-dist)
- Fountain parser with strict character detection
- Preview with stats and character tags
- Project folder required (native macOS folder picker via Electron IPC)
- Clears old state → writes project.json → reloads
- Import Script button on Pipeline Form page

## AI Enrichment

- `POST /api/chat/one-shot` — non-streaming LLM endpoint
- Enrich Characters / Enrich Locations buttons in toolbar
- Per-entity and batch enrichment
- Fills: description, age, gender, traits, arc, voice, wardrobe, relationships

## Asset Generation

- `POST /api/app/:id/generate-assets` — generates headshots and location shots via nanobanana
- Saves images to `{projectFolder}/characters/` and `{projectFolder}/locations/`
- Writes imagePath back to project.json
- Character avatars displayed next to dialogue in Screenplay view
- Location banners at top of scene cards

## Pipeline Skills

Created 3 new pipeline-specific scripts:
- `pdf-to-fountain.ts` — converts screenplay PDFs to Fountain format
- `fountain-to-pipeline.ts` — parses Fountain and imports to pipeline state
- `enrich-script-data.ts` — AI enrichment for characters and locations

## Fountain Script Editor (Monaco)

- Custom view with Monaco editor and Fountain language definition
- Syntax highlighting for scene headings, characters, dialogue, transitions, parentheticals
- Scene outline panel with click-to-navigate
- Status bar with scene/character/page counts
- Auto-save with debounce

## Infrastructure

- Electron clears session cache on startup (no more stale JS)
- No-cache HTTP headers for JS/CSS/HTML files
- Native macOS folder picker via Electron IPC (`dialog.showOpenDialog`)
- New Folder button in folder picker (inline input, creates via `/api/browse`)
- Cache-busted script tags

## NLE Editor Improvements

- Inspector slider controls with range + text input
- Collapsible app sidebar with toggle button
- Save button styling fix

## Website Updates

- Pipelines section on landing page with Screenplay Generator showcase
- Coming Soon cards for Social Content Calendar, Brand Asset Generator, Podcast Producer
- Pipelines nav link in navbar, mobile menu, footer
- Updated Hero subtitle mentioning creative pipelines
