#!/bin/sh
# Installs the latest keel CLI from GitHub Releases, checking its SHA256.
#   curl -fsSL https://github.com/reitmas32/keel/releases/latest/download/install.sh | sh
# KEEL_INSTALL_DIR overrides the destination (default ~/.local/bin).
set -eu

repo="reitmas32/keel"
dir="${KEEL_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os="unknown-linux-musl" ;;
  Darwin) os="apple-darwin" ;;
  *) echo "keel: sistema no soportado: $(uname -s) (en Windows usa install.ps1)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) echo "keel: arquitectura no soportada: $(uname -m)" >&2; exit 1 ;;
esac
asset="keel-${arch}-${os}"
base="https://github.com/${repo}/releases/latest/download"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Descargando ${asset}…"
curl -fsSL "${base}/${asset}" -o "${tmp}/keel"
curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS"

expected="$(awk -v a="$asset" '$2 == a || $2 == "*"a { print $1 }' "${tmp}/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/keel" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${tmp}/keel" | awk '{ print $1 }')"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "keel: la suma SHA256 no coincide con SHA256SUMS; no se instala." >&2
  exit 1
fi

mkdir -p "$dir"
chmod 755 "${tmp}/keel"
mv "${tmp}/keel" "${dir}/keel"
echo "keel instalado en ${dir}/keel: $("${dir}/keel" --version)"
case ":$PATH:" in
  *":${dir}:"*) ;;
  *) echo "Agrega ${dir} a tu PATH, p. ej.: echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.zshrc" ;;
esac
