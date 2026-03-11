/**
 * Dashboard Module — Public API
 *
 * Re-exports the main entry points for external consumers.
 * This is the barrel file that replaces the monolithic config-dashboard.ts.
 */

export { startDashboard } from './server.js';
export type { DashboardHandle, DashboardContext } from './types.js';
export { maskValue } from './utils.js';
