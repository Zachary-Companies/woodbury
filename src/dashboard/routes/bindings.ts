/**
 * Bindings Routes — CRUD for pipeline data connections.
 *
 * Manages entity-to-entity relationships, auto-binding rules,
 * and custom view configurations stored in the pipeline's bindings/ directory.
 */

import type { RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { discoverCompositions } from '../../workflow/loader.js';
import {
  loadBindings,
  saveBindings,
  loadRules,
  saveRules,
  loadViews,
  saveViews,
  applyAllRules,
  getBindingsFrom,
  getTargetIds,
  type Binding,
  type BindingRule,
  type ViewConfig,
} from '../pipeline-bindings.js';

// ── Helpers ──────────────────────────────────────────────────

async function resolvePipelineDir(compositionId: string): Promise<string | null> {
  const compositions = await discoverCompositions();
  const found = compositions.find(c => c.composition.id === compositionId);
  if (!found?.isV2Pipeline || !found.pipelineDir) return null;
  return found.pipelineDir;
}

// ── Route handler ────────────────────────────────────────────

export const handleBindingsRoutes: RouteHandler = async (req, res, pathname, _url, ctx) => {
  // Match /api/compositions/:id/bindings*
  const bindMatch = pathname.match(/^\/api\/compositions\/([^/]+)\/bindings(?:\/(.*))?$/);
  if (!bindMatch) return false;

  const compositionId = decodeURIComponent(bindMatch[1]);
  const subPath = bindMatch[2] ? `/${bindMatch[2]}` : '';

  const pipelineDir = await resolvePipelineDir(compositionId);
  if (!pipelineDir) {
    sendJson(res, 404, { error: 'Pipeline not found or not a v2 pipeline' });
    return true;
  }

  // ── GET /api/compositions/:id/bindings ──────────────────
  // List all bindings
  if (req.method === 'GET' && subPath === '') {
    const doc = await loadBindings(pipelineDir);
    sendJson(res, 200, doc);
    return true;
  }

  // ── POST /api/compositions/:id/bindings ─────────────────
  // Create a new binding
  if (req.method === 'POST' && subPath === '') {
    const body = await readBody(req);
    const doc = await loadBindings(pipelineDir);

    const now = new Date().toISOString();
    const binding: Binding = {
      id: body.id || `bind-${Date.now().toString(36)}`,
      type: body.type || 'references',
      source: body.source,
      target: body.target,
      confidence: body.confidence ?? 1.0,
      origin: body.origin || 'manual',
      createdAt: now,
      updatedAt: now,
      metadata: body.metadata,
    };

    doc.bindings.push(binding);
    if (!doc.pipelineId) doc.pipelineId = compositionId;
    await saveBindings(pipelineDir, doc);

    sendJson(res, 201, binding);
    return true;
  }

  // ── PUT /api/compositions/:id/bindings/:bindId ──────────
  // Update a binding
  if (req.method === 'PUT' && subPath.match(/^\/[^/]+$/) && !subPath.startsWith('/rules') && !subPath.startsWith('/views') && !subPath.startsWith('/for-') && !subPath.startsWith('/apply')) {
    const bindId = decodeURIComponent(subPath.slice(1));
    const body = await readBody(req);
    const doc = await loadBindings(pipelineDir);

    const idx = doc.bindings.findIndex(b => b.id === bindId);
    if (idx === -1) {
      sendJson(res, 404, { error: 'Binding not found' });
      return true;
    }

    doc.bindings[idx] = {
      ...doc.bindings[idx],
      ...body,
      id: bindId,
      updatedAt: new Date().toISOString(),
    };
    await saveBindings(pipelineDir, doc);

    sendJson(res, 200, doc.bindings[idx]);
    return true;
  }

  // ── DELETE /api/compositions/:id/bindings/:bindId ───────
  // Delete a binding
  if (req.method === 'DELETE' && subPath.match(/^\/[^/]+$/) && !subPath.startsWith('/rules') && !subPath.startsWith('/views')) {
    const bindId = decodeURIComponent(subPath.slice(1));
    const doc = await loadBindings(pipelineDir);

    const before = doc.bindings.length;
    doc.bindings = doc.bindings.filter(b => b.id !== bindId);

    if (doc.bindings.length === before) {
      sendJson(res, 404, { error: 'Binding not found' });
      return true;
    }

    await saveBindings(pipelineDir, doc);
    sendJson(res, 200, { deleted: true });
    return true;
  }

  // ── GET /api/compositions/:id/bindings/for-entity/:type/:id ──
  // Get bindings for a specific entity (as source)
  if (req.method === 'GET' && subPath.match(/^\/for-entity\//)) {
    const parts = subPath.split('/');
    // /for-entity/shot/shot-1
    const entityType = decodeURIComponent(parts[2] || '');
    const entityId = decodeURIComponent(parts[3] || '');
    const relationship = parts[4] ? decodeURIComponent(parts[4]) : undefined;

    const doc = await loadBindings(pipelineDir);
    const bindings = getBindingsFrom(doc, entityType, entityId, relationship);
    sendJson(res, 200, { bindings });
    return true;
  }

  // ── POST /api/compositions/:id/bindings/apply-rules ─────
  // Trigger auto-binding rule evaluation
  if (req.method === 'POST' && subPath === '/apply-rules') {
    const body = await readBody(req);
    const sourceEntities = body.sourceEntities || [];
    const targetEntities = body.targetEntities || [];

    const result = await applyAllRules(pipelineDir, sourceEntities, targetEntities);
    sendJson(res, 200, result);
    return true;
  }

  // ── GET /api/compositions/:id/bindings/rules ────────────
  if (req.method === 'GET' && subPath === '/rules') {
    const doc = await loadRules(pipelineDir);
    sendJson(res, 200, doc);
    return true;
  }

  // ── POST /api/compositions/:id/bindings/rules ───────────
  // Create a rule
  if (req.method === 'POST' && subPath === '/rules') {
    const body = await readBody(req);
    const doc = await loadRules(pipelineDir);

    const rule: BindingRule = {
      id: body.id || `rule-${Date.now().toString(36)}`,
      name: body.name || 'Unnamed rule',
      description: body.description,
      enabled: body.enabled ?? true,
      type: body.type || 'text-match',
      source: body.source,
      target: body.target,
      relationship: body.relationship || 'references',
      matchOptions: body.matchOptions,
    };

    doc.rules.push(rule);
    if (!doc.pipelineId) doc.pipelineId = compositionId;
    await saveRules(pipelineDir, doc);

    sendJson(res, 201, rule);
    return true;
  }

  // ── PUT /api/compositions/:id/bindings/rules/:ruleId ────
  if (req.method === 'PUT' && subPath.match(/^\/rules\/[^/]+$/)) {
    const ruleId = decodeURIComponent(subPath.split('/')[2]);
    const body = await readBody(req);
    const doc = await loadRules(pipelineDir);

    const idx = doc.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) {
      sendJson(res, 404, { error: 'Rule not found' });
      return true;
    }

    doc.rules[idx] = { ...doc.rules[idx], ...body, id: ruleId };
    await saveRules(pipelineDir, doc);

    sendJson(res, 200, doc.rules[idx]);
    return true;
  }

  // ── DELETE /api/compositions/:id/bindings/rules/:ruleId ─
  if (req.method === 'DELETE' && subPath.match(/^\/rules\/[^/]+$/)) {
    const ruleId = decodeURIComponent(subPath.split('/')[2]);
    const doc = await loadRules(pipelineDir);

    const before = doc.rules.length;
    doc.rules = doc.rules.filter(r => r.id !== ruleId);

    if (doc.rules.length === before) {
      sendJson(res, 404, { error: 'Rule not found' });
      return true;
    }

    await saveRules(pipelineDir, doc);
    sendJson(res, 200, { deleted: true });
    return true;
  }

  // ── GET /api/compositions/:id/bindings/views ────────────
  if (req.method === 'GET' && subPath === '/views') {
    const doc = await loadViews(pipelineDir);
    sendJson(res, 200, doc);
    return true;
  }

  // ── POST /api/compositions/:id/bindings/views ───────────
  if (req.method === 'POST' && subPath === '/views') {
    const body = await readBody(req);
    const doc = await loadViews(pipelineDir);

    const view: ViewConfig = {
      id: body.id || `view-${Date.now().toString(36)}`,
      type: body.type || 'custom',
      label: body.label || 'Custom View',
      icon: body.icon,
      entityMappings: body.entityMappings || {},
      bindingTypes: body.bindingTypes,
      settings: body.settings,
    };

    doc.views.push(view);
    if (!doc.pipelineId) doc.pipelineId = compositionId;
    await saveViews(pipelineDir, doc);

    sendJson(res, 201, view);
    return true;
  }

  // ── PUT /api/compositions/:id/bindings/views/:viewId ────
  if (req.method === 'PUT' && subPath.match(/^\/views\/[^/]+$/)) {
    const viewId = decodeURIComponent(subPath.split('/')[2]);
    const body = await readBody(req);
    const doc = await loadViews(pipelineDir);

    const idx = doc.views.findIndex(v => v.id === viewId);
    if (idx === -1) {
      sendJson(res, 404, { error: 'View not found' });
      return true;
    }

    doc.views[idx] = { ...doc.views[idx], ...body, id: viewId };
    await saveViews(pipelineDir, doc);

    sendJson(res, 200, doc.views[idx]);
    return true;
  }

  // ── DELETE /api/compositions/:id/bindings/views/:viewId ─
  if (req.method === 'DELETE' && subPath.match(/^\/views\/[^/]+$/)) {
    const viewId = decodeURIComponent(subPath.split('/')[2]);
    const doc = await loadViews(pipelineDir);

    const before = doc.views.length;
    doc.views = doc.views.filter(v => v.id !== viewId);

    if (doc.views.length === before) {
      sendJson(res, 404, { error: 'View not found' });
      return true;
    }

    await saveViews(pipelineDir, doc);
    sendJson(res, 200, { deleted: true });
    return true;
  }

  return false;
};
