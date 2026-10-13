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
  BackupInfo,
  BaseSchema,
  BaseSummary,
  ChangePasswordRequest,
  Collaborator,
  CreateBase,
  CreateInviteRequest,
  CreateTokenRequest,
  CreateView,
  CreatedInvite,
  CreatedToken,
  DuplicateBase,
  InstanceStats,
  InviteInfo,
  InvitePreview,
  LoginRequest,
  LoginResponse,
  Member,
  NotificationsResponse,
  OkResponse,
  PasswordResetConfirm,
  ResetLink,
  SessionInfo,
  SetupStatus,
  SignupRequest,
  Table,
  TokenInfo,
  TwoFactorDisable,
  TwoFactorSetup,
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

/**
 * Response shapes are exactly what crates/server/src/api sends (see the live contract tests in
 * web/contract, which run this client against the real server):
 *   - list endpoints return a bare JSON array of the DTO;
 *   - creates answer 201 with the DTO; deletes answer 204 (no body, `void` here);
 *   - actions without a result answer `{"ok": true}` (`OkResponse`);
 *   - `PATCH` answers the updated resource.
 * Workspaces, bases and members are not implemented server-side yet; they follow the same
 * conventions (bare arrays, no wrapper DTO exists in og_core::api::workspaces).
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
  },

  tokens: {
    list: () => http.get<TokenInfo[]>("/api/tokens"),
    create: (body: CreateTokenRequest) => http.post<CreatedToken>("/api/tokens", body),
    revoke: (id: string) => http.delete<void>(`/api/tokens/${enc(id)}`),
    /** Works with a session or, when `bearer` is given, an API token. */
    whoami: (bearer?: string) =>
      http.get<WhoAmI>("/api/tokens/whoami", { headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined }),
  },

  invites: {
    preview: (token: string) =>
      http.get<InvitePreview>(`/api/invites/by-token/${enc(token)}`, { skipAuthRedirect: true }),
    /** Returns the accepted invite (`workspace_id` or `base_id` says where to go next). */
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
    /** Newest first. Pass the previous page's `next_before` as `before` for the next (older) page. */
    audit: (opts: { before?: number | null; limit?: number } = {}) =>
      http.get<AuditPage>("/api/admin/audit", { query: { before: opts.before, limit: opts.limit } }),
    stats: () => http.get<InstanceStats>("/api/admin/stats"),
    backups: () => http.get<BackupInfo[]>("/api/admin/backups"),
    createBackup: () => http.post<BackupInfo>("/api/admin/backups"),
    /** Plain URL: downloads go through the browser (session cookie), not fetch. */
    backupUrl: (name: string) => `/api/admin/backups/${enc(name)}`,
  },

  workspaces: {
    list: () => http.get<WorkspaceSummary[]>("/api/workspaces"),
    create: (name: string) => http.post<WorkspaceSummary | undefined>("/api/workspaces", { name }),
    update: (id: string, body: UpdateWorkspace) => http.patch<void>(`/api/workspaces/${enc(id)}`, body),
    remove: (id: string) => http.delete<void>(`/api/workspaces/${enc(id)}`),
    members: (id: string) => http.get<Member[]>(`/api/workspaces/${enc(id)}/members`),
    updateMember: (id: string, userId: string, body: UpdateMember) =>
      http.patch<void>(`/api/workspaces/${enc(id)}/members/${enc(userId)}`, body),
    removeMember: (id: string, userId: string) =>
      http.delete<void>(`/api/workspaces/${enc(id)}/members/${enc(userId)}`),
  },

  bases: {
    create: (workspaceId: string, body: CreateBase) =>
      http.post<BaseSummary | BaseSchema>(`/api/workspaces/${enc(workspaceId)}/bases`, body),
    get: (id: string) => http.get<BaseSchema>(`/api/bases/${enc(id)}`),
    update: (id: string, body: UpdateBase) => http.patch<void>(`/api/bases/${enc(id)}`, body),
    remove: (id: string) => http.delete<void>(`/api/bases/${enc(id)}`),
    duplicate: (id: string, body: DuplicateBase) =>
      http.post<BaseSummary | BaseSchema>(`/api/bases/${enc(id)}/duplicate`, body),
    collaborators: (id: string) => http.get<Collaborator[]>(`/api/bases/${enc(id)}/collaborators`),
    members: (id: string) => http.get<Member[]>(`/api/bases/${enc(id)}/members`),
    updateMember: (id: string, userId: string, body: UpdateMember) =>
      http.patch<void>(`/api/bases/${enc(id)}/members/${enc(userId)}`, body),
    removeMember: (id: string, userId: string) =>
      http.delete<void>(`/api/bases/${enc(id)}/members/${enc(userId)}`),
    /** SSE endpoint path (see events.ts). */
    eventsUrl: (id: string) => `/api/bases/${enc(id)}/events`,
  },

  tables: {
    create: (baseId: string, name: string) => http.post<Table>(`/api/bases/${enc(baseId)}/tables`, { name }),
    update: (id: string, body: UpdateTable) => http.patch<void>(`/api/tables/${enc(id)}`, body),
    remove: (id: string) => http.delete<void>(`/api/tables/${enc(id)}`),
    duplicate: (id: string) => http.post<Table | undefined>(`/api/tables/${enc(id)}/duplicate`),
  },

  views: {
    create: (tableId: string, body: CreateView) => http.post<View>(`/api/tables/${enc(tableId)}/views`, body),
    update: (id: string, body: UpdateView) => http.patch<void>(`/api/views/${enc(id)}`, body),
    remove: (id: string) => http.delete<void>(`/api/views/${enc(id)}`),
    duplicate: (id: string) => http.post<View | undefined>(`/api/views/${enc(id)}/duplicate`),
  },

  notifications: {
    list: () => http.get<NotificationsResponse>("/api/notifications"),
  },
};
