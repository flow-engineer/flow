#!/bin/sh
# Installs a CLI that `flow cli pack` made, for anyone with Node.js:
#   curl -fsSL <the address this came from> | sh
# It keeps the package in ~/.<name> (<NAME>_HOME) and links the command onto PATH, without sudo.
# Run it again to update. <NAME>_CLI_URL installs another package instead, unchecked.
# `flow cli pack` fills in the values below; Flow's hosting puts the address it is served
# from in place of the base URL's.
set -eu

NAME="__FLOW_CLI_NAME__"
DISPLAY_NAME='__FLOW_CLI_DISPLAY_NAME__'
VERSION="__FLOW_CLI_VERSION__"
SHA256="__FLOW_CLI_SHA256__"
BASE_URL="__FLOW_CLI_BASE_URL__"
CLI_URL="${__FLOW_CLI_ENV___CLI_URL:-}"
URL="${CLI_URL:-$BASE_URL/cli/$NAME-$VERSION.tgz}"
PREFIX="${__FLOW_CLI_ENV___HOME:-$HOME/.$NAME}"
BIN="$PREFIX/bin"

fail() { printf '%s install: %s\n' "$NAME" "$1" >&2; exit 1; }

case "$PREFIX" in /*) ;; *) fail "__FLOW_CLI_ENV___HOME must be an absolute path." ;; esac
command -v node >/dev/null 2>&1 || fail "Node.js 20.19 or newer is needed. Install it from https://nodejs.org (or: brew install node), then run this again."
command -v npm >/dev/null 2>&1 || fail "npm is missing. It comes with Node.js from https://nodejs.org."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 19) ? 0 : 1)' \
  || fail "Node.js 20.19 or newer is needed; this is $(node -v). Update it from https://nodejs.org, then run this again."

existing="$(command -v "$NAME" || true)"
if [ -n "$existing" ] && [ "$existing" != "$BIN/$NAME" ]; then
  if [ ! -L "$existing" ] || [ "$(readlink "$existing")" != "$BIN/$NAME" ]; then
    fail "Another $NAME installation is already on PATH at $existing. Remove it before installing this build."
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'Downloading the %s CLI...\n' "$DISPLAY_NAME"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$tmp/$NAME.tgz" || fail "Could not download $URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/$NAME.tgz" "$URL" || fail "Could not download $URL"
else
  fail "curl or wget is needed. Install one, then run this again."
fi
# The package is checked against the checksum it was packed with, unless <NAME>_CLI_URL chose another.
if [ -z "$CLI_URL" ]; then
  if command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$NAME.tgz" | cut -d ' ' -f 1)"
  elif command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$NAME.tgz" | cut -d ' ' -f 1)"
  else fail "shasum or sha256sum is needed to check the download."; fi
  [ "$actual" = "$SHA256" ] || fail "The download from $URL is not $NAME $VERSION (its checksum differs). Nothing was installed; run this again."
fi
npm install --global --prefix "$PREFIX" "$tmp/$NAME.tgz" --silent --no-fund --no-audit >/dev/null
[ -x "$BIN/$NAME" ] || fail "The install finished but $BIN/$NAME is missing."

# A child process cannot change the calling terminal's PATH. Prefer an existing
# writable PATH directory so the command works in that terminal immediately.
# Parse without word splitting/globbing: PATH entries may contain spaces.
link_bin=""
remaining="${PATH:-}"
while :; do
  directory="${remaining%%:*}"
  case "$directory" in
    /*)
      if [ "$directory" = "$BIN" ]; then
        link_bin="$BIN"
        break
      fi
      if [ -d "$directory" ] && [ -w "$directory" ]; then
        destination="$directory/$NAME"
        # Never replace another installation or follow a directory symlink.
        if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
          if ln -s "$BIN/$NAME" "$destination" 2>/dev/null; then
            link_bin="$directory"
            break
          fi
        elif [ -L "$destination" ] && [ "$(readlink "$destination")" = "$BIN/$NAME" ]; then
          link_bin="$directory"
          break
        fi
      fi
      ;;
  esac
  case "$remaining" in *:*) remaining="${remaining#*:}" ;; *) break ;; esac
done

append_path() {
  rc="$1"
  mkdir -p "$(dirname "$rc")"
  if ! grep -qsFx "$line" "$rc"; then
    printf '\n# %s CLI\n%s\n' "$NAME" "$line" >> "$rc" \
      || fail "Could not configure $rc. The CLI is available at $BIN/$NAME."
  fi
}

ready=true
if [ -z "$link_bin" ]; then
  # No writable directory on PATH. Configure the user's shell automatically;
  # the new terminal picks this up without a manual export/source command.
  link_bin="$HOME/.local/bin"
  mkdir -p "$link_bin"
  destination="$link_bin/$NAME"
  if [ "$link_bin" = "$BIN" ]; then
    :
  elif [ -L "$destination" ] && [ "$(readlink "$destination")" = "$BIN/$NAME" ]; then
    :
  else
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      fail "Could not link $destination; an existing installation was left untouched."
    fi
    ln -s "$BIN/$NAME" "$destination" \
      || fail "Could not link $destination; an existing installation was left untouched."
  fi
  escaped_bin="$(printf '%s' "$link_bin" | sed 's/[\\"$`]/\\&/g')"
  line="export PATH=\"$escaped_bin:\$PATH\""
  user_shell="${SHELL:-sh}"
  case "${user_shell##*/}" in
    zsh) append_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      append_path "$HOME/.bashrc"
      # Bash reads only the first existing login file in this order.
      if [ -f "$HOME/.bash_profile" ]; then append_path "$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ]; then append_path "$HOME/.bash_login"
      else append_path "$HOME/.profile"; fi
      ;;
    fish)
      line="fish_add_path --prepend \"$escaped_bin\""
      append_path "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/$NAME.fish"
      ;;
    *) append_path "$HOME/.profile" ;;
  esac
  ready=false
fi

installed="$(node -p 'require(process.argv[1]).version' "$PREFIX/lib/node_modules/$NAME/package.json" 2>/dev/null || true)"
printf '\nInstalled %s %s in %s\n' "$NAME" "$installed" "$BIN"
if [ "$ready" = true ]; then
  printf 'Next: %s\n' "$NAME"
else
  printf 'PATH configured automatically. Open a new terminal, then: %s\n' "$NAME"
fi
