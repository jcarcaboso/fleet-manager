#!/bin/sh
set -eu

usage() {
  echo "usage: $0 --key-file PATH --base-url HTTPS_URL/v1 --model MODEL" >&2
  exit 2
}

key_file=
base_url=
model=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key-file) [ "$#" -ge 2 ] || usage; key_file=$2; shift 2 ;;
    --base-url) [ "$#" -ge 2 ] || usage; base_url=$2; shift 2 ;;
    --model) [ "$#" -ge 2 ] || usage; model=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$key_file" ] && [ -n "$base_url" ] && [ -n "$model" ] || usage
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

check_root=$(mktemp -d "${TMPDIR:-/tmp}/fleet-cliproxy-check.XXXXXXXX")
trap 'rm -rf -- "$check_root"' EXIT HUP INT TERM
export CHECK_ROOT=$check_root BASE_URL=$base_url MODEL=$model KEY_FILE=$key_file

key_file=$(python3 - <<'PY'
import json
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit

root = Path(os.environ["CHECK_ROOT"])
key = Path(os.environ["KEY_FILE"])
info = key.lstat()
if not stat.S_ISREG(info.st_mode) or key.is_symlink():
    raise SystemExit("key file must be a regular file, not a link")
if info.st_mode & 0o077:
    raise SystemExit("key file must not grant group or other permissions")
value = key.read_bytes()
trimmed = value.rstrip(b"\r\n")
if not trimmed or len(value) > 4096 or any(byte < 33 or byte > 126 for byte in trimmed):
    raise SystemExit("key file must contain one printable ASCII value of at most 4 KiB")

base = os.environ["BASE_URL"]
url = urlsplit(base)
if (url.scheme != "https" or not url.hostname or url.username or url.password
        or url.query or url.fragment or url.path.rstrip("/") != "/v1"):
    raise SystemExit("base URL must be an HTTPS /v1 endpoint without credentials, query, or fragment")
base = base.rstrip("/")
model = os.environ["MODEL"]
if not model or len(model) > 200 or model.strip() != model or not model.isascii() \
        or any(not character.isprintable() for character in model):
    raise SystemExit("model must be a non-empty printable ASCII identifier")

codex = root / "codex"
opencode = root / "xdg" / "opencode"
codex.mkdir(parents=True, mode=0o700)
opencode.mkdir(parents=True, mode=0o700)
quote = json.dumps
(codex / "config.toml").write_text(
    f"model = {quote(model)}\n"
    "model_provider = \"fleet-cliproxy\"\n\n"
    "model_catalog_json = \"/tmp/fleet-check/codex/model-catalog.json\"\n\n"
    "[model_providers.fleet-cliproxy]\n"
    "name = \"Fleet CLIProxy\"\n"
    f"base_url = {quote(base)}\n"
    "wire_api = \"responses\"\n"
    "requires_openai_auth = false\n\n"
    "[model_providers.fleet-cliproxy.auth]\n"
    "command = \"cat\"\n"
    "args = [\"/run/fleet/api-key\"]\n"
    "timeout_ms = 5000\n"
    "refresh_interval_ms = 300000\n",
    encoding="utf-8",
)
(codex / "model-catalog.json").write_text(json.dumps({"models": [{
    "slug": model,
    "display_name": model,
    "description": None,
    "default_reasoning_level": None,
    "supported_reasoning_levels": [],
    "shell_type": "unified_exec",
    "visibility": "list",
    "supported_in_api": True,
    "priority": 1,
    "availability_nux": None,
    "upgrade": None,
    "include_apps_usage_instructions": False,
    "supports_reasoning_summary_parameter": False,
    "support_verbosity": False,
    "default_verbosity": None,
    "apply_patch_tool_type": "freeform",
    "truncation_policy": {"mode": "bytes", "limit": 10000},
    "experimental_supported_tools": [],
    "base_instructions": "You are Codex, a coding agent. Work in the user's repository, follow applicable AGENTS.md instructions, and use the provided tools to complete the request.",
}]}, indent=2) + "\n", encoding="utf-8")
(opencode / "opencode.json").write_text(json.dumps({
    "model": f"fleet-cliproxy/{model}",
    "provider": {
        "fleet-cliproxy": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Fleet CLIProxy",
            "options": {"baseURL": base, "apiKey": "{file:/run/fleet/api-key}"},
            "models": {model: {"name": model}},
        }
    },
}, indent=2) + "\n", encoding="utf-8")
for path in [codex / "config.toml", codex / "model-catalog.json", opencode / "opencode.json"]:
    path.chmod(0o600)
print(key.resolve())
PY
)

docker run --rm \
  -e HOME=/tmp/fleet-runtime \
  -e CODEX_HOME=/tmp/fleet-check/codex \
  -e XDG_CONFIG_HOME=/tmp/fleet-check/xdg \
  -e CHECK_MODEL="$model" \
  -v "$check_root:/tmp/fleet-check" \
  -v "$key_file:/run/fleet/api-key:ro" \
  node:24-bookworm-slim \
  sh -ceu '
    apt-get update >/dev/null
    apt-get install -y --no-install-recommends ca-certificates >/dev/null
    mkdir -p "$HOME"
    if npx -y @openai/codex@0.154.0 exec --skip-git-repo-check --ephemeral \
      "Use the shell tool to run printf FLEET_CODEX_TOOL_OK, then reply with exactly FLEET_CODEX_OK and no other text." \
      >"$HOME/codex.out" 2>/dev/null && grep -Fqx FLEET_CODEX_OK "$HOME/codex.out"; then
      echo "Codex 0.154.0: OK"
    else
      echo "Codex 0.154.0 compatibility check failed" >&2
      exit 1
    fi
    if npx -y opencode-ai@1.18.31 run --model "fleet-cliproxy/$CHECK_MODEL" \
      "Use the shell tool to run printf FLEET_OPENCODE_TOOL_OK, then reply with exactly FLEET_OPENCODE_OK and no other text." \
      >"$HOME/opencode.out" 2>/dev/null && grep -Fqx FLEET_OPENCODE_OK "$HOME/opencode.out"; then
      echo "OpenCode 1.18.31: OK"
    else
      echo "OpenCode 1.18.31 compatibility check failed" >&2
      exit 1
    fi
  '
