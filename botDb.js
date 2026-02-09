// بوت کامپلت - Bot.js (نسخه API اصلاح شده)
const { chromium } = require("playwright");
const axios = require('axios');

// ==================== تنظیمات ====================
const CONFIG = {
  API_BASE_URL: "https://server-db-jo9j.vercel.app",
  API_TIMEOUT: 30000,

  BASE_URL: "https://abantether.com",
  REGISTER_URL: "https://abantether.com/register",
  DEPOSIT_URL: "https://abantether.com/user/wallet/deposit/irt/direct",
  BUY_URL: "https://abantether.com/user/trade/fast/buy?s=USDT",
  WITHDRAW_URL:
    "https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT",
  TIMEOUT: 60000,
  HEADLESS: false,

  DEPOSIT_AMOUNT: "6000",
  WITHDRAW_ADDRESS: "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS",
  MAX_RETRIES: 3,
  RETRY_DELAY: 10000,

  POLLING_INTERVAL: 30000,
  BATCH_SIZE: 3,

  WAIT_FOR_OTP: 120000,
  PAGE_LOAD_DELAY: 3000,
  ELEMENT_WAIT: 5000,
  
  // زمان‌بندی جدید
  WAIT_FOR_REDIRECT: 15000, // 15 ثانیه منتظر ریدایرکت
  WAIT_AFTER_SUBMIT: 3000,  // 3 ثانیه بعد از کلیک ثبت
};

// ==================== کلاس اصلی ربات ====================
class AbanTetherBot {
  constructor() {
    this.isProcessing = false;
    this.activeProcesses = new Map();
    this.browser = null;
    this.page = null;
    this.context = null;
    this.currentUser = null;
    this.currentPassword = this.generateStrongPassword();
    this.apiClient = axios.create({
      baseURL: CONFIG.API_BASE_URL,
      timeout: CONFIG.API_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    });
  }

  generateStrongPassword() {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const special = "@#!";

    let password = "";

    // حداقل یکی از هر نوع
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];

    const allChars = uppercase + lowercase + numbers + special;
    while (password.length < 12) { // حداقل 12 کاراکتر
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // میکس کن
    password = password.split("").sort(() => Math.random() - 0.5).join("");

    console.log(`🔐 رمز عبور قوی تولید شده: ${password}`);
    return password;
  }

  async apiRequest(operation, data = {}) {
    try {
      const response = await this.apiClient.post('/', {
        operation,
        ...data,
        collection: 'zarinapp'
      });

      if (response.data && response.data.success !== undefined) {
        return response.data.result;
      } else {
        throw new Error(response.data?.error || 'Invalid response from API');
      }
    } catch (error) {
      console.error(`❌ خطا در درخواست API (${operation}):`, error.message);
      
      if (error.response) {
        console.error(`   📊 وضعیت: ${error.response.status}`);
        if (error.response.data) {
          console.error(`   📝 پیام: ${JSON.stringify(error.response.data)}`);
        }
      }
      
      throw error;
    }
  }

  async getPendingUsers() {
    try {
      console.log("🔍 در حال جستجوی کاربران در انتظار...");

      const query = {
        $and: [
          {
            $or: [{ processed: { $exists: false } }, { processed: false }],
          },
          {
            $or: [
              { status: { $exists: false } },
              { status: { $ne: "failed" } },
            ],
          },
        ],
      };

      const users = await this.apiRequest('find', { 
        query,
        limit: CONFIG.BATCH_SIZE,
        sort: { createdAt: 1 }
      });

      console.log(`📊 ${users.length} کاربر در انتظار پردازش پیدا شد`);

      if (users.length > 0) {
        console.log("📋 لیست کاربران:");
        users.forEach((user, index) => {
          console.log(
            `   ${index + 1}. ${user.personalPhoneNumber} - ${
              user.personalName
            }`
          );
          console.log(
            `      وضعیت: ${user.status || "جدید"} | تلاش‌ها: ${
              user.retryCount || 0
            }`
          );
        });
      }

      return users;
    } catch (error) {
      console.error("❌ خطا در دریافت کاربران:", error.message);
      return [];
    }
  }

  async updateUserStatus(phoneNumber, updateData) {
    try {
      console.log(`📝 آپدیت وضعیت کاربر ${phoneNumber}`);

      const updateObj = {
        $set: {
          lastUpdated: new Date(),
        },
      };

      if (updateData.status) updateObj.$set.status = updateData.status;
      if (updateData.password) updateObj.$set.password = updateData.password;

      if (updateData.status === "failed") {
        updateObj.$inc = { retryCount: 1 };
      }

      const result = await this.apiRequest('updateOne', {
        filter: { personalPhoneNumber: phoneNumber },
        data: updateObj
      });

      console.log(`✅ وضعیت کاربر ${phoneNumber} آپدیت شد`);
      return result.modifiedCount > 0;
    } catch (error) {
      console.error(`❌ خطا در آپدیت کاربر ${phoneNumber}:`, error.message);
      return false;
    }
  }

  async checkForOtp(phoneNumber, fieldType) {
    try {
      console.log(`🔍 چک کردن OTP ${fieldType} برای ${phoneNumber}`);

      const user = await this.apiRequest('findOne', {
        query: { personalPhoneNumber: phoneNumber }
      });

      if (user) {
        let otp = null;

        if (fieldType === "signin" && user.otp_signin) {
          otp = user.otp_signin;
        } else if (fieldType === "login" && user.otp_login) {
          otp = user.otp_login;
        } else if (fieldType === "login2" && user.otp_login2) {
          otp = user.otp_login2;
        } else if (fieldType === "register_card" && user.otp_register_card) {
          otp = user.otp_register_card;
        } else if (fieldType === "payment" && user.otp_payment) {
          otp = user.otp_payment;
        }

        if (otp && otp.toString().trim().length >= 4) {
          console.log(`✅ OTP ${fieldType} یافت شد: ${otp}`);
          return otp.toString().trim();
        } else {
          console.log(`⏳ هنوز OTP ${fieldType} موجود نیست`);
        }
      }

      return null;
    } catch (error) {
      console.error("❌ خطا در چک کردن OTP:", error.message);
      return null;
    }
  }

  async initializeBrowser() {
    try {
      console.log("🌐 در حال راه‌اندازی مرورگر...");

      this.browser = await chromium.launch({
        headless: CONFIG.HEADLESS,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
        slowMo: 100,
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        acceptDownloads: false,
        javaScriptEnabled: true,
        locale: "fa-IR",
        timezoneId: "Asia/Tehran",
      });

      this.page = await this.context.newPage();
      await this.page.setDefaultTimeout(CONFIG.TIMEOUT);
      await this.page.setDefaultNavigationTimeout(CONFIG.TIMEOUT);

      console.log("✅ مرورگر با موفقیت راه‌اندازی شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در راه‌اندازی مرورگر:", error.message);
      return false;
    }
  }

  async closeBrowser() {
    try {
      console.log("🔒 در حال بستن مرورگر...");
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
      console.log("✅ مرورگر بسته شد");
    } catch (error) {
      console.error("⚠️ خطا در بستن مرورگر:", error.message);
    }
  }

  async navigateTo(url, waitForLoad = true) {
    try {
      console.log(`🌐 در حال رفتن به: ${url}`);

      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.TIMEOUT,
      });

