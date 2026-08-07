import { describe, it, expect } from "vitest";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";

const baseInput = {
  namespace: "paperclip-acme",
  sandboxName: "pc-01h00000000000000000000000",
  adapterType: "claude_local",
  image: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envSecretName: "pc-01h00000000000000000000000-env",
  serviceAccountName: "paperclip-tenant-sa",
  labels: { "paperclip.io/run-id": "r1" },
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  runtimeClassName: undefined,
};

describe("buildSandboxCrManifest", () => {
  it("returns a Sandbox CR with the correct apiVersion and kind", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.apiVersion).toBe("agents.x-k8s.io/v1alpha1");
    expect(cr.kind).toBe("Sandbox");
  });

  it("sets metadata name and namespace correctly", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.name).toBe(baseInput.sandboxName);
    expect(cr.metadata.namespace).toBe(baseInput.namespace);
  });

  it("does NOT set ownerReferences (out-of-cluster server, explicit release path)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.ownerReferences).toBeUndefined();
  });

  it("sets restartPolicy=Always on the pod template (required for long-lived Sandbox pod)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.restartPolicy).toBe("Always");
  });

  it("uses sleep-infinity entrypoint via Tini for multi-command exec", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.command).toEqual([
      "/usr/bin/tini",
      "--",
      "/bin/sh",
      "-c",
      "sleep infinity",
    ]);
  });

  it("applies the same security baseline as Job backend (non-root, drop ALL, RO rootFS, seccomp)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const podSec = cr.spec.podTemplate.spec.securityContext;
    expect(podSec.runAsNonRoot).toBe(true);
    expect(podSec.runAsUser).toBe(1000);
    expect(podSec.fsGroupChangePolicy).toBe("OnRootMismatch");
    expect(podSec.seccompProfile.type).toBe("RuntimeDefault");

    const container = cr.spec.podTemplate.spec.containers[0];
    expect(container.securityContext.runAsNonRoot).toBe(true);
    expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("disables automountServiceAccountToken", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
  });

  it("declares emptyDir volume mounts for standard agent paths", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const mounts = cr.spec.podTemplate.spec.containers[0].volumeMounts;
    const mountPaths = mounts
      .map((m: { mountPath: string }) => m.mountPath)
      .sort();
    expect(mountPaths).toEqual([
      "/home/paperclip",
      "/home/paperclip/.cache",
      "/tmp",
      "/workspace",
    ]);

    const volumes = cr.spec.podTemplate.spec.volumes;
    expect(
      volumes.every((v: { emptyDir?: unknown }) => v.emptyDir !== undefined),
    ).toBe(true);
  });

  it("envFrom references the per-run secret", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const envFrom = cr.spec.podTemplate.spec.containers[0].envFrom;
    expect(envFrom[0].secretRef.name).toBe(baseInput.envSecretName);
  });

  it("applies runtimeClassName when set", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      runtimeClassName: "kata-fc",
    });
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBe("kata-fc");
  });

  it("does not set runtimeClassName when unset", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.runtimeClassName).toBeUndefined();
  });

  it("applies provided labels to CR metadata and pod template labels (with role=agent added)", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.metadata.labels["paperclip.io/run-id"]).toBe("r1");
    expect(
      cr.spec.podTemplate.metadata.labels["paperclip.io/run-id"],
    ).toBe("r1");
    expect(cr.spec.podTemplate.metadata.labels["paperclip.io/role"]).toBe(
      "agent",
    );
  });

  it("applies imagePullSecrets when provided", () => {
    const cr = buildSandboxCrManifest({
      ...baseInput,
      imagePullSecrets: ["my-pull-secret"],
    });
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toEqual([
      { name: "my-pull-secret" },
    ]);
  });

  it("does not set imagePullSecrets when not provided", () => {
    const cr = buildSandboxCrManifest(baseInput);
    expect(cr.spec.podTemplate.spec.imagePullSecrets).toBeUndefined();
  });
});
<<<<<<< HEAD

describe("buildSandboxCrManifest: baked home seeding", () => {
  // The image builds a home directory the pod then throws away. Dockerfile
  // .gemini writes /home/paperclip/.gemini/settings.json to pre-select the
  // auth mode (gemini-cli refuses a headless run without it), and the `home`
  // emptyDir mounted at /home/paperclip shadows it at runtime. Every hosted
  // Gemini ACP run therefore started with no auth method selected and idled
  // until the 4h backstop: five runs were hung on this at once in prod on
  // 2026-08-04. The mount wins over the image by definition, so the baked
  // content has to be copied into the volume before the agent starts.
  it("seeds the home volume from the image before the agent container runs", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const initContainers = cr.spec.podTemplate.spec.initContainers;
    expect(Array.isArray(initContainers)).toBe(true);
    expect(initContainers).toHaveLength(1);

    const seed = initContainers[0];
    // Same image, so whatever that harness baked into its home is what gets
    // copied. A generic busybox would have nothing to copy.
    expect(seed.image).toBe(baseInput.image);
    // Writes into the volume at a staging path, NOT at /home/paperclip: the
    // whole point is to read the image's own home, which a mount there would
    // shadow in this container too.
    const mount = seed.volumeMounts.find((m: { name: string }) => m.name === "home");
    expect(mount.mountPath).not.toBe("/home/paperclip");
    expect(String(seed.command?.[seed.command.length - 1] ?? "")).toContain(mount.mountPath);
  });

  it("never clobbers content already in the home volume", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const seed = cr.spec.podTemplate.spec.initContainers[0];
    const script = String(seed.command?.[seed.command.length - 1] ?? "");
    // -n: no-clobber. A reused volume keeps whatever the last run left.
    expect(script).toMatch(/cp\s+-[a-zA-Z]*n/);
  });

  it("holds the seed container to the same security baseline as the agent", () => {
    const cr = buildSandboxCrManifest(baseInput);
    const seed = cr.spec.podTemplate.spec.initContainers[0];
    expect(seed.securityContext.runAsNonRoot).toBe(true);
    expect(seed.securityContext.runAsUser).toBe(1000);
    expect(seed.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(seed.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(seed.securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("does not let a seed failure block the run", () => {
    // An image with nothing baked into its home is the normal case for four of
    // the five harnesses. That must not be a CrashLoopBackOff.
    const cr = buildSandboxCrManifest(baseInput);
    const seed = cr.spec.podTemplate.spec.initContainers[0];
    expect(String(seed.command?.[seed.command.length - 1] ?? "")).toMatch(/\|\|\s*true/);
  });
});
=======
>>>>>>> origin/master
