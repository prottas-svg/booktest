FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
