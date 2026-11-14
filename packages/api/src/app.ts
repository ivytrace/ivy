import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authenticate } from './lib/auth/middleware.js';
import { mountAgentSurface } from './lib/mcp/mount.js';
import { serveUi } from './lib/static/serve-ui.js';
import { internalAuth } from './lib/internal/auth.js';
import { allProjects, projectContext, workspaceContext, type WorkspaceAccess } from './lib/tenancy/context.js';
import { userWorkspaceAccess } from './lib/tenancy/members.js';
import { deleteAwsAccount } from './routes/aws/accounts/delete.js';
import { getAwsAccount, getAwsAccounts } from './routes/aws/accounts/get.js';
import { patchAwsAccount } from './routes/aws/accounts/patch.js';
import { postAwsAccount } from './routes/aws/accounts/post.js';
import { syncAwsAccount } from './routes/aws/accounts/sync.js';
import { verifyAwsAccount } from './routes/aws/accounts/verify.js';
import { postAwsEvent } from './routes/aws/events.js';
import { getAwsAccountFunctions, getAwsFunctions } from './routes/aws/functions/get.js';
import { postAwsFunctionsBulk, putAwsFunction } from './routes/aws/functions/put.js';
import { deleteRuleRoute } from './routes/aws/rules/delete.js';
import { postRuleDryRun } from './routes/aws/rules/dry-run.js';
import { getRules } from './routes/aws/rules/get.js';
import { putRuleOrder } from './routes/aws/rules/order.js';
import { patchRule } from './routes/aws/rules/patch.js';
import { postRule } from './routes/aws/rules/post.js';
import { getAwsSetup } from './routes/aws/setup.js';
import { getAwsTemplate } from './routes/aws/template.js';
import { getConfig } from './routes/config/get.js';
import { getErrors } from './routes/errors/get.js';
import { getFunctions } from './routes/functions/get.js';
import { getHealth } from './routes/health/get.js';
import { deleteInvitation } from './routes/invitations/delete.js';
import { getInvitationByToken, getInvitations } from './routes/invitations/get.js';
import { postAcceptInvitation, postInvitation } from './routes/invitations/post.js';
import { getInvocations } from './routes/invocations/get.js';
import { deleteKey } from './routes/keys/delete.js';
import { getKeys } from './routes/keys/get.js';
import { postKey } from './routes/keys/post.js';
import { deleteMember } from './routes/members/delete.js';
import { getMembers } from './routes/members/get.js';
import { patchMember } from './routes/members/patch.js';
import { getProject, getProjects } from './routes/projects/get.js';
import { patchProject } from './routes/projects/patch.js';
import { postProject } from './routes/projects/post.js';
import { getTimeseries } from './routes/stats/timeseries.js';
import { getTrace } from './routes/traces/get.js';
import { deleteInternalLimits, putInternalLimits } from './routes/internal/limits/put.js';
import { getInternalMembers } from './routes/internal/members/get.js';
import { getInternalWorkspace, getInternalWorkspaces } from './routes/internal/workspaces/get.js';
import { getUsage } from './routes/usage/get.js';
import { deleteWorkspaceRoute } from './routes/workspaces/delete.js';
import { getWorkspace, getWorkspaces } from './routes/workspaces/get.js';
import { patchWorkspace } from './routes/workspaces/patch.js';
import { postWorkspace } from './routes/workspaces/post.js';

