FROM node:24-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
COPY scripts/admin-bootstrap.js scripts/admin-promote.js scripts/admin-commands.js scripts/admin-runtime.js scripts/admin-prompts.js ./scripts/

USER node

EXPOSE 3000

CMD ["npm", "start"]
