#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="siftlane"
ROOT_DIR="${SIFTLANE_ROOT_DIR:-/root/siftlane}"
INSTALL_DIR="${ROOT_DIR}"
BINARY_PATH="${INSTALL_DIR}/siftlane"
DATA_DIR="${SIFTLANE_DATA_DIR:-${ROOT_DIR}/data}"
DOWNLOAD_DIR="${ROOT_DIR}/downloads"
EXTRACT_DIR="${ROOT_DIR}/artifact"
ENV_FILE="/etc/default/${SERVICE_NAME}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
HOST="${SIFTLANE_HOST:-0.0.0.0}"
PORT="${SIFTLANE_PORT:-51888}"
DEFAULT_DOWNLOAD_URL="https://github.com/moyu-hax/siftlane/releases/latest/download/siftlane-linux.zip"
DOWNLOAD_URL="${LEME_DOWNLOAD_URL:-${SIFTLANE_DOWNLOAD_URL:-${DEFAULT_DOWNLOAD_URL}}}"
FORCE_DOWNLOAD="${LEME_FORCE_DOWNLOAD:-${SIFTLANE_FORCE_DOWNLOAD:-0}}"
GITHUB_TOKEN_VALUE="${LEME_GITHUB_TOKEN:-${SIFTLANE_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}}"

ARCH_RAW="$(uname -m)"
case "${ARCH_RAW}" in
  x86_64|amd64) ARCH_SUFFIX="x64" ;;
  aarch64|arm64) ARCH_SUFFIX="arm64" ;;
  *) echo "Unsupported architecture: ${ARCH_RAW}"; exit 1 ;;
esac

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run as root or with sudo."
    exit 1
  fi
}

require_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is required."
    exit 1
  fi
}

