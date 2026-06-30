FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN rm -f package-lock.json && npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p ton-signer-keys

EXPOSE 10000

CMD ["npm", "start"]
