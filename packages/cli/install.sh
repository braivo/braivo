#!/bin/sh
# SPDX-FileCopyrightText: 2026 Konstantin Tarkus
# SPDX-License-Identifier: AGPL-3.0-only

# Installs the released `braivo` for this machine (docs/adr/0027-standalone-cli.md):
#
#   curl -fsSL https://braivo.app/install.sh | bash
#
# BRAIVO_VERSION picks a release tag, the latest by default; BRAIVO_INSTALL_DIR
# the directory, ~/.local/bin by default. Running it again updates. Only fetches
# and places the file: anything more belongs in `braivo`, where it is tested.
set -eu

repo="braivo/braivo"
version="${BRAIVO_VERSION:-latest}"
dir="${BRAIVO_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "braivo is released for macOS, Linux, and Windows, not $(uname -s)." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "braivo is released for arm64 and x64, not $(uname -m)." >&2; exit 1 ;;
esac

# An x64 shell under Rosetta still runs on Apple silicon: take the native build.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  arch="arm64"
fi

if [ "$version" = "latest" ]; then
  url="https://github.com/$repo/releases/latest/download/braivo-$os-$arch"
else
  url="https://github.com/$repo/releases/download/$version/braivo-$os-$arch"
fi

# Downloaded beside its destination, started once, and only then renamed over
# it: a build this machine cannot run never replaces one it can, a `braivo mcp`
# still running keeps its file, and nothing ever sees half of one.
mkdir -p "$dir"
partial="$dir/.braivo.$$"
trap 'rm -f "$partial"' EXIT
echo "Downloading $url"
curl -fsSL "$url" -o "$partial"
chmod +x "$partial"
installed="$("$partial" --version)" || {
  echo "The downloaded braivo does not run on this machine." >&2
  exit 1
}
mv -f "$partial" "$dir/braivo"

echo "Installed $installed as $dir/braivo"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH to run it as braivo." ;;
esac