export function createApp(options: { uiDir: string; access?: WorkspaceAccess }) {
  const access = options.access ?? userWorkspaceAccess();
  const app = new Hono();

  // Internal admin API for an operator's billing service: not under /api, so a proxy can keep it private.
  app.use('/internal/*', internalAuth());
  app.get('/internal/workspaces', getInternalWorkspaces);
  app.get('/internal/workspaces/:id', getInternalWorkspace);
  app.put('/internal/workspaces/:id/limits', putInternalLimits);
  app.delete('/internal/workspaces/:id/limits', deleteInternalLimits);
  app.get('/internal/workspaces/:id/members', getInternalMembers);
  app.all('/internal/*', (c) => c.json({ error: 'Not found' }, 404));

  app.use('/api/*', authenticate());
  app.get('/api/health', getHealth);
  app.get('/api/config', getConfig);
  app.post('/api/aws/events', postAwsEvent);
  mountAgentSurface(app, access, { uiDir: options.uiDir });

  // The caller's account: workspaces and invite links (no workspace context).
  app.get('/api/workspaces', getWorkspaces(access));
  app.post('/api/workspaces', postWorkspace);
  app.get('/api/invitations/:token', getInvitationByToken);
  app.post('/api/invitations/:token/accept', postAcceptInvitation);

  // Everything else is in a workspace the caller is a member of (404 otherwise), and data in a project.
  const ws = '/api/w/:workspace';
  const prj = `${ws}/p/:project`;
  // (`/x/*` also matches `/x` itself in Hono.)
  app.use(`${ws}/*`, workspaceContext(access));
  app.use(`${prj}/*`, projectContext());

  app.get(ws, getWorkspace);
  app.patch(ws, patchWorkspace);
  app.delete(ws, deleteWorkspaceRoute);
  app.get(`${ws}/members`, getMembers);
  app.patch(`${ws}/members/:sub`, patchMember);
  app.delete(`${ws}/members/:sub`, deleteMember);
  app.get(`${ws}/invitations`, getInvitations);
  app.post(`${ws}/invitations`, postInvitation);
  app.delete(`${ws}/invitations/:id`, deleteInvitation);
  // This month's traces against the workspace's limits: workspace-level, across all its projects.
  app.get(`${ws}/usage`, getUsage);
  app.get(`${ws}/projects`, getProjects);
  app.post(`${ws}/projects`, postProject);
  app.get(prj, getProject);
  app.patch(prj, patchProject);
  app.get(`${prj}/keys`, getKeys);
  app.post(`${prj}/keys`, postKey);
  app.delete(`${prj}/keys/:id`, deleteKey);

  // Data: per project, and workspace-wide where it makes sense (explicitly all projects).
  app.get(`${prj}/functions`, getFunctions);
  app.get(`${prj}/invocations`, getInvocations);
  app.get(`${prj}/traces/:traceId`, getTrace);
  app.get(`${prj}/errors`, getErrors);
  app.get(`${prj}/stats/timeseries`, getTimeseries);
  app.get(`${ws}/functions`, allProjects(), getFunctions);
  app.get(`${ws}/errors`, allProjects(), getErrors);

  // AWS accounts and auto-trace, per workspace.
  app.get(`${ws}/aws/setup`, getAwsSetup);
  app.get(`${ws}/aws/template.yaml`, getAwsTemplate);
  app.get(`${ws}/aws/accounts`, getAwsAccounts);
  app.post(`${ws}/aws/accounts`, postAwsAccount);
  app.get(`${ws}/aws/accounts/:id`, getAwsAccount);
  app.patch(`${ws}/aws/accounts/:id`, patchAwsAccount);
  app.delete(`${ws}/aws/accounts/:id`, deleteAwsAccount);
  app.post(`${ws}/aws/accounts/:id/verify`, verifyAwsAccount);
  app.post(`${ws}/aws/accounts/:id/sync`, syncAwsAccount);
  app.get(`${ws}/aws/accounts/:id/functions`, getAwsAccountFunctions);
  app.get(`${ws}/aws/functions`, getAwsFunctions);
  app.post(`${ws}/aws/functions/bulk`, postAwsFunctionsBulk);
  app.put(`${ws}/aws/functions/:accountId/:region/:name`, putAwsFunction);
  app.get(`${ws}/aws/rules`, getRules);
  app.post(`${ws}/aws/rules`, postRule);
  app.post(`${ws}/aws/rules/dry-run`, postRuleDryRun);
  app.put(`${ws}/aws/rules/order`, putRuleOrder);
  app.patch(`${ws}/aws/rules/:id`, patchRule);
  app.delete(`${ws}/aws/rules/:id`, deleteRuleRoute);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use('*', serveUi(options.uiDir));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });
  return app;
}
