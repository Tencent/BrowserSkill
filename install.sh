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

# Extract the per-platform `assets[<platform_key>].sha256` hex from a
# version.json manifest. POSIX sed only (no jq dependency) — matches the
# platform's object block then the sha256 field inside it.
extract_asset_sha256() {
  json="$1"
  key="$2"
  printf '%s\n' "$json" | sed -n '/"'"$key"'":[[:space:]]*{/,/}/ s/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{1,\}\)".*/\1/p' | head -n 1
}

# Print the lowercase sha256 of a file. Returns non-zero (and prints
# nothing) when neither sha256sum nor shasum is available.
compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | sed 's/[[:space:]].*//'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | sed 's/[[:space:]].*//'
  else
    return 1
  fi
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

  # Resolve the version + manifest once. The manifest also carries the
  # per-asset sha256 we use to verify the download (mirrors `bsk update`,
  # which refuses to auto-update a release without a checksum).
  manifest_json=""
  if [ -n "${BSK_VERSION:-}" ]; then
    version="${BSK_VERSION#v}"
    tag="cli-v${version}"
    manifest_url="${GITHUB}/releases/download/${tag}/version.json"
    log "using pinned version ${version}"
    manifest_json="$(curl -fsSL "$manifest_url" 2>/dev/null || true)"
  else
    manifest_url="${GITHUB}/releases/latest/download/version.json"
    log "fetching latest version from ${manifest_url}"
    manifest_json="$(curl -fsSL "$manifest_url")" || die "could not fetch version.json"
    version="$(printf '%s' "$manifest_json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$version" ] || die "could not parse version from version.json"
    tag="cli-v${version}"
    log "latest version is ${version}"
  fi

  archive="bsk-v${version}-${triple}.tar.gz"
  download_url="${GITHUB}/releases/download/${tag}/${archive}"

  # Best-effort checksum: a missing manifest/checksum only skips
  # verification (does not block the install), but a *mismatch* is fatal.
  expected_sha=""
  if [ -n "$manifest_json" ]; then
    expected_sha="$(extract_asset_sha256 "$manifest_json" "$platform_key")"
  else
    log "warning: could not fetch version.json; skipping checksum verification"
  fi
  if [ -z "$expected_sha" ] && [ -n "$manifest_json" ]; then
    log "warning: no checksum published for ${platform_key}; skipping checksum verification"
  fi

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  log "downloading ${download_url}"
  curl -fsSL "$download_url" -o "${tmp_dir}/${archive}"

  if [ -n "$expected_sha" ]; then
    log "verifying checksum"
    if actual_sha="$(compute_sha256 "${tmp_dir}/${archive}")"; then
      expected_lower="$(printf '%s' "$expected_sha" | tr 'A-F' 'a-z')"
      if [ "$actual_sha" = "$expected_lower" ]; then
        log "checksum OK"
      else
        die "checksum mismatch: expected ${expected_lower}, got ${actual_sha}"
      fi
    else
      log "warning: no sha256 tool (sha256sum/shasum) found; skipping checksum verification"
    fi
  fi

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
