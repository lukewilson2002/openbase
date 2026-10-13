/**
 * Typed endpoint functions for the internal HTTP API (docs/plans §3.1).
 * Only endpoints the web shell uses are wrapped; later workstreams add theirs here
 * (records, aggregations, comments, ...) using the same `http` helpers.
 */
import { http } from "./client";
import {
  listOf,
  type AcceptInviteResult,
  type AdminUpdateUserRequest,
  type AuditPage,
} from "./extra";
import type {
  AdminCreateUser,
  AdminUser,
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
  WorkspaceSummary,
} from "./types";

const enc = encodeURIComponent;

/** `GET /api/auth/me` may return the user directly or as `{ user }`. */
function unwrapUser(res: unknown): User {
  const obj = res as { user?: User } | User;
  return "user" in obj && obj.user ? obj.user : (obj as User);
}

export const api = {
  setup: {
    status: () => http.get<SetupStatus>("/api/setup", { skipAuthRedirect: true }),
  },

  auth: {
    me: async () => unwrapUser(await http.get<unknown>("/api/auth/me", { skipAuthRedirect: true })),
    updateMe: async (body: UpdateMeRequest) => unwrapUser(await http.patch<unknown>("/api/auth/me", body)),
    signup: (body: SignupRequest) => http.post<LoginResponse | User>("/api/auth/signup", body, { skipAuthRedirect: true }),
    login: (body: LoginRequest) => http.post<LoginResponse>("/api/auth/login", body, { skipAuthRedirect: true }),
    login2fa: (code: string) => http.post<LoginResponse | User>("/api/auth/login/2fa", { code }, { skipAuthRedirect: true }),
    logout: () => http.post<void>("/api/auth/logout", undefined, { skipAuthRedirect: true }),
    changePassword: (body: ChangePasswordRequest) => http.post<void>("/api/auth/password", body),
    requestPasswordReset: (email: string) =>
      http.post<void>("/api/auth/password-reset/request", { email }, { skipAuthRedirect: true }),
    confirmPasswordReset: (body: PasswordResetConfirm) =>
      http.post<void>("/api/auth/password-reset/confirm", body, { skipAuthRedirect: true }),
    twoFactorSetup: () => http.post<TwoFactorSetup>("/api/auth/2fa/setup"),
    twoFactorEnable: (code: string) => http.post<void>("/api/auth/2fa/enable", { code }),
    twoFactorDisable: (body: TwoFactorDisable) => http.post<void>("/api/auth/2fa/disable", body),
    sessions: async () => listOf<SessionInfo>(await http.get<unknown>("/api/auth/sessions"), "sessions"),
    revokeSession: (id: string) => http.delete<void>(`/api/auth/sessions/${enc(id)}`),
    revokeOtherSessions: () => http.post<void>("/api/auth/sessions/revoke-others"),
  },

  tokens: {
    list: async () => listOf<TokenInfo>(await http.get<unknown>("/api/tokens"), "tokens"),
    create: (body: CreateTokenRequest) => http.post<CreatedToken>("/api/tokens", body),
    revoke: (id: string) => http.delete<void>(`/api/tokens/${enc(id)}`),
  },

  invites: {
    preview: (token: string) =>
      http.get<InvitePreview>(`/api/invites/by-token/${enc(token)}`, { skipAuthRedirect: true }),
    accept: (token: string) =>
      http.post<AcceptInviteResult | undefined>(`/api/invites/by-token/${enc(token)}/accept`),
    remove: (id: string) => http.delete<void>(`/api/invites/${enc(id)}`),
    forWorkspace: async (workspaceId: string) =>
      listOf<InviteInfo>(await http.get<unknown>(`/api/workspaces/${enc(workspaceId)}/invites`), "invites"),
    createForWorkspace: (workspaceId: string, body: CreateInviteRequest) =>
      http.post<CreatedInvite>(`/api/workspaces/${enc(workspaceId)}/invites`, body),
    forBase: async (baseId: string) =>
      listOf<InviteInfo>(await http.get<unknown>(`/api/bases/${enc(baseId)}/invites`), "invites"),
    createForBase: (baseId: string, body: CreateInviteRequest) =>
      http.post<CreatedInvite>(`/api/bases/${enc(baseId)}/invites`, body),
  },

  admin: {
    users: async () => listOf<AdminUser>(await http.get<unknown>("/api/admin/users"), "users"),
    createUser: (body: AdminCreateUser) =>
      http.post<AdminUser & { reset_link?: ResetLink | null }>("/api/admin/users", body),
    updateUser: (id: string, body: AdminUpdateUserRequest) =>
      http.patch<AdminUser | undefined>(`/api/admin/users/${enc(id)}`, body),
    resetLink: (id: string) => http.post<ResetLink>(`/api/admin/users/${enc(id)}/reset-link`),
    audit: async (limit: number, offset: number): Promise<AuditPage> => {
      const res = await http.get<unknown>("/api/admin/audit", { query: { limit, offset } });
      const entries = listOf<AuditPage["entries"][number]>(res, "entries", "items");
      const total =
        res && typeof res === "object" && !Array.isArray(res) && typeof (res as { total?: unknown }).total === "number"
          ? (res as { total: number }).total
          : undefined;
      return { entries, total };
    },
    stats: () => http.get<InstanceStats>("/api/admin/stats"),
    backups: async () => listOf<BackupInfo>(await http.get<unknown>("/api/admin/backups"), "backups"),
    createBackup: () => http.post<BackupInfo | undefined>("/api/admin/backups"),
    /** Plain URL: downloads go through the browser (session cookie), not fetch. */
    backupUrl: (name: string) => `/api/admin/backups/${enc(name)}`,
  },

  workspaces: {
    list: async () => listOf<WorkspaceSummary>(await http.get<unknown>("/api/workspaces"), "workspaces"),
    create: (name: string) => http.post<WorkspaceSummary | undefined>("/api/workspaces", { name }),
    update: (id: string, body: UpdateWorkspace) => http.patch<void>(`/api/workspaces/${enc(id)}`, body),
    remove: (id: string) => http.delete<void>(`/api/workspaces/${enc(id)}`),
    members: async (id: string) =>
      listOf<Member>(await http.get<unknown>(`/api/workspaces/${enc(id)}/members`), "members"),
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
    collaborators: async (id: string) =>
      listOf<Collaborator>(await http.get<unknown>(`/api/bases/${enc(id)}/collaborators`), "collaborators"),
    members: async (id: string) =>
      listOf<Member>(await http.get<unknown>(`/api/bases/${enc(id)}/members`), "members"),
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
