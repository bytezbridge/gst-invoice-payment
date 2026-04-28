FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 build-essential pkg-config && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data deliverables invoices
EXPOSE 3000
CMD ["node", "server.js"]
