/**
 * Typed endpoint functions for the internal HTTP API (docs/plans §3.1).
 * Only endpoints the web shell uses are wrapped; later workstreams add theirs here
 * (records, aggregations, comments, ...) using the same `http` helpers.
 */
import { http } from "./client";
import type {
  AdminCreateUser,
  AdminCreatedUser,
  AdminUpdateUser,
  AdminUser,
  AuditPage,
  Automation,
  BackupInfo,
  BaseSchema,
  ChangePasswordRequest,
  Collaborator,
  CreateAutomation,
  CreateBase,
  CreateInviteRequest,
  CreateTokenRequest,
  CreateView,
  CreatedInvite,
  ConsentDecision,
  ConsentOutcome,
  ConsentRequest,
  CreatedToken,
  EmailSettings,
  EmailTestResult,
  GrantInfo,
  DuplicateBase,
  InstanceStats,
  InviteInfo,
  InvitePreview,
  LoginRequest,
  LoginResponse,
  Member,
  NotificationsResponse,
  OkResponse,
  PasskeyChallenge,
  PasskeyInfo,
  PasskeyLoginFinish,
  PasskeyRegisterFinish,
  PasskeyRegisterStart,
  PasskeysRemoved,
  RestoreRequest,
  RestoreResponse,
  RunsPage,
  PasswordResetConfirm,
  ResetLink,
  SessionInfo,
  UpdateEmailSettings,
  SetupStatus,
  SignupRequest,
  Table,
  TestAutomation,
  TestResult,
  TokenInfo,
  TrashListing,
  TwoFactorDisable,
  TwoFactorSetup,
  UpdateAutomation,
  UpdateBase,
  UpdateMeRequest,
  UpdateMember,
  UpdateTable,
  UpdateView,
  UpdateWorkspace,
  User,
  View,
  WhoAmI,
  WorkspaceSummary,
} from "./types";

const enc = encodeURIComponent;

export type TrashKind = "workspace" | "base" | "table" | "field" | "view" | "record";

/** Query of `GET /api/trash` (`api.trash.all`). */
export type TrashFilter = {
  workspace_id?: string;
  base_id?: string;
  kind?: TrashKind;
};

/**
 * Response shapes are exactly what crates/server/src/api sends (see the live contract tests in
 * web/contract, which run this client against the real server):
 *   - list endpoints return a bare JSON array of the DTO;
 *   - creates answer 201 with the DTO; deletes answer 204 (no body, `void` here);
 *   - actions without a result answer `{"ok": true}` (`OkResponse`);
 *   - `PATCH` answers the updated resource.
 * Schema deletes and member changes answer `200 {"ok": true}`; creates answer 201 with the DTO;
 * renames/updates answer the updated resource (`WorkspaceSummary`, `BaseSchema`, `Table`, `View`).
 */
