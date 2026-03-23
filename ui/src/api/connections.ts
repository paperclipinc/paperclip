import { api } from "./client.js";
import type { Connection, OAuthProviderDefinition } from "@paperclipai/shared";

export interface ConnectionProviderWithConfig extends OAuthProviderDefinition {
  configured: boolean;
}

export interface ConnectionsListResponse {
  connections: Connection[];
  providers: ConnectionProviderWithConfig[];
}

export interface AuthorizeResponse {
  url: string;
}

export const connectionsApi = {
  list: (companyId: string) =>
    api.get<ConnectionsListResponse>(`/companies/${companyId}/connections`),

  authorize: (companyId: string, providerId: string) =>
    api.get<AuthorizeResponse>(
      `/companies/${companyId}/connections/${providerId}/authorize`,
    ),

  disconnect: (id: string) => api.delete<{ ok: boolean }>(`/connections/${id}`),

  refresh: (id: string) => api.post<Connection>(`/connections/${id}/refresh`, {}),

  reportAuthFailure: (
    companyId: string,
    providerId: string,
    errorMessage?: string,
  ) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/connections/auth-failure`,
      { providerId, errorMessage },
    ),
};
