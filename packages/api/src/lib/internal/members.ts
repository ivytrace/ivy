import { tenancyStore, type MemberRole } from '../tenancy/store.js';

export interface WorkspaceMember {
  sub: string;
  email: string;
  role: MemberRole;
}

/** Members of a workspace with their roles (the internal API's membership check for billing). */
export async function listWorkspaceMembers(tenantId: string): Promise<WorkspaceMember[]> {
  return (await tenancyStore().listMembers(tenantId)).map(({ sub, email, role }) => ({ sub, email, role }));
}
