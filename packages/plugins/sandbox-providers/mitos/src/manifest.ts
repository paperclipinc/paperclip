import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.mitos-sandbox-provider";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Mitos Snapshot-Fork Sandbox",
  description:
    "First-party sandbox provider plugin that provisions Paperclip execution environments by memory-snapshot fork from a warm template, driving the Paperclip snapshot-fork engine through its standalone sandbox-server REST API.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "mitos",
      kind: "sandbox_provider",
      displayName: "Mitos Snapshot-Fork Sandbox",
      description:
        "Provisions sandboxes by copy-on-write memory fork from a warm template. Acquire is a single POST /v1/fork against the sandbox-server, so cold-start cost is paid once per template and every run forks in sub-second time. Exec and file operations run over the per-sandbox sandbox-server API.",
      configSchema: {
        type: "object",
        properties: {
          apiUrl: {
            type: "string",
            description:
              "Base URL of the Paperclip sandbox-server (the standalone snapshot-fork REST API), for example `http://sandbox-server:8080`. The fork, exec, and file endpoints all hang off this origin.",
          },
          token: {
            type: "string",
            format: "secret-ref",
            description:
              "Optional bearer token for the sandbox-server when it runs token-gated. Paste a token or an existing Paperclip secret reference; saved environments store pasted values as company secrets. The standalone sandbox-server is tokenless by default, so this may be omitted. Falls back to MITOS_SANDBOX_TOKEN if set.",
          },
          template: {
            type: "string",
            description:
              "Template (or snapshot) id to fork sandboxes from. The template must already exist on the sandbox-server (POST /v1/templates). This is the warm base whose memory snapshot every acquire forks.",
          },
          cpu: {
            type: "number",
            description: "Optional CPU allocation hint in cores recorded in lease metadata.",
          },
          memory: {
            type: "number",
            description: "Optional memory allocation hint in MiB recorded in lease metadata.",
          },
          execTimeoutMs: {
            type: "number",
            description: "Default timeout for a single exec call in milliseconds.",
            default: 300000,
          },
          requestTimeoutMs: {
            type: "number",
            description: "Timeout for control-plane HTTP calls (health, fork, terminate) in milliseconds.",
            default: 60000,
          },
          reuseLease: {
            type: "boolean",
            description:
              "When true, a released sandbox is kept alive and resumed in place on the next run instead of being deleted. When false, release destroys the sandbox and resume forks a fresh one from the template.",
            default: false,
          },
        },
        required: ["apiUrl", "template"],
      },
    },
  ],
};

export default manifest;
