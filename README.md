<p align="center">
  <img src="electron/icons/icon.png" alt="Woodbury" width="128" height="128" />
</p>

<h1 align="center">Woodbury</h1>

<p align="center">
  <strong>Automate your browser. No code required.</strong><br/>
  Record your actions, replay them with AI. Woodbury turns your clicks into automated workflows — built for everyone, not just developers.
</p>

<p align="center">
  <a href="https://github.com/mephisto83/woodbury/releases/download/v1.0.11/Woodbury-1.0.11-arm64.dmg"><strong>Download for Mac</strong></a> · <a href="https://woobury-ai.web.app">Website</a> · <a href="docs/extensions.md">Extension Docs</a>
</p>

---

## What is Woodbury?

Woodbury is a desktop automation platform that lets you record browser and desktop interactions and replay them as intelligent workflows. It combines a visual pipeline builder, an AI coding assistant, and a Chrome extension into one app.

**Record** → Click record, do your task in the browser. Woodbury watches and learns.

**Replay** → Run your recorded workflow anytime. Woodbury handles it automatically.

**Scale** → Chain workflows into visual pipelines, schedule them, and run them across sites.

![Woodbury Dashboard — Visual Pipeline Builder](apps/woodbury-web/public/screenshots/dashboard-pipelines.png)

## Features

- **Browser Automation** — Record clicks, form fills, and navigation as replayable workflows
- **Desktop Automation** — Control any application, not just browsers
- **Visual AI** — Siamese neural network recognizes UI elements even when pages change (theme, hover states, layout shifts)
- **Visual Pipelines** — Chain workflows together in a node-based graph editor
- **Workflow Recording** — Chrome extension captures interactions as structured JSON with CSS selectors, fallback strategies, and variable substitution
- **Extension System** — Add custom tools, slash commands, system prompts, and web UIs
- **Interactive CLI (REPL)** — Multi-turn AI coding assistant with 40+ built-in tools
- **Scheduling** — Run automations on a schedule
- **No Code** — Point and click, no programming needed

## Download

