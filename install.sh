#!/bin/sh
# install.sh — install the bsk CLI on macOS and Linux from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
#
# Environment overrides:
#   BSK_REPO         GitHub owner/repo (default: Tencent/BrowserSkill)
#   BSK_VERSION      Pin CLI version (default: latest from version.json)
#   BSK_INSTALL_DIR  Install directory (default: $HOME/.local/bin)
#   BSK_BRANCH       Branch for install_sh raw URL metadata only (unused here)

set -eu

REPO="${BSK_REPO:-Tencent/BrowserSkill}"
INSTALL_DIR="${BSK_INSTALL_DIR:-$HOME/.local/bin}"
GITHUB="https://github.com/${REPO}"

log() {
  printf '==> %s\n' "$1" >&2
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os_id="darwin" ;;
    Linux) os_id="linux" ;;
    *) die "unsupported OS: $os (macOS and Linux only)" ;;
  esac

  case "$arch" in
    arm64 | aarch64) arch_id="arm64" ;;
    x86_64 | amd64) arch_id="x64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  platform_key="${os_id}-${arch_id}"

  case "$platform_key" in
    darwin-arm64) triple="aarch64-apple-darwin" ;;
    darwin-x64) triple="x86_64-apple-darwin" ;;
    linux-arm64) triple="aarch64-unknown-linux-musl" ;;
    linux-x64) triple="x86_64-unknown-linux-musl" ;;
    *) die "unsupported platform: $platform_key" ;;
  esac
}

fetch_latest_version() {
  version_json="${GITHUB}/releases/latest/download/version.json"
  log "fetching latest version from ${version_json}"
  json="$(curl -fsSL "$version_json")"
  version="$(printf '%s' "$json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || die "could not parse version.json"
  printf '%s' "$version"
}

path_contains_dir() {
  dir="$1"
  old_ifs="$IFS"
  IFS=:
  for entry in $PATH; do
    if [ "$entry" = "$dir" ]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

ensure_path() {
  if path_contains_dir "$INSTALL_DIR"; then
    return 0
  fi

  path_line="export PATH=\"\$HOME/.local/bin:\$PATH\""
  if [ "$INSTALL_DIR" != "$HOME/.local/bin" ]; then
    path_line="export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  appended=0
  for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$profile" ]; then
      if ! grep -Fq "$INSTALL_DIR" "$profile" 2>/dev/null; then
        printf '\n# Added by browser-skill install.sh\n%s\n' "$path_line" >>"$profile"
        log "added ${INSTALL_DIR} to PATH in ${profile}"
        appended=1
      fi
    fi
  done

  if [ "$appended" -eq 0 ]; then
    log "add ${INSTALL_DIR} to your PATH, for example:"
    printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
  else
    log "restart your shell or run: source ~/.zshrc  (or ~/.bashrc)"
  fi
}

main() {
  need_cmd curl
  need_cmd tar
  need_cmd uname

  detect_platform

  if [ -n "${BSK_VERSION:-}" ]; then
    version="${BSK_VERSION#v}"
    log "using pinned version ${version}"
  else
    version="$(fetch_latest_version)"
    log "latest version is ${version}"
  fi

  tag="cli-v${version}"
  archive="bsk-v${version}-${triple}.tar.gz"
  download_url="${GITHUB}/releases/download/${tag}/${archive}"

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  log "downloading ${download_url}"
  curl -fsSL "$download_url" -o "${tmp_dir}/${archive}"

  log "extracting ${archive}"
  tar -xzf "${tmp_dir}/${archive}" -C "$tmp_dir"

  mkdir -p "$INSTALL_DIR"
  install -m 0755 "${tmp_dir}/bsk" "${INSTALL_DIR}/bsk"

  log "installed bsk to ${INSTALL_DIR}/bsk"
  ensure_path

  if command -v bsk >/dev/null 2>&1; then
  "${INSTALL_DIR}/bsk" --version
  else
    log "verify install: ${INSTALL_DIR}/bsk --version"
  fi

  log "done"
}

main "$@"
