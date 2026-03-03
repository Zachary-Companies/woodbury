# Woodbury — Complete Platform Documentation

## What is Woodbury?

Woodbury is a free, open-source desktop automation platform for Mac and Windows that lets anyone automate their browser and desktop applications without writing code. It's built as an Electron app with a Chrome extension, a visual pipeline builder, an AI coding assistant with over 40 built-in tools, and a custom visual AI system that can recognize UI elements even when websites change their design.

The core idea is: record yourself doing something in Chrome, and Woodbury turns that recording into a replayable workflow that runs itself automatically. But it goes far beyond simple macro recording — Woodbury understands what elements look like, not just where they are, so your automations keep working even when websites update.

Woodbury is open source under the MIT license, available at github.com/Zachary-Companies/woodbury.

---

## The Two Pieces: Desktop App + Chrome Extension

Woodbury consists of two parts:

1. **The Woodbury Desktop App** — An Electron application that provides the dashboard, workflow engine, pipeline builder, AI assistant, and inference server.
2. **The Woodbury Bridge Chrome Extension** — The connection between Chrome and the desktop app. It watches what you do in the browser during recording, and drives the browser during replay.

The extension communicates with the desktop app through a local WebSocket connection on port 7865. Everything stays on your machine — no data is ever sent to external servers.

When you install the extension, it shows a small badge in your Chrome toolbar. "ON" with a green indicator means you're connected and ready to automate. "OFF" means the Woodbury desktop app isn't running yet. The extension automatically reconnects when the app starts up, using exponential backoff from 3 seconds up to 30 seconds.

---

## How Recording Works

Recording is the heart of Woodbury. Here's exactly what happens:

1. You open the Woodbury dashboard and go to the Workflows tab
2. Click "New Recording" and give your workflow a name, like "Create Song on Suno" or "Post to Instagram"
3. Click Start Recording
4. Do your task normally in Chrome — navigate to websites, click buttons, fill out forms, use keyboard shortcuts
5. The Woodbury Bridge Chrome extension watches every interaction in real time

Behind the scenes, the extension's content script captures incredibly rich data about each interaction:

**For every click, the extension records:**
- The element's CSS selector (the primary way to find it again)
- Multiple fallback CSS selectors (alternative paths to the same element)
- The element's ARIA label, text content, placeholder text, title, alt text, role, data-test-id
- The element's exact bounding box in pixels, plus its position as a percentage of the viewport
- The viewport dimensions at recording time
- The element's context: its parent elements up to 4 levels, the nearest landmark region (header, nav, main, footer, aside), the nearest heading, and sibling elements
- If it's a form field, the associated label text
- If there are multiple elements with the same text, which one this is (for example, "2nd of 3 divs with text 'Submit'")

**For keyboard input, it records:**
- The key pressed and any modifier keys (Ctrl, Shift, Alt, Cmd)
- The target element receiving the input

**For text entry, it records:**
- The full text value entered
- Whether to clear the field first
- The target element

**For navigation, it records:**
- The destination URL
- Optional wait conditions (wait for a specific element to appear, or wait a set time)

After each click interaction, the extension also captures a full page snapshot — a screenshot of the entire viewport plus metadata about every interactive element visible on the page. These snapshots serve double duty: they're used for visual AI training data, and they provide reference images for element matching during replay.

When you stop recording, Woodbury saves everything as a structured JSON workflow file (.workflow.json).

---

## Workflow Step Types

Woodbury supports 20 different step types that can be combined to automate almost anything:

### Browser Interaction Steps

**Navigate** — Go to a URL. Supports variable substitution, so you can parameterize URLs like `https://example.com/{{productId}}`. Can optionally wait for a specific CSS selector to appear or wait a set number of milliseconds.

**Click** — Click an element. Supports single click, double click, right click, and hover. Has an optional verify-click feature that takes a screenshot after clicking to confirm the click actually worked, with configurable retry attempts (default 3), verify delay (400ms), and retry delay (600ms).

**Type** — Enter text into an input field. Supports variable substitution so you can type different values each time. Can optionally clear the field first.

**Keyboard** — Press a key or key combination. Supports all standard keys (Enter, Escape, Tab, arrow keys, etc.) and modifier keys (Ctrl, Shift, Alt, Cmd). Used for keyboard shortcuts like Ctrl+A to select all.

**Scroll** — Scroll the page or a specific element. Supports up, down, left, and right directions with configurable amounts.

**Wait** — Pause execution until a condition is met. Conditions include: element becomes visible, element becomes hidden, URL matches a pattern, URL contains a substring, specific text appears on the page, specific text disappears, a fixed delay in milliseconds, or network becomes idle.

