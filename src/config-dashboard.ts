/**
 * Config Dashboard — Backward-Compatibility Facade
 *
 * The dashboard implementation has been modularised into src/dashboard/.
 * This file re-exports the public API so that existing imports
 * (cli.ts, repl.ts, electron/main.js, tests) continue to work unchanged.
 */

export { startDashboard } from './dashboard/index.js';
export type { DashboardHandle } from './dashboard/types.js';
export { maskValue } from './dashboard/utils.js';
