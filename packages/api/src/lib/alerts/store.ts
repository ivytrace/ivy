import { controlClient } from '../clickhouse/client.js';
import { crossTenantQuery, insertRows, tenantQuery } from '../clickhouse/scoped.js';

/** Control-plane rows of alerts and the digest (docs/implementation/alerts.md). */

export interface AlertSettings {
  slack_enabled: boolean;
  interval_minutes: number;
  every_occurrences: number;
  include_throttles: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  slack_enabled: true,
  interval_minutes: 60,
  every_occurrences: 100,
  include_throttles: false,
};

export type IntegrationStatus = 'ok' | 'broken';

export interface SlackIntegration {
  tenant_id: string;
  project_id: string;
  id: string;
  team_id: string;
  team_name: string;
  channel: string;
  channel_id: string;
  /** The incoming webhook URL, encrypted with IVY_SECRET_KEY (secret-box). */
  encrypted_webhook_url: string;
  configuration_url: string;
  status: IntegrationStatus;
  error: string;
  created_by: string;
  created_at: number;
}

export interface AlertState {
  tenant_id: string;
  project_id: string;
  fingerprint: string;
  first_notified_at: number;
  last_notified_at: number;
  occurrences_at_last_notify: number;
}

export interface NotificationPref {
  tenant_id: string;
  /** OIDC subject, or `email:<address>` for IVY_DIGEST_TO recipients. */
  sub: string;
  email: string;
  digest: boolean;
}

export interface Lease {
  name: string;
  holder: string;
  since: number;
  expires_at: number;
}

export interface AlertStore {
  getSettings(tenant: string, project: string): Promise<AlertSettings>;
  saveSettings(tenant: string, project: string, settings: AlertSettings): Promise<void>;
  listIntegrations(tenant: string, project: string): Promise<SlackIntegration[]>;
  /** Every working integration of every workspace (the evaluator's work list). */
  listAllIntegrations(): Promise<SlackIntegration[]>;
  saveIntegration(integration: SlackIntegration): Promise<void>;
  deleteIntegration(integration: SlackIntegration): Promise<void>;
  listStates(tenant: string, project: string): Promise<AlertState[]>;
  saveState(state: AlertState): Promise<void>;
  getDigestEnabled(tenant: string): Promise<boolean>;
  setDigestEnabled(tenant: string, enabled: boolean): Promise<void>;
  listPrefs(tenant: string): Promise<NotificationPref[]>;
  savePref(pref: NotificationPref): Promise<void>;
  /** Weeks (Monday, `YYYY-MM-DD`) a digest was sent for this workspace. */
  digestSent(tenant: string, week: string): Promise<boolean>;
  recordDigest(tenant: string, week: string, recipients: number): Promise<void>;
  listLeases(name: string): Promise<Lease[]>;
  saveLease(lease: Lease): Promise<void>;
}

const iso = (ms: number) => new Date(ms).toISOString();
let lastVersion = 0;
const version = () => iso((lastVersion = Math.max(Date.now(), lastVersion + 1)));
const control = () => controlClient();

const INTEGRATION_COLUMNS = `tenant_id, project_id, id, team_id, team_name, channel, channel_id, encrypted_webhook_url,
  configuration_url, status, error, created_by, toUnixTimestamp64Milli(created_at) AS created_at`;
const STATE_COLUMNS = `tenant_id, project_id, fingerprint, toUnixTimestamp64Milli(first_notified_at) AS first_notified_at,
  toUnixTimestamp64Milli(last_notified_at) AS last_notified_at, occurrences_at_last_notify`;
const integrationRow = (i: SlackIntegration, deleted = 0) => ({ ...i, created_at: iso(i.created_at), updated_at: version(), deleted });