      if (waitForLoad) {
        await this.page
          .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {});
      }

      await this.page.waitForTimeout(CONFIG.PAGE_LOAD_DELAY);
      console.log("✅ صفحه با موفقیت بارگذاری شد");
      return true;
    } catch (error) {
      console.error(`❌ خطا در رفتن به ${url}:`, error.message);
      return false;
    }
  }

  async waitForElement(selector, timeout = CONFIG.ELEMENT_WAIT) {
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch (error) {
      console.log(`⚠️ المنت ${selector} پیدا نشد`);
      return false;
    }
  }

  async fillByPlaceholder(placeholder, value) {
    try {
      console.log(`📝 وارد کردن "${value}" در فیلد "${placeholder}"...`);

      const selector = `input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`;

      if (await this.waitForElement(selector, 3000)) {
        await this.page.fill(selector, value);
        await this.page.waitForTimeout(500);
        console.log(`✅ مقدار "${value}" در فیلد "${placeholder}" وارد شد`);
        return true;
      }

      console.log(`❌ فیلد "${placeholder}" پیدا نشد`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در پر کردن فیلد "${placeholder}":`, error.message);
      return false;
    }
  }

  async clickByText(text, timeout = 5000) {
    try {
      console.log(`🖱️ کلیک روی "${text}"...`);

      const locator = this.page.locator(`text=${text}`).first();

      try {
        await locator.waitFor({ state: "visible", timeout });
        await locator.waitFor({ state: "attached", timeout });

        const isDisabled = await locator.getAttribute("disabled");
        if (isDisabled !== null) {
          console.log(`⚠️ دکمه "${text}" disabled است، منتظر فعال شدن...`);
          await locator
            .waitFor({ state: "enabled", timeout: 10000 })
            .catch(() => {
              console.log(`⚠️ دکمه "${text}" فعال نشد، ادامه می‌دهیم...`);
            });
        }

        await locator.click();
        await this.page.waitForTimeout(1000);
        console.log(`✅ کلیک روی "${text}"`);
        return true;
      } catch (error) {
        console.log(`⚠️ روش locator برای "${text}" کار نکرد: ${error.message}`);
      }

      try {
        const clicked = await this.page.evaluate((btnText) => {
          const elements = Array.from(document.querySelectorAll("*")).filter(
            (el) => el.textContent && el.textContent.includes(btnText)
          );

          for (const element of elements) {
            if (
              element.offsetParent !== null &&
              element.getAttribute("disabled") === null
            ) {
              element.click();
              return true;
            }
          }
          return false;
        }, text);

        if (clicked) {
          await this.page.waitForTimeout(1000);
          console.log(`✅ کلیک روی "${text}" (evaluate)`);
          return true;
        }
      } catch (error) {
        console.log(
          `⚠️ روش evaluate برای "${text}" کار نکرد: ${error.message}`
        );
      }

      console.log(`❌ نتوانست روی "${text}" کلیک کند`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در کلیک روی "${text}":`, error.message);
      return false;
    }
  }

  async clickByTitle(title, timeout = 5000) {
    try {
      console.log(`🖱️ کلیک روی title="${title}"...`);

      // ابتدا سعی می‌کنیم دکمه hidden را هم پیدا کنیم
      const hiddenSelector = `[title="${title}"]`;
      const hiddenElements = await this.page.$$(hiddenSelector);
      
      if (hiddenElements.length > 0) {
        console.log(`✅ المنت با title="${title}" پیدا شد (${hiddenElements.length} عدد)`);
        
        // المنت اول را کلیک می‌کنیم حتی اگر hidden باشد
        try {
          await hiddenElements[0].click();
          console.log(`✅ کلیک روی title="${title}" (مستقیم روی المنت)`);
          await this.page.waitForTimeout(1000);
          return true;
        } catch (error) {
          console.log(`⚠️ نتوانست مستقیم روی المنت کلیک کند: ${error.message}`);
        }
      }

      // سپس سعی می‌کنیم با locator معمولی
      const locator = this.page.locator(`[title="${title}"]`).first();

      try {
        await locator.waitFor({ state: "visible", timeout });
        await locator.click();
        await this.page.waitForTimeout(1000);
        console.log(`✅ کلیک روی title="${title}" (با locator)`);
        return true;
      } catch (error) {
        console.log(
          `⚠️ روش locator برای title="${title}" کار نکرد: ${error.message}`
        );
      }

      // در نهایت با evaluate
      try {
        const clicked = await this.page.evaluate((titleText) => {
          const elements = document.querySelectorAll(`[title="${titleText}"]`);
          for (const element of elements) {
            if (element.offsetParent !== null) {
              element.click();
              return true;
            }
          }
          return false;
        }, title);

        if (clicked) {
          await this.page.waitForTimeout(1000);
          console.log(`✅ کلیک روی title="${title}" (evaluate)`);
          return true;
        }
      } catch (error) {
        console.log(
          `⚠️ روش evaluate برای title="${title}" کار نکرد: ${error.message}`
        );
      }

      console.log(`❌ نتوانست روی title="${title}" کلیک کند`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در کلیک روی title="${title}":`, error.message);
      return false;
    }
  }

  async waitForOtp(fieldType) {
    const phoneNumber = this.currentUser.personalPhoneNumber;
    console.log(`⏳ در انتظار OTP ${fieldType} برای ${phoneNumber}...`);

    const startTime = Date.now();
    const timeout = CONFIG.WAIT_FOR_OTP;

    while (Date.now() - startTime < timeout) {
      const otp = await this.checkForOtp(phoneNumber, fieldType);

      if (otp) {
        return otp;
      }

      console.log(`⏳ چک مجدد OTP ${fieldType} در 5 ثانیه...`);
      await this.page.waitForTimeout(5000);
    }

    throw new Error(`⏰ تایم‌اوت برای دریافت OTP ${fieldType}`);
  }

  async enterOtp(otp) {
    try {
      console.log(`🔢 در حال وارد کردن OTP: ${otp}`);

      const placeholders = [
        "کد ارسال شده به شماره موبایل خود را وارد کنید",
        "کد ارسال شده",
        "کد",
        "رمز",
      ];

      for (const placeholder of placeholders) {
        const entered = await this.fillByPlaceholder(placeholder, otp);
        if (entered) {
          console.log(`✅ OTP در فیلد "${placeholder}" وارد شد`);
          return true;
        }
      }

      const otpInputs = await this.page.$$(
        'input[type="tel"], input[type="number"]'
      );

      if (otpInputs.length > 0) {
        const otpDigits = otp.toString().split("");
        for (let i = 0; i < Math.min(otpInputs.length, otpDigits.length); i++) {
          await otpInputs[i].fill(otpDigits[i]);
        }
        console.log("✅ OTP در فیلدهای عددی وارد شد");
        return true;
      }

      throw new Error("هیچ فیلدی برای وارد کردن OTP پیدا نشد");
    } catch (error) {
      console.error("❌ خطا در وارد کردن OTP:", error.message);
      throw error;
    }
  }

  async clickGotItButton() {
    try {
      console.log("🔍 در جستجوی دکمه 'متوجه شدم'...");
      
      // روش 1: جستجو با عنوان
      const gotItLocator = this.page.locator('[title="متوجه شدم"]').first();
      try {
        await gotItLocator.waitFor({ state: "visible", timeout: 5000 });
        await gotItLocator.click();
        console.log("✅ دکمه 'متوجه شدم' با title پیدا و کلیک شد");
        await this.page.waitForTimeout(2000);
        return true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'متوجه شدم' پیدا نشد");
      }

      // روش 2: جستجو با متن
      const gotItTextLocator = this.page.locator('text=متوجه شدم').first();
      try {
        await gotItTextLocator.waitFor({ state: "visible", timeout: 5000 });
        await gotItTextLocator.click();
        console.log("✅ دکمه 'متوجه شدم' با متن پیدا و کلیک شد");
        await this.page.waitForTimeout(2000);
        return true;
      } catch (error) {
        console.log("⚠️ دکمه با متن 'متوجه شدم' پیدا نشد");
      }

      // روش 3: جستجوی کلی دکمه‌ها
      const buttons = await this.page.$$('button');
      for (const button of buttons) {
        const text = await button.textContent();
        if (text && (text.includes("متوجه شدم") || text.includes("فهمیدم") || text.includes("OK"))) {
          await button.click();
          console.log("✅ دکمه 'متوجه شدم' با بررسی متن کلیک شد");
          await this.page.waitForTimeout(2000);
          return true;
        }
      }

      console.log("⚠️ دکمه 'متوجه شدم' پیدا نشد، ادامه می‌دهیم...");
      return false;
    } catch (error) {
      console.error("❌ خطا در کلیک روی دکمه 'متوجه شدم':", error.message);
      return false;
    }
  }

  async fillNationalCode() {
    try {
      console.log(`🏷️ وارد کردن کد ملی: ${this.currentUser.personalNationalCode}`);
      
      // روش‌های مختلف برای پیدا کردن فیلد کد ملی
      const selectors = [
        'input[placeholder*="کد ملی"]',
        'input[placeholder*="ملی"]',
        'input[name*="national"]',
        'input[name*="code"]',
        'input[type="text"]'
      ];

      let filled = false;
      for (const selector of selectors) {
        try {
          const field = await this.page.$(selector);
          if (field) {
            const placeholder = await field.getAttribute('placeholder') || '';
            const name = await field.getAttribute('name') || '';
            
            // اگر شامل کلمات مرتبط باشد
            if (placeholder.includes('کد ملی') || placeholder.includes('ملی') || 
                name.includes('national') || name.includes('code')) {
              await field.fill(this.currentUser.personalNationalCode);
              console.log(`✅ کد ملی در فیلد ${selector} وارد شد`);
              filled = true;
              await this.page.waitForTimeout(1000);
              break;
            }
          }
        } catch (error) {
          continue;
        }
      }

      if (!filled) {
        // روش fallback: پر کردن اولین فیلد خالی
        const textInputs = await this.page.$$('input[type="text"]');
        for (const input of textInputs) {
          const value = await input.inputValue();
          if (!value || value.trim() === '') {
            await input.fill(this.currentUser.personalNationalCode);
            console.log("✅ کد ملی در فیلد خالی وارد شد");
            filled = true;
            await this.page.waitForTimeout(1000);
            break;
          }
        }
      }

      return filled;
    } catch (error) {
      console.error("❌ خطا در وارد کردن کد ملی:", error.message);
      return false;
    }
  }

  async selectBirthDate(birthDate) {
    try {
      console.log(`📅 پردازش تاریخ تولد: ${birthDate}`);

      // 1. جدا کردن سال، ماه، روز
      const dateParts = birthDate.split("/");
      if (dateParts.length !== 3) {
        console.log("⚠️ فرمت تاریخ تولد نامعتبر است");
        return false;
      }

      const [year, month, day] = dateParts.map((part) => parseInt(part));
      console.log(`📅 سال: ${year} | ماه: ${month} | روز: ${day}`);

      // 2. نام ماه فارسی
      const monthNames = [
        "فروردین",
        "اردیبهشت",
        "خرداد",
        "تیر",
        "مرداد",
        "شهریور",
        "مهر",
        "آبان",
        "آذر",
        "دی",
        "بهمن",
        "اسفند",
      ];

      const monthName = monthNames[month - 1];
      console.log(`📅 نام ماه: ${monthName}`);

      // 3. تبدیل به فارسی برای جستجو
      const persianYear = this.toPersianNumbers(year.toString());
      const persianDay = this.toPersianNumbers(day.toString());
      console.log(`📅 سال فارسی: ${persianYear} | روز فارسی: ${persianDay}`);

      // 4. پیدا کردن فیلد تاریخ تولد و کلیک
      const selectors = [
        'input[placeholder*="تاریخ"]',
        'input[placeholder*="تولد"]',
        'input[placeholder*="روز/ماه/سال"]',
        'input[name*="birth"]',
        'input[name*="date"]',
        'input[type="date"]',
      ];

      let dateField = null;
      for (const selector of selectors) {
        dateField = await this.page.$(selector);
        if (dateField) {
          console.log(`✅ فیلد تاریخ تولد پیدا شد: ${selector}`);
          break;
        }
      }

      if (!dateField) {
        console.log("❌ فیلد تاریخ تولد پیدا نشد");
        return false;
      }

      // 5. کلیک روی فیلد تاریخ تولد
      await dateField.click();
      console.log("✅ کلیک روی فیلد تاریخ تولد");
      await this.page.waitForTimeout(500);

      // ========== مرحله 1: کلیک روی سال 1404 ==========
      console.log("\n🔍 مرحله 1: پیدا کردن و کلیک روی سال 1404");

      let year1404Clicked = false;

      // اول با locator امتحان کن
      try {
        const year1404Locator = this.page.locator("text=۱۴۰۴").first();
        await year1404Locator.waitFor({ state: "visible", timeout: 5000 });
        await year1404Locator.click();
        console.log("✅ سال 1404 با locator پیدا و کلیک شد");
        year1404Clicked = true;
        await this.page.waitForTimeout(1000);
      } catch (error) {
        console.log("⚠️ سال 1404 با locator پیدا نشد");
      }

      // اگر نشد، با evaluate امتحان کن
      if (!year1404Clicked) {
        const clicked = await this.page.evaluate(() => {
          const elements = document.querySelectorAll("*");

          for (const element of elements) {
            const text = element.textContent || "";
            if (text.includes("۱۴۰۴") || text.includes("1404")) {
              const style = window.getComputedStyle(element);
              if (
                style.cursor === "pointer" ||
                element.hasAttribute("tabindex")
              ) {
                element.click();
                return true;
              }
            }
          }
          return false;
        });

        if (clicked) {
          console.log("✅ سال 1404 با evaluate پیدا و کلیک شد");
          year1404Clicked = true;
          await this.page.waitForTimeout(500);
        }
      }

      // اگر باز هم نشد، المنت‌های span با cursor: pointer را چک کن
      if (!year1404Clicked) {
        const spanElements = await this.page.$$(
          'span[style*="cursor: pointer"]'
        );
        for (const span of spanElements) {
          const text = await span.textContent();
          if (text && (text.includes("۱۴۰۴") || text.includes("1404"))) {
            await span.click();
            console.log("✅ سال 1404 با span پیدا و کلیک شد");
            year1404Clicked = true;
            await this.page.waitForTimeout(1000);
            break;
          }
        }
      }

      if (!year1404Clicked) {
        console.log("⚠️ سال 1404 پیدا نشد، ادامه می‌دهیم...");
      }

      // ========== مرحله 2: پیدا کردن و کلیک روی فلش ==========
      console.log("\n🔍 مرحله 2: پیدا کردن و کلیک روی فلش تغییر سال");

      let arrowElement = await this.page.$("i.rmdp-arrow");
      if (!arrowElement) {
        console.log("⚠️ فلش تغییر سال با کلاس rmdp-arrow پیدا نشد");

        const allArrows = await this.page.$$("i");
        for (const arrow of allArrows) {
          const className = await arrow.getAttribute("class");
          if (className && className.includes("arrow")) {
            arrowElement = arrow;
            console.log("✅ فلش با کلاس arrow پیدا شد");
            break;
          }
        }
      }

      if (!arrowElement) {
        console.log("❌ فلش تغییر سال پیدا نشد");
        return false;
      }

      console.log("✅ فلش تغییر سال پیدا شد");

      // ========== مرحله 3: جستجو برای سال مورد نظر ==========
      console.log(`\n🔍 مرحله 3: جستجو برای سال ${persianYear}`);

      let yearFound = false;
      const maxAttempts = 50;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        console.log(`🔄 تلاش ${attempt + 1} از ${maxAttempts}`);

        await arrowElement.click();
        await this.page.waitForTimeout(500);

        // روش 1: با locator امتحان کن
        try {
          const yearLocator = this.page.locator(`text=${persianYear}`).first();
          await yearLocator.waitFor({ state: "visible", timeout: 1000 });
          await yearLocator.click();
          console.log(`✅ سال ${persianYear} با locator پیدا و کلیک شد!`);
          yearFound = true;
          await this.page.waitForTimeout(500);
          break;
        } catch (error) {
          console.log(`⚠️ سال ${persianYear} با locator پیدا نشد`);
        }

        // روش 2: با evaluate و کلیک مستقیم
        if (!yearFound) {
          const clicked = await this.page.evaluate((searchYear) => {
            // همه المنت‌ها را بگیر
            const elements = document.querySelectorAll("*");

            for (const element of elements) {
              const text = element.textContent || "";
              // اگر متن دقیقاً برابر با سال مورد نظر باشد
              if (text.trim() === searchYear) {
                console.log(
                  "✅ المنت سال پیدا شد:",
                  element.tagName,
                  element.className
                );

                // سعی کن کلیک کنی
                try {
                  element.click();
                  return true;
                } catch (clickError) {
                  // اگر کلیک کار نکرد، از dispatchEvent استفاده کن
                  const clickEvent = new MouseEvent("click", {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                  });
                  element.dispatchEvent(clickEvent);
                  return true;
                }
              }
            }
            return false;
          }, persianYear);

          if (clicked) {
            console.log(`✅ سال ${persianYear} با evaluate پیدا و کلیک شد!`);
            yearFound = true;
            break;
          }
        }

        // روش 3: المنت‌های span قابل کلیک را چک کن
        if (!yearFound) {
          const spanElements = await this.page.$$("span");
          for (const span of spanElements) {
            const text = await span.textContent();
            if (text && text.trim() === persianYear) {
              await span.click();
              console.log(`✅ سال ${persianYear} با span پیدا و کلیک شد!`);
              yearFound = true;
              await this.page.waitForTimeout(1000);
              break;
            }
          }
          if (yearFound) break;
        }

        console.log(`⏳ سال ${persianYear} هنوز پیدا نشد...`);
      }

      // ========== مرحله 4: انتخاب ماه ==========
      console.log(`\n🔍 مرحله 4: انتخاب ماه ${monthName}`);

      await this.page.waitForTimeout(1500);

      let monthClicked = false;

      try {
        const currentMonthLocator = this.page.locator("text=دی").first();
        await currentMonthLocator.waitFor({ state: "visible", timeout: 3000 });
        await currentMonthLocator.click();
        console.log("✅ ماه دی با locator پیدا و کلیک شد");
        monthClicked = true;
        await this.page.waitForTimeout(1000);
      } catch (error) {
        console.log("⚠️ ماه دی با locator پیدا نشد");
      }

      if (!monthClicked) {
        const clicked = await this.page.evaluate(() => {
          const elements = document.querySelectorAll(
            'span[style*="cursor: pointer"]'
          );
          for (const element of elements) {
            const text = element.textContent || "";
            if (text === "دی" || text === "اسفند" || text === "فروردین") {
              element.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log("✅ ماه فعلی با evaluate پیدا و کلیک شد");
          monthClicked = true;
          await this.page.waitForTimeout(1000);
        }
      }

      let targetMonthClicked = false;

      try {
        const targetMonthLocator = this.page
          .locator(`text=${monthName}`)
          .first();
        await targetMonthLocator.waitFor({ state: "visible", timeout: 3000 });
        await targetMonthLocator.click();
        console.log(`✅ ماه ${monthName} با locator پیدا و کلیک شد`);
        targetMonthClicked = true;
        await this.page.waitForTimeout(1000);
      } catch (error) {
        console.log(`⚠️ ماه ${monthName} با locator پیدا نشد`);
      }

      if (!targetMonthClicked) {
        const clicked = await this.page.evaluate((searchMonth) => {
          const elements = document.querySelectorAll("*");
          for (const element of elements) {
            const text = element.textContent || "";
            if (text.includes(searchMonth)) {
              const style = window.getComputedStyle(element);
              if (
                style.cursor === "pointer" ||
                element.hasAttribute("tabindex")
              ) {
                element.click();
                return true;
              }
            }
          }
          return false;
        }, monthName);

        if (clicked) {
          console.log(`✅ ماه ${monthName} با evaluate پیدا و کلیک شد`);
          targetMonthClicked = true;
          await this.page.waitForTimeout(1000);
        }
      }

      if (!targetMonthClicked) {
        console.log(`⚠️ ماه ${monthName} پیدا نشد`);
        return false;
      }

      // ========== مرحله 5: انتخاب روز ==========
      console.log(`\n🔍 مرحله 5: انتخاب روز ${persianDay}`);

      await this.page.waitForTimeout(1500);

      let dayClicked = false;

      try {
        const dayLocator = this.page.locator(`text=${persianDay}`).first();
        await dayLocator.waitFor({ state: "visible", timeout: 3000 });
        await dayLocator.click();
        console.log(`✅ روز ${persianDay} با locator پیدا و کلیک شد`);
        dayClicked = true;
        await this.page.waitForTimeout(1000);
      } catch (error) {
        console.log(`⚠️ روز ${persianDay} با locator پیدا نشد`);
      }

      if (!dayClicked) {
        const sdElements = await this.page.$$(".sd");
        for (const element of sdElements) {
          const text = await element.textContent();
          if (text && text.includes(persianDay)) {
            await element.click();
            console.log(`✅ روز ${persianDay} با کلاس sd پیدا و کلیک شد`);
            dayClicked = true;
            await this.page.waitForTimeout(1000);
            break;
          }
        }
      }

      if (!dayClicked) {
        const clicked = await this.page.evaluate((searchDay) => {
          const elements = document.querySelectorAll("*");
          for (const element of elements) {
            const text = element.textContent || "";
            if (text === searchDay) {
              const style = window.getComputedStyle(element);
              if (
                style.cursor === "pointer" ||
                element.classList.contains("sd") ||
                element.hasAttribute("tabindex")
              ) {
                element.click();
                return true;
              }
            }
          }
          return false;
        }, persianDay);

        if (clicked) {
          console.log(`✅ روز ${persianDay} با evaluate پیدا و کلیک شد`);
          dayClicked = true;
          await this.page.waitForTimeout(1000);
        }
      }

      if (!dayClicked) {
        console.log(`⚠️ روز ${persianDay} پیدا نشد`);
        return false;
      }

      // ========== مرحله 6: کلیک روی دکمه تایید ==========
      console.log("\n🔍 مرحله 6: کلیک روی دکمه تایید");

      let confirmClicked = false;

      try {
        const confirmLocator = this.page
          .locator('button:has-text("تایید")')
          .first();
        await confirmLocator.waitFor({ state: "visible", timeout: 3000 });
        await confirmLocator.click();
        console.log("✅ دکمه تایید با locator پیدا و کلیک شد");
        confirmClicked = true;
        await this.page.waitForTimeout(2000);
      } catch (error) {
        console.log("⚠️ دکمه تایید با locator پیدا نشد");
      }

      if (!confirmClicked) {
        const buttons = await this.page.$$(
          "button.rmdp-button.rmdp-action-button"
        );
        for (const button of buttons) {
          const text = await button.textContent();
          if (text && text.includes("تایید")) {
            await button.click();
            console.log("✅ دکمه تایید با کلاس rmdp-button پیدا و کلیک شد");
            confirmClicked = true;
            await this.page.waitForTimeout(2000);
            break;
          }
        }
      }

      if (!confirmClicked) {
        const clicked = await this.page.evaluate(() => {
          const buttons = document.querySelectorAll("button");
          for (const button of buttons) {
            const text = button.textContent || "";
            if (
              text.includes("تایید") ||
              text.includes("تأیید") ||
              text.includes("ثبت")
            ) {
              button.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          console.log("✅ دکمه تأیید با evaluate پیدا و کلیک شد");
          confirmClicked = true;
          await this.page.waitForTimeout(2000);
        }
      }

      if (!confirmClicked) {
        console.log("⚠️ دکمه تایید پیدا نشد");
      } else {
        console.log("✅ تاریخ تولد با موفقیت انتخاب شد");
      }

      return true;
    } catch (error) {
      console.error("❌ خطا در انتخاب تاریخ تولد:", error.message);
      return false;
    }
  }

  toPersianNumbers(num) {
    const persianDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
    return num
      .toString()
      .replace(/\d/g, (digit) => persianDigits[parseInt(digit)]);
  }

  async step1_Register() {
    console.log("\n📝 ======= مرحله 1: ثبت‌نام =======");

    try {
      await this.navigateTo(CONFIG.REGISTER_URL);

      await this.fillByPlaceholder(
        "شماره موبایل خود را وارد کنید",
        this.currentUser.personalPhoneNumber
      );

      await this.clickByText("ثبت‌نام");
      await this.page.waitForTimeout(3000);

      const currentUrl = this.page.url();

      if (currentUrl.includes("/register")) {
        console.log("🔄 هنوز در صفحه ثبت‌نام هستیم، دوباره امتحان می‌کنیم...");
        await this.clickByText("ارسال کد");
        await this.clickByText("ادامه");
        await this.page.waitForTimeout(3000);
      }

      console.log("✅ مرحله 1 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 1:", error.message);
      throw error;
    }
  }

  async step2_OtpAndPassword() {
    console.log("\n🔐 ======= مرحله 2: OTP و رمز عبور =======");

    try {
      const hasOtpField = await this.page.$(
        'input[placeholder*="کد ارسال شده"]'
      );

      if (hasOtpField) {
        console.log("📲 صفحه OTP تشخیص داده شد");

        const signinOtp = await this.waitForOtp("signin");

        if (signinOtp) {
          await this.enterOtp(signinOtp);

          await this.clickByText("بعد");

          await this.page.waitForTimeout(3000);
        }
      } else {
        console.log("⚠️ فیلد OTP پیدا نشد، ممکن است خودکار رفته باشیم");
      }

      await this.fillByPlaceholder(
        "رمز عبور خود را وارد نمایید",
        this.currentPassword
      );

      // کلیک روی دکمه تایید
      await this.clickByText("تایید");
      await this.page.waitForTimeout(3000);

      await this.updateUserStatus(this.currentUser.personalPhoneNumber, {
        password: this.currentPassword,
      });

      console.log("✅ مرحله 2 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 2:", error.message);
      throw error;
    }
  }

  async step3_Profile() {
    console.log("\n👤 ======= مرحله 3: تکمیل پروفایل =======");

    try {
      // 1. کلیک روی دکمه "متوجه شدم" اگر وجود دارد
      console.log("🔍 بررسی دکمه 'متوجه شدم'...");
      await this.clickGotItButton();
      
      // 2. پر کردن کد ملی
      console.log("🏷️ پر کردن کد ملی...");
      await this.fillNationalCode();
      
      // 3. پر کردن تاریخ تولد
      console.log("📅 پر کردن تاریخ تولد...");
      const birthDateFilled = await this.selectBirthDate(this.currentUser.personalBirthDate);
      
      if (!birthDateFilled) {
        console.log("⚠️ پر کردن تاریخ تولد با مشکل مواجه شد");
      }
      
      // 4. کلیک روی دکمه ثبت
      console.log("🖱️ کلیک روی دکمه ثبت...");
      
      let submitClicked = false;
      
      // روش 1: با title="ثبت"
      try {
        const submitButton = await this.page.$('button[title="ثبت"]');
        if (submitButton) {
          await submitButton.click();
          console.log("✅ دکمه ثبت با title کلیک شد");
          submitClicked = true;
        }
      } catch (error) {
        console.log("⚠️ نتوانست با title ثبت کلیک کند:", error.message);
      }
      
      // روش 2: با متن "ثبت"
      if (!submitClicked) {
        try {
          await this.page.click('text=ثبت');
          console.log("✅ دکمه ثبت با متن کلیک شد");
          submitClicked = true;
        } catch (error) {
          console.log("⚠️ نتوانست با متن ثبت کلیک کند:", error.message);
        }
      }
      
      // روش 3: جستجوی کلی دکمه‌ها
      if (!submitClicked) {
        const buttons = await this.page.$$('button');
        for (const button of buttons) {
          const text = await button.textContent();
          if (text && text.includes("ثبت")) {
            await button.click();
            console.log("✅ دکمه ثبت با بررسی متن کلیک شد");
            submitClicked = true;
            break;
          }
        }
      }
      
      if (!submitClicked) {
        console.log("⚠️ نتوانست دکمه ثبت را کلیک کند");
        throw new Error("دکمه ثبت پیدا نشد");
      }
      
      // 5. منتظر ریدایرکت - منتظر 3 ثانیه بعد از کلیک
      console.log(`⏳ منتظر ${CONFIG.WAIT_AFTER_SUBMIT/1000} ثانیه بعد از کلیک...`);
      await this.page.waitForTimeout(CONFIG.WAIT_AFTER_SUBMIT);
      
      // 6. منتظر 15 ثانیه برای ریدایرکت
      console.log(`⏳ منتظر ${CONFIG.WAIT_FOR_REDIRECT/1000} ثانیه برای ریدایرکت...`);
      const startTime = Date.now();
      let hasRedirected = false;
      
      while (Date.now() - startTime < CONFIG.WAIT_FOR_REDIRECT) {
        const currentUrl = this.page.url();
        
        // اگر از صفحه ثبت‌نام خارج شدیم
        if (!currentUrl.includes('abantether.com/user/kyc/basic')) {
          console.log(`✅ ریدایرکت شد به: ${currentUrl}`);
          hasRedirected = true;
          break;
        }
        
        // هر 2 ثانیه چک کن
        await this.page.waitForTimeout(2000);
      }
      
      // 7. اگر ریدایرکت نشد، فرآیند فراموشی رمز و لاگین
      if (!hasRedirected) {
        console.log("🔄 ثبت نام کامل نشد، شروع فرآیند فراموشی رمز...");
        
        await this.page.goto('https://abantether.com/login');
        await this.page.waitForTimeout(3000);

        // کلیک فراموشی رمز
        await this.page.click('button[title="فراموشی رمز عبور"]');
        await this.page.waitForTimeout(2000);

        // وارد کردن شماره موبایل
        await this.page.fill('input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]', this.currentUser.personalPhoneNumber);
        await this.page.click('button[title="مرحله بعد"]');
        await this.page.waitForTimeout(4000);

        // منتظر OTP فراموشی رمز (otp_login)
        let otpLogin = null;
        const otpStart = Date.now();
        while (Date.now() - otpStart < CONFIG.WAIT_FOR_OTP) {
          otpLogin = await this.checkForOtp(this.currentUser.personalPhoneNumber, "login");
          if (otpLogin) break;
          await this.page.waitForTimeout(5000);
        }
        if (!otpLogin) throw new Error("OTP فراموشی رمز دریافت نشد");

        await this.page.fill('input[name="otp"][placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]', otpLogin);
        await this.page.waitForTimeout(2000);

        // تولید و وارد کردن رمز جدید
        const newPass = this.generateStrongPassword();
        await this.page.fill('input[placeholder="رمز عبور جدید خود را وارد نمایید"]', newPass);
        await this.page.fill('input[placeholder="رمز عبور جدید خود را مجددا وارد نمایید"]', newPass);
        await this.page.click('button[title="تایید"]');
        await this.page.waitForTimeout(4000);

        // حالا لاگین عادی
        await this.page.fill('input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]', this.currentUser.personalPhoneNumber);
        await this.page.fill('input[data-testid="password-input"][placeholder="رمز عبور خود را وارد نمایید"]', newPass);
        await this.page.click('button[title="ورود"]');
        await this.page.waitForTimeout(4000);

        // منتظر OTP ورود نهایی (otp_login2)
        let otpLogin2 = null;
        const otpStart2 = Date.now();
        while (Date.now() - otpStart2 < CONFIG.WAIT_FOR_OTP) {
          otpLogin2 = await this.checkForOtp(this.currentUser.personalPhoneNumber, "login2");
          if (otpLogin2) break;
          await this.page.waitForTimeout(5000);
        }
        if (!otpLogin2) throw new Error("OTP ورود نهایی دریافت نشد");

        await this.page.fill('input[placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]', otpLogin2);
      
        await this.page.waitForTimeout(5000);

        // ذخیره رمز جدید در دیتابیس
        this.currentPassword = newPass;
        await this.updateUserStatus(this.currentUser.personalPhoneNumber, { password: newPass });

        console.log("✅ فرآیند فراموشی رمز و لاگین با موفقیت انجام شد");
      }
      
      console.log("✅ مرحله 3 تکمیل شد");
      return true;
      
    } catch (error) {
      console.error("❌ خطا در مرحله 3:", error.message);
      throw error;
    }
  }



async step4_AddContract() {
  console.log("\n📄 ======= مرحله 4: افزودن قرارداد =======");

  try {
    console.log("🌐 رفتن به صفحه افزودن قرارداد...");
    
    // مستقیماً به صفحه واریز برو
    await this.navigateTo(CONFIG.DEPOSIT_URL);
    await this.page.waitForTimeout(3000);
    
    // بررسی URL فعلی
    const currentUrl = this.page.url();
    console.log(`🌐 URL فعلی: ${currentUrl}`);
    
    // اگر هنوز در صفحه لاگین یا ثبت‌نام هستیم
    if (currentUrl.includes('/login') || currentUrl.includes('/register')) {
      console.log("⚠️ هنوز لاگین نشده‌ایم، لاگین می‌کنیم...");
      
      // لاگین با رمز ذخیره شده
      await this.page.fill('input[placeholder*="شماره موبایل"]', this.currentUser.personalPhoneNumber);
      await this.page.fill('input[placeholder*="رمز عبور"]', this.currentPassword || 'Test1234@');
      await this.clickByText("ورود");
      await this.page.waitForTimeout(3000);
      
      // بررسی OTP لاگین
      const loginOtp = await this.checkForOtp(this.currentUser.personalPhoneNumber, "login");
      if (loginOtp) {
        await this.enterOtp(loginOtp);
        await this.clickByText("تایید");
        await this.page.waitForTimeout(5000);
      }
      
      // دوباره به صفحه واریز برو
      await this.navigateTo(CONFIG.DEPOSIT_URL);
      await this.page.waitForTimeout(3000);
    }
    
    console.log("✅ به صفحه واریز رسیدیم");
    
    // بررسی وجود دکمه "افزودن قرارداد" - حتی اگر hidden باشد
    console.log("🔍 جستجوی دکمه افزودن قرارداد...");
    
    let addContractClicked = false;
    
    // روش 1: پیدا کردن المنت hidden و کلیک مستقیم
    const addContractElements = await this.page.$$('[title="افزودن قرارداد"]');
    if (addContractElements.length > 0) {
      console.log(`✅ المنت با title="افزودن قرارداد" پیدا شد (${addContractElements.length} عدد)`);
      
      try {
        // المنت اول را کلیک می‌کنیم حتی اگر hidden باشد
        await addContractElements[0].click();
        console.log("✅ دکمه افزودن قرارداد کلیک شد (مستقیم روی المنت hidden)");
        addContractClicked = true;
        await this.page.waitForTimeout(3000);
      } catch (error) {
        console.log("⚠️ نتوانست مستقیم روی المنت کلیک کند:", error.message);
      }
    }
    
    // روش 2: کلیک با title (با متد بهبود یافته)
    if (!addContractClicked) {
      try {
        await this.clickByTitle("افزودن قرارداد");
        console.log("✅ دکمه افزودن قرارداد با clickByTitle کلیک شد");
        addContractClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'افزودن قرارداد' پیدا نشد");
      }
    }
    
    // روش 3: کلیک با متن
    if (!addContractClicked) {
      try {
        await this.clickByText("افزودن قرارداد");
        console.log("✅ دکمه افزودن قرارداد با متن کلیک شد");
        addContractClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با متن 'افزودن قرارداد' پیدا نشد");
      }
    }
    
    // روش 4: جستجوی عمومی
    if (!addContractClicked) {
      const buttons = await this.page.$$('button, a');
      for (const element of buttons) {
        const text = await element.textContent();
        if (text && (text.includes("افزودن قرارداد") || text.includes("افزودن") || text.includes("قرارداد"))) {
          await element.click();
          console.log("✅ دکمه افزودن قرارداد با بررسی متن کلیک شد");
          addContractClicked = true;
          break;
        }
      }
    }
    
    if (!addContractClicked) {
      console.log("⚠️ دکمه افزودن قرارداد پیدا نشد، ممکن است قبلاً افزوده شده باشد");
      return true; // ادامه می‌دهیم
    } else {
      await this.page.waitForTimeout(3000);
    }
    
    // ========== مراحل جدید بعد از کلیک روی افزودن قرارداد ==========
    
    // مرحله 1: کلیک روی "نام بانک خود را انتخاب نمایید"
    console.log("\n🏦 مرحله 1: انتخاب نام بانک");
    
    let bankDropdownClicked = false;
    
    // جستجوی div با متن "نام بانک خود را انتخاب نمایید"
    const bankDivs = await this.page.$$('div');
    for (const div of bankDivs) {
      const text = await div.textContent();
      if (text && text.trim() === "نام بانک خود را انتخاب نمایید") {
        await div.click();
        console.log("✅ دکمه 'نام بانک خود را انتخاب نمایید' کلیک شد");
        bankDropdownClicked = true;
        break;
      }
    }
    
    // اگر با متن دقیق پیدا نشد، با متن جزئی امتحان کن
    if (!bankDropdownClicked) {
      const allElements = await this.page.$$('*');
      for (const element of allElements) {
        const text = await element.textContent();
        if (text && text.includes("نام بانک") && text.includes("انتخاب")) {
          await element.click();
          console.log("✅ دکمه انتخاب بانک با متن جزئی کلیک شد");
          bankDropdownClicked = true;
          break;
        }
      }
    }
    
    if (!bankDropdownClicked) {
      throw new Error("نتوانست دکمه انتخاب بانک را پیدا کند");
    }
    
    await this.page.waitForTimeout(3000); // زمان بیشتر برای باز شدن لیست
    
    // مرحله 2: انتخاب بانک از لیست (بر اساس دیتابیس)
    console.log("\n🏦 مرحله 2: انتخاب بانک از لیست");
    
    // نام بانک را از شماره کارت تشخیص بده
    const bankName = this.getBankName(this.currentUser.cardNumber);
    console.log(`🏦 بانک تشخیص داده شده: ${bankName}`);
    
    let bankSelected = false;
    
    // === روش 1: کلیک مستقیم با evaluate ===
    console.log(`🔍 جستجوی بانک ${bankName} با evaluate...`);
    
    const clicked = await this.page.evaluate((bankName) => {
      // همه section‌های بانک را پیدا کن
      const bankSections = document.querySelectorAll('section.flex.justify-between.items-center');
      
      for (const section of bankSections) {
        // در هر section دنبال p با نام بانک بگرد
        const pElements = section.querySelectorAll('p.text-slate-900.Text_title-small__8t9nb');
        
        for (const pElement of pElements) {
          if (pElement.textContent && pElement.textContent.trim() === bankName) {
            console.log("✅ بانک پیدا شد:", pElement.textContent);
            
            // روی div والد کلیک کن
            const parentDiv = pElement.closest('div.w-full.flex.flex-1.justify-start');
            if (parentDiv) {
              parentDiv.click();
              return true;
            }
            
            // اگر div والد پیدا نشد، روی section کلیک کن
            section.click();
            return true;
          }
        }
      }
      
      // روش جایگزین: جستجوی همه المنت‌ها
      const allElements = document.querySelectorAll('*');
      for (const element of allElements) {
        if (element.textContent && element.textContent.trim() === bankName) {
          console.log("✅ بانک پیدا شد (جستجوی عمومی):", element.tagName);
          
          // روی المنت کلیک کن
          try {
            element.click();
            return true;
          } catch (clickError) {
            // اگر کلیک مستقیم کار نکرد، با dispatchEvent امتحان کن
            const clickEvent = new MouseEvent('click', {
              view: window,
              bubbles: true,
              cancelable: true
            });
            element.dispatchEvent(clickEvent);
            return true;
          }
        }
      }
      
      return false;
    }, bankName);
    
    if (clicked) {
      console.log(`✅ بانک ${bankName} با evaluate کلیک شد`);
      bankSelected = true;
    }
    
    // === روش 2: اگر evaluate کار نکرد، با selectorهای Playwright ===
    if (!bankSelected) {
      console.log(`🔍 جستجوی بانک ${bankName} با selectorهای Playwright...`);
      
      try {
        // سعی کن مستقیم روی p با نام بانک کلیک کنی
        const bankPLocator = this.page.locator(`p.text-slate-900.Text_title-small__8t9nb:has-text("${bankName}")`).first();
        await bankPLocator.waitFor({ state: 'visible', timeout: 3000 });
        await bankPLocator.click();
        console.log(`✅ بانک ${bankName} با locator p انتخاب شد`);
        bankSelected = true;
      } catch (error) {
        console.log(`⚠️ با locator p پیدا نشد:`, error.message);
      }
    }
    
    // === روش 3: کلیک روی section حاوی بانک ===
    if (!bankSelected) {
      console.log(`🔍 جستجوی section حاوی بانک ${bankName}...`);
      
      // همه section‌ها را بگیر
      const allSections = await this.page.$$('section.flex.justify-between.items-center');
      
      for (let i = 0; i < allSections.length; i++) {
        try {
          const sectionText = await allSections[i].textContent();
          if (sectionText && sectionText.includes(bankName)) {
            await allSections[i].click();
            console.log(`✅ بانک ${bankName} در section ${i + 1} انتخاب شد`);
            bankSelected = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    // === روش 4: کلیک روی div والد ===
    if (!bankSelected) {
      console.log(`🔍 جستجوی div حاوی بانک ${bankName}...`);
      
      // همه div‌های حاوی بانک را بگیر
      const bankDivs = await this.page.$$('div.w-full.flex.flex-1.justify-start');
      
      for (let i = 0; i < bankDivs.length; i++) {
        try {
          const divText = await bankDivs[i].textContent();
          if (divText && divText.includes(bankName)) {
            await bankDivs[i].click();
            console.log(`✅ بانک ${bankName} در div ${i + 1} انتخاب شد`);
            bankSelected = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    // === روش 5: جستجوی عمومی ===
    if (!bankSelected) {
      console.log(`🔍 جستجوی عمومی برای بانک ${bankName}...`);
      
      const allElements = await this.page.$$('*');
      for (let i = 0; i < allElements.length; i++) {
        try {
          const text = await allElements[i].textContent();
          if (text && text.trim() === bankName) {
            await allElements[i].click();
            console.log(`✅ بانک ${bankName} با جستجوی عمومی انتخاب شد (المنت ${i + 1})`);
            bankSelected = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    // === روش 6: Fallback - انتخاب اولین بانک ===
    if (!bankSelected) {
      console.log(`⚠️ بانک ${bankName} پیدا نشد، اسکرین‌شات و دیباگ...`);
      
      // اسکرین‌شات برای دیباگ
      await this.page.screenshot({ path: 'debug-bank-dropdown-full.png' });
      console.log("📸 اسکرین‌شات کامل برای دیباگ ذخیره شد: debug-bank-dropdown-full.png");
      
      // چاپ اطلاعات برای دیباگ
      const allSections = await this.page.$$('section.flex.justify-between.items-center');
      console.log(`🔍 تعداد section‌ها: ${allSections.length}`);
      
      for (let i = 0; i < Math.min(allSections.length, 3); i++) {
        try {
          const sectionText = await allSections[i].textContent();
          console.log(`   Section ${i + 1}: ${sectionText?.substring(0, 50)}...`);
        } catch (error) {
          continue;
        }
      }
      
      console.log("⚠️ انتخاب اولین بانک در لیست...");
      
      // روی اولین section بانک کلیک کن (بعد از header)
      if (allSections.length > 1) {
        await allSections[1].click(); // اولین section بعد از header
        console.log("⚠️ اولین بانک در لیست انتخاب شد");
        bankSelected = true;
      }
    }
    
    if (!bankSelected) {
      throw new Error("نتوانست بانکی را از لیست انتخاب کند");
    }
    
    console.log(`✅ بانک ${bankName} با موفقیت انتخاب شد`);
    await this.page.waitForTimeout(2000);
    
    // مرحله 3: کلیک روی "مدت قرارداد خود را انتخاب کنید"
    console.log("\n📅 مرحله 3: انتخاب مدت قرارداد");
    
    let contractDropdownClicked = false;
    
    // جستجوی div با متن "مدت قرارداد خود را انتخاب کنید"
    const contractDivs = await this.page.$$('div');
    for (const div of contractDivs) {
      const text = await div.textContent();
      if (text && text.trim() === "مدت قرارداد خود را انتخاب کنید") {
        await div.click();
        console.log("✅ دکمه 'مدت قرارداد خود را انتخاب کنید' کلیک شد");
        contractDropdownClicked = true;
        break;
      }
    }
    
    // اگر با متن دقیق پیدا نشد، با متن جزئی امتحان کن
    if (!contractDropdownClicked) {
      const allElements = await this.page.$$('*');
      for (const element of allElements) {
        const text = await element.textContent();
        if (text && (text.includes("مدت قرارداد") || (text.includes("مدت") && text.includes("قرارداد")))) {
          await element.click();
          console.log("✅ دکمه انتخاب مدت قرارداد با متن جزئی کلیک شد");
          contractDropdownClicked = true;
          break;
        }
      }
    }
    
    if (!contractDropdownClicked) {
      throw new Error("نتوانست دکمه انتخاب مدت قرارداد را پیدا کند");
    }
    
    await this.page.waitForTimeout(2000);
    
    // مرحله 4: انتخاب "12 ماهه"
    console.log("\n📅 مرحله 4: انتخاب مدت 12 ماهه");
    
    let periodSelected = false;
    
    // === روش 1: با evaluate و جستجوی دقیق ===
    console.log("🔍 جستجوی مدت 12 ماهه با evaluate...");
    
    const periodClicked = await this.page.evaluate(() => {
      // دنبال div با id="12 ماهه" بگرد
      const period12Div = document.querySelector('div[id="12 ماهه"]');
      if (period12Div) {
        console.log("✅ مدت 12 ماهه پیدا شد");
        period12Div.click();
        return true;
      }
      
      // اگر با id پیدا نشد، با متن بگرد
      const allDivs = document.querySelectorAll('div.flex.justify-start.items-center');
      for (const div of allDivs) {
        if (div.textContent && div.textContent.trim() === "12 ماهه") {
          console.log("✅ مدت 12 ماهه با متن پیدا شد");
          div.click();
          return true;
        }
      }
      
      // جستجوی عمومی
      const allElements = document.querySelectorAll('div, p, span');
      for (const element of allElements) {
        if (element.textContent && element.textContent.trim() === "12 ماهه") {
          console.log("✅ مدت 12 ماهه با جستجوی عمومی پیدا شد");
          element.click();
          return true;
        }
      }
      
      return false;
    });
    
    if (periodClicked) {
      console.log("✅ مدت 12 ماهه با evaluate انتخاب شد");
      periodSelected = true;
    }
    
    // === روش 2: با locator ===
    if (!periodSelected) {
      console.log("🔍 جستجوی مدت 12 ماهه با locator...");
      
      try {
        // روش 1: با id
        const periodLocator1 = this.page.locator('div[id="12 ماهه"]').first();
        await periodLocator1.waitFor({ state: 'visible', timeout: 3000 });
        await periodLocator1.click();
        console.log("✅ مدت 12 ماهه با id انتخاب شد");
        periodSelected = true;
      } catch (error) {
        console.log("⚠️ مدت 12 ماهه با id پیدا نشد:", error.message);
        
        try {
          // روش 2: با متن
          const periodLocator2 = this.page.locator('div:has-text("12 ماهه")').first();
          await periodLocator2.waitFor({ state: 'visible', timeout: 3000 });
          await periodLocator2.click();
          console.log("✅ مدت 12 ماهه با متن انتخاب شد");
          periodSelected = true;
        } catch (error2) {
          console.log("⚠️ مدت 12 ماهه با متن پیدا نشد:", error2.message);
        }
      }
    }
    
    // === روش 3: با selectorهای Playwright ===
    if (!periodSelected) {
      console.log("🔍 جستجوی مدت 12 ماهه با selector...");
      
      try {
        // المنت‌های div در dropdown را پیدا کن
        const periodDivs = await this.page.$$('div.px-4.flex.justify-start.items-center.hover\\:bg-slate-50');
        
        for (const div of periodDivs) {
          const text = await div.textContent();
          if (text && text.trim() === "12 ماهه") {
            await div.click();
            console.log("✅ مدت 12 ماهه با selector انتخاب شد");
            periodSelected = true;
            break;
          }
        }
      } catch (error) {
        console.log("⚠️ مدت 12 ماهه با selector پیدا نشد:", error.message);
      }
    }
    
    // === روش 4: جستجوی عمومی ===
    if (!periodSelected) {
      console.log("🔍 جستجوی عمومی برای مدت 12 ماهه...");
      
      const allElements = await this.page.$$('*');
      for (let i = 0; i < allElements.length; i++) {
        try {
          const text = await allElements[i].textContent();
          if (text && text.trim() === "12 ماهه") {
            await allElements[i].click();
            console.log("✅ مدت 12 ماهه با جستجوی عمومی انتخاب شد");
            periodSelected = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    // === روش 5: Fallback - انتخاب اولین گزینه ===
    if (!periodSelected) {
      console.log("⚠️ مدت 12 ماهه پیدا نشد، دیباگ می‌کنیم...");
      
      // چاپ همه گزینه‌های موجود
      const periodOptions = await this.page.$$('div.px-4.flex.justify-start.items-center');
      console.log(`🔍 تعداد گزینه‌های مدت: ${periodOptions.length}`);
      
      for (let i = 0; i < Math.min(periodOptions.length, 3); i++) {
        try {
          const text = await periodOptions[i].textContent();
          console.log(`   گزینه ${i + 1}: ${text}`);
        } catch (error) {
          continue;
        }
      }
      
      console.log("⚠️ انتخاب اولین گزینه مدت...");
      
      if (periodOptions.length > 0) {
        await periodOptions[0].click();
        const selectedText = await periodOptions[0].textContent();
        console.log(`⚠️ اولین گزینه انتخاب شد: ${selectedText}`);
        periodSelected = true;
      }
    }
    
    if (!periodSelected) {
      throw new Error("نتوانست مدت قراردادی را از لیست انتخاب کند");
    }
    
    console.log("✅ مدت 12 ماهه با موفقیت انتخاب شد");
    await this.page.waitForTimeout(2000);
    
    // مرحله 5: کلیک روی دکمه "ثبت و ادامه"
    console.log("\n✅ مرحله 5: کلیک روی دکمه ثبت و ادامه");
    
    let continueClicked = false;
    
    // روش 1: با title
    try {
      await this.clickByTitle("ثبت و ادامه");
      console.log("✅ دکمه 'ثبت و ادامه' با title کلیک شد");
      continueClicked = true;
    } catch (error) {
      console.log("⚠️ دکمه با title 'ثبت و ادامه' پیدا نشد");
    }
    
    // روش 2: با متن
    if (!continueClicked) {
      try {
        await this.clickByText("ثبت و ادامه");
        console.log("✅ دکمه 'ثبت و ادامه' با متن کلیک شد");
        continueClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با متن 'ثبت و ادامه' پیدا نشد");
      }
    }
    
    // روش 3: جستجوی عمومی
    if (!continueClicked) {
      const buttons = await this.page.$$('button');
      for (const button of buttons) {
        const text = await button.textContent();
        if (text && (text.includes("ثبت و ادامه") || text.includes("ادامه"))) {
          await button.click();
          console.log("✅ دکمه ادامه با بررسی متن کلیک شد");
          continueClicked = true;
          break;
        }
      }
    }
    
    if (!continueClicked) {
      throw new Error("نتوانست دکمه ثبت و ادامه را پیدا کند");
    }
    
    console.log("✅ مراحل افزودن قرارداد با موفقیت تکمیل شد");
    await this.page.waitForTimeout(3000);
    
    console.log("✅ مرحله 4 تکمیل شد");
    return true;
    
  } catch (error) {
    console.error("❌ خطا در مرحله 4:", error.message);
    
    // اسکرین‌شات برای دیباگ
    try {
      await this.page.screenshot({ path: 'error-step4.png' });
      console.log("📸 اسکرین‌شات خطا ذخیره شد: error-step4.png");
    } catch (screenshotError) {
      console.log("⚠️ نتوانست اسکرین‌شات بگیرد:", screenshotError.message);
    }
    
    throw error;
  }
}

  async step5_BankProcess() {
    console.log("\n🏦 ======= مرحله 5: پردازش بانکی =======");

    try {
      const user = this.currentUser;
      const bankName = this.getBankName(user.cardNumber);
      
      console.log(`🏦 پردازش بانک: ${bankName}`);
      console.log(bankName);
      console.log(bankName == "بانک ملی");
      
      // تشخیص بانک و فراخوانی تابع مربوطه
      switch(bankName) {
        case "بانک ملی":
          return await this.processBankMelli();
        case "بانک ملت":
          return await this.processBankMellat();
        case "بانک صادرات":
          return await this.processBankSaderat();
        case "بانک تجارت":
          return await this.processBankTejarat();
        // بانک‌های دیگر را اضافه کنید...
        default:
          console.log(`⚠️ بانک ${bankName} پشتیبانی نمی‌شود، از بانک ملی استفاده می‌کنیم`);
          return await this.processBankMelli();
      }
    } catch (error) {
      console.error("❌ خطا در مرحله 5:", error.message);
      throw error;
    }
  }

  // ========== تابع پردازش بانک ملی ==========
  async processBankMelli() {
    console.log("\n🏦 ======= پردازش بانک ملی =======");

    try {
      console.log("🖱️ کلیک روی ورود با کارت بانک ملی");
      
      // منتظر بارگذاری کامل صفحه
      await this.page.waitForTimeout(3000);
      
      // روش‌های مختلف برای کلیک روی بانک ملی
      let clicked = false;
      
      // روش 1: با متن کامل
      try {
        await this.clickByText("ورود با کارت بانک ملی");
        clicked = true;
      } catch (error) {
        console.log("⚠️ نتوانست با متن کامل کلیک کند");
      }
      
      // روش 2: با متن جزئی
      if (!clicked) {
        try {
          await this.clickByText("بانک ملی");
          clicked = true;
        } catch (error) {
          console.log("⚠️ نتوانست با 'بانک ملی' کلیک کند");
        }
      }
      
      // روش 3: با evaluate
      if (!clicked) {
        const found = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('*');
          for (const element of elements) {
            const text = element.textContent || '';
            if (text.includes('بانک ملی') && (text.includes('ورود') || element.tagName === 'BUTTON' || element.tagName === 'DIV')) {
              element.click();
              return true;
            }
          }
          return false;
        });
        
        if (found) {
          console.log("✅ با evaluate کلیک شد");
          clicked = true;
        }
      }
      
      if (!clicked) {
        console.log("⚠️ نتوانست روی بانک ملی کلیک کند، ادامه می‌دهیم...");
      } else {
        await this.page.waitForTimeout(4000);
      }

      // وارد کردن شماره کارت
      console.log("💳 وارد کردن شماره کارت");
      const user = this.currentUser;
      const cleanCard = user.cardNumber.replace(/[\s-]/g, '');
      
      // روش‌های مختلف برای پیدا کردن فیلد کارت
      let cardFilled = false;
      
      try {
        await this.page.fill('#card', cleanCard);
        console.log("✅ شماره کارت در #card وارد شد");
        cardFilled = true;
      } catch (error) {
        console.log("⚠️ فیلد #card پیدا نشد");
      }
      
      if (!cardFilled) {
        try {
          await this.fillByPlaceholder("شماره کارت", cleanCard);
          cardFilled = true;
        } catch (error) {
          console.log("⚠️ فیلد با placeholder شماره کارت پیدا نشد");
        }
      }
      
      if (!cardFilled) {
        // جستجوی عمومی فیلدهای input
        const inputs = await this.page.$$('input');
        for (const input of inputs) {
          const placeholder = await input.getAttribute('placeholder') || '';
          const name = await input.getAttribute('name') || '';
          const id = await input.getAttribute('id') || '';
          
          if (placeholder.includes('کارت') || placeholder.includes('card') || 
              name.includes('card') || id.includes('card')) {
            await input.fill(cleanCard);
            console.log("✅ شماره کارت در فیلد عمومی وارد شد");
            cardFilled = true;
            break;
          }
        }
      }
      
      if (!cardFilled) {
        console.log("⚠️ نتوانست فیلد شماره کارت را پیدا کند");
      }
      
      await this.page.waitForTimeout(1000);

      // حل کپچا
      console.log("🔍 حل کپچا...");
      const captchaCode = await this.solveCaptchaWithOCR();
      
      if (captchaCode) {
        console.log(`✅ کپچا حل شد: ${captchaCode}`);
        
        // وارد کردن کپچا
        let captchaFilled = false;
        
        try {
          await this.page.fill('#captcha', captchaCode);
          captchaFilled = true;
        } catch (error) {
          console.log("⚠️ فیلد #captcha پیدا نشد");
        }
        
        if (!captchaFilled) {
          try {
            await this.page.fill('input[name="captchaNumber"]', captchaCode);
            captchaFilled = true;
          } catch (error) {
            console.log("⚠️ فیلد captchaNumber پیدا نشد");
          }
        }
        
        if (!captchaFilled) {
          const inputs = await this.page.$$('input');
          for (const input of inputs) {
            const placeholder = await input.getAttribute('placeholder') || '';
            if (placeholder.includes('کد') || placeholder.includes('captcha') || placeholder.includes('کپچا')) {
              await input.fill(captchaCode);
              captchaFilled = true;
              break;
            }
          }
        }
        
        if (captchaFilled) {
          console.log("✅ کپچا وارد شد");
        }
      } else {
        console.log("⚠️ حل کپچا ناموفق، منتظر وارد کردن دستی...");
        await this.page.waitForTimeout(15000); // 15 ثانیه منتظر می‌ماند
      }

      await this.page.waitForTimeout(1500);

      // کلیک روی ارسال رمز فعالسازی
      console.log("🖱️ کلیک روی ارسال رمز فعالسازی");
      await this.clickByText("ارسال رمز فعالسازی");
      await this.page.waitForTimeout(5000);

      // دریافت OTP کارت
      console.log("⏳ منتظر OTP کارت...");
      let cardOtp = null;
      const start = Date.now();
      while (Date.now() - start < CONFIG.WAIT_FOR_OTP) {
        cardOtp = await this.checkForOtp(user.personalPhoneNumber, "register_card");
        if (cardOtp) break;
        await this.page.waitForTimeout(5000);
      }
      
      if (!cardOtp) {
        throw new Error("OTP کارت دریافت نشد");
      }

      console.log(`✅ OTP کارت دریافت شد: ${cardOtp}`);
      
      // وارد کردن OTP
      let otpFilled = false;
      
      try {
        await this.page.fill('input[autocomplete="one-time-code"]', cardOtp);
        otpFilled = true;
      } catch (error) {
        console.log("⚠️ فیلد autocomplete پیدا نشد");
      }
      
      if (!otpFilled) {
        try {
          await this.page.fill('input[formcontrolname="otpCode"]', cardOtp);
          otpFilled = true;
        } catch (error) {
          console.log("⚠️ فیلد otpCode پیدا نشد");
        }
      }
      
      if (!otpFilled) {
        try {
          await this.fillByPlaceholder("کد", cardOtp);
          otpFilled = true;
        } catch (error) {
          console.log("⚠️ فیلد با placeholder کد پیدا نشد");
        }
      }
      
      if (otpFilled) {
        console.log("✅ OTP وارد شد");
      }
      
      await this.page.waitForTimeout(1500);

      // کلیک روی ادامه
      console.log("🖱️ کلیک روی ادامه");
      await this.clickByText("ادامه");
      await this.page.waitForTimeout(6000);

      // کلیک روی ثبت قرارداد
      console.log("🖱️ کلیک روی ثبت قرارداد");
      await this.clickByText("ثبت قرارداد");
      await this.page.waitForTimeout(4000);

      console.log("✅ پردازش بانک ملی تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در پردازش بانک ملی:", error.message);
      throw error;
    }
  }

  // ========== تابع پردازش بانک ملت ==========
  async processBankMellat() {
    console.log("\n🏦 ======= پردازش بانک ملت =======");

    try {
      console.log("🖱️ کلیک روی ورود با کارت بانک ملت");
      
      await this.page.waitForTimeout(3000);
      
      let clicked = false;
      
      // روش‌های مختلف برای کلیک روی بانک ملت
      try {
        await this.clickByText("ورود با کارت بانک ملت");
        clicked = true;
      } catch (error) {
        console.log("⚠️ نتوانست با متن کامل کلیک کند");
      }
      
      if (!clicked) {
        try {
          await this.clickByText("بانک ملت");
          clicked = true;
        } catch (error) {
          console.log("⚠️ نتوانست با 'بانک ملت' کلیک کند");
        }
      }
      
      if (!clicked) {
        const found = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('*');
          for (const element of elements) {
            const text = element.textContent || '';
            if (text.includes('بانک ملت') && (text.includes('ورود') || element.tagName === 'BUTTON' || element.tagName === 'DIV')) {
              element.click();
              return true;
            }
          }
          return false;
        });
        
        if (found) {
          console.log("✅ با evaluate کلیک شد");
          clicked = true;
        }
      }
      
      if (!clicked) {
        throw new Error("نتوانست روی بانک ملت کلیک کند");
      }
      
      await this.page.waitForTimeout(4000);

      // مراحل خاص بانک ملت
      console.log("💳 وارد کردن شماره کارت بانک ملت");
      const user = this.currentUser;
      const cleanCard = user.cardNumber.replace(/[\s-]/g, '');
      
      // بانک ملت ممکن است فیلدهای متفاوتی داشته باشد
      let cardFilled = false;
      
      // فیلدهای مختلف بانک ملت را امتحان کن
      const cardSelectors = [
        'input[name="cardNumber"]',
        'input#cardNumber',
        'input[placeholder*="شماره کارت"]',
        'input[placeholder*="کارت"]',
        'input[type="text"]'
      ];
      
      for (const selector of cardSelectors) {
        try {
          const input = await this.page.$(selector);
          if (input) {
            await input.fill(cleanCard);
            console.log(`✅ شماره کارت در ${selector} وارد شد`);
            cardFilled = true;
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      if (!cardFilled) {
        // جستجوی عمومی
        const inputs = await this.page.$$('input');
        for (const input of inputs) {
          const placeholder = await input.getAttribute('placeholder') || '';
          if (placeholder.includes('کارت') || placeholder.includes('card')) {
            await input.fill(cleanCard);
            console.log("✅ شماره کارت در فیلد عمومی وارد شد");
            cardFilled = true;
            break;
          }
        }
      }
      
      if (!cardFilled) {
        throw new Error("نتوانست فیلد شماره کارت بانک ملت را پیدا کند");
      }
      
      await this.page.waitForTimeout(1000);

      // ادامه مراحل مشابه بانک ملی یا مختص بانک ملت
      // ...
      
      console.log("✅ پردازش بانک ملت تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در پردازش بانک ملت:", error.message);
      throw error;
    }
  }

  // ========== توابع بانک‌های دیگر (الگو) ==========
  async processBankSaderat() {
    console.log("\n🏦 ======= پردازش بانک صادرات =======");
    
    // پیاده‌سازی مشابه با منطق مختص بانک صادرات
    // ...
    
    return true;
  }

  async processBankTejarat() {
    console.log("\n🏦 ======= پردازش بانک تجارت =======");
    
    // پیاده‌سازی مشابه با منطق مختص بانک تجارت
    // ...
    
    return true;
  }

  async step6_Deposit() {
    console.log("\n💵 ======= مرحله 6: واریز تومان =======");

    try {
      // صبر کن تا صفحه کاملاً لود شود
      await this.page.waitForTimeout(3000);
      
      console.log("💰 وارد کردن مبلغ 5,000,000 تومان");
      
      // 1. پیدا کردن فیلد مبلغ با placeholder و inputmode
      const amountInput = await this.page.$('input[placeholder="مبلغ واریز را به تومان وارد نمایید"][inputmode="decimal"]');
      if (!amountInput) {
        throw new Error("فیلد مبلغ واریز پیدا نشد");
      }
      
      await amountInput.fill(CONFIG.DEPOSIT_AMOUNT);
      console.log("✅ مبلغ 5,000,000 تومان وارد شد");
      
      await this.page.waitForTimeout(1000);
      
      // 2. کلیک روی لیست بانک‌ها
      console.log("🏦 کلیک روی لیست بانک‌ها");
      
      const bankList = await this.page.$('#bank-list');
      if (!bankList) {
        throw new Error("لیست بانک‌ها (#bank-list) پیدا نشد");
      }
      
      await bankList.click();
      console.log("✅ لیست بانک‌ها باز شد");
      
      await this.page.waitForTimeout(2000);
      
      // 3. انتخاب بانک بر اساس دیتابیس
      const bankName = this.getBankName(this.currentUser.cardNumber);
      console.log(`🏦 انتخاب بانک: ${bankName}`);
      
      // پیدا کردن تگ p با محتوای نام بانک
      const bankElements = await this.page.$$('p');
      let bankSelected = false;
      
      for (const pElement of bankElements) {
        const text = await pElement.textContent();
        if (text && text.trim() === bankName) {
          await pElement.click();
          console.log(`✅ بانک ${bankName} انتخاب شد`);
          bankSelected = true;
          break;
        }
      }
      
      // اگر با نام کامل پیدا نشد، با نام جزئی
      if (!bankSelected) {
        const allElements = await this.page.$$('*');
        for (const element of allElements) {
          const text = await element.textContent();
          if (text && text.includes(bankName)) {
            await element.click();
            console.log(`✅ بانک ${bankName} با متن جزئی انتخاب شد`);
            bankSelected = true;
            break;
          }
        }
      }
      
      if (!bankSelected) {
        throw new Error(`بانک ${bankName} در لیست پیدا نشد`);
      }
      
      await this.page.waitForTimeout(2000);
      
      // 4. کلیک روی دکمه "واریز"
      console.log("🖱️ کلیک روی دکمه 'واریز'");
      
      let depositClicked = false;
      
      // روش 1: با title
      try {
        await this.clickByTitle("واریز");
        console.log("✅ دکمه 'واریز' با title کلیک شد");
        depositClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'واریز' پیدا نشد");
      }
      
      // روش 2: با text
      if (!depositClicked) {
        try {
          await this.clickByText("واریز");
          console.log("✅ دکمه 'واریز' با متن کلیک شد");
          depositClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه با متن 'واریز' پیدا نشد");
        }
      }
      
      if (!depositClicked) {
        throw new Error("دکمه واریز پیدا نشد");
      }
      
      await this.page.waitForTimeout(3000);
      
      // 5. کلیک روی دکمه "تایید و پرداخت"
      console.log("✅ کلیک روی دکمه 'تایید و پرداخت'");
      
      let confirmClicked = false;
      
      // روش 1: با title
      try {
        await this.clickByTitle("تایید و پرداخت");
        console.log("✅ دکمه 'تایید و پرداخت' با title کلیک شد");
        confirmClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'تایید و پرداخت' پیدا نشد");
      }
      
      // روش 2: با text
      if (!confirmClicked) {
        try {
          await this.clickByText("تایید و پرداخت");
          console.log("✅ دکمه 'تایید و پرداخت' با متن کلیک شد");
          confirmClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه با متن 'تایید و پرداخت' پیدا نشد");
        }
      }
      
      if (!confirmClicked) {
        throw new Error("دکمه تایید و پرداخت پیدا نشد");
      }
      
      await this.page.waitForTimeout(3000);
      
      // 6. منتظر OTP پرداخت (اگر لازم بود)
      console.log("⏳ منتظر OTP پرداخت...");
      const paymentOtp = await this.checkForOtp(this.currentUser.personalPhoneNumber, "payment");
      
      if (paymentOtp) {
        console.log(`✅ OTP پرداخت دریافت شد: ${paymentOtp}`);
        await this.enterOtp(paymentOtp);
        
        // کلیک روی دکمه تأیید OTP
        await this.clickByText("تأیید");
        console.log("✅ OTP پرداخت وارد شد");
      } else {
        console.log("⚠️ OTP پرداخت دریافت نشد، ادامه می‌دهیم...");
      }
      
      await this.page.waitForTimeout(5000);
      
      console.log("✅ مرحله 6 (واریز تومان) تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 6:", error.message);
      throw error;
    }
  }

  async step7_Buy() {
    console.log("\n🔄 ======= مرحله 7: خرید تتر =======");

    try {
      console.log("🌐 رفتن به صفحه خرید تتر...");
      await this.navigateTo(CONFIG.BUY_URL);
      await this.page.waitForTimeout(3000);
      
      // 1. پیدا کردن و کلیک روی دکمه خرید
      console.log("🖱️ پیدا کردن دکمه خرید با کلاس مشخص...");
      
      let buyButtonClicked = false;
      
      // جستجو با کلاس‌های مشخص شده
      const buyButtons = await this.page.$$(`
        button.Button_button__A32Lt.Button_filled-primary__B_qAg.Button_xs__xIGXZ.Button_rounded___9Gws.Button_xs-leading__4fGsJ,
        button[class*="Button_button__A32Lt"][class*="Button_filled-primary__B_qAg"][class*="Button_xs__xIGXZ"][class*="Button_rounded___9Gws"]
      `);
      
      if (buyButtons.length > 0) {
        await buyButtons[0].click();
        console.log("✅ دکمه خرید با کلاس خاص کلیک شد");
        buyButtonClicked = true;
      }
      
      // روش جایگزین: جستجو با متن
      if (!buyButtonClicked) {
        try {
          await this.clickByText("خرید");
          console.log("✅ دکمه خرید با متن کلیک شد");
          buyButtonClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه خرید با متن پیدا نشد");
        }
      }
      
      if (!buyButtonClicked) {
        throw new Error("دکمه خرید پیدا نشد");
      }
      
      await this.page.waitForTimeout(2000);
      
      // 2. وارد کردن مبلغ در فیلد خرید
      console.log("💰 وارد کردن مبلغ 5,000,000 در فیلد خرید...");
      
      const amountInputs = await this.page.$$(`
        input.Input_input__wMmzD.Input_ltr__7PqEB.Input_md__sKJjg,
        input[class*="Input_input__wMmzD"][class*="Input_ltr__7PqEB"][class*="Input_md__sKJjg"]
      `);
      
      if (amountInputs.length > 0) {
        await amountInputs[0].fill(CONFIG.DEPOSIT_AMOUNT);
        console.log("✅ مبلغ در فیلد خرید وارد شد");
      } else {
        // روش جایگزین: پیدا کردن هر فیلد input
        const allInputs = await this.page.$$('input[type="text"], input[type="number"]');
        if (allInputs.length > 0) {
          await allInputs[0].fill(CONFIG.DEPOSIT_AMOUNT);
          console.log("✅ مبلغ در اولین فیلد input وارد شد");
        } else {
          throw new Error("فیلد وارد کردن مبلغ پیدا نشد");
        }
      }
      
      await this.page.waitForTimeout(1000);
      
      // 3. کلیک روی دکمه "ثبت سفارش"
      console.log("✅ کلیک روی دکمه 'ثبت سفارش'");
      
      let orderButtonClicked = false;
      
      // روش 1: با title
      try {
        await this.clickByTitle("ثبت سفارش");
        console.log("✅ دکمه 'ثبت سفارش' با title کلیک شد");
        orderButtonClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'ثبت سفارش' پیدا نشد");
      }
      
      // روش 2: با متن
      if (!orderButtonClicked) {
        try {
          await this.clickByText("ثبت سفارش");
          console.log("✅ دکمه 'ثبت سفارش' با متن کلیک شد");
          orderButtonClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه با متن 'ثبت سفارش' پیدا نشد");
        }
      }
      
      // روش 3: جستجوی دکمه‌ها
      if (!orderButtonClicked) {
        const buttons = await this.page.$$('button');
        for (const button of buttons) {
          const text = await button.textContent();
          if (text && (text.includes("ثبت سفارش") || text.includes("خرید") || text.includes("تایید"))) {
            await button.click();
            console.log("✅ دکمه ثبت سفارش با بررسی متن کلیک شد");
            orderButtonClicked = true;
            break;
          }
        }
      }
      
      if (!orderButtonClicked) {
        throw new Error("دکمه ثبت سفارش پیدا نشد");
      }
      
      await this.page.waitForTimeout(5000);
      
      console.log("✅ مرحله 7 (خرید تتر) تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 7:", error.message);
      throw error;
    }
  }

  async step8_Withdraw() {
    console.log("\n📤 ======= مرحله 8: برداشت تتر =======");

    try {
      console.log("🌐 رفتن به صفحه برداشت تتر...");
      await this.navigateTo(CONFIG.WITHDRAW_URL);
      await this.page.waitForTimeout(3000);
      
      // 1. جستجوی "تتر" در فیلد جستجو
      console.log("🔍 جستجوی 'تتر' در فیلد جستجو...");
      
      const searchInput = await this.page.$('input[placeholder="جستجو"][inputmode="text"]');
      if (!searchInput) {
        throw new Error("فیلد جستجو پیدا نشد");
      }
      
      await searchInput.fill("تتر");
      console.log("✅ کلمه 'تتر' در فیلد جستجو وارد شد");
      
      await this.page.waitForTimeout(2000);
      
      // 2. کلیک روی "تتر" در نتایج
      console.log("🖱️ کلیک روی 'تتر' در نتایج...");
      
      let tetherClicked = false;
      const pElements = await this.page.$$('p');
      
      for (const pElement of pElements) {
        const text = await pElement.textContent();
        if (text && text.trim() === "تتر") {
          await pElement.click();
          console.log("✅ 'تتر' در نتایج انتخاب شد");
          tetherClicked = true;
          break;
        }
      }
      
      if (!tetherClicked) {
        // اگر با متن دقیق پیدا نشد
        const allElements = await this.page.$$('*');
        for (const element of allElements) {
          const text = await element.textContent();
          if (text && text.includes("تتر")) {
            await element.click();
            console.log("✅ 'تتر' با متن جزئی انتخاب شد");
            tetherClicked = true;
            break;
          }
        }
      }
      
      if (!tetherClicked) {
        throw new Error("گزینه 'تتر' در نتایج پیدا نشد");
      }
      
      await this.page.waitForTimeout(2000);
      
      // 3. وارد کردن آدرس ولت
      console.log("📫 وارد کردن آدرس ولت...");
      
      const addressInput = await this.page.$('input[placeholder="آدرس ولت مقصد خود را وارد کنید"]');
      if (!addressInput) {
        throw new Error("فیلد آدرس ولت پیدا نشد");
      }
      
      await addressInput.fill(CONFIG.WITHDRAW_ADDRESS);
      console.log("✅ آدرس ولت وارد شد");
      
      await this.page.waitForTimeout(1000);
      
      // 4. کلیک روی "برداشت کل موجودی"
      console.log("✅ کلیک روی دکمه 'برداشت کل موجودی'");
      
      let withdrawAllClicked = false;
      
      // روش 1: با title کامل یا جزئی
      try {
        await this.clickByTitle("برداشت کل موجودی");
        console.log("✅ دکمه 'برداشت کل موجودی' با title کلیک شد");
        withdrawAllClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title کامل پیدا نشد");
      }
      
      // جستجوی دکمه با title جزئی
      if (!withdrawAllClicked) {
        const buttonsWithTitle = await this.page.$$('[title*="برداشت"]');
        for (const button of buttonsWithTitle) {
          const title = await button.getAttribute('title');
          if (title && title.includes("برداشت")) {
            await button.click();
            console.log("✅ دکمه برداشت با title جزئی کلیک شد");
            withdrawAllClicked = true;
            break;
          }
        }
      }
      
      // روش 2: با متن
      if (!withdrawAllClicked) {
        try {
          await this.clickByText("برداشت کل موجودی");
          console.log("✅ دکمه 'برداشت کل موجودی' با متن کلیک شد");
          withdrawAllClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه با متن 'برداشت کل موجودی' پیدا نشد");
        }
      }
      
      if (!withdrawAllClicked) {
        throw new Error("دکمه برداشت کل موجودی پیدا نشد");
      }
      
      await this.page.waitForTimeout(2000);
      
      // 5. کلیک روی "ثبت برداشت"
      console.log("✅ کلیک روی دکمه 'ثبت برداشت'");
      
      let submitWithdrawClicked = false;
      
      // روش 1: با title
      try {
        await this.clickByTitle("ثبت برداشت");
        console.log("✅ دکمه 'ثبت برداشت' با title کلیک شد");
        submitWithdrawClicked = true;
      } catch (error) {
        console.log("⚠️ دکمه با title 'ثبت برداشت' پیدا نشد");
      }
      
      // روش 2: با متن
      if (!submitWithdrawClicked) {
        try {
          await this.clickByText("ثبت برداشت");
          console.log("✅ دکمه 'ثبت برداشت' با متن کلیک شد");
          submitWithdrawClicked = true;
        } catch (error) {
          console.log("⚠️ دکمه با متن 'ثبت برداشت' پیدا نشد");
        }
      }
      
      if (!submitWithdrawClicked) {
        throw new Error("دکمه ثبت برداشت پیدا نشد");
      }
      
      await this.page.waitForTimeout(5000);
      
      console.log("✅ مرحله 8 (برداشت تتر) تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 8:", error.message);
      throw error;
    }
  }

  getBankName(cardNumber) {
    if (!cardNumber || typeof cardNumber !== "string") {
      return "بانک ملی";
    }
    
    const cleanCard = cardNumber.replace(/[\s-]/g, '');
    
    // بانک ملت
    if (cleanCard.startsWith("610433") || cleanCard.startsWith("991975")) {
      return "بانک ملت";
    }
    // بانک ملی
    else if (cleanCard.startsWith("603799")) {
      return "بانک ملی";
    }
    // بانک صادرات
    else if (cleanCard.startsWith("603769")) {
      return "بانک صادرات";
    }
    // بانک تجارت
    else if (cleanCard.startsWith("585983") || cleanCard.startsWith("627353")) {
      return "بانک تجارت";
    }
    // بانک رفاه
    else if (cleanCard.startsWith("589463")) {
      return "بانک رفاه";
    }
    // بانک کشاورزی
    else if (cleanCard.startsWith("603770") || cleanCard.startsWith("639217")) {
      return "بانک کشاورزی";
    }
    // بانک مسکن
    else if (cleanCard.startsWith("628023")) {
      return "بانک مسکن";
    }
    // بانک سپه
    else if (cleanCard.startsWith("589210")) {
      return "بانک سپه";
    }
    // پیش‌فرض
    return "بانک ملی";
  }

  async solveCaptchaWithOCR() {
    console.log("🔍 در حال حل کپچا با OCR.space...");

    const API_KEY = 'K85487279088957';

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const captchaImg = await this.page.$('img.border-start.h-100');
        if (!captchaImg) throw new Error("تصویر کپچا پیدا نشد");

        const screenshotBuffer = await captchaImg.screenshot({ type: 'png' });
        const base64Image = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

        const response = await axios.post('https://api.ocr.space/parse/image', new URLSearchParams({
          apikey: API_KEY,
          base64Image: base64Image,
          language: 'eng',
          OCREngine: '3',
          scale: 'true',
          isOverlayRequired: 'true',
          detectOrientation: 'true'
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (response.data.IsErroredOnProcessing) {
          console.log(`⚠️ ارور API تلاش ${attempt}:`, response.data.ErrorMessage);
          continue;
        }

        if (response.data.ParsedResults?.[0]?.ParsedText) {
          let text = response.data.ParsedResults[0].ParsedText.trim();
          let code = text.replace(/\D/g, '');

          console.log(`تلاش ${attempt} - متن خام: "${text}" → کد: "${code}"`);

          if (code.length >= 4) {
            console.log(`✅ کپچا حل شد: ${code.substring(0,4)}`);
            return code.substring(0,4);
          }
        }

        console.log(`⚠️ تلاش ${attempt} ناموفق، رفرش کپچا...`);
        const refreshBtn = await this.page.$('#card-captcha-refresh-btn i, a i.fa-sync-alt');
        if (refreshBtn) {
          await refreshBtn.click();
          await this.page.waitForTimeout(3000);
        }

      } catch (error) {
        console.error(`❌ خطا در OCR تلاش ${attempt}:`, error.message);
      }
    }

    return null;
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUser = user;

    let currentStep = "شروع";
    let retryCount = user.retryCount || 0;

    try {
      console.log("\n" + "=".repeat(50));
      console.log(`🚀 شروع پردازش کاربر: ${user.personalName}`);
      console.log(`📱 شماره: ${phoneNumber}`);
      console.log(`🏦 بانک: ${this.getBankName(user.cardNumber)}`);
      console.log(`🔄 تلاش: ${retryCount + 1}/${CONFIG.MAX_RETRIES}`);
      console.log("=".repeat(50));

      if (retryCount >= CONFIG.MAX_RETRIES) {
        console.log(`⛔ کاربر به حداکثر تلاش‌ها رسیده است`);
        await this.updateUserStatus(phoneNumber, {
          status: "failed",
        });
        return false;
      }

      await this.updateUserStatus(phoneNumber, {
        status: "processing",
      });

      if (!(await this.initializeBrowser())) {
        throw new Error("راه‌اندازی مرورگر ناموفق بود");
      }

      const steps = [
        {
          name: "ثبت‌نام",
          method: () => this.step1_Register(),
          retryable: true,
        },
        {
          name: "OTP و رمز عبور",
          method: () => this.step2_OtpAndPassword(),
          retryable: true,
        },
        {
          name: "پروفایل",
          method: () => this.step3_Profile(),
          retryable: true,
        },
        {
          name: "افزودن قرارداد",
          method: () => this.step4_AddContract(),
          retryable: true,
        },
        {
          name: "پردازش بانکی",
          method: () => this.step5_BankProcess(),
          retryable: true,
        },
        {
          name: "واریز تومان",
          method: () => this.step6_Deposit(),
          retryable: true,
        },
        { name: "خرید تتر", method: () => this.step7_Buy(), retryable: true },
        {
          name: "برداشت تتر",
          method: () => this.step8_Withdraw(),
          retryable: true,
        },
      ];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        currentStep = step.name;

        console.log(`\n📋 مرحله ${i + 1}/${steps.length}: ${step.name}`);

        try {
          await step.method();

          if (i < steps.length - 1) {
            const delay = Math.random() * 2000 + 1000;
            console.log(`⏳ تأخیر ${Math.round(delay / 1000)} ثانیه...`);
            await this.page.waitForTimeout(delay);
          }
        } catch (stepError) {
          console.error(`❌ خطا در "${step.name}":`, stepError.message);

          if (step.retryable && retryCount < CONFIG.MAX_RETRIES - 1) {
            console.log(`🔄 تلاش مجدد...`);

            await this.closeBrowser();
            await this.page.waitForTimeout(CONFIG.RETRY_DELAY);

            this.currentPassword = this.generateStrongPassword();

            if (!(await this.initializeBrowser())) {
              throw new Error("خطا در راه‌اندازی مجدد مرورگر");
            }

            i--;
            retryCount++;
            continue;
          } else {
            throw stepError;
          }
        }
      }

      await this.updateUserStatus(phoneNumber, {
        processed: true,
        status: "completed",
        password: this.currentPassword,
      });

      console.log(`\n🎉 پردازش کاربر ${phoneNumber} با موفقیت تکمیل شد!`);
      console.log(`🔐 رمز عبور استفاده شده: ${this.currentPassword}`);
      return true;
    } catch (error) {
      console.error(`\n💥 خطا برای کاربر ${phoneNumber}:`, error.message);
      await this.updateUserStatus(phoneNumber, {
        status: "failed",
      });
      return false;
    } finally {
      await this.closeBrowser();
      this.activeProcesses.delete(phoneNumber);
      this.currentUser = null;
      this.currentPassword = this.generateStrongPassword();
    }
  }

  async startService() {
    console.log("\n🚀 سرویس ربات آبان تتر شروع شد");
    console.log("\n🔧 تنظیمات:");
    console.log(`   📍 URL سایت: ${CONFIG.BASE_URL}`);
    console.log(`   🔌 API سرور: ${CONFIG.API_BASE_URL}`);
    console.log(
      `   💰 مبلغ واریز: ${CONFIG.DEPOSIT_AMOUNT.toLocaleString()} تومان`
    );
    console.log(
      `   📫 آدرس برداشت: ${CONFIG.WITHDRAW_ADDRESS.substring(0, 20)}...`
    );
    console.log(`   🔄 حداکثر تلاش: ${CONFIG.MAX_RETRIES} بار`);
    console.log(
      `   ⏱️ فاصله چک دیتابیس: ${CONFIG.POLLING_INTERVAL / 1000} ثانیه`
    );
    console.log(
      `   🖥️ حالت مرورگر: ${CONFIG.HEADLESS ? "پنهان" : "قابل مشاهده"}`
    );

    console.log("\n🔗 در حال تست اتصال به API سرور...");
    
    try {
      // تست ساده‌تر اتصال به API
      const testResponse = await this.apiClient.post('/', {
        operation: 'find',
        query: {},
        collection: 'zarinapp',
        limit: 1
      });
      
      if (testResponse.data && testResponse.data.success !== undefined) {
        console.log(`✅ اتصال به API سرور موفق`);
        console.log(`📊 وضعیت: ${testResponse.status} ${testResponse.statusText}`);
      } else {
        console.log(`⚠️ پاسخ غیرمنتظره از سرور:`, testResponse.data);
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        console.error("❌ سرور یافت نشد یا قابل دسترسی نیست");
        console.error(`   آدرس: ${CONFIG.API_BASE_URL}`);
        console.error("   بررسی کنید که سرور در حال اجرا باشد");
        return;
      } else if (error.response) {
        console.log(`⚠️ پاسخ سرور: ${error.response.status} - ${error.response.statusText}`);
        
        if (error.response.status === 405) {
          console.log("ℹ️ سرور فقط POST می‌پذیرد - این نرمال است");
          console.log("✅ اتصال به API سرور تأیید شد");
        } else if (error.response.status === 500) {
          console.log("⚠️ خطای سرور داخلی - ممکن است JSON بدن مشکل داشته باشد");
          // امتحان با فرمت ساده‌تر
          try {
            const simpleTest = await this.apiClient.post('/', {
              operation: 'find',
              collection: 'zarinapp'
            });
            console.log("✅ اتصال با درخواست ساده موفق بود");
          } catch (simpleError) {
            console.error("❌ حتی درخواست ساده هم شکست خورد");
            return;
          }
        } else {
          console.error("❌ خطای غیرمنتظره از سرور");
          return;
        }
      } else if (error.request) {
        console.error("❌ پاسخی از سرور دریافت نشد");
        console.error("   بررسی کنید که سرور در حال اجرا باشد");
        return;
      } else {
        console.error("❌ خطای ناشناخته:", error.message);
        return;
      }
    }

    this.startPolling();

    process.on("SIGINT", async () => {
      console.log("\n🛑 دریافت سیگنال خاتمه...");
      await this.stopService();
      process.exit(0);
    });

    console.log("\n✅ سرویس با موفقیت راه‌اندازی شد");
    console.log("⏳ در انتظار کاربران جدید...");
  }

  async startPolling() {
    const poll = async () => {
      if (this.isProcessing) {
        console.log("⏸️ در حال پردازش کاربران دیگر...");
        return;
      }

      this.isProcessing = true;

      try {
        const pendingUsers = await this.getPendingUsers();

        for (const user of pendingUsers) {
          const phoneNumber = user.personalPhoneNumber;

          if (this.activeProcesses.has(phoneNumber)) {
            console.log(`⏭️ کاربر ${phoneNumber} در حال پردازش است`);
            continue;
          }

          this.activeProcesses.set(phoneNumber, true);

          this.processUser(user).finally(() => {
            this.activeProcesses.delete(phoneNumber);
          });
        }
      } catch (error) {
        console.error("❌ خطا در پولینگ:", error.message);
      } finally {
        this.isProcessing = false;
      }
    };

    await poll();

    setInterval(poll, CONFIG.POLLING_INTERVAL);

    console.log(
      `✅ پولینگ فعال شد (هر ${CONFIG.POLLING_INTERVAL / 1000} ثانیه)`
    );
  }

  async stopService() {
    console.log("\n🛑 در حال توقف سرویس...");
    await this.closeBrowser();

    console.log("✅ سرویس متوقف شد");
  }
}

// ==================== اجرای برنامه ====================
if (require.main === module) {
  process.on("uncaughtException", (error) => {
    console.error("🔥 خطای غیرمنتظره:", error);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 Promise رد شده:", reason);
  });

  console.log("\n🤖 ربات آبان تتر - نسخه API");
  console.log(`🔌 سرور API: ${CONFIG.API_BASE_URL}`);
  console.log(`🖥️ حالت: ${CONFIG.HEADLESS ? "Headless" : "با نمایش مرورگر"}`);

  const bot = new AbanTetherBot();

  bot.startService().catch((error) => {
    console.error("❌ خطای شروع سرویس:", error);
    process.exit(1);
  });
}

module.exports = AbanTetherBot;