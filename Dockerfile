FROM node:18-alpine

# نصب chromium و dependencies
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    wqy-zenhei

# تنظیم محیط برای chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_CHROME_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# جلوگیری از دانلود chromium اضافی
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# کپی package.json
COPY package*.json ./

# نصب dependencies
RUN npm install --production

# کپی فایل‌های پروژه
COPY . .

# پورت
EXPOSE 3000

# اجرای ربات
CMD ["node", "bot.js"]