**Assert** — Check a condition and fail the workflow if it's not met. Can check if an element exists, is visible, has matching text, or check the URL or page title. Used for validation.

### File Operation Steps

**Download** — Click a trigger element to start a download, then wait for it to complete. Can match against an expected filename pattern and has a configurable timeout.

**Capture Download** — Capture recently completed downloads into a variable. Looks back up to 30 seconds (configurable), waits up to 60 seconds for completion, and stores the result in a variable (default: "downloadedFiles").

**File Dialog** — Handle native OS file selection dialogs. Specifies the file path to select, optionally clicks a trigger element first, and stores the selected file path in a variable. Has configurable delays before and after to handle dialog animation.

**Move File** — Move or rename files. Source supports glob patterns. Both source and destination support variable substitution.

### Control Flow Steps

**Set Variable** — Set a variable from various sources: a literal value, the text content of an element, an attribute of an element, the current page URL, a URL parameter, or a regex extraction from any string.

**Conditional** — If/else branching. Evaluates a condition (same types as Assert), runs the "then" steps if true, and optionally runs "else" steps if false.

**Loop** — Iterate over an array variable. Exposes the current item and optionally the current index as variables to the loop body steps.

**Try/Catch** — Error handling. Runs the "try" steps, and if any fail, runs the "catch" steps instead. Optionally stores the error message in a variable.

**Sub-Workflow** — Execute another workflow as a step. Can pass variables into the sub-workflow. Enables workflow composition and reuse.

### Desktop Automation Steps

**Desktop Launch App** — Open a native application by name (like "Blender", "Spotify", or "Notepad"). Has a configurable delay after launch (default 2 seconds) to wait for the app to start.

**Desktop Click** — Click at absolute screen coordinates. Supports single click, double click, and right click. Can store a reference screenshot for debugging. Has a configurable delay after click (default 500ms).

**Desktop Type** — Type text into the currently focused desktop application. Supports variable substitution.

**Desktop Keyboard** — Press keys in a desktop application. Same key and modifier support as the browser keyboard step.

---

## Element Resolution: How Woodbury Finds Elements

When replaying a workflow, Woodbury needs to find each element on the page. It uses a multi-strategy fallback chain, trying each approach in order until one succeeds:

1. **Placeholder** — For form fields, looks for the matching placeholder text. This is the most stable identifier for inputs since placeholder text rarely changes.

2. **Primary CSS Selector** — The main selector captured during recording. If multiple elements match, Woodbury disambiguates by comparing each candidate's position to the expected percentage-based coordinates, picking the one closest to where the element was during recording.

3. **Fallback Selectors** — Alternative CSS paths to the same element, tried in sequence.

4. **ARIA Label** — Looks for elements with matching `aria-label` attributes. ARIA labels are accessibility attributes that tend to be stable across redesigns.

5. **Text Content** — Searches for elements containing the recorded text. Useful for buttons and links.

6. **Natural Language Description** — Sends a description of the element to the Chrome extension's `find_interactive` function, which scores all interactive elements on the page against the description. This is the most flexible approach but slowest.

7. **Viewport Percentage** — As a last resort, clicks at the recorded percentage position within the viewport. For example, if the element was at 50% horizontal and 30% vertical during recording, Woodbury clicks at that relative position.

---

## Visual AI: How Woodbury Recognizes Elements By Sight

This is Woodbury's most innovative feature. Traditional automation tools break when websites change their code — a new CSS class name, a redesigned button, a theme switch from light to dark mode. Woodbury solves this with a custom-trained Siamese neural network that recognizes elements by how they look, not by their code.

### How It Works

During recording, Woodbury captures screenshots of every element you interact with. These images become training data for a neural network that learns to recognize those specific UI elements.

The model architecture is a Siamese encoder — a dual-path neural network that takes two images and produces embeddings (compact numerical representations) that can be compared. If two images show the same UI element (even with visual variations), their embeddings will be very similar. If they show different elements, the embeddings will be dissimilar.

### The Model

**Backbone**: MobileNetV3-Small (2.5 million parameters) by default. Also supports EfficientNet-B0 (5.3M params) and ResNet18 (11.7M params).

**Input**: 224x224 pixel images, letterboxed to preserve aspect ratio (no stretching), padded with black to fill the square.

**Output**: 64-dimensional L2-normalized embeddings. Because they're normalized, cosine similarity equals the dot product — a simple and fast comparison.

**Inference Speed**: Under 2 milliseconds per element on CPU using ONNX Runtime. No GPU needed for running workflows.

**Model Size**: Under 3 megabytes for the ONNX file.

