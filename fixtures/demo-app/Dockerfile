# Reference Dockerfile for demo-app. ProofGate's sandbox does not need
# this; it runs the repo on a generic node base. Kept so maintainers can
# see how the service is built and run.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund || true
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
