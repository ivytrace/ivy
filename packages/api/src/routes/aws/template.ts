import type { Context } from 'hono';
import { principalArn } from '../../lib/aws/clients.js';
import { eventsUrl } from '../../lib/aws/config.js';
import { roleNameOf } from '../../lib/aws/present.js';
import { awsStore } from '../../lib/aws/store.js';
import { templateYaml, type TemplateParams } from '../../lib/aws/template.js';
import { tenantOf } from '../../lib/tenancy/context.js';

function sendTemplate(c: Context, params: TemplateParams, suffix = '') {
  c.header('content-type', 'text/yaml; charset=utf-8');
  if (c.req.query('download')) c.header('content-disposition', `attachment; filename="ivy-trace${suffix}.yaml"`);
  return c.body(templateYaml(params));
}

/**
 * `GET /api/aws/template.yaml`, public: the generic template. Every per-connection value (external
 * ID, role name, events URL, event secret) is a parameter without a default; only the trusted
 * principal, which is the same for every connection and not secret, has one. This is the file to
 * publish to S3 as IVY_CFN_TEMPLATE_URL; quick-create links pass the rest as `param_…`.
 */
export async function getPublicAwsTemplate(c: Context) {
  return sendTemplate(c, { principalArn: await principalArn() });
}

/**
 * `GET /api/w/:workspace/aws/template.yaml?account=<id>`: the same template with that connection's
 * values (including its event secret) as defaults, for the "download and upload in the console"
 * path. Behind auth; without `account` it is the generic template.
 */
export async function getAwsTemplate(c: Context) {
  const params: TemplateParams = { principalArn: await principalArn() };
  const id = c.req.query('account');
  if (id) {
    const account = await awsStore().getAccount(tenantOf(c).id, id);
    if (!account) return c.json({ error: 'Account not found' }, 404);
    Object.assign(params, {
      externalId: account.external_id,
      roleName: roleNameOf(account),
      eventsUrl: eventsUrl() ?? '',
      eventSecret: eventsUrl() ? account.event_secret : '',
    });
  }
  return sendTemplate(c, params, id ? `-${id.slice(0, 8)}` : '');
}
