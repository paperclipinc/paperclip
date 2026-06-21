import { api } from "./client";

export interface ActivationStatus {
  activated: boolean;
}

export const activationApi = {
  statusForCompany: (companyId: string) =>
    api.get<ActivationStatus>(`/companies/${companyId}/activation`),
};
