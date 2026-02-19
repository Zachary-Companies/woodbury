# woodbury

Interactive AI coding assistant CLI powered by an embedded agentic-loop engine in src/loop/.

## Features

- **14 built-in tools** — file I/O, shell, git, grep, web fetch, database queries, code execution, and more
- **Extension system** — add custom tools, slash commands, system prompts, and web UIs
- **Interactive REPL** — multi-turn conversations with slash commands
- **One-shot mode** — run a single task from the command line
- **Multi-turn memory** — conversation history preserved across turns
- **Markdown rendering** — syntax-highlighted code blocks in the terminal
- **Project context** — loads `.woodbury.md` for project-specific instructions
- **Ctrl+C handling** — abort running tasks or double-press to exit

## Setup

Requires Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/) (or OpenAI/Groq).

```bash
git clone https://github.com/Zachary-Companies/woodbury.git
cd woodbury
```

**Windows:**
```
setup.bat
```

**Mac/Linux:**
```bash
./setup.sh
```

**Or manually:**
```bash
npm run setup
```

### API Keys

Add your API keys to `~/.agentic-loop/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
```

## Usage

```bash
woodbury                                    # Interactive REPL
woodbury "read package.json"                # One-shot mode
woodbury -m claude-opus-4-20250514 "task"   # Specify model
woodbury --safe "task"                      # Disable dangerous tools
woodbury -v "task"                          # Verbose output
woodbury -d /path/to/project "task"         # Set working directory
```

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

## Tools

All 14 tools from the embedded agentic-loop engine in src/loop/:

| Tool | Description |
|------|-------------|
| `file_read` | Read file contents |
| `file_write` | Write/create files |
| `list_directory` | List directory contents |
| `file_search` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `shell_execute` | Execute shell commands |
| `code_execute` | Run code (Node.js, TypeScript, Python) |
| `test_run` | Run tests (Jest, Vitest, pytest) |
| `git` | Git operations |
| `web_fetch` | HTTP requests |
| `web_crawl` | Parse HTML to text |
| `web_crawl_rendered` | Render JavaScript with Puppeteer |
| `google_search` | Google Custom Search |
| `database_query` | Query databases (SQLite, Postgres, DynamoDB) |

Use `--safe` to disable tools that can modify your system.

## Extensions

Extensions add new capabilities to Woodbury — tools, slash commands, system prompt guidance, and web dashboards — without modifying core code.

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

Extensions live in `~/.woodbury/extensions/`. Each extension has a `package.json` with a `woodbury` field and a JS entry point that exports `activate(ctx)`:

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

See [docs/extensions.md](docs/extensions.md) for the full authoring guide, [docs/extension-api-reference.md](docs/extension-api-reference.md) for the complete API reference, and [docs/extension-testing.md](docs/extension-testing.md) for testing patterns.

## Project Context

Create a `.woodbury.md` file in your project root to provide project-specific instructions. Woodbury walks up from the working directory to find it and includes its contents in the system prompt.

## License

MIT
