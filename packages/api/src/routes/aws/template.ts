import type { Context } from 'hono';
import { principalArn } from '../../lib/aws/clients.js';
import { connectionTemplate } from '../../lib/aws/publish.js';
import { awsStore } from '../../lib/aws/store.js';
import { templateYaml } from '../../lib/aws/template.js';
import { tenantOf } from '../../lib/tenancy/context.js';

/**
 * With `account`: that connection's template with all its values (including the event secret) as
 * defaults, for the "download and upload in the CloudFormation console" path. Without: the template
 * with only the trusted principal filled in.
 */
export async function getAwsTemplate(c: Context) {
  const id = c.req.query('account');
  let body: string;
  if (id) {
    const account = await awsStore().getAccount(tenantOf(c).id, id);
    if (!account) return c.json({ error: 'Account not found' }, 404);
    body = await connectionTemplate(account);
  } else {
    body = templateYaml({ principalArn: await principalArn() });
  }
  c.header('content-type', 'text/yaml; charset=utf-8');
  if (c.req.query('download')) c.header('content-disposition', `attachment; filename="ivy-trace${id ? `-${id.slice(0, 8)}` : ''}.yaml"`);
  return c.body(body);
}
