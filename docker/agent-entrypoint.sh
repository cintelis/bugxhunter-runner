#!/bin/sh
# OpenCode records file changes only inside git repositories, so make sure the
# workspace root is one (projects created inside it are tracked from day one).
set -e
if [ ! -d /workspace/.git ]; then
  git -C /workspace init -q
  git -C /workspace commit -q --allow-empty -m "workspace created"
fi
exec "$@"
