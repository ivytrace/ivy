import type { Context } from 'hono';
import { principalArn } from '../../lib/aws/clients.js';
import { eventsUrl } from '../../lib/aws/config.js';
import { roleNameOf } from '../../lib/aws/present.js';
import { awsStore } from '../../lib/aws/store.js';
import { templateYaml, type TemplateParams } from '../../lib/aws/template.js';
import { tenantOf } from '../../lib/clickhouse/tenant.js';

/**
 * Without `account`: the generic template (only the trusted principal has a default), suitable for
 * publishing to S3 as IVY_CFN_TEMPLATE_URL. With `account`: defaults for that connection filled in,
 * for the "download and upload in the console" path.
 */
export async function getAwsTemplate(c: Context) {
  const params: TemplateParams = { principalArn: await principalArn() };
  const id = c.req.query('account');
  if (id) {
    const account = await awsStore().getAccount(tenantOf(c), id);
    if (!account) return c.json({ error: 'Account not found' }, 404);
    Object.assign(params, {
      externalId: account.external_id,
      roleName: roleNameOf(account),
      eventsUrl: eventsUrl() ?? '',
      eventSecret: eventsUrl() ? account.event_secret : '',
    });
  }
  c.header('content-type', 'text/yaml; charset=utf-8');
  if (c.req.query('download')) c.header('content-disposition', `attachment; filename="ivy-trace${id ? `-${id.slice(0, 8)}` : ''}.yaml"`);
  return c.body(templateYaml(params));
}
