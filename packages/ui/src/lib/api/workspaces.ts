import { mutate } from "swr";
import { slugify } from "../utils/slug";
import { fetchJson, sendJson } from "./client";
import { wsPath } from "./hooks";
import type { ApiKey, CreatedInvitation, CreatedKey, Invitation, InvitationInfo, Member, Project, Role, Workspace } from "./types";

const api = (ws: string) => `/api${wsPath(ws)}`;
const enc = encodeURIComponent;

/** Revalidates every cached response under /api/workspaces and /api/w/<ws> (not span data). */
export const refreshWorkspace = (ws?: string) =>
  mutate(
    (key) =>
      typeof key === "string" &&
      (key.startsWith("/api/workspaces") ||
        (ws ? key === api(ws) || /\/(projects|members|invitations|keys)(\?|$)/.test(key) : false)),
  );

export const createWorkspace = (body: { name: string }) => sendJson<Workspace>("POST", "/api/workspaces", body);

export const updateWorkspace = (ws: string, body: { name?: string; slug?: string }) => sendJson<Workspace>("PATCH", api(ws), body);

export const deleteWorkspace = (ws: string, confirm: string) =>
  sendJson<{ deleted: boolean }>("DELETE", `${api(ws)}?confirm=${enc(confirm)}`);

export const createProject = (ws: string, body: { name: string }) => sendJson<Project>("POST", `${api(ws)}/projects`, body);

export const updateProject = (ws: string, project: string, body: { name?: string; slug?: string; archived?: boolean }) =>
  sendJson<Project>("PATCH", `${api(ws)}/p/${enc(project)}`, body);

export const createKey = (ws: string, project: string, name: string) => sendJson<CreatedKey>("POST", `${api(ws)}/p/${enc(project)}/keys`, { name });

export const revokeKey = (ws: string, project: string, id: string) => sendJson<ApiKey>("DELETE", `${api(ws)}/p/${enc(project)}/keys/${enc(id)}`);

export const setMemberRole = (ws: string, sub: string, role: Role) => sendJson<Member>("PATCH", `${api(ws)}/members/${enc(sub)}`, { role });

export const removeMember = (ws: string, sub: string) => sendJson<{ removed: boolean }>("DELETE", `${api(ws)}/members/${enc(sub)}`);

export const inviteMember = (ws: string, body: { email: string; role: Role }) => sendJson<CreatedInvitation>("POST", `${api(ws)}/invitations`, body);

export const revokeInvitation = (ws: string, id: string) => sendJson<Invitation>("DELETE", `${api(ws)}/invitations/${enc(id)}`);

export const getInvitation = (token: string) => fetchJson<InvitationInfo>(`/api/invitations/${enc(token)}`);

export const acceptInvitation = (token: string) =>
  sendJson<{ accepted: boolean; workspace: Workspace }>("POST", `/api/invitations/${enc(token)}/accept`);

/**
 * The first project of a workspace: names its untouched default project (whose URL then follows the
 * name, as if it were created now), or creates a project when there are others already.
 */
export async function firstProject(ws: string, list: Pick<Project, "slug" | "default">[], name: string): Promise<Project> {
  const pristine = list.length === 1 && list[0].default && list[0].slug === "default";
  if (!pristine) return createProject(ws, { name });
  return updateProject(ws, "default", { name, slug: slugify(name) || undefined }).catch(() => updateProject(ws, "default", { name }));
}
