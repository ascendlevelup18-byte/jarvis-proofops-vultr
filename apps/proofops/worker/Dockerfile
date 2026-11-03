# ProofOps browser worker image. Built on the VM; never pushed to a registry.
# Base: the official Node Playwright image matching the pinned npm version (browsers preinstalled).
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /opt/proofops-worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY worker.mjs ./

# Runs as an unprivileged uid; the launcher also passes --user 10001:10001, --read-only, --cap-drop=ALL.
USER 10001:10001
ENV HOME=/tmp NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "/opt/proofops-worker/worker.mjs"]
