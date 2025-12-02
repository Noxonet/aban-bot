FROM node:18-bullseye

# نصب dependencies سیستم
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# کپی package.json و نصب dependencies
COPY package*.json ./
RUN npm install

# نصب Playwright و کرومیوم
RUN npx playwright install chromium --with-deps

# کپی کد برنامه
COPY . .

# پورت
EXPOSE 8080

# اجرای برنامه
CMD ["node", "bot.js"]