# Prizrak homeserver — минимальный образ.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
RUN npm install --omit=dev
ENV PRIZRAK_DOMAIN=localhost \
    PRIZRAK_PORT=8801 \
    PRIZRAK_STORE=/data/store.json
VOLUME /data
EXPOSE 8801
CMD ["node", "packages/server/src/server.js"]
