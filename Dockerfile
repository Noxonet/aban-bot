# Dockerfile for AbanTether Bot
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# تنظیم دایرکتوری کار
WORKDIR /app

# نصب پکیج‌های سیستم
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# کپی package.json و package-lock.json
COPY package*.json ./

# نصب وابستگی‌های Node.js
RUN npm ci --only=production

# کپی فایل‌های برنامه
COPY . .

# ایجاد دایرکتوری‌های لازم
RUN mkdir -p screenshots logs

# نصب مرورگر کرومیوم
RUN npx playwright install chromium \
    && npx playwright install-deps chromium

# تنظیم متغیرهای محیطی
ENV NODE_ENV=production
ENV HEADLESS=true
ENV TZ=Asia/Tehran

# دسترسی‌های لازم
RUN chmod +x /app/Bot.js

# اکسپوز پورت (اگر نیاز باشد)
EXPOSE 3000

# کامند اجرا
CMD ["node", "Bot.js"]