### Training

Each model is trained specifically for one website. The training process uses several techniques:

**Loss Function**: NT-Xent (Normalized Temperature-scaled Cross-Entropy), the same loss used in SimCLR. Temperature is 0.10. Also supports Contrastive loss, Triplet loss, and ArcFace loss.

**Batch Sampling**: PK sampling — 32 identities (different UI elements) times 4 samples each equals 128 images per batch. This ensures every batch contains multiple positive pairs for the loss function.

**Optimizer**: AdamW with learning rate 3e-4, weight decay 1e-4.

**Learning Rate Schedule**: 5% linear warmup followed by cosine annealing.

**Mixed Precision**: Automatic mixed precision on NVIDIA GPUs for faster training. Standard precision on Apple Silicon.

**EMA**: Exponential Moving Average of weights with decay 0.999 for smoother convergence.

**Early Stopping**: Patience of 15 epochs — if validation ROC-AUC doesn't improve for 15 epochs, training stops.

### 14 UI-Specific Augmentations

The training pipeline includes augmentations specifically designed for web UI elements. During training, each image has random augmentations applied to teach the model to be invariant to visual changes:

1. **Theme Inversion** (probability 0.1) — Inverts colors to simulate dark/light theme switching. Rare but critical for theme-agnostic matching.

2. **State Color Shift** (probability 0.5) — Modifies brightness, contrast, or saturation to simulate hover, focus, active, and disabled states. Modes include brighten (1.1-1.4x), darken (0.6-0.9x), desaturate, tint with a random color, or reduce opacity.

3. **Color Jitter** (probability 0.5) — Random brightness, contrast, saturation (±30%), and hue (±5%) variations.

4. **Focus Ring** (probability 0.15) — Draws CSS focus-visible-style outlines in various colors (blue, red, yellow, green, white, black) with random thickness (1-20px relative to element size).

5. **Random Crop Shift** (probability 0.35) — Shifts the crop window by ±8% to simulate bounding box imprecision.

6. **Random Padding** (probability 0.35) — Adds random padding (up to 10% of dimensions) on each side with sampled background colors.

7. **Random Affine** (probability 0.25) — Slight rotation (±1 degree), translation (±3%), and scaling (90-110%) to handle minor layout shifts.

8. **Density Scaling** (probability 0.64) — Downsamples to 50-90% then upsamples to simulate different devicePixelRatio values (Retina vs standard displays).

9. **Sharpen Variation** (probability 0.15) — Randomly sharpens (1.2-2.5x) or softens (0.3-0.8x) to handle different font rendering engines.

10. **Anti-Aliasing Blur** (probability 0.12) — Gaussian blur with radius 0.3-1.2px to simulate browser rendering differences.

11. **JPEG Compression** (probability 0.64) — Applies JPEG compression at quality 40-95 to simulate screenshot compression artifacts.

12. **Gaussian Noise** (probability 0.12) — Adds random noise with standard deviation 2.0-10.0 to simulate sensor noise.

13. **Overlay Simulation** (probability 0.03) — Places a random semi-transparent rectangle to simulate tooltips, badges, or notification overlays covering part of the element.

14. **Random Erasing** (probability 0.15) — Cuts out a random rectangular region (up to 15% of area) to simulate occlusion.

A SubsetAugmentation wrapper ensures at most 3-4 augmentations are applied per image to prevent compound destruction.

### Data Preparation

Before training, raw recording data needs to be processed:

1. **Load Snapshots** — Read all `snapshot_*.json` metadata files and their associated viewport screenshots
2. **Load Interactions** — Read `interactions_*.json` files to know which elements were actually clicked during recording
3. **Crop Elements** — For each element in each snapshot, crop it from the full-page screenshot using its bounding box
4. **Multi-Crop Generation** — Generate multiple crops per element with different framing strategies:
   - Crop 0: Canonical (standard 2px padding)
   - Crop 1: Tight (no padding)
   - Crop 2: Padded (15% extra padding)
   - Crop 3: Context (50% extra padding for surrounding context)
   - Crops 4+: Random jitter (random padding 0-3x, position offset ±15%, scale 88-112%)
5. **Group Assignment** — Elements are grouped by identity: `site_id:selector` (e.g., `suno.com:button.submit`). All crops of the same element across different snapshots share a group. Alternatively, when using step-based grouping, interacted elements get `step:N` groups and non-interacted elements get `neg:site_id:selector` groups as hard negatives.
6. **Write Metadata** — Output `metadata.jsonl` (one JSON entry per crop) plus the crop images organized by site and group hash.