normalize_download_url() {
  local url="$1"

  if [[ "${url}" =~ ^https://github\.com/([^/]+)/([^/]+)/actions/runs/[0-9]+/artifacts/([0-9]+) ]]; then
    echo "https://api.github.com/repos/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/actions/artifacts/${BASH_REMATCH[3]}/zip"
    return
  fi

  echo "${url}"
}

is_github_artifact_api_url() {
  [[ "$1" =~ ^https://api\.github\.com/repos/[^/]+/[^/]+/actions/artifacts/[0-9]+/zip$ ]]
}

download_failed_hint() {
  local url="$1"

  echo "Download failed: ${url}"
  if is_github_artifact_api_url "${url}"; then
    echo "GitHub Actions artifact downloads may need authentication, especially for private repositories."
    echo "Use a token with Actions read permission:"
    echo "  sudo LEME_GITHUB_TOKEN=\"YOUR_TOKEN\" LEME_DOWNLOAD_URL=\"YOUR_ARTIFACT_URL\" bash install-server.sh"
    echo "Recommended for servers: use the Release URL instead:"
    echo "  https://github.com/moyu-hax/siftlane/releases/latest/download/siftlane-linux.zip"
  fi
}

fetch_file() {
  local url="$1"
  local output="$2"
  local normalized_url

  normalized_url="$(normalize_download_url "${url}")"
  if [[ "${normalized_url}" != "${url}" ]]; then
    echo "Converted GitHub artifact page URL to API download URL."
    url="${normalized_url}"
  fi

  if command -v curl >/dev/null 2>&1; then
    local curl_args=(-fL --retry 3 --connect-timeout 20 -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
    if is_github_artifact_api_url "${url}" && [[ -n "${GITHUB_TOKEN_VALUE}" ]]; then
      curl_args+=(-H "Authorization: Bearer ${GITHUB_TOKEN_VALUE}")
    fi
    if ! curl "${curl_args[@]}" "${url}" -o "${output}"; then
      download_failed_hint "${url}"
      exit 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    local wget_args=(-O "${output}" --header="Accept: application/vnd.github+json" --header="X-GitHub-Api-Version: 2022-11-28")
    if is_github_artifact_api_url "${url}" && [[ -n "${GITHUB_TOKEN_VALUE}" ]]; then
      wget_args+=(--header="Authorization: Bearer ${GITHUB_TOKEN_VALUE}")
    fi
    if ! wget "${wget_args[@]}" "${url}"; then
      download_failed_hint "${url}"
      exit 1
    fi
  else
    echo "curl or wget is required."
    exit 1
  fi
}
file_magic() {
  dd if="$1" bs=4 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n'
}

is_zip() {
  [[ "$(file_magic "$1")" == 504b* ]]
}

is_elf() {
  [[ "$(file_magic "$1")" == "7f454c46" ]]
}

ensure_unzip() {
  if command -v unzip >/dev/null 2>&1; then
    return
  fi

  echo "unzip not found, installing..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y unzip
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y unzip
  elif command -v yum >/dev/null 2>&1; then
    yum install -y unzip
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache unzip
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm unzip
  else
    echo "Please install unzip first."
    exit 1
  fi
}

install_sing_box() {
  if command -v sing-box >/dev/null 2>&1; then
    echo "sing-box found: $(command -v sing-box)"
    return
  fi

  echo "sing-box not found, installing..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://sing-box.app/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://sing-box.app/install.sh | sh
  else
    echo "curl or wget is required to install sing-box."
    exit 1
  fi

  systemctl disable --now sing-box >/dev/null 2>&1 || true
}

find_binary_in_dir() {
  local dir="$1"
  local candidate

  for candidate in \
    "${dir}/siftlane-linux-${ARCH_SUFFIX}" \
    "${dir}/release/siftlane-linux-${ARCH_SUFFIX}" \
    "${dir}/siftlane-linux/siftlane-linux-${ARCH_SUFFIX}" \
    "${dir}/siftlane"; do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  candidate="$(find "${dir}" -maxdepth 4 -type f -name "siftlane-linux-${ARCH_SUFFIX}" -print -quit 2>/dev/null || true)"
  if [[ -n "${candidate}" ]]; then
    echo "${candidate}"
    return 0
  fi

  candidate="$(find "${dir}" -maxdepth 4 -type f -name "siftlane" -print -quit 2>/dev/null || true)"
  if [[ -n "${candidate}" ]]; then
    echo "${candidate}"
    return 0
  fi

  return 1
}

find_local_binary() {
  if [[ "${FORCE_DOWNLOAD}" == "1" ]]; then
    return 1
  fi

  local candidate
  for candidate in \
    "${LEME_BINARY:-}" \
    "${SIFTLANE_BINARY:-}" \
    "${ROOT_DIR}/siftlane-linux-${ARCH_SUFFIX}" \
    "${ROOT_DIR}/upload/siftlane-linux-${ARCH_SUFFIX}"; do
    if [[ -n "${candidate}" && -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  if [[ -z "${DOWNLOAD_URL}" && -f "${BINARY_PATH}" ]]; then
    echo "${BINARY_PATH}"
    return 0
  fi

  return 1
}

find_local_archive() {
  if [[ "${FORCE_DOWNLOAD}" == "1" ]]; then
    return 1
  fi

  local candidate
  for candidate in \
    "${LEME_ARCHIVE:-}" \
    "${SIFTLANE_ARCHIVE:-}" \
    "${ROOT_DIR}/siftlane-linux.zip" \
    "${ROOT_DIR}/siftlane-artifact.zip" \
    "${ROOT_DIR}/artifact.zip"; do
    if [[ -n "${candidate}" && -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done

  return 1
}

install_binary_file() {
  local source="$1"

  if ! is_elf "${source}"; then
    echo "The selected file is not a Linux executable: ${source}"
    echo "If this is a GitHub Actions artifact, pass its download URL so the script can download and unzip it."
    exit 1
  fi

  if [[ "${source}" == "${BINARY_PATH}" ]]; then
    chmod +x "${BINARY_PATH}"
  else
    install -Dm755 "${source}" "${BINARY_PATH}"
  fi
}

install_archive_file() {
  local archive="$1"
  local binary

  ensure_unzip
  rm -rf "${EXTRACT_DIR}"
  mkdir -p "${EXTRACT_DIR}"
  unzip -oq "${archive}" -d "${EXTRACT_DIR}"

  binary="$(find_binary_in_dir "${EXTRACT_DIR}" || true)"
  if [[ -z "${binary}" ]]; then
    echo "No matching binary found in artifact for ${ARCH_RAW} (${ARCH_SUFFIX})."
    echo "Expected: siftlane-linux-${ARCH_SUFFIX}"
    exit 1
  fi

  install_binary_file "${binary}"
}

download_and_install() {
  local download_file="${DOWNLOAD_DIR}/siftlane-download"

  if [[ -z "${DOWNLOAD_URL}" ]]; then
    echo "No local binary found."
    echo "Put siftlane-linux-${ARCH_SUFFIX} in ${ROOT_DIR}, or run with:"
    echo "  sudo LEME_DOWNLOAD_URL=\"https://github.com/moyu-hax/siftlane/releases/latest/download/siftlane-linux.zip\" bash install-server.sh"
    exit 1
  fi

  mkdir -p "${DOWNLOAD_DIR}"
  rm -f "${download_file}"

  echo "Downloading artifact from: ${DOWNLOAD_URL}"
  fetch_file "${DOWNLOAD_URL}" "${download_file}"

  if is_zip "${download_file}"; then
    install_archive_file "${download_file}"
    return
  fi

  install_binary_file "${download_file}"
}

write_env() {
  local sing_box_path
  sing_box_path="${SING_BOX_PATH:-$(command -v sing-box || true)}"
  sing_box_path="${sing_box_path:-sing-box}"

  cat > "${ENV_FILE}" <<EOF
SIFTLANE_HOST=${HOST}
SIFTLANE_PORT=${PORT}
SIFTLANE_DATA_DIR=${DATA_DIR}
SING_BOX_PATH=${sing_box_path}
EOF
}

write_service() {
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Siftlane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${BINARY_PATH}
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
}

install_or_update() {
  local local_binary
  local local_archive

  mkdir -p "${INSTALL_DIR}" "${DATA_DIR}" "${DOWNLOAD_DIR}"

  if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi

  install_sing_box

  local_binary="$(find_local_binary || true)"
  if [[ -n "${local_binary}" ]]; then
    echo "Using local binary first: ${local_binary}"
    install_binary_file "${local_binary}"
  else
    local_archive="$(find_local_archive || true)"
    if [[ -n "${local_archive}" ]]; then
      echo "Using local artifact first: ${local_archive}"
      install_archive_file "${local_archive}"
    else
      download_and_install
    fi
  fi

  write_env
  write_service
  chmod 755 "${INSTALL_DIR}" "${DATA_DIR}"
  chmod 644 "${ENV_FILE}" "${SERVICE_FILE}"

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"

  local server_ip
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  server_ip="${server_ip:-SERVER_IP}"

  echo
  echo "Siftlane installed."
  echo "Open: http://${server_ip}:${PORT}"
  echo "Root: ${ROOT_DIR}"
  echo "Binary: ${BINARY_PATH}"
  echo "Data: ${DATA_DIR}"
  echo "Commands:"
  echo "  systemctl status ${SERVICE_NAME}"
  echo "  systemctl restart ${SERVICE_NAME}"
  echo "  journalctl -u ${SERVICE_NAME} -f"
}

uninstall() {
  systemctl disable --now "${SERVICE_NAME}" >/dev/null 2>&1 || true
  rm -f "${SERVICE_FILE}" "${ENV_FILE}" "${BINARY_PATH}"
  systemctl daemon-reload

  read -r -p "Remove ${ROOT_DIR}/data and downloaded artifacts? [y/N]: " remove_data
  if [[ "${remove_data:-N}" =~ ^[Yy]$ ]]; then
    rm -rf "${DATA_DIR}" "${DOWNLOAD_DIR}" "${EXTRACT_DIR}"
  fi
}

usage() {
  echo "Usage: bash install-server.sh [install|update|uninstall]"
  echo
  echo "Release download example:"
  echo "  sudo LEME_DOWNLOAD_URL=\"https://github.com/moyu-hax/siftlane/releases/latest/download/siftlane-linux.zip\" bash install-server.sh"
  echo
  echo "GitHub Actions artifact example, private repositories need LEME_GITHUB_TOKEN:"
  echo "  sudo LEME_GITHUB_TOKEN=\"YOUR_TOKEN\" LEME_DOWNLOAD_URL=\"https://github.com/moyu-hax/siftlane/actions/runs/.../artifacts/...\" bash install-server.sh"
}

main() {
  require_root
  require_systemd

  echo "Siftlane installer"
  echo "Root: ${ROOT_DIR}"
  echo "Architecture: ${ARCH_RAW} -> ${ARCH_SUFFIX}"

  case "${1:-install}" in
    install|update) install_or_update ;;
    uninstall|remove) uninstall ;;
    -h|--help|help) usage ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
