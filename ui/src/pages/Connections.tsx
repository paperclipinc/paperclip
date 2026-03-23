import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { connectionsApi } from "../api/connections";
import type { ConnectionProviderWithConfig } from "../api/connections";
import type { Connection, OAuthProviderCategory } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Link2,
  Search,
  ExternalLink,
  RefreshCw,
  Unplug,
  Check,
  AlertTriangle,
  X,
} from "lucide-react";

// ── Category metadata ───────────────────────────────────────────────────

const CATEGORY_LABELS: Record<OAuthProviderCategory, string> = {
  source_control: "Source Control",
  communication: "Communication",
  project_management: "Project Management",
  cloud: "Cloud",
  productivity: "Productivity",
  ai: "AI",
  other: "Other",
};

const CATEGORY_ORDER: OAuthProviderCategory[] = [
  "source_control",
  "project_management",
  "communication",
  "productivity",
  "cloud",
  "ai",
  "other",
];

// ── Status badge ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge variant="default" className="bg-green-600 hover:bg-green-700">
          Connected
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 border-amber-500/30">
          Expired
        </Badge>
      );
    case "error":
      return (
        <Badge variant="secondary" className="bg-red-500/20 text-red-700 border-red-500/30">
          Error
        </Badge>
      );
    case "revoked":
      return (
        <Badge variant="secondary">Revoked</Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

// ── Main page ───────────────────────────────────────────────────────────

export function Connections() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<OAuthProviderCategory | "all">("all");

  // Handle OAuth callback results from URL params
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (connected) {
      pushToast({ title: `Connected to ${connected}`, tone: "success" });
      setSearchParams({}, { replace: true });
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.list(selectedCompanyId!) });
    }
    if (error) {
      pushToast({ title: "Connection failed", body: error, tone: "error" });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams]);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Connections" },
    ]);
  }, [selectedCompany, setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.connections.list(selectedCompanyId!),
    queryFn: () => connectionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.disconnect(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      pushToast({ title: "Disconnected", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to disconnect", body: err instanceof Error ? err.message : "Unknown error", tone: "error" });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.refresh(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
      pushToast({ title: "Token refreshed", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Refresh failed", body: err instanceof Error ? err.message : "Unknown error", tone: "error" });
    },
  });

  const handleConnect = async (providerId: string) => {
    if (!selectedCompanyId) return;
    try {
      const { url } = await connectionsApi.authorize(selectedCompanyId, providerId);
      window.location.href = url;
    } catch (err) {
      pushToast({
        title: "Failed to start connection",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    }
  };

  // ── Group providers by category ──────────────────────────────────────

  const providers = data?.providers ?? [];
  const conns = data?.connections ?? [];
  const connByProvider = useMemo(
    () => new Map(conns.map((c) => [c.providerId, c])),
    [conns],
  );

  const filteredProviders = useMemo(() => {
    let result = providers;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.displayName.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q),
      );
    }
    if (categoryFilter !== "all") {
      result = result.filter((p) => p.category === categoryFilter);
    }
    return result;
  }, [providers, search, categoryFilter]);

  const grouped = useMemo(() => {
    const groups = new Map<OAuthProviderCategory, ConnectionProviderWithConfig[]>();
    for (const p of filteredProviders) {
      const cat = p.category as OAuthProviderCategory;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => ({
      category: c,
      label: CATEGORY_LABELS[c],
      providers: groups.get(c)!,
    }));
  }, [filteredProviders]);

  // ── Active categories for filter chips ────────────────────────────────

  const activeCategories = useMemo(() => {
    const cats = new Set(providers.map((p) => p.category as OAuthProviderCategory));
    return CATEGORY_ORDER.filter((c) => cats.has(c));
  }, [providers]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="text-sm text-muted-foreground">Loading connections...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Connections</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Connect third-party services so agents can access APIs on your behalf.
        Tokens are encrypted and automatically refreshed.
      </p>

      {/* Search + filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search services..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-transparent py-2 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCategoryFilter("all")}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              categoryFilter === "all"
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {activeCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat === categoryFilter ? "all" : cat)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                categoryFilter === cat
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      {/* Provider grid grouped by category */}
      {grouped.length === 0 && (
        <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {search ? `No services matching "${search}"` : "No services available"}
        </div>
      )}

      {grouped.map(({ category, label, providers: groupProviders }) => (
        <section key={category} className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groupProviders.map((provider) => {
              const conn = connByProvider.get(provider.id);
              return (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  connection={conn ?? null}
                  onConnect={() => handleConnect(provider.id)}
                  onDisconnect={() => conn && disconnectMutation.mutate(conn.id)}
                  onRefresh={() => conn && refreshMutation.mutate(conn.id)}
                  isDisconnecting={disconnectMutation.isPending}
                  isRefreshing={refreshMutation.isPending}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Provider card ───────────────────────────────────────────────────────

function ProviderCard({
  provider,
  connection,
  onConnect,
  onDisconnect,
  onRefresh,
  isDisconnecting,
  isRefreshing,
}: {
  provider: ConnectionProviderWithConfig;
  connection: Connection | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  isDisconnecting: boolean;
  isRefreshing: boolean;
}) {
  const isConnected = connection?.status === "active";
  const isExpired = connection?.status === "expired" || connection?.status === "error";
  const isConfigured = provider.configured;

  return (
    <div
      className={`rounded-lg border px-4 py-4 transition-colors ${
        isConnected
          ? "border-green-500/30 bg-green-500/[0.04]"
          : isExpired
            ? "border-amber-500/30 bg-amber-500/[0.04]"
            : "border-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{provider.displayName}</span>
            {connection && <StatusBadge status={connection.status} />}
          </div>
          {provider.description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {provider.description}
            </p>
          )}
        </div>
      </div>

      {/* Connection info */}
      {connection?.accountLabel && (
        <div className="mt-2 text-xs text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{connection.accountLabel}</span>
        </div>
      )}

      {connection?.lastError && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="line-clamp-2">{connection.lastError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2">
        {!connection && isConfigured && (
          <Button size="sm" onClick={onConnect}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Connect
          </Button>
        )}

        {!connection && !isConfigured && (
          <Button size="sm" variant="outline" disabled>
            Not configured
          </Button>
        )}

        {isConnected && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={onDisconnect}
              disabled={isDisconnecting}
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" />
              {isDisconnecting ? "..." : "Disconnect"}
            </Button>
          </>
        )}

        {isExpired && (
          <>
            <Button size="sm" onClick={onConnect}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Reconnect
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Try refresh"}
            </Button>
          </>
        )}
      </div>

      {/* Unconfigured hint */}
      {!isConfigured && !connection && (
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Set <code className="font-mono text-[10px]">PAPERCLIP_OAUTH_{provider.id.toUpperCase()}_CLIENT_ID</code> to enable
        </p>
      )}
    </div>
  );
}