The `--crops-per-element` flag controls data multiplication. Setting it to 8 produces about 8 times more training data without needing to re-record. A typical setting is 8-15 crops per element.

### Evaluation Metrics

After each epoch, the model is evaluated on a held-out validation set:

- **ROC-AUC** — Area under the Receiver Operating Characteristic curve. Measures overall discriminative ability.
- **PR-AUC** — Area under the Precision-Recall curve.
- **EER** — Equal Error Rate, the point where the false positive rate equals the false negative rate. Lower is better.
- **EER Threshold** — The cosine similarity threshold at the EER point.
- **TAR@FMR=0.1%** — True Accept Rate at a 0.1% False Match Rate. How many genuine matches the model catches while only allowing 1 in 1000 false matches.
- **TAR@FMR=0.01%** — Same at an even stricter 0.01% False Match Rate.

Evaluation samples balanced positive/negative pairs — positive pairs from the same group, negative pairs from different groups — and computes cosine similarity scores.

### Multi-Crop Matching at Inference Time

For robust verification, the inference system uses multiple crop strategies when comparing elements:

- **Tight** (0% padding) — Just the element, nothing else
- **Standard** (3% padding) — Slight context
- **Padded** (15% padding) — More surrounding context
- **Context** (50% padding) — Significant surrounding area

The final similarity score can be computed by:
- **Mean fusion** — Average of same-strategy pair similarities
- **Max fusion** — Maximum similarity across all crop pairs
- **Two-stage fusion** — Accept immediately if any pair exceeds a high threshold (0.93), otherwise require at least 3 of all pairs to exceed a lower threshold (0.80)

### ONNX Export

After training, models are exported to ONNX format for deployment:
- Opset version 18
- Static input shape: 1×3×224×224
- Optional QUInt8 quantization for smaller file size
- Both full-precision and quantized variants are saved

### Node.js Inference (No Python Required)

End users never need Python installed. The Woodbury desktop app includes a complete Node.js port of the inference system:

- **ONNX Runtime via onnxruntime-node** (N-API bindings)
- **Sharp (libvips)** for image processing instead of PIL
- **LRU Model Cache** holding up to 5 ONNX models simultaneously
- **HTTP API on port 8679** with the same endpoints as the Python server

The Node.js preprocessing matches the Python preprocessing exactly — same letterbox algorithm, same ImageNet normalization constants (mean: 0.485, 0.456, 0.406; std: 0.229, 0.224, 0.225), same canvas size. The only difference is the resize algorithm: Sharp uses lanczos3 while Python uses bilinear, causing approximately 0.32% embedding divergence (cross-pipeline cosine similarity of 0.9968). This is acceptable since both pipelines are internally consistent.

### Inference Server API

The inference server (port 8679) provides these endpoints:

- `GET /health` — Returns status, default model path, and list of loaded models
- `POST /embed` — Embed a single image, returns the 64-dimensional embedding vector
- `POST /compare` — Compare two images directly, returns cosine similarity
- `POST /compare-region` — Crop a region from a screenshot and compare to a reference image
- `POST /search-region` — Compare multiple candidate regions against a reference, returns ranked results with the best match
- `POST /search-region-weighted` — Same as search-region but with position weighting using exponential decay (default decay: 15.0 as percentage of viewport). Combines visual similarity with spatial proximity.
- `POST /load-model` — Pre-load a model into the cache

All images are passed as base64-encoded data URLs.

### Visual Verification During Replay

The VisualVerifier class orchestrates visual element matching during workflow replay:

1. **Threshold Check**: Compare the element at the expected position against the reference image. If cosine similarity exceeds 0.75, the element is verified.
2. **Nearby Search**: If the threshold isn't met, search all clickable elements within a 200-pixel radius. Compare each against the reference. Accept any match above 0.65 similarity.
3. **Position-Weighted Search**: For weighted searches, combine visual similarity with an exponential decay function based on distance from the expected position.

### Distributed Training

For faster training on remote GPU machines, Woodbury includes a distributed training worker:

- Lightweight HTTP server (Python stdlib only, no Flask or FastAPI)
- Runs on port 8677 by default
- Accepts training jobs as multipart uploads (config JSON + tar.gz of snapshots)
- Runs the full pipeline: prepare data, train model, export ONNX
- Streams progress events back via polling endpoint
- UDP beacon every 10 seconds on port 8678 for auto-discovery on the local network
- Dashboard provides UI for adding/removing workers, selecting training targets, and monitoring progress

