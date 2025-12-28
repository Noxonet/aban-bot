// بوت کامپلت - Bot.js
const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

// ==================== تنظیمات ====================
const CONFIG = {
  // تنظیمات دیتابیس
  MONGODB_URI: 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority',
  DB_NAME: 'ZarrinApp',
  COLLECTION_NAME: 'zarinapp',
  
  // تنظیمات سایت
  BASE_URL: 'https://abantether.com',
  REGISTER_URL: 'https://abantether.com/register',
  DEPOSIT_URL: 'https://abantether.com/user/wallet/deposit/irt/direct',
  BUY_URL: 'https://abantether.com/user/trade/fast/buy?s=USDT',
  WITHDRAW_URL: 'https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT',
  TIMEOUT: 60000, // 60 ثانیه
  HEADLESS: false, // برای تست false، برای سرور true
  
  // تنظیمات تراکنش
  DEPOSIT_AMOUNT: '5000000',
  PASSWORD: 'ImSorryButIhaveTo@1',
  WITHDRAW_ADDRESS: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
  MAX_RETRIES: 3,
  RETRY_DELAY: 10000, // 10 ثانیه
  
  // تنظیمات پولینگ
  POLLING_INTERVAL: 30000, // 30 ثانیه
  BATCH_SIZE: 3,
  
  // تنظیمات منتظر ماندن
  WAIT_FOR_OTP: 120000, // 2 دقیقه برای OTP
  PAGE_LOAD_DELAY: 3000, // 3 ثانیه تاخیر بین صفحات
  ELEMENT_WAIT: 5000 // 5 ثانیه منتظر المنت
};

// ==================== کلاس اصلی ربات ====================
class AbanTetherBot {
  constructor() {
    this.dbClient = null;
    this.db = null;
    this.collection = null;
    this.isProcessing = false;
    this.activeProcesses = new Map();
    this.browser = null;
    this.page = null;
    this.context = null;
    this.currentUser = null;
    this.userSteps = new Map(); // ذخیره وضعیت مراحل کاربر
  }

  // ==================== روش‌های دیتابیس ====================
  async connectToDatabase() {
    try {
      console.log('🔗 در حال اتصال به دیتابیس...');
      this.dbClient = new MongoClient(CONFIG.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });
      
      await this.dbClient.connect();
      this.db = this.dbClient.db(CONFIG.DB_NAME);
      this.collection = this.db.collection(CONFIG.COLLECTION_NAME);
      
      // تست اتصال
      await this.db.command({ ping: 1 });
      console.log('✅ اتصال به دیتابیس موفقیت‌آمیز بود');
      return true;
    } catch (error) {
      console.error('❌ خطا در اتصال به دیتابیس:', error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      console.log('🔍 در حال جستجوی کاربران در انتظار...');
      
      // کوئری بهبود یافته
      const query = {
        $and: [
          { 
            $or: [
              { processed: { $exists: false } }, // اگر فیلد وجود ندارد
              { processed: false }, // اگر false است
              { processed: { $ne: true } } // اگر true نیست
            ]
          },
          {
            $or: [
              { status: { $exists: false } }, // اگر فیلد وجود ندارد
              { status: { $ne: 'failed' } }, // اگر failed نیست
              { status: 'processing' }, // اگر در حال پردازش است
              { status: 'retrying' } // اگر در حال تلاش مجدد است
            ]
          },
          {
            $or: [
              { retryCount: { $exists: false } }, // اگر فیلد وجود ندارد
              { retryCount: { $lt: CONFIG.MAX_RETRIES } } // اگر کمتر از حداکثر است
            ]
          }
        ]
      };

      const users = await this.collection
        .find(query)
        .sort({ createdAt: 1 })
        .limit(CONFIG.BATCH_SIZE)
        .toArray();

      console.log(`📊 ${users.length} کاربر در انتظار پردازش پیدا شد`);
      
      if (users.length > 0) {
        console.log('📋 لیست کاربران:');
        users.forEach((user, index) => {
          console.log(`   ${index + 1}. ${user.personalPhoneNumber} - ${user.personalName}`);
          console.log(`      وضعیت: ${user.status || 'جدید'} | تلاش‌ها: ${user.retryCount || 0}`);
          console.log(`      کارت: ${user.cardNumber?.substring(0, 6)}... | بانک: ${this.getBankName(user.cardNumber)}`);
        });
      }
      
      return users;
    } catch (error) {
      console.error('❌ خطا در دریافت کاربران:', error.message);
      return [];
    }
  }

  async updateUserStatus(phoneNumber, updateData) {
    try {
      console.log(`📝 آپدیت وضعیت کاربر ${phoneNumber}:`, updateData);
      
      const result = await this.collection.updateOne(
        { personalPhoneNumber: phoneNumber },
        {
          $set: updateData,
          $inc: { retryCount: updateData.status === 'failed' ? 1 : 0 },
          $currentDate: { lastUpdated: true }
        },
        { upsert: false }
      );
      
      const success = result.modifiedCount > 0;
      if (success) {
        console.log(`✅ وضعیت کاربر ${phoneNumber} آپدیت شد`);
      } else {
        console.log(`⚠️ کاربر ${phoneNumber} پیدا نشد یا تغییری نکرد`);
      }
      
      return success;
    } catch (error) {
      console.error(`❌ خطا در آپدیت کاربر ${phoneNumber}:`, error.message);
      return false;
    }
  }

  async markAsProcessing(phoneNumber) {
    return this.updateUserStatus(phoneNumber, {
      status: 'processing',
      startedAt: new Date(),
      lastStep: 'start'
    });
  }

  async markAsCompleted(phoneNumber, details = {}) {
    return this.updateUserStatus(phoneNumber, {
      processed: true,
      status: 'completed',
      completedAt: new Date(),
      ...details
    });
  }