export const clickhouseAlertStore: AlertStore = {
  async getSettings(tenant, project) {
    const rows = await tenantQuery<AlertSettings>(
      control(),
      tenant,
      `SELECT slack_enabled, interval_minutes, every_occurrences, include_throttles FROM alert_settings FINAL
       WHERE tenant_id = {tenant:String} AND project_id = {project_id:String}`,
      { project_id: project },
    );
    return rows[0] ? { ...rows[0], slack_enabled: !!rows[0].slack_enabled, include_throttles: !!rows[0].include_throttles } : { ...DEFAULT_ALERT_SETTINGS };
  },
  saveSettings: (tenant, project, s) =>
    insertRows(control(), 'alert_settings', [{ tenant_id: tenant, project_id: project, ...s, updated_at: version() }]),
  listIntegrations: (tenant, project) =>
    tenantQuery<SlackIntegration>(
      control(),
      tenant,
      `SELECT ${INTEGRATION_COLUMNS} FROM slack_integrations FINAL
       WHERE tenant_id = {tenant:String} AND project_id = {project_id:String} AND NOT deleted ORDER BY created_at`,
      { project_id: project },
    ),
  // Cross-tenant by nature: the background evaluator works through every connected project.
  listAllIntegrations: () =>
    crossTenantQuery<SlackIntegration>(
      control(),
      `SELECT ${INTEGRATION_COLUMNS} FROM slack_integrations FINAL WHERE NOT deleted AND status = 'ok' ORDER BY tenant_id, project_id, created_at`,
    ),
  saveIntegration: (i) => insertRows(control(), 'slack_integrations', [integrationRow(i)]),
  deleteIntegration: (i) => insertRows(control(), 'slack_integrations', [integrationRow(i, 1)]),
  listStates: (tenant, project) =>
    tenantQuery<AlertState>(
      control(),
      tenant,
      `SELECT ${STATE_COLUMNS} FROM alert_state FINAL WHERE tenant_id = {tenant:String} AND project_id = {project_id:String}`,
      { project_id: project },
    ),
  saveState: (s) =>
    insertRows(control(), 'alert_state', [
      { ...s, first_notified_at: iso(s.first_notified_at), last_notified_at: iso(s.last_notified_at), updated_at: version() },
    ]),
  async getDigestEnabled(tenant) {
    const rows = await tenantQuery<{ enabled: boolean }>(
      control(),
      tenant,
      'SELECT enabled FROM digest_settings FINAL WHERE tenant_id = {tenant:String}',
    );
    return rows[0] ? !!rows[0].enabled : true;
  },
  setDigestEnabled: (tenant, enabled) => insertRows(control(), 'digest_settings', [{ tenant_id: tenant, enabled, updated_at: version() }]),
  async listPrefs(tenant) {
    const rows = await tenantQuery<NotificationPref>(
      control(),
      tenant,
      'SELECT tenant_id, sub, email, digest FROM notification_prefs FINAL WHERE tenant_id = {tenant:String}',
    );
    return rows.map((r) => ({ ...r, digest: !!r.digest }));
  },
  savePref: (p) => insertRows(control(), 'notification_prefs', [{ ...p, updated_at: version() }]),
  async digestSent(tenant, week) {
    const rows = await tenantQuery<{ n: number }>(
      control(),
      tenant,
      'SELECT count() AS n FROM digest_sends WHERE tenant_id = {tenant:String} AND week = {week:Date}',
      { week },
    );
    return (rows[0]?.n ?? 0) > 0;
  },
  recordDigest: (tenant, week, recipients) =>
    insertRows(control(), 'digest_sends', [{ tenant_id: tenant, week, recipients, sent_at: version() }]),
  listLeases: (name) =>
    crossTenantQuery<Lease>(
      control(),
      `SELECT name, holder, toUnixTimestamp64Milli(since) AS since, toUnixTimestamp64Milli(expires_at) AS expires_at
       FROM job_leases FINAL WHERE name = {name:String}`,
      { name },
    ),
  saveLease: (l) => insertRows(control(), 'job_leases', [{ ...l, since: iso(l.since), expires_at: iso(l.expires_at), updated_at: version() }]),
};

/** In-memory AlertStore with the same semantics. Used by tests. */
export function memoryAlertStore(): AlertStore {
  const settings = new Map<string, AlertSettings>();
  const integrations = new Map<string, SlackIntegration>();
  const states = new Map<string, AlertState>();
  const digest = new Map<string, boolean>();
  const prefs = new Map<string, NotificationPref>();
  const sends = new Set<string>();
  const leases = new Map<string, Lease>();
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    async getSettings(tenant, project) {
      return copy(settings.get(`${tenant}/${project}`) ?? DEFAULT_ALERT_SETTINGS);
    },
    async saveSettings(tenant, project, s) {
      settings.set(`${tenant}/${project}`, copy(s));
    },
    async listIntegrations(tenant, project) {
      return [...integrations.values()].filter((i) => i.tenant_id === tenant && i.project_id === project).map(copy);
    },
    async listAllIntegrations() {
      return [...integrations.values()].filter((i) => i.status === 'ok').map(copy);
    },
    async saveIntegration(i) {
      integrations.set(`${i.tenant_id}/${i.project_id}/${i.id}`, copy(i));
    },
    async deleteIntegration(i) {
      integrations.delete(`${i.tenant_id}/${i.project_id}/${i.id}`);
    },
    async listStates(tenant, project) {
      return [...states.values()].filter((s) => s.tenant_id === tenant && s.project_id === project).map(copy);
    },
    async saveState(s) {
      states.set(`${s.tenant_id}/${s.project_id}/${s.fingerprint}`, copy(s));
    },
    async getDigestEnabled(tenant) {
      return digest.get(tenant) ?? true;
    },
    async setDigestEnabled(tenant, enabled) {
      digest.set(tenant, enabled);
    },
    async listPrefs(tenant) {
      return [...prefs.values()].filter((p) => p.tenant_id === tenant).map(copy);
    },
    async savePref(p) {
      prefs.set(`${p.tenant_id}/${p.sub}`, copy(p));
    },
    async digestSent(tenant, week) {
      return sends.has(`${tenant}/${week}`);
    },
    async recordDigest(tenant, week) {
      sends.add(`${tenant}/${week}`);
    },
    async listLeases(name) {
      return [...leases.values()].filter((l) => l.name === name).map(copy);
    },
    async saveLease(l) {
      leases.set(`${l.name}/${l.holder}`, copy(l));
    },
  };
}

let current: AlertStore = clickhouseAlertStore;
export const alertStore = () => current;
export function setAlertStore(store: AlertStore) {
  current = store;
}
