<p align="center">
  <img src="doc/assets/header.png" alt="Paperclip — runs your business" width="720" />
</p>

<h3 align="center">Paperclip Inc. — Opinionated Fork</h3>

<p align="center">
  This is the <strong>internal fork</strong> maintained by <a href="https://paperclip.inc">Paperclip Inc.</a><br/>
  For the upstream open-source project, visit <a href="https://github.com/paperclipai/paperclip"><strong>paperclipai/paperclip</strong></a>.
</p>

<p align="center">
  <a href="https://github.com/paperclipai/paperclip"><img src="https://img.shields.io/badge/upstream-paperclipai%2Fpaperclip-blue" alt="Upstream" /></a>
  <a href="https://github.com/paperclipai/paperclip/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<br/>

## About this repository

This fork powers the managed hosting platform at [paperclip.inc](https://paperclip.inc). It tracks the upstream [paperclipai/paperclip](https://github.com/paperclipai/paperclip) project and layers on opinionated adaptations specific to our infrastructure, workflows, and customer requirements.

Changes made here are **not intended for general use**. If you're looking to self-host or contribute to Paperclip, head to the upstream repository.

<br/>

## Relationship to upstream

| | |
| --- | --- |
| **Upstream** | [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) |
| **This fork** | [github.com/paperclipinc/paperclip](https://github.com/paperclipinc/paperclip) |
| **Sync strategy** | Regularly rebased onto `upstream/main` |
| **Direction of contributions** | Bug fixes and improvements are contributed back upstream via pull requests |

<br/>

## What this fork adds

This repository contains modifications tailored to the Paperclip Inc. managed platform, including but not limited to:

- Infrastructure and deployment configuration for our hosting environment
- Platform-specific integrations and service adapters
- Internal tooling and operational enhancements
- Security hardening for multi-tenant production workloads

<br/>

## Contributing

**Upstream contributions** — If you'd like to contribute to Paperclip itself, please open issues and pull requests against the upstream repository at [paperclipai/paperclip](https://github.com/paperclipai/paperclip).

**Fork-specific changes** — Internal team members should follow the standard branch-and-PR workflow against this repository.

<br/>

## Development

```bash
pnpm install
pnpm dev
```

Refer to the upstream [documentation](https://paperclip.inc/docs) and [development guide](doc/DEVELOPING.md) for detailed setup instructions.

<br/>

## License

MIT — see [LICENSE](LICENSE). Original work by [Paperclip](https://github.com/paperclipai/paperclip).

<br/>

---

<p align="center">
  <sub><a href="https://paperclip.inc">paperclip.inc</a> · Managed Paperclip hosting</sub>
</p>
