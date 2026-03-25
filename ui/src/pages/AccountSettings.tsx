import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { User, LogOut, Check, Mail } from "lucide-react";

export function AccountSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authApi.getSession(),
  });

  // Profile local state
  const [name, setName] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);

  // Email local state
  const [newEmail, setNewEmail] = useState("");

  // Security local state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

  const profileDirty = !!session && name.trim() !== (session.user.name ?? "");

  // Clear the "saved" indicator when the user starts editing again
  useEffect(() => {
    if (profileDirty) setProfileSaved(false);
  }, [profileDirty]);

  const profileMutation = useMutation({
    mutationFn: (data: { name: string }) => authApi.updateUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
      setProfileSaved(true);
      pushToast({ tone: "success", title: "Profile updated" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to update profile",
        body: err instanceof Error ? err.message : "Something went wrong",
      });
    },
  });

  const emailMutation = useMutation({
    mutationFn: (data: { newEmail: string }) => authApi.changeEmail(data),
    onSuccess: () => {
      setNewEmail("");
      pushToast({
        tone: "success",
        title: "Verification email sent",
        body: "Check your new email inbox to confirm the change.",
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to change email",
        body: err instanceof Error ? err.message : "Something went wrong",
      });
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
      pushToast({ tone: "success", title: "Password changed successfully" });
    },
    onError: (err) => {
      setPasswordError(
        err instanceof Error ? err.message : "Failed to change password",
      );
    },
  });

  function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    profileMutation.mutate({ name: name.trim() });
  }

  function handleChangeEmail(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newEmail.trim();
    if (!trimmed || trimmed === session?.user.email) return;
    emailMutation.mutate({ newEmail: trimmed });
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
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

  const canSubmitEmail =
    !emailMutation.isPending &&
    newEmail.trim().length > 0 &&
    newEmail.trim() !== (session?.user.email ?? "");

  const canSubmitPassword =
    !passwordMutation.isPending &&
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0;

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center gap-2">
          <User className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Account Settings</h1>
        </div>
        <div className="space-y-4">
          <div className="h-48 animate-pulse rounded-md border border-border bg-muted/30" />
          <div className="h-64 animate-pulse rounded-md border border-border bg-muted/30" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <User className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Account Settings</h1>
      </div>

      {/* Profile */}
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">Profile</CardTitle>
          <CardDescription>
            Your personal information visible to other members.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSaveProfile}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <p className="text-sm text-muted-foreground">
                {session?.user.email ?? "\u2014"}
              </p>
            </div>
          </CardContent>
          <Separator />
          <CardFooter className="pt-4 gap-3">
            <Button
              type="submit"
              size="sm"
              disabled={profileMutation.isPending || !profileDirty || !name.trim()}
            >
              {profileMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
            {profileSaved && !profileDirty && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </CardFooter>
        </form>
      </Card>

      {/* Email */}
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">
            <span className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Email address
            </span>
          </CardTitle>
          <CardDescription>
            Change the email associated with your account. A verification link
            will be sent to the new address.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleChangeEmail}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-email">New email</Label>
              <Input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder={session?.user.email ?? "new@example.com"}
                autoComplete="email"
              />
            </div>
          </CardContent>
          <Separator />
          <CardFooter className="pt-4">
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmitEmail}
            >
              {emailMutation.isPending ? "Sending..." : "Send verification email"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Password */}
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="text-sm">Password</CardTitle>
          <CardDescription>
            Update your password to keep your account secure.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleChangePassword}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                Must be at least 8 characters.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {passwordError && (
              <p className="text-sm text-destructive">{passwordError}</p>
            )}
          </CardContent>
          <Separator />
          <CardFooter className="pt-4">
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmitPassword}
            >
              {passwordMutation.isPending ? "Changing..." : "Change password"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Sign Out */}
      <Card className="rounded-lg border-destructive/30">
        <CardHeader>
          <CardTitle className="text-sm">Sign out</CardTitle>
          <CardDescription>
            End your current session on this device.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            variant="destructive"
            size="sm"
            onClick={async () => {
              await authApi.signOut();
              window.location.href = "/auth";
            }}
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
