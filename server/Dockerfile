FROM node:24.16.0-bookworm-slim
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /srv/data && chown -R node:node /srv
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/srv/data/accounts.sqlite NODE_ENV=production
EXPOSE 8787
CMD ["node", "src/index.mjs"]
