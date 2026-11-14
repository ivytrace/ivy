import { controlClient } from '../clickhouse/client.js';
import { tenantQuery } from '../clickhouse/scoped.js';
import type { MemberRole } from '../tenancy/store.js';

export interface WorkspaceMember {
  sub: string;
  email: string;
  role: MemberRole;
}

export type MemberLister = (tenantId: string) => Promise<WorkspaceMember[]>;

const clickhouseMembers: MemberLister = (tenantId) =>
  tenantQuery<WorkspaceMember>(
    controlClient(),
    tenantId,
    `SELECT sub, email, role FROM tenant_members FINAL WHERE tenant_id = {tenant:String} AND NOT deleted ORDER BY created_at, sub`,
  );

let current: MemberLister = clickhouseMembers;

/** Members of a workspace (the internal API's membership check for billing). */
export const listWorkspaceMembers: MemberLister = (tenantId) => current(tenantId);

export function setMemberListerForTests(lister: MemberLister | undefined) {
  current = lister ?? clickhouseMembers;
}
