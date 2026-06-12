# `@paperclipai/plugin-mitos`

Mitos snapshot-fork sandbox provider plugin for Paperclip.

Mitos provisions Paperclip execution environments by memory-snapshot fork from a warm template. It drives the Paperclip snapshot-fork engine through its standalone `sandbox-server` REST API. Because cold start is paid once per template, every run acquires its sandbox with a single copy-on-write fork, so acquire is sub-second.

This package lives in the Paperclip monorepo, but it is intentionally excluded from the root `pnpm` workspace and shaped to publish and install like a standalone npm package. That lets operators install it from the Plugins page by package name without introducing root lockfile churn for the provider's dependencies. Mitos talks to the sandbox-server over plain `fetch`, so it has no runtime dependencies beyond the plugin SDK.

## Install

From a Paperclip instance, install:

```text
@paperclipai/plugin-mitos
```

## Configuration

Configure Mitos from `Company Settings -> Environments`, not from the plugin's instance settings page.

| Field | Required | Description |
| --- | --- | --- |
| `apiUrl` | yes | Base URL of the sandbox-server, for example `http://sandbox-server:8080`. |
| `template` | yes | Template (or snapshot) id to fork from. Must already exist on the server (`POST /v1/templates`). `snapshot` is accepted as an alias. |
| `token` | no | Bearer token for token-gated deployments. Secret reference. Falls back to `MITOS_SANDBOX_TOKEN`. The standalone server is tokenless by default. |
| `cpu`, `memory` | no | Allocation hints recorded in lease metadata. |
| `execTimeoutMs` | no | Default per-exec timeout in milliseconds. Default `300000`. |
| `requestTimeoutMs` | no | Control-plane HTTP timeout in milliseconds. Default `60000`. |
| `reuseLease` | no | Keep a released sandbox alive and resume it in place on the next run. Default `false`. |

## Lifecycle to sandbox-server REST mapping

| Driver method | sandbox-server call |
| --- | --- |
| `validateConfig` | `GET /v1/health` then `GET /v1/templates` to confirm the template exists |
| `probe` | `GET /v1/health` + `GET /v1/templates` |
| `acquireLease` | `POST /v1/fork {template, id}`, then `POST /v1/files/mkdir` for the workspace root |
| `resumeLease` | reuse in place if `reuseLease` and the sandbox is still in `GET /v1/sandboxes`; otherwise re-`POST /v1/fork` |
| `releaseLease` | `DELETE /v1/sandboxes/{id}` for ephemeral leases; no-op for `reuseLease` |
| `destroyLease` | `DELETE /v1/sandboxes/{id}` |
| `realizeWorkspace` | `POST /v1/files/mkdir` for the cwd; host drives install commands via `execute` |
| `execute` | `POST {endpoint}/v1/exec` with `Authorization: Bearer <token>` |

Exec and file requests carry the sandbox id in the body and the per-sandbox bearer token in the `Authorization` header. The token is never logged, never placed in error messages, and never written outside lease metadata.

## Authentication model

The standalone `sandbox-server` is tokenless by design (`AllowTokenless`): its sandboxes accept exec and file calls without a bearer token. A forkd-backed deployment instead mints a per-sandbox token on fork; when the fork response includes a `token`, Mitos captures it into the lease and presents it on every exec and file call. The optional `token` config field is for deployments that gate the control plane itself.

## Follow-ups

- **True in-place memory-resume.** `resumeLease` re-forks from the snapshot today, which is already the fast path. A future sandbox-server suspend/restore endpoint would let a paused VM resume in place; Mitos already prefers in-place reuse when `reuseLease` keeps the sandbox alive.
- **Pause endpoint.** `releaseLease` with `reuseLease` keeps the sandbox alive but cannot idle or pause it, because the sandbox-server has no pause endpoint yet. Until then, "keep" means "do not delete".
- **stdin.** The one-shot exec endpoint has no stdin channel, so Mitos stages stdin as a quoted heredoc in the composed command line.
