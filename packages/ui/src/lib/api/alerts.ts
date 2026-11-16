import { fetchJson, sendJson } from "./client";
import { wsPath } from "./hooks";
import { mutate } from "swr";
import type { AlertSettings, ApplyAlertsResult, DigestPreview, NotificationItem, SlackChannel } from "./types";

const enc = encodeURIComponent;
const alerts = (ws: string, project: string) => `/api${wsPath(ws)}/p/${enc(project)}/alerts`;

export const updateAlertSettings = (ws: string, project: string, body: Partial<AlertSettings>) =>
  sendJson<AlertSettings>("PUT", alerts(ws, project), body);

/** Sets the whole rule on several projects at once (all or none); then refetches every project's alerts. */
export async function applyAlertSettings(ws: string, projects: string[], settings: AlertSettings) {
  const result = await sendJson<ApplyAlertsResult>("POST", `/api${wsPath(ws)}/alerts/apply`, { projects, settings });
  await mutate((key) => typeof key === "string" && key.includes(`${wsPath(ws)}/p/`) && key.endsWith("/alerts"));
  return result;
}

/** Slack's authorize URL; the browser then goes there (and comes back to the alert settings). */
export const connectSlack = (ws: string, project: string) => sendJson<{ url: string }>("POST", `${alerts(ws, project)}/slack/connect`);

export const removeSlackChannel = (ws: string, project: string, id: string) =>
  sendJson<{ removed: boolean }>("DELETE", `${alerts(ws, project)}/slack/${enc(id)}`);

export const testSlackChannel = (ws: string, project: string, id: string) =>
  sendJson<{ ok: boolean; error: string | null; integration: SlackChannel }>("POST", `${alerts(ws, project)}/slack/${enc(id)}/test`);

export const updateDigest = (ws: string, enabled: boolean) => sendJson<{ enabled: boolean }>("PUT", `/api${wsPath(ws)}/digest`, { enabled });

export const previewDigest = (ws: string) => fetchJson<DigestPreview>(`/api${wsPath(ws)}/digest/preview`);

export const updateNotifications = (workspace: string, digest: boolean) =>
  sendJson<NotificationItem>("PUT", "/api/me/notifications", { workspace, digest });