| Platform | Link |
|----------|------|
| macOS (Apple Silicon) | [Woodbury-1.0.11-arm64.dmg](https://github.com/mephisto83/woodbury/releases/download/v1.0.11/Woodbury-1.0.11-arm64.dmg) |

## Getting Started

### Desktop App (recommended)

1. Download the `.dmg` from the [latest release](https://github.com/mephisto83/woodbury/releases/latest)
2. Drag **Woodbury** into your Applications folder
3. Open Woodbury — the dashboard launches automatically
4. Add your API key (Anthropic, OpenAI, or Groq) in the Config tab

### From Source

Requires Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/) (or OpenAI/Groq).

```bash
git clone https://github.com/mephisto83/woodbury.git
cd woodbury
npm run setup
```

Add your API keys to `~/.agentic-loop/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
```

**Run the desktop app in dev mode:**
```bash
npm run electron:dev
```

**Or use the CLI:**
```bash
woodbury                                    # Interactive REPL
woodbury "read package.json"                # One-shot mode
woodbury -m claude-opus-4-20250514 "task"   # Specify model
woodbury --safe "task"                      # Disable dangerous tools
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electron Desktop App                                    │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │  Config       │  │  Workflows    │  │  Pipelines   │  │
│  │  Dashboard    │  │  (Record/Run) │  │  (Node Graph)│  │
│  └──────────────┘  └───────────────┘  └──────────────┘  │
├──────────────────────────────────────────────────────────┤
│  Backend (Node.js)                                       │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │
│  │  Agentic Loop │  │  Workflow     │  │  Extension   │  │
│  │  (40+ tools)  │  │  Engine       │  │  Manager     │  │
│  └──────────────┘  └───────────────┘  └──────────────┘  │
├──────────────────────────────────────────────────────────┤
│  Chrome Extension          │  Visual AI (ONNX)           │
│  Records browser actions   │  Element matching via        │
│  Injects automation        │  Siamese embeddings          │
└──────────────────────────────────────────────────────────┘
```

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Main application source (CLI, agent, tools, dashboard) |
| `src/loop/` | Embedded agentic loop engine |
| `src/loop/tools/` | 40+ tool implementations |
| `src/workflow/` | Workflow recording, execution, and visual verification |
| `src/config-dashboard/` | Dashboard web UI (Config, Workflows, Pipelines, Runs) |
| `electron/` | Electron shell (main process, preload, icons) |
| `apps/woodbury-web/` | Marketing website (Next.js, deployed to Firebase) |
| `apps/remote/` | Remote relay application |
| `docs/` | Extension authoring docs, API reference |

## Workflows

Woodbury workflows are structured JSON documents (`.workflow.json`) that capture browser and desktop interactions:

- **Browser steps** — navigate, click, type, keyboard shortcuts, wait conditions
- **Desktop steps** — launch apps, click at coordinates, type text, keyboard input
- **Element targeting** — CSS selectors with fallback strategies (aria labels, text content, position)
- **Variable substitution** — Parameterize workflows with runtime variables
- **Visual verification** — AI-powered element matching via trained Siamese models
- **Expectations** — Assert conditions after workflow execution
- **Retry logic** — Automatic retry on step or expectation failure

### Recording

```bash
# Via CLI
woodbury
> /record my-workflow suno.com

# Or use the dashboard: Workflows tab → New Recording
```

The Chrome extension captures every interaction and converts it into a `WorkflowDocument` with full metadata.

### Visual AI

Woodbury trains site-specific Siamese neural networks to verify UI elements across visual variations. See [woobury-models](https://github.com/mephisto83/woobury-models) for the training system.

- **Input**: 224×224 letterboxed element crops
- **Output**: 64-dim L2-normalized embeddings
- **Matching**: Cosine similarity with configurable threshold
- **Inference**: ONNX Runtime (<2ms per element on CPU)

## Pipelines

The visual pipeline builder lets you chain workflows into directed graphs:

- Drag-and-drop node editor
- Connect workflow outputs to inputs
- Script nodes for custom logic
- Run pipelines end-to-end from the dashboard

## CLI Tools

All 40+ tools from the embedded agentic loop:

| Category | Tools |
|----------|-------|
| **File** | `file_read`, `file_write`, `list_directory`, `file_search`, `grep` |
| **Shell** | `shell_execute`, `code_execute`, `test_runner` |
| **Git** | `git` |
| **Web** | `web_fetch`, `web_crawl`, `web_crawl_rendered` |
| **Search** | `google_search`, `duckduckgo_search`, `searxng_search`, `api_search` |
| **Database** | `database_query` |
| **PDF** | `pdf_read` |
| **Browser** | `browser_query`, `ff_browser`, `ff_mouse`, `ff_keyboard`, `ff_screenshot`, `ff_file_dialog` |
| **AI/Vision** | `ff_vision`, `ff_prompt_chain`, `ff_prompt_optimize`, `nanobanana` |
| **Workflow** | `ff_workflow_execute` |
| **Memory** | `memory_save`, `memory_recall` |
| **Task** | `task_create`, `task_get`, `task_list`, `task_update` |
| **Queue** | `queue_init`, `queue_add_items`, `queue_next`, `queue_done`, `queue_status` |
| **Utility** | `ff_json_extract`, `ff_web_scrape`, `ff_image_utils`, `ff_pdf_extract` |
| **Meta** | `reflect`, `delegate`, `goal_contract`, `preflight_check` |

Use `--safe` to disable tools that can modify your system.

## Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | `/h`, `/?` | Show commands |
| `/exit` | `/quit`, `/q` | Exit |
| `/clear` | `/reset` | Clear conversation history |
| `/model [name]` | `/m` | View/change model |
| `/tools` | `/t` | List available tools |
| `/compact` | `/verbose`, `/v` | Toggle verbose mode |
| `/history` | `/turns` | Show conversation summary |
| `/providers` | `/keys` | Show configured API providers |
| `/extensions` | | List loaded extensions |

## Extensions

Extensions add new capabilities — tools, slash commands, system prompt guidance, and web dashboards — without modifying core code.

```bash
# Scaffold a new extension
woodbury ext create social-media

# Install from npm
woodbury ext install woodbury-ext-analytics

# List installed extensions
woodbury ext list

# Start without extensions
woodbury --no-extensions
```

Extensions live in `~/.woodbury/extensions/`. Each exports an `activate(ctx)` function:

```javascript
module.exports = {
  async activate(ctx) {
    ctx.registerTool(definition, handler);     // AI-callable tool
    ctx.registerCommand(slashCommand);          // REPL command
    ctx.addSystemPrompt('Instructions...');     // Agent guidance
    await ctx.serveWebUI({ staticDir: 'web' }); // Local dashboard
  }
};
```

See [docs/extensions.md](docs/extensions.md) for the full authoring guide, [docs/extension-api-reference.md](docs/extension-api-reference.md) for the API reference, and [docs/extension-testing.md](docs/extension-testing.md) for testing patterns.

## Building

```bash
# Build TypeScript
npm run build

# Run tests
npm test

# Build Electron .dmg (macOS)
npm run electron:build

# Dev mode (Electron)
npm run electron:dev
```

## Project Context

Create a `.woodbury.md` file in your project root to provide project-specific instructions. Woodbury walks up from the working directory to find it and includes its contents in the system prompt.

## Links

- **Website**: [woobury-ai.web.app](https://woobury-ai.web.app)
- **Visual AI Models**: [woobury-models](https://github.com/mephisto83/woobury-models)
- **Releases**: [GitHub Releases](https://github.com/mephisto83/woodbury/releases)

## License

MIT — [Zachary Companies](https://github.com/Zachary-Companies)
