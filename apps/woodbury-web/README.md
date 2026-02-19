# Woodbury Web - Enhanced Agent REPL

An advanced web-based REPL for AI agent interaction with complete transparency, control, and reproducibility.

## Features Implemented

### 🎯 Core Philosophy: "Chat + Plan + Act + Trace"

The UI provides instant visibility into:
- **What's the goal?** - Clear context and objectives
- **What's the current plan?** - Step-by-step plan visualization
- **What action is happening right now?** - Real-time activity stream
- **What changed because of it?** - Diff views and state changes
- **How do I stop/undo/approve it?** - Interactive controls

### 🖼️ 3-Pane Layout

**Left: Conversation + Commands**
- Prompt input with syntax highlighting
- Slash command palette (`/plan`, `/run`, `/context`, etc.)
- Conversation history with search
- Reusable snippet library

**Center: Interactive Timeline**
- Step-by-step event stream: thought → tool → result → decision
- Expandable nodes with full input/output details
- JSON pretty-printing with syntax highlighting
- One-click replay of individual steps or entire runs

**Right: State Inspector**
- Working set (active files, URLs, notes)
- Context variables and constraints
- Tool permissions and budget meters
- Pinned facts and user-approved truths

### 🛡️ Safety & Control

**Risk-Based Approval System**
- 4 risk levels: `safe` → `medium` → `high` → `critical`
- Context-aware tool assessment
- Interactive diff previews before file operations
- Approval history and reasoning tracking

**Tool Permission Management**
- Scoped permissions per project and session
- Allowlist/blocklist tool configuration
- "Elevate once" option for temporary permissions

### 📊 Transparency & Debugging

**Complete Observability**
- Schema-aware JSON rendering with collapsible sections
- Structured tool args with validation indicators
- Result rendering: tables, diffs, trees, artifacts
- Source provenance tracking

**Reproducible Runs**
- Full run bundle export (timeline + artifacts + context)
- Exact replay vs. modified re-execution
- State synchronization and approval preservation
- Golden transcript generation for regression testing

## Architecture

```
src/
├── app/                     # Next.js 14 app router
├── components/
│   ├── REPL.tsx             # Main 3-pane interface
│   ├── Timeline.tsx         # Interactive event timeline
│   ├── ApprovalSystem.tsx   # Risk assessment engine
│   └── ApprovalGate.tsx     # Approval UI with previews
├── server/
│   └── WebSocketAgent.ts    # Real-time agent bridge
├── types/index.ts           # TypeScript interfaces
└── __tests__/               # Comprehensive test suite
```

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Integration

The web REPL integrates seamlessly with the existing woodbury CLI:

```bash
# Start web interface
woodbury web

# Connect to existing session
woodbury web --session <session-id>

# Export session for analysis
woodbury export --format json --output session.json
```

## Commands

The REPL supports all standard woodbury commands plus web-specific interactions:

- `/plan` - Generate or edit execution plan
- `/run` - Execute plan with optional flags
- `/context` - Manage working set and variables
- `/approve` - Configure approval preferences
- `/export` - Export current session
- `/replay` - Replay previous runs
- `/budget` - View/set resource limits

## Technology Stack

- **Frontend**: Next.js 14, React 18, TypeScript
- **Styling**: Tailwind CSS with custom components
- **Real-time**: WebSocket integration
- **Testing**: Jest with React Testing Library
- **Build**: Next.js optimized bundling

## Status

✅ **Complete Implementation** - All core features delivered
✅ **Full Test Coverage** - Comprehensive test suite
✅ **Production Ready** - Build optimization and error handling
✅ **CLI Integration** - Seamless woodbury workflow integration

This implementation delivers the complete vision for an agent REPL that makes AI thinking legible, actions controllable, and runs reproducible.
