#!/usr/bin/env bash
# npm run test:e2e — builds the CLI, makes sure the Python venv exists, runs tests/e2e/drive.py.
set -euo pipefail
cd "$(dirname "$0")/../.."

VENV=.cache/e2e-venv
REQ=tests/e2e/requirements.txt
if [ ! -x "$VENV/bin/python" ]; then
  echo "creating $VENV"
  python3 -m venv "$VENV"
fi
# Reinstall only when requirements.txt changes.
if ! cmp -s "$REQ" "$VENV/.requirements.txt"; then
  "$VENV/bin/pip" install --quiet --disable-pip-version-check -r "$REQ"
  cp "$REQ" "$VENV/.requirements.txt"
fi

npm run --silent build >/dev/null 2>&1 || { npm run build; exit 1; }
exec "$VENV/bin/python" tests/e2e/drive.py "$@"
