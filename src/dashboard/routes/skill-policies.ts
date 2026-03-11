import type { DashboardContext, RouteHandler } from '../types.js';
import { sendJson, readBody } from '../utils.js';
import { SkillPolicyStore } from '../../loop/v3/skill-policy-store.js';

const skillPolicyStore = new SkillPolicyStore();

export const handleSkillPolicyRoutes: RouteHandler = async (req, res, pathname, url, _ctx) => {
  if (req.method === 'GET' && pathname === '/api/skill-policies') {
    const reviewStatus = url.searchParams.get('reviewStatus') || undefined;
    const skillName = url.searchParams.get('skillName') || undefined;
    const updates = skillName
      ? skillPolicyStore.getForSkill(skillName, reviewStatus as any)
      : skillPolicyStore.getAll().filter(update => !reviewStatus || update.reviewStatus === reviewStatus);
    sendJson(res, 200, { updates });
    return true;
  }

  if (req.method === 'PUT' && pathname.startsWith('/api/skill-policies/')) {
    const updateId = pathname.replace('/api/skill-policies/', '');
    try {
      const body = await readBody(req);
      const existing = skillPolicyStore.getAll().find(update => update.id === updateId);
      if (!existing) {
        sendJson(res, 404, { error: 'Skill policy update not found' });
        return true;
      }

      if (body.reviewStatus) {
        skillPolicyStore.updateReviewStatus(updateId, body.reviewStatus);
      }

      const current = skillPolicyStore.getAll().find(update => update.id === updateId)!;
      current.guidance = typeof body.guidance === 'string' ? body.guidance : current.guidance;
      current.applicabilityPattern = typeof body.applicabilityPattern === 'string'
        ? body.applicabilityPattern
        : current.applicabilityPattern;
      current.confidence = typeof body.confidence === 'number' ? body.confidence : current.confidence;
      current.updatedAt = new Date().toISOString();
      skillPolicyStore.replace(current);

      sendJson(res, 200, { success: true, update: current });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
    return true;
  }

  return false;
};