  async markAsFailed(phoneNumber, reason, step = 'unknown') {
    return this.updateUserStatus(phoneNumber, {
      status: 'failed',
      failureReason: reason,
      failedStep: step,
      failedAt: new Date()
    });
  }

  async markAsRetry(phoneNumber, step, reason) {
    return this.updateUserStatus(phoneNumber, {
      status: 'retrying',
      lastRetryAt: new Date(),
      lastStep: step,
      retryReason: reason,
      lastError: reason
    });
  }

  async checkForOtp(phoneNumber, fieldType) {
    try {
      const user = await this.collection.findOne({ 
        personalPhoneNumber: phoneNumber 
      });
      
      if (user) {
        let otp = null;
        switch (fieldType) {
          case 'login':
            otp = user.otp_login;
            break;
          case 'register_card':
            otp = user.otp_register_card;
            break;
          case 'payment':
            otp = user.otp_payment;
            break;
        }
        
        if (otp && otp.toString().trim().length >= 4) {
          console.log(`✅ OTP ${fieldType} یافت شد: ${otp}`);
          return otp.toString().trim();
        } else {
          console.log(`⏳ OTP ${fieldType} هنوز دریافت نشده`);
          return null;
        }
      }
      
      return null;
    } catch (error) {
      console.error('❌ خطا در چک کردن OTP:', error.message);
      return null;
    }
  }

