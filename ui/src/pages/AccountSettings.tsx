import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { User } from "lucide-react";
import { Field } from "../components/agent-config-primitives";

export function AccountSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authApi.getSession(),
  });

  // Profile local state
  const [name, setName] = useState("");

  // Security local state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Sync name from session
  useEffect(() => {
    if (session?.user.name) {
      setName(session.user.name);
    }
  }, [session?.user.name]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Account Settings" }]);
  }, [setBreadcrumbs]);

  const profileDirty = !!session && name !== (session.user.name ?? "");

  const profileMutation = useMutation({
    mutationFn: (data: { name: string }) => authApi.updateUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
    },
  });

  const passwordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      authApi.changePassword(data),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordError(null);
      setPasswordSuccess("Password changed successfully.");
    },
    onError: (err) => {
      setPasswordSuccess(null);
      setPasswordError(
        err instanceof Error ? err.message : "Failed to change password"
      );
    },
  });

  function handleSaveProfile() {
    profileMutation.mutate({ name: name.trim() });
  }

  function handleChangePassword() {
    setPasswordSuccess(null);
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }

    passwordMutation.mutate({ currentPassword, newPassword });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <User className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Account Settings</h1>
      </div>

      {/* Profile */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Profile
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Display name">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Email">
            <p className="text-sm text-muted-foreground">
              {session?.user.email ?? "—"}
            </p>
          </Field>
        </div>
      </div>

      {profileDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveProfile}
            disabled={profileMutation.isPending || !name.trim()}
          >
            {profileMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {profileMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {profileMutation.isError && (
            <span className="text-xs text-destructive">
              {profileMutation.error instanceof Error
                ? profileMutation.error.message
                : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Security */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Security
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Current password">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleChangePassword}
          disabled={
            passwordMutation.isPending ||
            !currentPassword ||
            !newPassword ||
            !confirmPassword
          }
        >
          {passwordMutation.isPending ? "Changing..." : "Change password"}
        </Button>
        {passwordSuccess && (
          <span className="text-xs text-muted-foreground">{passwordSuccess}</span>
        )}
        {passwordError && (
          <span className="text-xs text-destructive">{passwordError}</span>
        )}
      </div>

      {/* Sign Out */}
      <div className="space-y-4">
        <Button
          variant="destructive"
          size="sm"
          onClick={async () => {
            await authApi.signOut();
            window.location.href = "/auth";
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