Worker endpoints:
- `GET /health` — Status, GPU info, busy/idle, Python and PyTorch versions
- `POST /jobs` — Submit a training job with data
- `GET /jobs/current` — Full job status with all progress events
- `GET /jobs/current/events?since=N` — Incremental progress polling
- `GET /jobs/current/artifacts` — Download trained model files as tar.gz
- `POST /jobs/current/cancel` — Cancel the current job

---

## The Dashboard

Woodbury's dashboard is a web-based UI served locally on port 9001 inside the Electron window. It has five main tabs:

### Config Tab
Manage API keys and settings for installed extensions. Each extension can declare required and optional environment variables. The dashboard provides a form for entering and saving these values, which are stored in `.env` files in each extension's directory.

### Workflows Tab
Create, edit, run, and debug workflows.

**Creating workflows**: Click "New Recording" to start recording, or create manually by adding steps.

**Editing workflows**: Visual editor showing all steps with their targets, conditions, and parameters. Edit element selectors, add variables, configure retry logic.

**Running workflows**: Click "Run Workflow" to execute. Real-time progress shows each step completing or failing. Variables can be provided at runtime.

**Debug mode**: Step through a workflow one action at a time. Colored circles with step numbers appear on the actual web page showing where each action will happen. Green checkmarks indicate completed steps, red X marks indicate failures. The extension's side panel shows the full step list with timing and error details. You can drag debug markers to adjust positions if an element has moved. This makes it easy to build, test, and troubleshoot workflows interactively.

**Variables**: Workflows can declare variables with types (string, number, boolean, array), defaults, and descriptions. Variables are substituted at runtime using `{{variableName}}` syntax throughout URLs, text values, and file paths. Variables can also have a generationPrompt for AI-generated values.

**Expectations**: Post-execution checks that validate the workflow accomplished its goal. Can check file counts in directories, verify files exist with minimum sizes, or check variable values.

**Retry logic**: Both per-step and per-workflow retry with configurable max attempts, delay, and backoff multiplier.

### Pipelines Tab
A visual node-based graph editor for chaining workflows into complex automations.

**Node types**:
- **Workflow nodes** — Execute a recorded workflow
- **Script nodes** — Run custom JavaScript logic between workflows
- **Branch nodes** — Conditional routing based on variable values
- **Switch nodes** — Multi-way branching with case matching
- **For-Each loop nodes** — Iterate over arrays
- **Delay nodes** — Wait a configurable time
- **Approval Gate nodes** — Pause for human approval before continuing, with optional preview of variable values and configurable timeout
- **Output nodes** — Declare pipeline outputs
- **Sub-pipeline nodes** — Nest one pipeline inside another

**Edges** connect node outputs to inputs, creating a directed graph. Variables flow along edges.

**Batching**: Run a pipeline multiple times with different variable combinations. Supports "zip" mode (parallel iteration) and "product" mode (Cartesian product of variable pools).

**Scheduling**: Run pipelines on a cron schedule with configurable variables.

### Runs Tab
Complete execution history for all workflow and pipeline runs. Each run record includes:
- Status (running, completed, failed, cancelled)
- Duration
- Step-by-step results with timing and errors
- Variables used and their final values
- Output files produced
- For pipelines: node-by-node results, expectation results, retry counts

### Training Tab
Manage visual AI model training:
- View available training data (snapshots per site)
- Configure training parameters (backbone, epochs, learning rate, crops per element)
- Start training locally or on a remote GPU worker
- Live progress visualization (loss curve, metrics, ETA)
- Worker management (add, remove, probe remote workers)
- Run history for completed training sessions

---

## The Agentic Loop: 40+ Built-in Tools

Woodbury includes an embedded AI coding assistant with over 40 tools. This powers both the CLI mode and the automation intelligence:

### Browser Tools
- **browser_query** — Query the Chrome DOM via the bridge. Actions include: ping, find_interactive (natural language element search), find_elements (CSS selector), find_element_by_text, get_clickable_elements, get_form_fields, get_page_info, get_page_structure, get_page_text, click_element, set_value, scroll_to_element, get_element_info, highlight_element, wait_for_element
- **workflow_play** — Execute recorded workflows with variable binding

### Desktop Tools
- **mouse** — Control the mouse cursor with absolute screen coordinates. Actions: move, click, double_click, right_click, scroll, drag. Supports smooth movement and Chrome offset compensation.
- **keyboard** — Keyboard input. Actions: type text, press keys, hotkeys, clear fields. Platform-aware modifiers.
- **screenshot** — Capture the screen or browser viewport. Returns PNG base64.

### Vision & AI Tools
- **vision_analyze** — Analyze screenshots using Claude vision to detect UI elements, text, and layouts
- **nanobanana** — Generate or edit images using Google Gemini models (flash for speed, pro for quality)

