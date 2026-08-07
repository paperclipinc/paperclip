group "default" {
  targets = ["base", "claude", "codex", "gemini", "opencode", "pi", "hermes"]
}

variable "VERSION" { default = "dev" }
<<<<<<< HEAD
variable "REGISTRY" { default = "ghcr.io/paperclipinc" }
=======
variable "REGISTRY" { default = "ghcr.io/paperclipai" }
>>>>>>> origin/master

target "base" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.base"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-base:${VERSION}"]
}

target "claude" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.claude"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-claude:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}

target "codex" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.codex"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-codex:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}

target "gemini" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.gemini"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-gemini:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}

target "opencode" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.opencode"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-opencode:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}

target "pi" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.pi"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-pi:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}

target "hermes" {
  context = "."
  dockerfile = "docker/agent-runtime/Dockerfile.hermes"
  platforms = ["linux/amd64"]
  tags = ["${REGISTRY}/agent-runtime-hermes:${VERSION}"]
  args = {
    BASE_TAG = "${VERSION}"
  }
  contexts = {
<<<<<<< HEAD
    "paperclipinc/agent-runtime-base:${VERSION}" = "target:base"
=======
    "paperclipai/agent-runtime-base:${VERSION}" = "target:base"
>>>>>>> origin/master
  }
}
