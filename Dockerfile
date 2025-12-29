FROM node:18-bullseye

# نصب وابستگی‌های مورد نیاز برای Playwright
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libgbm1 \
    libxshmfence1 \
    libdrm2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# کپی package.json
COPY package*.json ./

# نصب dependencies
RUN npm install

# نصب Playwright browsers
RUN npx playwright install chromium

# کپی فایل‌های پروژه
COPY . .

# محیط اجرا
ENV NODE_ENV=production
ENV PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/usr/bin/chromium

# پورت
EXPOSE 3000

# اجرای ربات
CMD ["node", "Bot.js"]