### File Tools
- **file_read** — Read file contents
- **file_write** — Create or modify files with safety checks
- **file_search** — Search for files by glob pattern
- **grep** — Regex-based content search across files
- **list_directory** — List directory contents
- **pdf_read** — Extract text from PDF documents

### Web Tools
- **web_fetch** — Fetch and analyze URLs
- **web_crawl** — Crawl links from a page
- **web_crawl_rendered** — Crawl with JavaScript rendering
- **google_search** — Search Google
- **duckduckgo_search** — Search DuckDuckGo
- **searxng_search** — Search via SearXNG
- **api_search** — Discover REST API endpoints

### Code & Shell Tools
- **shell_execute** — Run shell commands
- **code_execute** — Execute JavaScript code
- **test_runner** — Run test suites
- **git** — Git operations
- **database_query** — Execute SQL queries

### Task & Memory Tools
- **task_create**, **task_list**, **task_get**, **task_update** — Task management
- **memory_save** — Persist data across conversation turns
- **memory_recall** — Retrieve saved data
- **queue_init**, **queue_add_items**, **queue_next**, **queue_done**, **queue_status** — Work queue management

### Meta Tools
- **reflect** — Self-reflection for better reasoning
- **delegate** — Delegate work to another tool
- **goal_contract** — Define and track goals
- **preflight_check** — Validate conditions before proceeding

### Utility Tools
- **ff_json_extract** — Extract structured data from JSON
- **ff_web_scrape** — Structured web scraping
- **ff_image_utils** — Image manipulation utilities
- **ff_pdf_extract** — PDF data extraction
- **ff_prompt_chain** — Chain multiple AI prompts
- **ff_prompt_optimize** — Optimize prompts for better results

---

## The Extension System

Woodbury supports third-party extensions that add new tools, commands, system prompts, and web dashboards without modifying core code.

Extensions live in `~/.woodbury/extensions/`. Each extension has:
- An `activate.ts` entry point that exports an `activate(context)` function
- A `package.json` with metadata
- An `.env` file for credentials and configuration
- Optional `tools/`, `workflows/`, `commands/`, and `web/` directories

The Extension Context API provides:
- `registerTool(definition, handler)` — Register an AI-callable tool
- `registerCommand(definition, handler)` — Register a REPL slash command
- `registerWorkflow(path)` — Register a workflow file
- `addSystemPrompt(text)` — Add instructions to the AI's system prompt
- `serveWebUI(port, staticPath)` — Serve a local web dashboard
- `getEnv(key)` — Read environment variables from the extension's .env file
- `log(message, level)` — Log messages

Extensions are managed via CLI:
- `woodbury ext create <name>` — Scaffold a new extension
- `woodbury ext install <package>` — Install from npm
- `woodbury ext list` — List installed extensions
- `woodbury --no-extensions` — Run without loading extensions

---

## The CLI and REPL

Woodbury can be used as a command-line tool:

```
woodbury                              # Interactive REPL mode
woodbury "read package.json"          # One-shot mode (single task)
woodbury -m claude-opus-4-20250514 "task"  # Specify AI model
woodbury --safe "task"                # Disable dangerous tools
woodbury --debug                      # Enable verbose logging
```

### REPL Features
- Terminal UI with fixed-bottom input prompt and scrolling output
- Token-by-token streaming from the AI model
- Command history (up/down arrows)
- Paste detection for multi-line input
- Ctrl+C handling: once cancels current operation, twice exits

### Slash Commands
- `/help` (aliases: `/h`, `/?`) — Show available commands
- `/exit` (aliases: `/quit`, `/q`) — Exit the REPL
- `/clear` (alias: `/reset`) — Clear conversation history
- `/model [name]` (alias: `/m`) — View or change the AI model
- `/tools` (alias: `/t`) — List all available tools
- `/compact` (alias: `/verbose`, `/v`) — Toggle verbose mode
- `/history` (alias: `/turns`) — Show conversation summary
- `/providers` (alias: `/keys`) — Show configured API providers
- `/extensions` — List loaded extensions
- `/log` — Show debug log (last 20 lines)
- `/log N` — Show last N lines of debug log
- `/record <name> <site>` — Start recording a workflow

---

## The Bridge Server

The bridge server is the WebSocket relay that connects the Chrome extension to the Woodbury backend. It operates in two modes:

1. **Server mode** — Listens on port 7865, accepts connections from the Chrome extension
2. **Piggyback mode** — If another Woodbury instance already owns the port, connects as a client to that server

The protocol is request-response with message ID correlation. Each request has a 15-second timeout. The extension sends a `hello` message on connect with its version and metadata.

