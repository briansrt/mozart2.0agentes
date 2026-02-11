# ========== Dependencias ==========
FROM node:18-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
  && ln -sf python3 /usr/bin/python
COPY package*.json ./
RUN npm ci

# ========== Runner ==========
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copiamos node_modules ya resueltas
COPY --from=deps /app/node_modules ./node_modules

# Copiamos el resto del código
COPY . .

# ✅ Copiamos el archivo .env al contenedor (como tú siempre lo usas)
COPY .env .env

# ✅ Puerto donde escucha tu app (corregido)
EXPOSE 4000

# ✅ Healthcheck usando el puerto correcto
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/ping || exit 1

# Comando de arranque
CMD ["node", "index.js"]

