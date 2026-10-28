// The installer `flow cli pack` writes beside the packed CLI (install.sh), and Flow's hosting serves:
//   curl -fsSL https://cli.acme.com | sh
// It installs the package into its own prefix (~/.<name>) with npm, no sudo, checks the download's
// sha256 first, refuses to replace another <name> on PATH, and links the command into the first
// writable PATH directory so it works in this terminal; failing that it adds one marked line to the
// shell's rc file, once. <NAME>_HOME moves the prefix and <NAME>_CLI_URL the download (then unchecked).
// Running it again updates in place. Every word a person reads names the brand (displayName).

export interface InstallScript {
  /** The command (and package) name: lowercase letters, digits and dashes. */
  name: string;
  /** How people see it written ("Acme"). */
  displayName: string;
  /** The packed CLI's address, pinned to its version. */
  url: string;
  sha256: string;
  version: string;
  /** The oldest Node the CLI runs on, [major, minor]. */
  node: [number, number];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A value inside double quotes in sh: nothing that expands or ends the quotes. */
const quoted = (value: string) => value.replace(/[\\"$`\r\n]/g, "");

export function installScript(o: InstallScript): string {
  if (!NAME.test(o.name)) throw new Error(`The CLI's name, ${JSON.stringify(o.name)}, is not a command name: lowercase letters, digits and dashes.`);
  if (!/^https?:\/\/[^\s"'`$\\]+$/.test(o.url)) throw new Error(`${o.url} is not an address the installer can download from.`);
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error("sha256 is 64 hex digits.");
  const env = o.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const brand = quoted(o.displayName) || o.name;
  const [major, minor] = o.node;
  return `#!/usr/bin/env sh
# Installs the ${brand} CLI ${quoted(o.version)}:  curl -fsSL <this address> | sh
# It lives in ~/.${o.name} (${env}_HOME), linked onto PATH, without sudo. Run it again to update.
set -eu

NAME="${o.name}"
BRAND="${brand}"
URL="\${${env}_CLI_URL:-${o.url}}"
SHA256="${o.sha256}"
PREFIX="\${${env}_HOME:-$HOME/.${o.name}}"
BIN="$PREFIX/bin"

fail() { printf '%s install: %s\\n' "$NAME" "$1" >&2; exit 1; }

case "$PREFIX" in /*) ;; *) fail "${env}_HOME must be an absolute path." ;; esac
command -v curl >/dev/null 2>&1 || fail "curl is required. Install it, then run this again."
command -v node >/dev/null 2>&1 || fail "Node.js ${major}.${minor} or newer is needed. Install it from https://nodejs.org (or: brew install node), then run this again."
command -v npm >/dev/null 2>&1 || fail "npm is missing. It comes with Node.js from https://nodejs.org."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > ${major} || (a === ${major} && b >= ${minor}) ? 0 : 1)' \\
  || fail "Node.js ${major}.${minor} or newer is needed; this is $(node -v). Update it from https://nodejs.org, then run this again."

existing="$(command -v "$NAME" || true)"
if [ -n "$existing" ] && [ "$existing" != "$BIN/$NAME" ]; then
  if [ ! -L "$existing" ] || [ "$(readlink "$existing")" != "$BIN/$NAME" ]; then
    fail "Another $NAME is already on PATH at $existing. Remove it, then run this again."
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'Downloading the %s CLI...\\n' "$BRAND"
curl -fsSL "$URL" -o "$tmp/$NAME.tgz" || fail "Could not download $URL"
if [ -z "\${${env}_CLI_URL:-}" ]; then
  got="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/$NAME.tgz")"
  [ "$got" = "$SHA256" ] || fail "The download from $URL is not the published build (its sha256 differs). Nothing was installed."
fi
npm install --global --prefix "$PREFIX" "$tmp/$NAME.tgz" --silent --no-fund --no-audit >/dev/null
[ -x "$BIN/$NAME" ] || fail "The install finished but $BIN/$NAME is missing."

# A child process cannot change the calling terminal's PATH. Prefer a writable directory already on
# PATH so the command works in that terminal now. PATH is split by hand: entries may hold spaces.
link_bin=""
remaining="\${PATH:-}"
while :; do
  directory="\${remaining%%:*}"
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
  case "$remaining" in *:*) remaining="\${remaining#*:}" ;; *) break ;; esac
done

append_path() {
  rc="$1"
  mkdir -p "$(dirname "$rc")"
  if ! grep -qsFx "$line" "$rc"; then
    printf '\\n# %s CLI\\n%s\\n' "$BRAND" "$line" >> "$rc" \\
      || fail "Could not configure $rc. The CLI is at $BIN/$NAME."
  fi
}

ready=true
if [ -z "$link_bin" ]; then
  # No writable directory on PATH: link into ~/.local/bin and put that on PATH in the shell's rc
  # file, so a new terminal has it.
  link_bin="$HOME/.local/bin"
  mkdir -p "$link_bin"
  destination="$link_bin/$NAME"
  if [ "$link_bin" = "$BIN" ]; then
    :
  elif [ -L "$destination" ] && [ "$(readlink "$destination")" = "$BIN/$NAME" ]; then
    :
  else
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      fail "Could not link $destination; what is there was left untouched."
    fi
    ln -s "$BIN/$NAME" "$destination" || fail "Could not link $destination; what is there was left untouched."
  fi
  escaped_bin="$(printf '%s' "$link_bin" | sed 's/[\\\\"$\`]/\\\\&/g')"
  line="export PATH=\\"$escaped_bin:\\$PATH\\""
  user_shell="\${SHELL:-sh}"
  case "\${user_shell##*/}" in
    zsh) append_path "\${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      append_path "$HOME/.bashrc"
      # A login bash reads only the first of these that exists.
      if [ -f "$HOME/.bash_profile" ]; then append_path "$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ]; then append_path "$HOME/.bash_login"
      else append_path "$HOME/.profile"; fi
      ;;
    fish)
      line="fish_add_path --prepend \\"$escaped_bin\\""
      append_path "\${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/$NAME.fish"
      ;;
    *) append_path "$HOME/.profile" ;;
  esac
  ready=false
fi

version="$(node -p 'require(process.argv[1]).version' "$PREFIX/lib/node_modules/$NAME/package.json" 2>/dev/null || true)"
printf '\\nInstalled the %s CLI %s in %s\\n' "$BRAND" "$version" "$BIN"
if [ "$ready" = true ]; then
  printf 'Next: %s\\n' "$NAME"
else
  printf 'Open a new terminal, then run: %s\\n' "$NAME"
fi
`;
}