  // ==================== روش‌های پلی‌رایت ====================
  async initializeBrowser() {
    try {
      console.log('🌐 در حال راه‌اندازی مرورگر...');
      
      this.browser = await chromium.launch({
        headless: CONFIG.HEADLESS,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-blink-features=AutomationControlled'
        ],
        slowMo: CONFIG.HEADLESS ? 0 : 100 // برای تست آهسته‌تر
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        acceptDownloads: false,
        javaScriptEnabled: true,
        locale: 'fa-IR',
        permissions: ['geolocation'],
        timezoneId: 'Asia/Tehran'
      });

      // مخفی کردن automation
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['fa-IR', 'fa', 'en-US', 'en'] });
      });

      this.page = await this.context.newPage();
      await this.page.setDefaultTimeout(CONFIG.TIMEOUT);
      await this.page.setDefaultNavigationTimeout(CONFIG.TIMEOUT);
      
      // تنظیم هدرها
      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      });

      console.log('✅ مرورگر با موفقیت راه‌اندازی شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در راه‌اندازی مرورگر:', error.message);
      return false;
    }
  }

  async closeBrowser() {
    try {
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
      console.log('🔒 مرورگر بسته شد');
    } catch (error) {
      console.error('⚠️ خطا در بستن مرورگر:', error.message);
    }
  }

  async navigateTo(url, waitForLoad = true) {
    try {
      console.log(`🌐 در حال رفتن به: ${url}`);
      
      await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.TIMEOUT 
      });
      
      if (waitForLoad) {
        await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
          console.log('⚠️ شبکه idle نشد، ادامه می‌دهیم...');
        });
      }
      
      await this.page.waitForTimeout(CONFIG.PAGE_LOAD_DELAY);
      console.log('✅ صفحه با موفقیت بارگذاری شد');
      return true;
    } catch (error) {
      console.error(`❌ خطا در رفتن به ${url}:`, error.message);
      return false;
    }
  }

  async waitForElement(selector, timeout = CONFIG.ELEMENT_WAIT, visible = true) {
    try {
      const options = { timeout };
      if (visible) options.state = 'visible';
      
      await this.page.waitForSelector(selector, options);
      return true;
    } catch (error) {
      console.log(`⏳ المنت ${selector} پیدا نشد (${timeout}ms)`);
      return false;
    }
  }

  async fillByPlaceholder(placeholder, value) {
    try {
      const selector = `input[placeholder*="${placeholder}"], textarea[placeholder*="${placeholder}"]`;
      
      if (await this.waitForElement(selector, 5000)) {
        await this.page.fill(selector, value);
        console.log(`✅ مقدار "${value}" در فیلد "${placeholder}" وارد شد`);
        await this.page.waitForTimeout(500);
        return true;
      }
      
      console.log(`⚠️ فیلد با placeholder "${placeholder}" پیدا نشد`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در پر کردن فیلد "${placeholder}":`, error.message);
      return false;
    }
  }

  async clickByText(text, exact = false) {
    try {
      let selector;
      if (exact) {
        selector = `text="${text}"`;
      } else {
        selector = `text=${text}`;
      }
      
      if (await this.waitForElement(selector, 5000)) {
        await this.page.click(selector);
        console.log(`🖱️ کلیک روی "${text}"`);
        await this.page.waitForTimeout(1000);
        return true;
      }
      
      // امتحان XPath
      const xpath = `//*[contains(text(), '${text}')]`;
      const elements = await this.page.$x(xpath);
      
      if (elements.length > 0) {
        for (const element of elements) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            await element.click();
            console.log(`🖱️ کلیک روی "${text}" (XPath)`);
            await this.page.waitForTimeout(1000);
            return true;
          }
        }
      }
      
      console.log(`⚠️ متن "${text}" برای کلیک پیدا نشد`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در کلیک روی "${text}":`, error.message);
      return false;
    }
  }

  async clickByTitle(title) {
    try {
      const selector = `[title="${title}"]`;
      
      if (await this.waitForElement(selector, 5000)) {
        await this.page.click(selector);
        console.log(`🖱️ کلیک روی عنصر با title="${title}"`);
        await this.page.waitForTimeout(1000);
        return true;
      }
      
      console.log(`⚠️ عنصر با title="${title}" پیدا نشد`);
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
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const remaining = Math.round((timeout - (Date.now() - startTime)) / 1000);
      console.log(`⏳ ${elapsed} ثانیه گذشته - ${remaining} ثانیه باقی مانده`);
      
      await this.page.waitForTimeout(3000);
    }
    
    throw new Error(`⏰ تایم‌اوت برای دریافت OTP ${fieldType}`);
  }

  async enterOtp(otp) {
    try {
      console.log(`🔢 در حال وارد کردن OTP: ${otp}`);
      
      // روش 1: جستجوی فیلد OTP با placeholder
      const placeholders = ['کد ارسال شده', 'کد', 'رمز', 'کد تأیید', 'رمز پویا'];
      
      for (const placeholder of placeholders) {
        const entered = await this.fillByPlaceholder(placeholder, otp);
        if (entered) {
          return true;
        }
      }
      
      // روش 2: جستجوی فیلدهای عددی
      const otpInputs = await this.page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"]');
      
      if (otpInputs.length > 0) {
        console.log(`🔢 پیدا کردن ${otpInputs.length} فیلد عددی`);
        
        // اگر یک فیلد بزرگ پیدا شد
        if (otpInputs.length === 1) {
          await otpInputs[0].fill(otp);
          return true;
        }
        
        // اگر چند فیلد کوچک پیدا شد (مثل 4 یا 6 رقمی)
        const otpDigits = otp.toString().split('');
        for (let i = 0; i < Math.min(otpInputs.length, otpDigits.length); i++) {
          await otpInputs[i].fill(otpDigits[i]);
          await this.page.waitForTimeout(100);
        }
        return true;
      }
      
      // روش 3: جستجو با نام
      const nameInputs = await this.page.$$('input[name*="otp"], input[name*="code"], input[name*="pin"]');
      if (nameInputs.length > 0) {
        await nameInputs[0].fill(otp);
        return true;
      }
      
      throw new Error('هیچ فیلدی برای وارد کردن OTP پیدا نشد');
      
    } catch (error) {
      console.error('❌ خطا در وارد کردن OTP:', error.message);
      throw error;
    }
  }

  async takeScreenshot(name) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `screenshots/${name}_${timestamp}.png`;
      
      await this.page.screenshot({ 
        path: filename, 
        fullPage: true 
      });
      
      console.log(`📸 اسکرین‌شات ذخیره شد: ${filename}`);
    } catch (error) {
      console.error('⚠️ خطا در گرفتن اسکرین‌شات:', error.message);
    }
  }

  // ==================== مراحل پردازش ====================
  async step1_Register() {
    console.log('\n📝 ======= مرحله 1: ثبت‌نام =======');
    
    try {
      await this.navigateTo(CONFIG.REGISTER_URL);
      await this.takeScreenshot('01_register_page');
      
      // وارد کردن شماره موبایل
      const phoneEntered = await this.fillByPlaceholder('شماره موبایل خود را وارد کنید', this.currentUser.personalPhoneNumber);
      
      if (!phoneEntered) {
        // روش جایگزین
        await this.page.fill('input[type="tel"]', this.currentUser.personalPhoneNumber);
        console.log('✅ شماره موبایل وارد شد (روش جایگزین)');
      }
      
      await this.takeScreenshot('02_phone_entered');
      
      // کلیک روی ثبت‌نام
      const clicked = await this.clickByText('ثبت‌نام');
      
      if (!clicked) {
        // امتحان دکمه‌های دیگر
        await this.clickByText('ادامه');
        await this.clickByText('ارسال کد');
      }
      
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('03_after_register_click');
      
      // چک کردن آیا صفحه تغییر کرده
      const currentUrl = this.page.url();
      console.log(`🔗 URL فعلی: ${currentUrl}`);
      
      // اگر صفحه OTP است
      if (currentUrl.includes('verify') || await this.page.$('input[placeholder*="کد ارسال شده"]')) {
        console.log('📲 وارد صفحه OTP شدیم');
        
        // منتظر OTP
        const loginOtp = await this.waitForOtp('login');
        
        if (loginOtp) {
          await this.enterOtp(loginOtp);
          await this.takeScreenshot('04_otp_entered');
          
          // کلیک روی مرحله بعد
          await this.clickByText('بعد');
          await this.clickByText('ادامه');
          await this.clickByText('ورود');
          
          await this.page.waitForTimeout(3000);
          await this.takeScreenshot('05_after_otp');
        }
      }
      
      console.log('✅ مرحله 1 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 1:', error.message);
      await this.takeScreenshot('error_step1');
      throw error;
    }
  }

  async step2_Password() {
    console.log('\n🔐 ======= مرحله 2: رمز عبور =======');
    
    try {
      await this.takeScreenshot('06_password_page');
      
      // وارد کردن رمز عبور
      const passwordEntered = await this.fillByPlaceholder('رمز عبور خود را وارد نمایید', CONFIG.PASSWORD);
      
      if (!passwordEntered) {
        // روش جایگزین
        await this.page.fill('input[type="password"]', CONFIG.PASSWORD);
        console.log('✅ رمز عبور وارد شد (روش جایگزین)');
      }
      
      await this.takeScreenshot('07_password_entered');
      
      // کلیک روی تایید
      await this.clickByTitle('تایید');
      await this.clickByText('تایید');
      await this.clickByText('ادامه');
      
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('08_after_password');
      
      console.log('✅ مرحله 2 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 2:', error.message);
      await this.takeScreenshot('error_step2');
      throw error;
    }
  }

  async step3_Profile() {
    console.log('\n👤 ======= مرحله 3: پروفایل =======');
    
    try {
      await this.takeScreenshot('09_profile_page');
      
      // وارد کردن کد ملی
      const nationalCodeEntered = await this.fillByPlaceholder('کد ۱۰ رقمی شناسایی خود را وارد کنید', this.currentUser.personalNationalCode);
      
      if (!nationalCodeEntered) {
        // روش جایگزین
        await this.page.fill('input[type="text"]', this.currentUser.personalNationalCode);
        console.log('✅ کد ملی وارد شد (روش جایگزین)');
      }
      
      // وارد کردن تاریخ تولد
      const birthDateEntered = await this.fillByPlaceholder('روز/ماه/سال', this.currentUser.personalBirthDate);
      
      if (!birthDateEntered) {
        // روش جایگزین
        const dateInputs = await this.page.$$('input[type="text"], input[type="date"]');
        for (const input of dateInputs) {
          const placeholder = await input.getAttribute('placeholder');
          if (placeholder && placeholder.includes('تاریخ')) {
            await input.fill(this.currentUser.personalBirthDate);
            console.log('✅ تاریخ تولد وارد شد (روش جایگزین)');
            break;
          }
        }
      }
      
      await this.takeScreenshot('10_profile_filled');
      
      // کلیک روی ثبت
      await this.clickByTitle('ثبت');
      await this.clickByText('ثبت');
      await this.clickByText('تکمیل ثبت‌نام');
      
      await this.page.waitForTimeout(5000);
      await this.takeScreenshot('11_after_profile');
      
      // چک کردن پیام موفقیت
      try {
        await this.clickByText('باشه');
        await this.clickByText('تأیید');
        await this.clickByText('ادامه');
        console.log('✅ پیام تأیید کلیک شد');
      } catch (e) {
        // مشکلی نیست
      }
      
      console.log('✅ مرحله 3 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 3:', error.message);
      await this.takeScreenshot('error_step3');
      throw error;
    }
  }

  async step4_Wallet() {
    console.log('\n💰 ======= مرحله 4: کیف پول =======');
    
    try {
      await this.takeScreenshot('12_main_page');
      
      // هاور روی منوی سایدبار
      const sideMenu = await this.page.$('.SideMenu_wrapper__XuXfv');
      if (sideMenu) {
        await sideMenu.hover();
        console.log('🖱️ هاور روی منوی سایدبار');
        await this.page.waitForTimeout(1000);
      }
      
      // کلیک روی کیف پول
      const walletLink = await this.page.$('[data-testid="link-sidebar-wallet"]');
      if (walletLink) {
        await walletLink.click();
        console.log('🖱️ کلیک روی لینک کیف پول (data-testid)');
      } else {
        await this.clickByText('کیف پول');
        await this.clickByText('wallet', true);
      }
      
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('13_wallet_page');
      
      console.log('✅ مرحله 4 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 4:', error.message);
      await this.takeScreenshot('error_step4');
      throw error;
    }
  }

  async step5_AddContract() {
    console.log('\n📄 ======= مرحله 5: افزودن قرارداد =======');
    
    try {
      // کلیک روی واریز
      await this.clickByTitle('واریز');
      await this.clickByText('واریز');
      
      await this.page.waitForTimeout(1000);
      await this.takeScreenshot('14_deposit_menu');
      
      // کلیک روی تومان
      await this.page.click('p:has-text("تومان")');
      await this.page.click('div:has-text("تومان")');
      
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('15_toman_selected');
      
      // رفتن به صفحه واریز مستقیم
      await this.navigateTo(CONFIG.DEPOSIT_URL, false);
      await this.takeScreenshot('16_deposit_page');
      
      // کلیک روی افزودن قرارداد
      await this.clickByTitle('افزودن قرارداد');
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('17_add_contract_modal');
      
      // انتخاب بانک
      await this.page.click('div:has-text("نام بانک خود را انتخاب نمایید")');
      await this.page.waitForTimeout(1000);
      
      const bankName = this.getBankName(this.currentUser.cardNumber);
      console.log(`🏦 انتخاب بانک: ${bankName}`);
      
      await this.page.click(`p:has-text("${bankName}")`);
      await this.page.waitForTimeout(1000);
      await this.takeScreenshot('18_bank_selected');
      
      // انتخاب مدت قرارداد
      await this.page.click('div:has-text("مدت قرارداد خود را انتخاب کنید")');
      await this.page.waitForTimeout(1000);
      await this.page.click('p:has-text("1 ماهه")');
      await this.page.waitForTimeout(1000);
      await this.takeScreenshot('19_duration_selected');
      
      // کلیک روی ثبت و ادامه
      await this.clickByTitle('ثبت و ادامه');
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('20_contract_added');
      
      console.log('✅ مرحله 5 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 5:', error.message);
      await this.takeScreenshot('error_step5');
      throw error;
    }
  }

  async step6_BankProcess() {
    console.log('\n🏦 ======= مرحله 6: پردازش بانکی =======');
    
    try {
      const bankName = this.getBankName(this.currentUser.cardNumber);
      console.log(`🏦 تشخیص بانک: ${bankName}`);
      await this.takeScreenshot('21_bank_process_page');
      
      if (bankName === 'بانک ملی') {
        await this.processBankMelli();
      } else if (bankName === 'بانک مهر ایران') {
        await this.processBankMellat();
      } else {
        console.log(`⚠️ بانک ${bankName} - پردازش عمومی`);
        await this.processGenericBank();
      }
      
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('24_after_bank_process');
      
      // کلیک روی ثبت قرارداد
      await this.clickByText('ثبت قرار داد');
      await this.clickByText('ثبت قرارداد');
      await this.clickByText('تأیید');
      
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('25_contract_registered');
      
      console.log('✅ مرحله 6 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 6:', error.message);
      await this.takeScreenshot('error_step6');
      throw error;
    }
  }

  async processBankMelli() {
    console.log('🏦 پردازش بانک ملی');
    
    // کلیک روی ورود با کارت بانک ملی
    await this.page.click('div:has-text("ورود با کارت بانک ملی"), p:has-text("ورود با کارت بانک ملی")');
    await this.page.waitForTimeout(3000);
    await this.takeScreenshot('22_bank_melli_page');
    
    // اینجا نیاز به وارد کردن دستی کپچا داریم
    console.log('⏸️ منتظر وارد کردن دستی کپچا... (15 ثانیه)');
    await this.page.waitForTimeout(15000);
    
    await this.clickByText('ارسال رمز فعالسازی');
    await this.clickByText('دریافت رمز');
    
    const cardOtp = await this.waitForOtp('register_card');
    if (cardOtp) {
      await this.enterOtp(cardOtp);
      await this.takeScreenshot('23_otp_entered_bank');
      await this.clickByText('ادامه');
      await this.clickByText('تأیید');
    }
  }

  async processBankMellat() {
    console.log('🏦 پردازش بانک مهر ایران');
    
    // وارد کردن اطلاعات کارت
    await this.fillByPlaceholder('شماره کارت', this.currentUser.cardNumber);
    await this.fillByPlaceholder('CVV2', this.currentUser.cvv2);
    await this.fillByPlaceholder('ماه', this.currentUser.bankMonth.toString());
    await this.fillByPlaceholder('سال', this.currentUser.bankYear.toString());
    
    await this.takeScreenshot('22_bank_mellat_filled');
    
    console.log('⏸️ منتظر وارد کردن دستی کپچا... (15 ثانیه)');
    await this.page.waitForTimeout(15000);
    
    await this.clickByText('دریافت رمز پویا');
    await this.clickByText('ارسال رمز');
    
    const cardOtp = await this.waitForOtp('register_card');
    if (cardOtp) {
      await this.fillByPlaceholder('رمز دوم', cardOtp);
      await this.fillByPlaceholder('رمز پویا', cardOtp);
      await this.takeScreenshot('23_otp_entered_bank');
      await this.clickByText('تایید');
      await this.clickByText('ادامه');
    }
  }

  async processGenericBank() {
    console.log('🏦 پردازش بانک عمومی');
    
    // منتظر OTP کارت
    const cardOtp = await this.waitForOtp('register_card');
    if (cardOtp) {
      await this.enterOtp(cardOtp);
      await this.takeScreenshot('23_otp_entered_bank');
      await this.clickByText('تأیید');
      await this.clickByText('ادامه');
    }
  }

  async step7_Deposit() {
    console.log('\n💵 ======= مرحله 7: واریز تومان =======');
    
    try {
      // برگشت به صفحه اصلی
      await this.navigateTo(CONFIG.BASE_URL);
      await this.step4_Wallet();
      await this.takeScreenshot('26_wallet_after_contract');
      
      // وارد کردن مبلغ
      await this.fillByPlaceholder('مبلغ واریز را به تومان وارد نمایید', CONFIG.DEPOSIT_AMOUNT);
      
      // انتخاب بانک از لیست
      const bankList = await this.page.$('#bank-list');
      if (bankList) {
        await bankList.click();
        await this.page.waitForTimeout(1000);
        
        const bankName = this.getBankName(this.currentUser.cardNumber);
        await this.page.click(`p:has-text("${bankName}")`);
        await this.takeScreenshot('27_bank_selected_deposit');
      }
      
      // کلیک روی واریز
      await this.clickByTitle('واریز');
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('28_before_payment');
      
      // کلیک روی تایید و پرداخت
      await this.clickByTitle('تایید و پرداخت');
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('29_payment_page');
      
      // منتظر OTP پرداخت
      const paymentOtp = await this.waitForOtp('payment');
      if (paymentOtp) {
        await this.enterOtp(paymentOtp);
        await this.takeScreenshot('30_payment_otp_entered');
        await this.clickByText('تأیید');
        await this.clickByText('پرداخت');
      }
      
      await this.page.waitForTimeout(5000);
      await this.takeScreenshot('31_after_payment');
      
      console.log('✅ مرحله 7 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 7:', error.message);
      await this.takeScreenshot('error_step7');
      throw error;
    }
  }

  async step8_Buy() {
    console.log('\n🔄 ======= مرحله 8: خرید تتر =======');
    
    try {
      await this.navigateTo(CONFIG.BUY_URL);
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('32_buy_page');
      
      // پیدا کردن و کلیک روی دکمه خرید
      const buyButton = await this.page.$('.Button_button__A32Lt.Button_filled-primary__B_qAg');
      if (buyButton) {
        await buyButton.click();
        console.log('🖱️ کلیک روی دکمه خرید (کلاس)');
      } else {
        await this.clickByText('خرید');
        await this.clickByText('خرید تتر');
      }
      
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('33_buy_modal');
      
      // وارد کردن مبلغ
      const amountInput = await this.page.$('.Input_input__wMmzD.Input_ltr__7PqEB');
      if (amountInput) {
        await amountInput.fill(CONFIG.DEPOSIT_AMOUNT);
        console.log('💰 مبلغ وارد شد');
      } else {
        await this.fillByPlaceholder('مبلغ', CONFIG.DEPOSIT_AMOUNT);
      }
      
      await this.takeScreenshot('34_amount_entered');
      
      // کلیک روی ثبت سفارش
      await this.clickByTitle('ثبت سفارش');
      await this.clickByText('ثبت سفارش');
      await this.clickByText('خرید');
      
      await this.page.waitForTimeout(5000);
      await this.takeScreenshot('35_after_buy');
      
      console.log('✅ مرحله 8 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 8:', error.message);
      await this.takeScreenshot('error_step8');
      throw error;
    }
  }

  async step9_Withdraw() {
    console.log('\n📤 ======= مرحله 9: برداشت تتر =======');
    
    try {
      await this.navigateTo(CONFIG.WITHDRAW_URL);
      await this.page.waitForTimeout(3000);
      await this.takeScreenshot('36_withdraw_page');
      
      // جستجوی تتر
      await this.fillByPlaceholder('جستجو', 'تتر');
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('37_search_tether');
      
      // کلیک روی تتر
      await this.page.click('p:has-text("تتر")');
      await this.page.click('div:has-text("تتر")');
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('38_tether_selected');
      
      // وارد کردن آدرس ولت
      await this.fillByPlaceholder('آدرس ولت مقصد خود را وارد کنید', CONFIG.WITHDRAW_ADDRESS);
      await this.takeScreenshot('39_address_entered');
      
      // کلیک روی برداشت کل موجودی
      await this.clickByTitle(/برداشت کل موجودی/);
      await this.clickByText('برداشت کل موجودی');
      await this.page.waitForTimeout(2000);
      await this.takeScreenshot('40_max_amount');
      
      // کلیک روی ثبت برداشت
      await this.clickByTitle('ثبت برداشت');
      await this.clickByText('ثبت برداشت');
      await this.clickByText('برداشت');
      
      await this.page.waitForTimeout(5000);
      await this.takeScreenshot('41_after_withdraw');
      
      console.log('✅ مرحله 9 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 9:', error.message);
      await this.takeScreenshot('error_step9');
      throw error;
    }
  }

  // ==================== روش‌های کمکی ====================
  getBankName(cardNumber) {
    if (!cardNumber || typeof cardNumber !== 'string') {
      return 'بانک ملی';
    }
    
    const firstSix = cardNumber.substring(0, 6);
    const firstFour = cardNumber.substring(0, 4);
    
    // بانک ملی
    if (firstSix === '603799') return 'بانک ملی';
    
    // بانک مهر ایران
    if (firstSix === '610433' || firstSix === '504172') return 'بانک مهر ایران';
    
    // بانک کشاورزی
    if (firstSix === '603770' || firstSix === '639217') return 'بانک کشاورزی';
    
    // بانک تجارت
    if (firstSix === '585983' || firstSix === '627353') return 'بانک تجارت';
    
    // بانک صادرات
    if (firstSix === '603769' || firstSix === '903769') return 'بانک صادرات ایران';
    
    // بانک ملت
    if (firstSix === '610433' || firstSix === '991975') return 'بانک ملت';
    
    // بانک پارسیان
    if (firstSix === '622106' || firstSix === '627884') return 'بانک پارسیان';
    
    // بانک اقتصاد نوین
    if (firstSix === '627412') return 'بانک اقتصاد نوین';
    
    // بانک سامان
    if (firstSix === '621986') return 'بانک سامان';
    
    // بانک پاسارگاد
    if (firstSix === '502229' || firstSix === '639347') return 'بانک پاسارگاد';
    
    // بانک انصار
    if (firstSix === '627381') return 'بانک انصار';
    
    // بانک دی
    if (firstSix === '502938') return 'بانک دی';
    
    // شناسایی با 4 رقم اول
    if (firstFour === '6037') return 'بانک ملی';
    if (firstFour === '6104') return 'بانک مهر ایران';
    if (firstFour === '6274') return 'بانک اقتصاد نوین';
    
    return 'بانک ملی'; // پیش‌فرض
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUser = user;
    
    let currentStep = 'شروع';
    let retryCount = user.retryCount || 0;
    let attemptNumber = retryCount + 1;
    
    try {
      console.log('\n' + '='.repeat(50));
      console.log(`🚀 شروع پردازش کاربر (تلاش ${attemptNumber}/${CONFIG.MAX_RETRIES})`);
      console.log(`👤 نام: ${user.personalName}`);
      console.log(`📱 شماره: ${phoneNumber}`);
      console.log(`🏦 بانک: ${this.getBankName(user.cardNumber)}`);
      console.log(`💳 کارت: ${user.cardNumber?.substring(0, 6)}...`);
      console.log('='.repeat(50));
      
      // بررسی حداکثر تلاش
      if (retryCount >= CONFIG.MAX_RETRIES) {
        console.log(`⛔ کاربر به حداکثر تلاش‌ها رسیده است (${retryCount}/${CONFIG.MAX_RETRIES})`);
        await this.markAsFailed(phoneNumber, 'حداکثر تلاش‌ها انجام شد');
        return false;
      }
      
      // ذخیره وضعیت شروع
      await this.markAsProcessing(phoneNumber);
      
      // راه‌اندازی مرورگر
      console.log('🌐 در حال راه‌اندازی مرورگر...');
      if (!await this.initializeBrowser()) {
        throw new Error('راه‌اندازی مرورگر ناموفق بود');
      }
      
      // ایجاد پوشه اسکرین‌شات
      const fs = require('fs');
      if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots', { recursive: true });
      }
      
      // مراحل پردازش
      const steps = [
        { name: 'ثبت‌نام', method: () => this.step1_Register(), retryable: true },
        { name: 'رمز عبور', method: () => this.step2_Password(), retryable: true },
        { name: 'پروفایل', method: () => this.step3_Profile(), retryable: true },
        { name: 'کیف پول', method: () => this.step4_Wallet(), retryable: true },
        { name: 'افزودن قرارداد', method: () => this.step5_AddContract(), retryable: true },
        { name: 'پردازش بانکی', method: () => this.step6_BankProcess(), retryable: true },
        { name: 'واریز تومان', method: () => this.step7_Deposit(), retryable: true },
        { name: 'خرید تتر', method: () => this.step8_Buy(), retryable: true },
        { name: 'برداشت تتر', method: () => this.step9_Withdraw(), retryable: true }
      ];
      
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        currentStep = step.name;
        
        console.log(`\n📋 مرحله ${i + 1}/${steps.length}: ${step.name}`);
        
        try {
          // اجرای مرحله
          await step.method();
          
          // آپدیت وضعیت در دیتابیس
          await this.updateUserStatus(phoneNumber, { 
            lastStep: step.name,
            lastStepTime: new Date()
          });
          
          // تأخیر بین مراحل
          if (i < steps.length - 1) {
            const delay = Math.random() * 2000 + 1000; // 1-3 ثانیه تصادفی
            console.log(`⏳ تأخیر ${Math.round(delay/1000)} ثانیه...`);
            await this.page.waitForTimeout(delay);
          }
          
        } catch (stepError) {
          console.error(`❌ خطا در مرحله "${step.name}":`, stepError.message);
          
          // اگر مرحله قابل ری‌تکت است
          if (step.retryable && attemptNumber < CONFIG.MAX_RETRIES) {
            console.log(`🔄 تلاش مجدد برای مرحله "${step.name}" (تلاش ${attemptNumber + 1}/${CONFIG.MAX_RETRIES})`);
            
            // آپدیت وضعیت ری‌تکت
            await this.markAsRetry(phoneNumber, step.name, stepError.message);
            
            // بستن مرورگر
            console.log('🔒 در حال بستن مرورگر برای تلاش مجدد...');
            await this.closeBrowser();
            
            // تأخیر قبل از تلاش مجدد
            console.log(`⏳ تأخیر ${CONFIG.RETRY_DELAY/1000} ثانیه قبل از تلاش مجدد...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
            
            // راه‌اندازی مجدد مرورگر
            console.log('🌐 راه‌اندازی مجدد مرورگر...');
            if (!await this.initializeBrowser()) {
              throw new Error('راه‌اندازی مجدد مرورگر ناموفق بود');
            }
            
            // برگشت به مرحله قبل
            i--;
            attemptNumber++;
            continue;
          } else {
            // غیرقابل ری‌تکت یا به حداکثر رسیده
            throw stepError;
          }
        }
      }
      
      // تکمیل موفقیت‌آمیز
      const processingTime = Date.now() - (user.startedAt?.getTime() || Date.now());
      const minutes = Math.floor(processingTime / 60000);
      const seconds = Math.floor((processingTime % 60000) / 1000);
      
      await this.markAsCompleted(phoneNumber, {
        completedAt: new Date(),
        processingTime: processingTime,
        processingTimeText: `${minutes} دقیقه و ${seconds} ثانیه`,
        completedSteps: steps.map(s => s.name)
      });
      
      console.log('\n' + '🎉'.repeat(25));
      console.log(`🎉 پردازش کاربر ${phoneNumber} با موفقیت تکمیل شد!`);
      console.log(`⏱️ زمان پردازش: ${minutes} دقیقه و ${seconds} ثانیه`);
      console.log('🎉'.repeat(25));
      
      return true;
      
    } catch (error) {
      console.error('\n' + '💥'.repeat(25));
      console.error(`💥 خطای بحرانی برای کاربر ${phoneNumber}:`);
      console.error(`📌 مرحله: ${currentStep}`);
      console.error(`❌ خطا: ${error.message}`);
      console.error('💥'.repeat(25));
      
      // ثبت خطا در دیتابیس
      await this.markAsFailed(phoneNumber, error.message, currentStep);
      
      return false;
      
    } finally {
      // پاکسازی
      console.log('🧹 در حال پاکسازی...');
      await this.closeBrowser();
      this.activeProcesses.delete(phoneNumber);
      this.currentUser = null;
      this.userSteps.delete(phoneNumber);
    }
  }

  // ==================== سرویس اصلی ====================
  async startService() {
    console.log('\n' + '🚀'.repeat(30));
    console.log('🚀 سرویس ربات آبان تتر شروع شد');
    console.log('🚀'.repeat(30));
    
    console.log('\n🔧 تنظیمات:');
    console.log(`   📍 URL سایت: ${CONFIG.BASE_URL}`);
    console.log(`   💰 مبلغ واریز: ${CONFIG.DEPOSIT_AMOUNT.toLocaleString()} تومان`);
    console.log(`   📫 آدرس برداشت: ${CONFIG.WITHDRAW_ADDRESS.substring(0, 20)}...`);
    console.log(`   🔄 حداکثر تلاش: ${CONFIG.MAX_RETRIES} بار`);
    console.log(`   ⏱️ فاصله چک دیتابیس: ${CONFIG.POLLING_INTERVAL / 1000} ثانیه`);
    console.log(`   🖥️ حالت مرورگر: ${CONFIG.HEADLESS ? 'پنهان' : 'قابل مشاهده'}`);
    
    // اتصال به دیتابیس
    console.log('\n🔗 در حال اتصال به دیتابیس MongoDB...');
    if (!await this.connectToDatabase()) {
      console.error('❌ خاتمه به دلیل خطای دیتابیس');
      process.exit(1);
    }
    
    // شروع پولینگ
    console.log(`\n🔍 شروع پولینگ دیتابیس (هر ${CONFIG.POLLING_INTERVAL / 1000} ثانیه)...`);
    this.startPolling();
    
    // مدیریت خاتمه برنامه
    this.setupShutdownHandlers();
    
    console.log('\n✅ سرویس با موفقیت راه‌اندازی شد');
    console.log('⏳ در انتظار کاربران جدید...');
  }

  async startPolling() {
    const poll = async () => {
      // جلوگیری از اجرای همزمان
      if (this.isProcessing) {
        console.log('⏸️ در حال پردازش کاربران دیگر، چک بعدی...');
        return;
      }
      
      this.isProcessing = true;
      
      try {
        // دریافت کاربران در انتظار
        const pendingUsers = await this.getPendingUsers();
        
        if (pendingUsers.length === 0) {
          console.log('👀 هیچ کاربری برای پردازش یافت نشد');
          return;
        }
        
        // پردازش هر کاربر
        for (const user of pendingUsers) {
          const phoneNumber = user.personalPhoneNumber;
          
          // چک کردن اگر کاربر در حال پردازش است
          if (this.activeProcesses.has(phoneNumber)) {
            console.log(`⏭️ کاربر ${phoneNumber} در حال پردازش است، رد شدن...`);
            continue;
          }
          
          // افزودن به لیست پردازش‌های فعال
          this.activeProcesses.set(phoneNumber, true);
          
          // پردازش غیرهمزمان
          console.log(`\n▶️ شروع پردازش کاربر ${phoneNumber}...`);
          this.processUser(user)
            .then(success => {
              if (success) {
                console.log(`✅ پردازش کاربر ${phoneNumber} موفقیت‌آمیز بود`);
              } else {
                console.log(`❌ پردازش کاربر ${phoneNumber} ناموفق بود`);
              }
            })
            .catch(error => {
              console.error(`💥 خطای غیرمنتظره در پردازش ${phoneNumber}:`, error.message);
            })
            .finally(() => {
              // حذف از لیست پردازش‌های فعال
              this.activeProcesses.delete(phoneNumber);
              console.log(`🗑️ کاربر ${phoneNumber} از لیست پردازش حذف شد`);
            });
        }
        
      } catch (error) {
        console.error('❌ خطا در پولینگ:', error.message);
      } finally {
        this.isProcessing = false;
      }
    };
    
    // اجرای اولیه
    await poll().catch(console.error);
    
    // تنظیم تایمر برای پولینگ دوره‌ای
    const intervalId = setInterval(() => {
      poll().catch(console.error);
    }, CONFIG.POLLING_INTERVAL);
    
    // ذخیره intervalId برای توقف
    this.pollingIntervalId = intervalId;
    
    console.log(`✅ پولینگ فعال شد (هر ${CONFIG.POLLING_INTERVAL / 1000} ثانیه)`);
  }

  setupShutdownHandlers() {
    // مدیریت سیگنال‌های خاتمه
    const shutdown = async (signal) => {
      console.log(`\n🛑 دریافت سیگنال ${signal}...`);
      console.log('🧹 در حال توقف سرویس...');
      
      // توقف interval پولینگ
      if (this.pollingIntervalId) {
        clearInterval(this.pollingIntervalId);
        console.log('⏹️ پولینگ متوقف شد');
      }
      
      // بستن مرورگر
      await this.closeBrowser();
      
      // بستن اتصال دیتابیس
      if (this.dbClient) {
        await this.dbClient.close();
        console.log('🔒 اتصال دیتابیس بسته شد');
      }
      
      console.log('👋 سرویس با موفقیت متوقف شد');
      process.exit(0);
    };
    
    process.on('SIGINT', () => shutdown('SIGINT (Ctrl+C)'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGQUIT', () => shutdown('SIGQUIT'));
    
    console.log('✅ مدیریت‌گرهای خاتمه تنظیم شدند');
  }

  async stopService() {
    console.log('\n🛑 درخواست توقف سرویس...');
    
    // توقف interval پولینگ
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
    
    // بستن مرورگر
    await this.closeBrowser();
    
    // بستن اتصال دیتابیس
    if (this.dbClient) {
      await this.dbClient.close();
      this.dbClient = null;
    }
    
    console.log('✅ سرویس متوقف شد');
  }
}

// ==================== اجرای برنامه ====================
if (require.main === module) {
  // مدیریت خطاهای غیرمنتظره
  process.on('uncaughtException', (error) => {
    console.error('\n' + '🔥'.repeat(30));
    console.error('🔥 خطای غیرمنتظره (uncaughtException):');
    console.error('🔥 پیام:', error.message);
    console.error('🔥 Stack:', error.stack);
    console.error('🔥'.repeat(30));
    
    // لاگ فایل خطا
    const fs = require('fs');
    const errorLog = `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${error.message}\n${error.stack}\n\n`;
    fs.appendFileSync('error.log', errorLog);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n' + '🔥'.repeat(30));
    console.error('🔥 Promise رد شده (unhandledRejection):');
    console.error('🔥 دلیل:', reason);
    console.error('🔥'.repeat(30));
    
    // لاگ فایل خطا
    const fs = require('fs');
    const errorLog = `[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason}\n\n`;
    fs.appendFileSync('error.log', errorLog);
  });
  
  // ایجاد فایل لاگ
  const fs = require('fs');
  if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs', { recursive: true });
  }
  
  // ریدایرکت کنسول لاگ به فایل
  const originalLog = console.log;
  const originalError = console.error;
  
  console.log = function(...args) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    fs.appendFileSync('logs/bot.log', logMessage, { flag: 'a' });
    originalLog.apply(console, args);
  };
  
  console.error = function(...args) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    
    const timestamp = new Date().toISOString();
    const errorMessage = `[${timestamp}] ERROR: ${message}\n`;
    
    fs.appendFileSync('logs/error.log', errorMessage, { flag: 'a' });
    originalError.apply(console, args);
  };
  
  // شروع ربات
  console.log('\n' + '🤖'.repeat(30));
  console.log('🤖 ربات آبان تتر - نسخه نهایی');
  console.log('🤖'.repeat(30));
  
  const bot = new AbanTetherBot();
  
  bot.startService().catch(error => {
    console.error('❌ خطای شروع سرویس:', error);
    
    // لاگ خطای شروع
    const fs = require('fs');
    const errorLog = `[${new Date().toISOString()}] STARTUP ERROR: ${error.message}\n${error.stack}\n\n`;
    fs.appendFileSync('error.log', errorLog);
    
    process.exit(1);
  });
}

module.exports = AbanTetherBot;