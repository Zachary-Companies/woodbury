# Changelog — 2026-03-24

## Video Generation & Image Tool Fixes

Added Veo 3.1 video generation as a new agent tool and pipeline SDK method, fixed aspect ratio handling in image generation, and hardened the React frontend's asset extraction.

### Added

- **`nanobanana-video` tool** (`src/loop/tools/nanobanana-video.ts`) — Generate video clips using Google's Veo 3.1 model. Supports `text-to-video` and `image-to-video` actions with configurable duration (4–8s) and aspect ratio (16:9 / 9:16). Uses the Gemini long-running operations API with polling. Registered in the tool index alongside the existing image generation tool.

- **Pipeline SDK: `generateVideo()`** — New method on `PipelineRouteSdk` and corresponding implementation in `pipeline-route-factory.ts`. Pipeline nodes can now generate video clips via `sdk.generateVideo({ action, prompt, outputPath })`.

- **Tests** — `src/__tests__/nanobanana.test.ts` (verifies aspectRatio is passed correctly in API requests) and `src/__tests__/nanobanana-video.test.ts` (covers API request structure, image loading, video saving, operation polling, and error handling).

- **Documentation** — `docs/react-frontend-integration.md` explaining the project data flow from pipeline node outputs to domain JSON files consumed by the React frontend, including critical fields like scene element ranges and asset structure.

### Fixed

- **Nanobanana `aspectRatio` parameter** — The image generation tool now correctly passes `aspectRatio` to the Gemini API under `generationConfig.imageConfig.aspectRatio`. Previously the parameter was accepted but not forwarded.

- **`useDataExtraction` asset handling** — The React hook now handles `project.assets` as either an array or a `{ assets: [] }` wrapper object, preventing crashes when the asset structure varies between pipeline versions.