export const api = {
  setup: {
    status: () => http.get<SetupStatus>("/api/setup", { skipAuthRedirect: true }),
  },

  auth: {
    me: () => http.get<User>("/api/auth/me", { skipAuthRedirect: true }),
    updateMe: (body: UpdateMeRequest) => http.patch<User>("/api/auth/me", body),
    /** Creates the account and signs in (the first account becomes the administrator). */
    signup: (body: SignupRequest) => http.post<User>("/api/auth/signup", body, { skipAuthRedirect: true }),
    /** `{ user }` when logged in, or `{ two_factor_required: true }` with a pending session cookie. */
    login: (body: LoginRequest) => http.post<LoginResponse>("/api/auth/login", body, { skipAuthRedirect: true }),
    login2fa: (code: string) => http.post<LoginResponse>("/api/auth/login/2fa", { code }, { skipAuthRedirect: true }),
    logout: () => http.post<OkResponse>("/api/auth/logout", undefined, { skipAuthRedirect: true }),
    changePassword: (body: ChangePasswordRequest) => http.post<OkResponse>("/api/auth/password", body),
    requestPasswordReset: (email: string) =>
      http.post<OkResponse>("/api/auth/password-reset/request", { email }, { skipAuthRedirect: true }),
    confirmPasswordReset: (body: PasswordResetConfirm) =>
      http.post<OkResponse>("/api/auth/password-reset/confirm", body, { skipAuthRedirect: true }),
    twoFactorSetup: () => http.post<TwoFactorSetup>("/api/auth/2fa/setup"),
    /** Returns the updated user (`totp_enabled: true`). */
    twoFactorEnable: (code: string) => http.post<User>("/api/auth/2fa/enable", { code }),
    /** Returns the updated user (`totp_enabled: false`). */
    twoFactorDisable: (body: TwoFactorDisable) => http.post<User>("/api/auth/2fa/disable", body),
    sessions: () => http.get<SessionInfo[]>("/api/auth/sessions"),
    revokeSession: (id: string) => http.delete<void>(`/api/auth/sessions/${enc(id)}`),
    revokeOtherSessions: () => http.post<OkResponse>("/api/auth/sessions/revoke-others"),

    /** The caller's passkeys, oldest first. */
    passkeys: () => http.get<PasskeyInfo[]>("/api/auth/passkeys"),
    /**
     * Start registering a passkey. Answers 403 `reauth_required` for a session older than 10
     * minutes unless the account `password` is sent.
     */
    passkeyRegisterStart: (body: PasskeyRegisterStart = {}) => http.post<PasskeyChallenge>("/api/auth/passkeys/register/start", body),
    passkeyRegisterFinish: (body: PasskeyRegisterFinish) => http.post<PasskeyInfo>("/api/auth/passkeys/register/finish", body),
    renamePasskey: (id: string, name: string) => http.patch<PasskeyInfo>(`/api/auth/passkeys/${enc(id)}`, { name }),
    removePasskey: (id: string) => http.delete<void>(`/api/auth/passkeys/${enc(id)}`),
    /** Signing in with a passkey: anonymous, a challenge first and then the browser's answer. */
    passkeyLoginStart: () => http.post<PasskeyChallenge>("/api/auth/passkey-login/start", {}, { skipAuthRedirect: true }),
    passkeyLoginFinish: (body: PasskeyLoginFinish) => http.post<LoginResponse>("/api/auth/passkey-login/finish", body, { skipAuthRedirect: true }),
  },

  tokens: {
    list: () => http.get<TokenInfo[]>("/api/tokens"),
    create: (body: CreateTokenRequest) => http.post<CreatedToken>("/api/tokens", body),
    revoke: (id: string) => http.delete<void>(`/api/tokens/${enc(id)}`),
    /** Works with a session or, when `bearer` is given, an API token. */
    whoami: (bearer?: string) =>
      http.get<WhoAmI>("/api/tokens/whoami", { headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined }),
  },

  /** Apps connected through OAuth (Claude, ChatGPT, ...): the consent step and the connected-apps list. */
  oauth: {
    /** A pending authorization request, as the consent page shows it. */
    request: (id: string) => http.get<ConsentRequest>(`/api/oauth/requests/${enc(id)}`),
    /** `redirect_to` is where the browser goes next: the app's address with the code (or the refusal). */
    decide: (id: string, body: ConsentDecision) => http.post<ConsentOutcome>(`/api/oauth/requests/${enc(id)}/decision`, body),
    grants: () => http.get<GrantInfo[]>("/api/oauth/grants"),
    revokeGrant: (id: string) => http.delete<void>(`/api/oauth/grants/${enc(id)}`),
  },

  invites: {
    preview: (token: string) =>
      http.get<InvitePreview>(`/api/invites/by-token/${enc(token)}`, { skipAuthRedirect: true }),
    /** Returns the accepted invite (`workspace_id` says where to go next). */
    accept: (token: string) => http.post<InviteInfo>(`/api/invites/by-token/${enc(token)}/accept`),
    remove: (id: string) => http.delete<void>(`/api/invites/${enc(id)}`),
    forWorkspace: (workspaceId: string) => http.get<InviteInfo[]>(`/api/workspaces/${enc(workspaceId)}/invites`),
    createForWorkspace: (workspaceId: string, body: CreateInviteRequest) =>
      http.post<CreatedInvite>(`/api/workspaces/${enc(workspaceId)}/invites`, body),
    forBase: (baseId: string) => http.get<InviteInfo[]>(`/api/bases/${enc(baseId)}/invites`),
    createForBase: (baseId: string, body: CreateInviteRequest) =>
      http.post<CreatedInvite>(`/api/bases/${enc(baseId)}/invites`, body),
  },

  admin: {
    users: () => http.get<AdminUser[]>("/api/admin/users"),
    /** `reset_link` is present when no password was given. */
    createUser: (body: AdminCreateUser) => http.post<AdminCreatedUser>("/api/admin/users", body),
    updateUser: (id: string, body: AdminUpdateUser) => http.patch<AdminUser>(`/api/admin/users/${enc(id)}`, body),
    resetLink: (id: string) => http.post<ResetLink>(`/api/admin/users/${enc(id)}/reset-link`),
    /** Remove every passkey of a user (a lost device). */
    removePasskeys: (id: string) => http.delete<PasskeysRemoved>(`/api/admin/users/${enc(id)}/passkeys`),
    /** Newest first. Pass the previous page's `next_before` as `before` for the next (older) page. */
    audit: (opts: { before?: number | null; limit?: number } = {}) =>
      http.get<AuditPage>("/api/admin/audit", { query: { before: opts.before, limit: opts.limit } }),
    stats: () => http.get<InstanceStats>("/api/admin/stats"),
    /** Every user's connected apps. */
    oauthGrants: () => http.get<GrantInfo[]>("/api/admin/oauth/grants"),
    revokeOauthGrant: (id: string) => http.delete<void>(`/api/admin/oauth/grants/${enc(id)}`),
    backups: () => http.get<BackupInfo[]>("/api/admin/backups"),
    createBackup: () => http.post<BackupInfo>("/api/admin/backups"),
    /** The effective SMTP settings and where each comes from (the password is never returned). */
    email: () => http.get<EmailSettings>("/api/admin/email"),
    updateEmail: (body: UpdateEmailSettings) => http.patch<EmailSettings>("/api/admin/email", body),
    /** A failed delivery is a normal answer (`ok: false` with the mail server's own error). */
    sendTestEmail: (to?: string) => http.post<EmailTestResult>("/api/admin/email/test", to ? { to } : {}),
    /** Plain URL: downloads go through the browser (session cookie), not fetch. */
    backupUrl: (name: string) => `/api/admin/backups/${enc(name)}`,
  },

  workspaces: {
    list: () => http.get<WorkspaceSummary[]>("/api/workspaces"),
    create: (name: string, icon?: string | null) => http.post<WorkspaceSummary>("/api/workspaces", icon ? { name, icon } : { name }),
    update: (id: string, body: UpdateWorkspace) => http.patch<WorkspaceSummary>(`/api/workspaces/${enc(id)}`, body),
    remove: (id: string) => http.delete<OkResponse>(`/api/workspaces/${enc(id)}`),
    members: (id: string) => http.get<Member[]>(`/api/workspaces/${enc(id)}/members`),
    updateMember: (id: string, userId: string, body: UpdateMember) =>
      http.patch<OkResponse>(`/api/workspaces/${enc(id)}/members/${enc(userId)}`, body),
    removeMember: (id: string, userId: string) =>
      http.delete<OkResponse>(`/api/workspaces/${enc(id)}/members/${enc(userId)}`),
  },

  bases: {
    create: (workspaceId: string, body: CreateBase) =>
      http.post<BaseSchema>(`/api/workspaces/${enc(workspaceId)}/bases`, body),
    get: (id: string) => http.get<BaseSchema>(`/api/bases/${enc(id)}`),
    update: (id: string, body: UpdateBase) => http.patch<BaseSchema>(`/api/bases/${enc(id)}`, body),
    remove: (id: string) => http.delete<OkResponse>(`/api/bases/${enc(id)}`),
    duplicate: (id: string, body: DuplicateBase) => http.post<BaseSchema>(`/api/bases/${enc(id)}/duplicate`, body),
    collaborators: (id: string) => http.get<Collaborator[]>(`/api/bases/${enc(id)}/collaborators`),
    members: (id: string) => http.get<Member[]>(`/api/bases/${enc(id)}/members`),
    removeMember: (id: string, userId: string) =>
      http.delete<OkResponse>(`/api/bases/${enc(id)}/members/${enc(userId)}`),
    /** SSE endpoint path (see events.ts). */
    eventsUrl: (id: string) => `/api/bases/${enc(id)}/events`,
  },

  tables: {
    create: (baseId: string, name: string, icon?: string | null) => http.post<Table>(`/api/bases/${enc(baseId)}/tables`, icon ? { name, icon } : { name }),
    update: (id: string, body: UpdateTable) => http.patch<Table>(`/api/tables/${enc(id)}`, body),
    remove: (id: string) => http.delete<OkResponse>(`/api/tables/${enc(id)}`),
    /** `include_records` defaults to true server-side. */
    duplicate: (id: string, body: { name?: string | null; include_records?: boolean } = {}) =>
      http.post<Table>(`/api/tables/${enc(id)}/duplicate`, body),
    setPrimaryField: (id: string, fieldId: string) => http.post<Table>(`/api/tables/${enc(id)}/primary-field`, { field_id: fieldId }),
  },

  views: {
    create: (tableId: string, body: CreateView) => http.post<View>(`/api/tables/${enc(tableId)}/views`, body),
    update: (id: string, body: UpdateView) => http.patch<View>(`/api/views/${enc(id)}`, body),
    remove: (id: string) => http.delete<OkResponse>(`/api/views/${enc(id)}`),
    duplicate: (id: string, body: { name?: string | null; personal?: boolean } = {}) =>
      http.post<View>(`/api/views/${enc(id)}/duplicate`, body),
  },

  notifications: {
    list: () => http.get<NotificationsResponse>("/api/notifications"),
    /** Without `ids` everything is marked read. */
    markRead: (ids?: string[]) => http.post<OkResponse>("/api/notifications/read", ids ? { ids } : {}),
  },

  trash: {
    /**
     * Everything the caller could restore, from every workspace they belong to, newest first.
     * Each filter is optional; `kind` is one of workspace | base | table | field | view | record.
     */
    all: (filter: TrashFilter = {}) => http.get<TrashListing>("/api/trash", { query: filter }),
    /** Creators and above. */
    forBase: (baseId: string) => http.get<TrashListing>(`/api/bases/${enc(baseId)}/trash`),
    /** Workspace owners. */
    forWorkspace: (workspaceId: string) => http.get<TrashListing>(`/api/workspaces/${enc(workspaceId)}/trash`),
    /** The caller's own deleted workspaces (owners): a deleted workspace has no trash of its own to open. */
    deletedWorkspaces: () => http.get<TrashListing>("/api/trash/workspaces"),
    /** `kind` is one of workspace | base | table | field | view | record. */
    restore: (body: RestoreRequest) => http.post<RestoreResponse>("/api/trash/restore", body),
  },

  automations: {
    list: (baseId: string) => http.get<Automation[]>(`/api/bases/${enc(baseId)}/automations`),
    /** A webhook trigger's token is in `webhook_token` of this response only. */
    create: (baseId: string, body: CreateAutomation) => http.post<Automation>(`/api/bases/${enc(baseId)}/automations`, body),
    get: (id: string) => http.get<Automation>(`/api/automations/${enc(id)}`),
    update: (id: string, body: UpdateAutomation) => http.patch<Automation>(`/api/automations/${enc(id)}`, body),
    remove: (id: string) => http.delete<OkResponse>(`/api/automations/${enc(id)}`),
    /** A dry run (the default) sends and writes nothing. */
    test: (id: string, body: TestAutomation = { dry_run: true }) => http.post<TestResult>(`/api/automations/${enc(id)}/test`, body),
    /** Newest first; pass the previous page's `next_before` as `before`. */
    runs: (id: string, opts: { limit?: number; before?: number } = {}) => http.get<RunsPage>(`/api/automations/${enc(id)}/runs`, { query: { limit: opts.limit, before: opts.before } }),
  },
};
