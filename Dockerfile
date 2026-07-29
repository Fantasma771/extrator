FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json index.js ./
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "index.js"]