Event types flowing through the bridge:
- `recording_event` — User interactions captured during recording
- `page_elements_snapshot` — ML training data (screenshot + element metadata)
- `set_recording_mode` — Toggle recording on/off in the content script
- `show_debug_overlay` / `update_debug_step` / `hide_debug_overlay` — Debug mode UI

---

## Data Storage

Everything is stored locally on your machine:

```
~/.woodbury/
├── data/
│   ├── training-crops/
│   │   ├── snapshots/           — Recording snapshots per site
│   │   │   └── <site_id>/
│   │   │       ├── snapshot_*.json
│   │   │       ├── snapshot_*_viewport.png
│   │   │       ├── snapshot_*_desktop.png
│   │   │       └── interactions_*.json
│   │   ├── crops/               — Cropped element images
│   │   │   └── <site_hash>/<group_hash>/0000.png, 0001.png, ...
│   │   └── metadata.jsonl       — Training metadata
│   ├── models/
│   │   └── <run-id>/
│   │       ├── encoder.onnx     — Trained model
│   │       └── metadata.json    — Training run info
│   ├── runs/                    — Execution history
│   ├── workflows/               — Saved workflow files
│   ├── runs.json                — Run index
│   └── dashboard.json           — Dashboard URL/port
├── logs/
│   ├── recording.log
│   ├── execution.log
│   └── woodbury-*.log           — Session logs
├── extensions/                  — Third-party plugins
│   └── <extension-name>/
│       ├── activate.ts
│       ├── package.json
│       └── .env
└── worker/                      — Remote training worker data
    └── <job-id>/
```

You can delete the entire `~/.woodbury/` directory at any time to remove all stored data.

---

## Privacy and Security

