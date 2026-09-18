#!/usr/bin/env bash
# Builds the Finance Tracker image on this machine so a Portainer stack can
# reference it by name. Run this on the SAME host Portainer deploys to.
set -euo pipefail

IMAGE="${IMAGE:-finance-tracker:local}"
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker is not installed or not on PATH." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Error: cannot reach the Docker daemon." >&2
    echo "Is it running, and is your user in the 'docker' group? (try: sudo $0)" >&2
    exit 1
fi

if [ ! -f Dockerfile ]; then
    echo "Error: Dockerfile not found. Run this from inside the project folder." >&2
    exit 1
fi

echo "Building ${IMAGE} ..."
docker build -t "${IMAGE}" .

cat <<EOF

Built: ${IMAGE}

Next steps
  1. Open Portainer -> Stacks -> Add stack -> Web editor
  2. Paste the contents of docker-compose.local.yml
  3. Deploy

The app will be at http://<this-host>:8090
To rebuild after a code change, re-run this script and redeploy the stack.
EOF
