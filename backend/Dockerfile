FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js worker.js mock.js schema.sql domain.js auth.js reconciliation.js migrate.js ./
COPY migrations ./migrations
EXPOSE 3001 4001 4002
CMD ["npm", "start"]