- The Chrome extension only communicates with localhost (port 7865) — no data leaves your machine
- No analytics, telemetry, or tracking of any kind
- All recordings, snapshots, and trained models stay in `~/.woodbury/`
- The extension only activates when you start a recording or run a workflow
- The `debugger` permission is used solely for simulating mouse/keyboard input during replay
- Chrome extension storage is used only for connection state persistence
- The `--safe` flag disables all tools that can modify your system

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Desktop App (.dmg for Mac, .exe for Windows)       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Dashboard (HTTP :9001)                               │   │
│  │  ├── Config Tab (extension API keys)                 │   │
│  │  ├── Workflows Tab (record, edit, run, debug)        │   │
│  │  ├── Pipelines Tab (visual node graph editor)        │   │
│  │  ├── Runs Tab (execution history)                    │   │
│  │  └── Training Tab (visual AI model training)         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Workflow Engine                                      │   │
│  │  ├── Recorder (captures Chrome interactions)         │   │
│  │  ├── Executor (replays workflows step-by-step)       │   │
│  │  ├── Resolver (multi-strategy element finding)       │   │
│  │  ├── Visual Verifier (ONNX element matching)         │   │
│  │  └── Variable Substitution ({{variable}} syntax)     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────┐  ┌──────────────────────────────┐    │
│  │  Bridge Server    │  │  Inference Server             │    │
│  │  (ws://7865)      │  │  (HTTP :8679)                 │    │
│  │  WebSocket relay   │  │  ONNX Runtime + Sharp         │    │
│  │  to Chrome ext    │  │  <2ms per element on CPU      │    │
│  └──────────────────┘  └──────────────────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Agentic Loop (40+ tools)                             │   │
│  │  Browser, Desktop, File, Web, Code, AI/Vision,       │   │
│  │  Memory, Tasks, Queues, Meta                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Extension System                                     │   │
│  │  Tools, Commands, System Prompts, Web UIs             │   │
│  └──────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│  Chrome Extension (Woodbury Bridge)                          │
│  ├── Background Service Worker (WebSocket client)           │
│  ├── Content Script (DOM queries, recording, debug UI)      │
│  ├── Side Panel (workflow debug step-through)               │
│  └── Popup (connection status)                              │
├─────────────────────────────────────────────────────────────┤
│  Training System (woobury-models, Python/PyTorch)            │
│  ├── Data Preparation (crop elements, multi-crop jitter)    │
│  ├── Training (Siamese encoder, NT-Xent loss, PK sampling) │
│  ├── 14 UI-specific augmentations                           │
│  ├── Evaluation (ROC-AUC, EER, TAR@FMR)                    │
│  ├── ONNX Export + Quantization                             │
│  └── Distributed Worker (HTTP server for remote GPU)        │
└─────────────────────────────────────────────────────────────┘
```

The ONNX model file (encoder.onnx) is the only artifact that crosses the boundary between the Python training system and the Node.js runtime.

---

## Use Cases

Woodbury works on any website. Some examples:

- **Music Creation** — Automate song creation on platforms like Suno: enter lyrics, select a style, click Create, wait for generation, download the finished tracks as MP3s, organize them into folders.
- **Social Media** — Post content to Instagram, Twitter, or other platforms. Upload images, write captions, schedule posts.
- **Data Entry** — Fill out repetitive forms across multiple websites with different data each time using variable substitution and batching.
- **E-Commerce** — Monitor prices, add items to carts, complete purchases through multi-step checkout flows.
- **Web Scraping** — Navigate through paginated results, extract text and data into variables, save to files.
- **Testing** — Run through user flows on your own websites to verify they work, with assertions to check for expected outcomes.
- **File Management** — Download files from multiple sources, rename them, move them to organized directories.
- **Content Publishing** — Write blog posts, upload to CMS platforms, set metadata, publish.

For complex scenarios, chain multiple workflows into pipelines: search for products, compare prices, make a decision with a script node, buy the best deal, and post about it on social media — all as a visual flow of connected nodes.

---

## Who Is Woodbury For?

Woodbury is designed for everyone, not just developers:

- **Content creators** automating repetitive posting and publishing tasks
- **Musicians** using online music creation tools who want to streamline their workflow
- **Small business owners** managing multiple web platforms efficiently
- **Researchers** collecting data from multiple websites systematically
- **QA testers** automating user flow testing with visual verification
- **Data analysts** who need to gather and process web data regularly
- **Anyone** who does repetitive tasks in a web browser and wishes they could automate them

No coding knowledge is required. If you can click a mouse, you can build automations with Woodbury. The visual pipeline builder lets you create complex multi-step automations by connecting nodes in a graph, and the debug mode lets you step through and verify each action before running it for real.

---

## Getting Started

1. Download the Woodbury desktop app from GitHub (free, open source, available for Mac and Windows)
2. Install the Woodbury Bridge Chrome extension from the Chrome Web Store
3. Open Woodbury — the dashboard launches automatically
4. Add your AI API key (Anthropic, OpenAI, or Groq) in the Config tab
5. Go to the Workflows tab, click "New Recording"
6. Record your first workflow by doing your task in Chrome
7. Hit replay and watch it run automatically

The whole setup takes about 5 minutes.

---

## Platform Support

Woodbury runs on both macOS and Windows:

### macOS
- **Installer**: `.dmg` (Apple Silicon / arm64)
- **Desktop automation**: Native Swift-based desktop hook for mouse/keyboard capture, with uiohook-napi as fallback
- **App launch**: Uses `open -a "AppName"` via the shell
- **Window chrome**: Hidden title bar with macOS traffic light buttons (close/minimize/zoom)
- **Tray**: Template icon that adapts to light/dark menu bar

### Windows
- **Installer**: `.exe` via NSIS (x64), with option to choose installation directory
- **Desktop automation**: uiohook-napi (cross-platform N-API bindings for keyboard/mouse hooks)
- **App launch**: Uses PowerShell `Start-Process` to launch applications
- **Window chrome**: Standard Windows title bar
- **Tray**: System tray icon with context menu

### Cross-Platform Architecture
The vast majority of Woodbury's codebase is platform-independent — Node.js, Electron, and the Chrome extension run identically on both platforms. Platform-specific behavior is isolated to a few areas:

- **Electron main process** (`electron/main.js`): Conditionally applies macOS-only UI features (hidden title bar, traffic light positioning, drag region CSS) using `process.platform === 'darwin'` guards
- **Build scripts** (`package.json`): Cross-platform `postinstall` and `postbuild` scripts that use inline Node.js instead of shell-specific commands (`chmod`, `plutil`, `rm -rf`)
- **Workflow recorder** (`src/workflow/recorder.ts`): Platform-specific error messages — macOS hints about Accessibility permissions, Windows hints about running as Administrator
- **Shell execution**: Falls back to `cmd.exe` on Windows when bash is unavailable
- **Native modules**: ONNX Runtime, Sharp, uiohook-napi, and ws all ship with Windows prebuilds and are unpacked from the asar archive at runtime

### CI/CD
Both Mac and Windows installers are built automatically via GitHub Actions:

- **macOS**: Builds on `macos-latest` using `electron-builder --mac`, producing a `.dmg`
- **Windows**: Builds on `windows-latest` using `electron-builder --win`, producing an `.exe` via NSIS
- **Triggers**: Runs on push to version tags (`v*`) or manual workflow dispatch
- **Releases**: Artifacts are automatically uploaded to the corresponding GitHub release
