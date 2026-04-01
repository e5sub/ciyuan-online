FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.html ./index.html
COPY online-gateway.html ./online-gateway.html
COPY server.js ./server.js
COPY schema.sql ./schema.sql

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
