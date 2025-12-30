FROM node:18-bullseye

# نصب وابستگی‌های سیستم برای Playwright
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
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgcc1 \
    libgconf-2-4 \
    libstdc++6 \
    libxi6 \
    libxfixes3 \
    libxcb1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxtst6 \
    libnss3-tools \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# نصب کرومیوم برای Playwright
RUN apt-get update && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# کپی package.json
COPY package*.json ./

# نصب dependencies
RUN npm install --production

# نصب Playwright (بدون دانلود مرورگر مجدد)
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

# کپی فایل‌های پروژه
COPY . .

# تنظیم محیط
ENV NODE_ENV=production
ENV PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

# پورت (Railway نیاز دارد)
EXPOSE 3000

# ایجاد کاربر غیر root برای امنیت بیشتر
RUN useradd -m -u 1000 botuser
USER botuser

# اجرای ربات
CMD ["node", "Bot.js"]