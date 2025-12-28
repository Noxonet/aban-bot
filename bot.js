// Bot.js - ربات کامل اتوماسیون آبان تتر
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
  TIMEOUT: 45000,
  HEADLESS: true, // برای تست false بگذارید
  
  // تنظیمات تراکنش
  DEPOSIT_AMOUNT: '5000000',
  PASSWORD: 'ImSorryButIhaveTo@1',
  WITHDRAW_ADDRESS: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
  MAX_RETRIES: 3,
  RETRY_DELAY: 5000,
  
  // تنظیمات پولینگ
  POLLING_INTERVAL: 30000, // 30 ثانیه
  BATCH_SIZE: 5
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
  }

  // ==================== روش‌های دیتابیس ====================
  async connectToDatabase() {
    try {
      this.dbClient = new MongoClient(CONFIG.MONGODB_URI);
      await this.dbClient.connect();
      this.db = this.dbClient.db(CONFIG.DB_NAME);
      this.collection = this.db.collection(CONFIG.COLLECTION_NAME);
      console.log('✅ اتصال به دیتابیس موفقیت‌آمیز بود');
      return true;
    } catch (error) {
      console.error('❌ خطا در اتصال به دیتابیس:', error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      const query = {
        $or: [
          { otp_login: { $exists: true, $ne: null, $ne: '' } },
          { otp_register_card: { $exists: true, $ne: null, $ne: '' } },
          { otp_payment: { $exists: true, $ne: null, $ne: '' } }
        ],
        $and: [
          { processed: { $ne: true } },
          { status: { $ne: 'failed' } },
          { 
            $or: [
              { retryCount: { $exists: false } },
              { retryCount: { $lt: CONFIG.MAX_RETRIES } }
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
      return users;
    } catch (error) {
      console.error('❌ خطا در دریافت کاربران:', error.message);
      return [];
    }
  }

  async updateUserStatus(phoneNumber, updateData) {
    try {
      const result = await this.collection.updateOne(
        { personalPhoneNumber: phoneNumber },
        {
          $set: updateData,
          $inc: { retryCount: updateData.status === 'failed' ? 1 : 0 },
          $currentDate: { lastUpdated: true }
        }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      console.error('❌ خطا در آپدیت کاربر:', error.message);
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
      retryReason: reason
    });
  }

  // ==================== روش‌های پلی‌رایت ====================
  async initializeBrowser() {
    try {
      this.browser = await chromium.launch({
        headless: CONFIG.HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        acceptDownloads: false,
        javaScriptEnabled: true,
        locale: 'fa-IR' // برای نمایش بهتر فارسی
      });

      this.page = await this.context.newPage();
      await this.page.setDefaultTimeout(CONFIG.TIMEOUT);
      await this.page.setDefaultNavigationTimeout(CONFIG.TIMEOUT);

      console.log('🌐 مرورگر با موفقیت راه‌اندازی شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در راه‌اندازی مرورگر:', error.message);
      return false;
    }
  }

  async closeBrowser() {
    try {
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
      console.log('🔒 مرورگر بسته شد');
    } catch (error) {
      console.error('خطا در بستن مرورگر:', error.message);
    }
  }

  async navigateTo(url) {
    try {
      console.log(`🌐 در حال رفتن به: ${url}`);
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.TIMEOUT });
      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      console.log('✅ صفحه با موفقیت بارگذاری شد');
      await this.page.waitForTimeout(2000); // تأخیر برای بارگذاری کامل
      return true;
    } catch (error) {
      console.error(`❌ خطا در رفتن به ${url}:`, error.message);
      return false;
    }
  }

  async waitForElement(selector, timeout = 10000) {
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch (error) {
      return false;
    }
  }

  async fillByPlaceholder(placeholder, value) {
    try {
      const selector = `input[placeholder*="${placeholder}"]`;
      await this.page.fill(selector, value);
      console.log(`✅ مقدار "${value}" در فیلد "${placeholder}" وارد شد`);
      await this.page.waitForTimeout(500);
      return true;
    } catch (error) {
      console.error(`❌ خطا در پر کردن فیلد "${placeholder}":`, error.message);
      return false;
    }
  }

  async clickByText(text) {
    try {
      // ابتدا سعی می‌کنیم با XPath کلیک کنیم
      const xpath = `//*[contains(text(), '${text}')]`;
      const elements = await this.page.$x(xpath);
      
      if (elements.length > 0) {
        await elements[0].click();
        console.log(`🖱️ کلیک روی "${text}" (XPath)`);
        await this.page.waitForTimeout(1000);
        return true;
      }
      
      // اگر پیدا نشد، با CSS Selector امتحان می‌کنیم
      const cssSelector = `button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`;
      if (await this.waitForElement(cssSelector, 2000)) {
        await this.page.click(cssSelector);
        console.log(`🖱️ کلیک روی "${text}" (CSS)`);
        await this.page.waitForTimeout(1000);
        return true;
      }
      
      console.error(`❌ پیدا نکردن دکمه "${text}"`);
      return false;
    } catch (error) {
      console.error(`❌ خطا در کلیک روی "${text}":`, error.message);
      return false;
    }
  }

  async clickByTitle(title) {
    try {
      const selector = `[title="${title}"]`;
      if (await this.waitForElement(selector, 2000)) {
        await this.page.click(selector);
        console.log(`🖱️ کلیک روی عنصر با title="${title}"`);
        await this.page.waitForTimeout(1000);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ خطا در کلیک روی title="${title}":`, error.message);
      return false;
    }
  }

  async waitForOtp(fieldType) {
    console.log(`⏳ در انتظار OTP برای ${fieldType}...`);
    
    const phoneNumber = this.currentUser.personalPhoneNumber;
    const startTime = Date.now();
    const timeout = 60000; // 60 ثانیه
    
    while (Date.now() - startTime < timeout) {
      try {
        // چک کردن دیتابیس برای OTP جدید
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
          
          if (otp && otp.length >= 4) {
            console.log(`✅ OTP دریافت شد: ${otp}`);
            return otp;
          }
        }
        
        // منتظر ماندن قبل از چک مجدد
        await this.page.waitForTimeout(2000);
        
      } catch (error) {
        console.error('خطا در انتظار برای OTP:', error.message);
      }
    }
    
    throw new Error(`⏰ تایم‌اوت برای دریافت OTP ${fieldType}`);
  }

  async enterOtp(otp) {
    try {
      // سعی در پر کردن فیلد OTP با placeholder
      const entered = await this.fillByPlaceholder('کد ارسال شده', otp) || 
                     await this.fillByPlaceholder('کد', otp) ||
                     await this.fillByPlaceholder('رمز', otp);
      
      if (!entered) {
        // روش جایگزین: پیدا کردن تمام فیلدهای عددی
        const otpInputs = await this.page.$$('input[type="tel"], input[type="number"]');
        if (otpInputs.length > 0) {
          const otpDigits = otp.toString().split('');
          for (let i = 0; i < Math.min(otpInputs.length, otpDigits.length); i++) {
            await otpInputs[i].fill(otpDigits[i]);
          }
        }
      }
      
      console.log(`✅ OTP وارد شد`);
      return true;
    } catch (error) {
      console.error('❌ خطا در وارد کردن OTP:', error.message);
      return false;
    }
  }

  // ==================== مراحل پردازش کاربر ====================
  async step1_Register() {
    console.log('📝 مرحله 1: ثبت‌نام با شماره موبایل');
    
    try {
      // رفتن به صفحه ثبت‌نام
      await this.navigateTo(CONFIG.REGISTER_URL);
      
      // وارد کردن شماره موبایل
      await this.fillByPlaceholder('شماره موبایل خود را وارد کنید', this.currentUser.personalPhoneNumber);
      
      // کلیک روی دکمه ثبت‌نام
      await this.clickByText('ثبت‌نام');
      await this.page.waitForTimeout(3000);
      
      // چک کردن تغییر URL یا رفتن به مرحله بعد
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/register') || currentUrl !== CONFIG.REGISTER_URL) {
        console.log('✅ خودکار به مرحله بعد رفت');
        return true;
      }
      
      // انتظار برای OTP لاگین
      await this.updateUserStatus(this.currentUser.personalPhoneNumber, { lastStep: 'waiting_for_login_otp' });
      const loginOtp = await this.waitForOtp('login');
      
      if (loginOtp) {
        // وارد کردن OTP
        await this.fillByPlaceholder('کد ارسال شده به شماره موبایل خود را وارد کنید', loginOtp);
        
        // کلیک روی مرحله بعد
        await this.clickByText('بعد');
        await this.page.waitForTimeout(3000);
      }
      
      console.log('✅ مرحله 1 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 1:', error.message);
      throw error;
    }
  }

  async step2_Password() {
    console.log('🔐 مرحله 2: وارد کردن رمز عبور');
    
    try {
      // وارد کردن رمز عبور
      await this.fillByPlaceholder('رمز عبور خود را وارد نمایید', CONFIG.PASSWORD);
      
      // کلیک روی تایید
      await this.clickByTitle('تایید');
      await this.page.waitForTimeout(3000);
      
      console.log('✅ مرحله 2 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 2:', error.message);
      throw error;
    }
  }

  async step3_CompleteProfile() {
    console.log('👤 مرحله 3: تکمیل پروفایل');
    
    try {
      // وارد کردن کد ملی
      await this.fillByPlaceholder('کد ۱۰ رقمی شناسایی خود را وارد کنید', this.currentUser.personalNationalCode);
      
      // وارد کردن تاریخ تولد (فرض می‌کنیم فرمت 1361/12/20 باشد)
      await this.fillByPlaceholder('روز/ماه/سال', this.currentUser.personalBirthDate);
      
      // کلیک روی ثبت
      await this.clickByTitle('ثبت');
      await this.page.waitForTimeout(5000);
      
      // چک کردن اگر باکس تأیید باز شد
      try {
        await this.page.click('button:has-text("باشه"), button:has-text("تأیید"), button:has-text("ادامه")');
        console.log('✅ باکس تأیید کلیک شد');
      } catch (e) {
        // باکس باز نشده، مشکلی نیست
      }
      
      console.log('✅ مرحله 3 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 3:', error.message);
      throw error;
    }
  }

  async step4_NavigateToWallet() {
    console.log('💰 مرحله 4: رفتن به کیف پول');
    
    try {
      // هاور روی منوی سایدبار
      const sideMenu = await this.page.$('.SideMenu_wrapper__XuXfv');
      if (sideMenu) {
        await sideMenu.hover();
        await this.page.waitForTimeout(1000);
      }
      
      // کلیک روی کیف پول
      const walletLink = await this.page.$('[data-testid="link-sidebar-wallet"]');
      if (walletLink) {
        await walletLink.click();
      } else {
        await this.page.click('a:has-text("کیف پول")');
      }
      
      await this.page.waitForTimeout(3000);
      
      console.log('✅ مرحله 4 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 4:', error.message);
      throw error;
    }
  }

  async step5_AddContract() {
    console.log('📄 مرحله 5: افزودن قرارداد');
    
    try {
      // کلیک روی واریز
      await this.clickByTitle('واریز');
      await this.page.waitForTimeout(2000);
      
      // کلیک روی تومان
      await this.page.click('p:has-text("تومان")');
      await this.page.waitForTimeout(2000);
      
      // رفتن به صفحه واریز مستقیم
      await this.navigateTo(CONFIG.DEPOSIT_URL);
      
      // کلیک روی افزودن قرارداد
      await this.clickByTitle('افزودن قرارداد');
      await this.page.waitForTimeout(2000);
      
      // انتخاب بانک
      await this.page.click('div:has-text("نام بانک خود را انتخاب نمایید")');
      await this.page.waitForTimeout(1000);
      
      // انتخاب بانک براساس دیتابیس
      const bankName = this.getBankName(this.currentUser.cardNumber);
      await this.page.click(`p:has-text("${bankName}")`);
      await this.page.waitForTimeout(1000);
      
      // انتخاب مدت قرارداد
      await this.page.click('div:has-text("مدت قرارداد خود را انتخاب کنید")');
      await this.page.waitForTimeout(1000);
      await this.page.click('p:has-text("1 ماهه")');
      await this.page.waitForTimeout(1000);
      
      // کلیک روی ثبت و ادامه
      await this.clickByTitle('ثبت و ادامه');
      await this.page.waitForTimeout(3000);
      
      console.log('✅ مرحله 5 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 5:', error.message);
      throw error;
    }
  }

  async step6_BankProcess() {
    console.log('🏦 مرحله 6: پردازش بانکی');
    
    try {
      const bankName = this.getBankName(this.currentUser.cardNumber);
      
      // بررسی نوع بانک و انجام مراحل مربوطه
      if (bankName === 'بانک ملی') {
        await this.processBankMelli();
      } else if (bankName === 'بانک مهر ایران') {
        await this.processBankMellat();
      } else {
        // برای بانک‌های دیگر، منتظر OTP کارت
        await this.updateUserStatus(this.currentUser.personalPhoneNumber, { lastStep: 'waiting_for_card_otp' });
        const cardOtp = await this.waitForOtp('register_card');
        
        if (cardOtp) {
          await this.enterOtp(cardOtp);
          await this.clickByText('تأیید');
        }
      }
      
      await this.page.waitForTimeout(5000);
      
      // کلیک روی ثبت قرارداد
      await this.clickByText('ثبت قرار داد');
      await this.page.waitForTimeout(3000);
      
      console.log('✅ مرحله 6 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 6:', error.message);
      throw error;
    }
  }

  async processBankMelli() {
    console.log('🏦 پردازش بانک ملی');
    
    // کلیک روی ورود با کارت بانک ملی
    await this.page.click('div:has-text("ورود با کارت بانک ملی"), p:has-text("ورود با کارت بانک ملی")');
    await this.page.waitForTimeout(3000);
    
    // وارد کردن شماره کارت
    const cardLabel = await this.page.$('label:has-text("شماره کارت")');
    if (cardLabel) {
      const cardInput = await cardLabel.evaluateHandle(el => el.nextElementSibling);
      await cardInput.fill(this.currentUser.cardNumber);
    }
    
    // وارد کردن کپچا (در اینجا نیاز به OCR داریم، فعلاً دستی)
    console.log('⚠️ نیاز به وارد کردن دستی کپچا');
    await this.page.waitForTimeout(10000); // زمان برای وارد کردن دستی
    
    // کلیک روی ارسال رمز فعالسازی
    await this.clickByText('ارسال رمز فعالسازی');
    
    // انتظار برای OTP
    await this.updateUserStatus(this.currentUser.personalPhoneNumber, { lastStep: 'waiting_for_card_otp' });
    const cardOtp = await this.waitForOtp('register_card');
    
    if (cardOtp) {
      await this.enterOtp(cardOtp);
      await this.clickByText('ادامه');
    }
  }

  async processBankMellat() {
    console.log('🏦 پردازش بانک مهر ایران');
    
    // وارد کردن شماره کارت
    await this.fillByPlaceholder('شماره کارت', this.currentUser.cardNumber);
    
    // وارد کردن CVV2
    await this.fillByPlaceholder('CVV2', this.currentUser.cvv2);
    
    // وارد کردن ماه انقضا
    await this.fillByPlaceholder('ماه', this.currentUser.bankMonth.toString());
    
    // وارد کردن سال انقضا
    await this.fillByPlaceholder('سال', this.currentUser.bankYear.toString());
    
    // وارد کردن کپچا (دستی)
    console.log('⚠️ نیاز به وارد کردن دستی کپچا');
    await this.page.waitForTimeout(10000);
    
    // کلیک روی دریافت رمز پویا
    await this.clickByText('دریافت رمز پویا');
    
    // انتظار برای OTP
    await this.updateUserStatus(this.currentUser.personalPhoneNumber, { lastStep: 'waiting_for_card_otp' });
    const cardOtp = await this.waitForOtp('register_card');
    
    if (cardOtp) {
      await this.fillByPlaceholder('رمز دوم', cardOtp);
      await this.clickByText('تایید');
    }
  }

  async step7_Deposit() {
    console.log('💵 مرحله 7: واریز تومان');
    
    try {
      // برگشت به صفحه اصلی یا کیف پول
      await this.navigateTo(CONFIG.BASE_URL);
      await this.step4_NavigateToWallet();
      
      // وارد کردن مبلغ
      await this.fillByPlaceholder('مبلغ واریز را به تومان وارد نمایید', CONFIG.DEPOSIT_AMOUNT);
      
      // انتخاب بانک از لیست
      const bankList = await this.page.$('#bank-list');
      if (bankList) {
        await bankList.click();
        await this.page.waitForTimeout(1000);
        
        const bankName = this.getBankName(this.currentUser.cardNumber);
        await this.page.click(`p:has-text("${bankName}")`);
      }
      
      // کلیک روی واریز
      await this.clickByTitle('واریز');
      await this.page.waitForTimeout(2000);
      
      // کلیک روی تایید و پرداخت
      await this.clickByTitle('تایید و پرداخت');
      await this.page.waitForTimeout(3000);
      
      // انتظار برای OTP پرداخت
      await this.updateUserStatus(this.currentUser.personalPhoneNumber, { lastStep: 'waiting_for_payment_otp' });
      const paymentOtp = await this.waitForOtp('payment');
      
      if (paymentOtp) {
        await this.enterOtp(paymentOtp);
        await this.clickByText('تأیید');
      }
      
      await this.page.waitForTimeout(5000);
      
      console.log('✅ مرحله 7 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 7:', error.message);
      throw error;
    }
  }

  async step8_BuyTether() {
    console.log('🔄 مرحله 8: خرید تتر');
    
    try {
      // رفتن به صفحه خرید
      await this.navigateTo(CONFIG.BUY_URL);
      await this.page.waitForTimeout(3000);
      
      // پیدا کردن و کلیک روی دکمه خرید
      const buyButton = await this.page.$('.Button_button__A32Lt.Button_filled-primary__B_qAg');
      if (buyButton) {
        await buyButton.click();
      } else {
        await this.clickByText('خرید');
      }
      
      await this.page.waitForTimeout(2000);
      
      // وارد کردن مبلغ
      const amountInput = await this.page.$('.Input_input__wMmzD.Input_ltr__7PqEB');
      if (amountInput) {
        await amountInput.fill(CONFIG.DEPOSIT_AMOUNT);
      }
      
      // کلیک روی ثبت سفارش
      await this.clickByTitle('ثبت سفارش');
      await this.page.waitForTimeout(5000);
      
      console.log('✅ مرحله 8 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 8:', error.message);
      throw error;
    }
  }

  async step9_WithdrawTether() {
    console.log('📤 مرحله 9: برداشت تتر');
    
    try {
      // رفتن به صفحه برداشت
      await this.navigateTo(CONFIG.WITHDRAW_URL);
      await this.page.waitForTimeout(3000);
      
      // جستجوی تتر
      await this.fillByPlaceholder('جستجو', 'تتر');
      await this.page.waitForTimeout(2000);
      
      // کلیک روی تتر
      await this.page.click('p:has-text("تتر")');
      await this.page.waitForTimeout(2000);
      
      // وارد کردن آدرس ولت
      await this.fillByPlaceholder('آدرس ولت مقصد خود را وارد کنید', CONFIG.WITHDRAW_ADDRESS);
      
      // کلیک روی برداشت کل موجودی
      await this.clickByTitle(/برداشت کل موجودی/);
      await this.page.waitForTimeout(2000);
      
      // کلیک روی ثبت برداشت
      await this.clickByTitle('ثبت برداشت');
      await this.page.waitForTimeout(5000);
      
      console.log('✅ مرحله 9 تکمیل شد');
      return true;
    } catch (error) {
      console.error('❌ خطا در مرحله 9:', error.message);
      throw error;
    }
  }

  // ==================== روش‌های کمکی ====================
  getBankName(cardNumber) {
    // تشخیص بانک براساس شماره کارت
    const firstSix = cardNumber.substring(0, 6);
    
    // بانک ملی: 603799
    if (cardNumber.startsWith('603799')) {
      return 'بانک ملی';
    }
    // بانک مهر ایران: 610433
    else if (cardNumber.startsWith('610433')) {
      return 'بانک مهر ایران';
    }
    // بانک کشاورزی: 603770
    else if (cardNumber.startsWith('603770')) {
      return 'بانک کشاورزی';
    }
    // بانک تجارت: 585983
    else if (cardNumber.startsWith('585983')) {
      return 'بانک تجارت';
    }
    // پیش‌فرض
    else {
      return 'بانک ملی';
    }
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUser = user;
    
    let currentStep = 'start';
    
    try {
      console.log(`\n🚀 شروع پردازش کاربر: ${phoneNumber}`);
      console.log(`📱 شماره موبایل: ${phoneNumber}`);
      console.log(`🏦 بانک: ${this.getBankName(user.cardNumber)}`);
      
      // چک کردن تعداد تلاش‌های قبلی
      const retryCount = user.retryCount || 0;
      if (retryCount >= CONFIG.MAX_RETRIES) {
        console.log(`⛔ کاربر ${phoneNumber} به حداکثر تلاش‌ها رسیده است`);
        await this.markAsFailed(phoneNumber, 'حداکثر تلاش‌ها انجام شده', 'max_retries');
        return false;
      }
      
      // علامت‌گذاری به عنوان در حال پردازش
      await this.markAsProcessing(phoneNumber);
      
      // راه‌اندازی مرورگر
      if (!await this.initializeBrowser()) {
        throw new Error('راه‌اندازی مرورگر ناموفق بود');
      }
      
      // اجرای مراحل
      const steps = [
        { name: 'ثبت‌نام', method: () => this.step1_Register(), retryable: true },
        { name: 'رمز عبور', method: () => this.step2_Password(), retryable: true },
        { name: 'تکمیل پروفایل', method: () => this.step3_CompleteProfile(), retryable: true },
        { name: 'کیف پول', method: () => this.step4_NavigateToWallet(), retryable: true },
        { name: 'افزودن قرارداد', method: () => this.step5_AddContract(), retryable: true },
        { name: 'پردازش بانکی', method: () => this.step6_BankProcess(), retryable: true },
        { name: 'واریز تومان', method: () => this.step7_Deposit(), retryable: true },
        { name: 'خرید تتر', method: () => this.step8_BuyTether(), retryable: true },
        { name: 'برداشت تتر', method: () => this.step9_WithdrawTether(), retryable: true }
      ];
      
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        currentStep = step.name;
        
        console.log(`\n📋 مرحله ${i + 1}/${steps.length}: ${step.name}`);
        
        try {
          await step.method();
          await this.updateUserStatus(phoneNumber, { lastStep: step.name + '_completed' });
          
          // تأخیر بین مراحل
          if (i < steps.length - 1) {
            await this.page.waitForTimeout(2000);
          }
          
        } catch (stepError) {
          console.error(`❌ خطا در مرحله "${step.name}":`, stepError.message);
          
          if (step.retryable && retryCount < CONFIG.MAX_RETRIES - 1) {
            console.log(`🔄 تلاش مجدد برای مرحله "${step.name}"...`);
            await this.markAsRetry(phoneNumber, step.name, stepError.message);
            
            // بستن مرورگر و شروع مجدد
            await this.closeBrowser();
            await this.page.waitForTimeout(CONFIG.RETRY_DELAY);
            
            // راه‌اندازی مجدد مرورگر
            if (!await this.initializeBrowser()) {
              throw new Error('راه‌اندازی مجدد مرورگر ناموفق بود');
            }
            
            // تلاش مجدد برای مرحله فعلی
            i--;
            continue;
          } else {
            throw stepError;
          }
        }
      }
      
      // تکمیل موفقیت‌آمیز
      await this.markAsCompleted(phoneNumber, {
        completedAt: new Date(),
        processingTime: Date.now() - (user.startedAt?.getTime() || Date.now()),
        completedSteps: steps.map(s => s.name)
      });
      
      console.log(`🎉 پردازش کاربر ${phoneNumber} با موفقیت تکمیل شد`);
      return true;
      
    } catch (error) {
      console.error(`💥 خطای بحرانی برای کاربر ${phoneNumber}:`, error.message);
      
      await this.markAsFailed(phoneNumber, error.message, currentStep);
      return false;
      
    } finally {
      // بستن مرورگر
      await this.closeBrowser();
      
      // حذف از لیست پردازش‌های فعال
      this.activeProcesses.delete(phoneNumber);
      this.currentUser = null;
    }
  }

  // ==================== سرویس اصلی ====================
  async startService() {
    console.log('🚀 سرویس ربات آبان تتر شروع شد');
    console.log('⏱️ چک دیتابیس هر 30 ثانیه');
    console.log('🔧 تنظیمات:', {
      حداکثر_تلاش: CONFIG.MAX_RETRIES,
      مبلغ_واریز: CONFIG.DEPOSIT_AMOUNT,
      آدرس_برداشت: CONFIG.WITHDRAW_ADDRESS,
      حالت_headless: CONFIG.HEADLESS
    });
    
    // اتصال به دیتابیس
    if (!await this.connectToDatabase()) {
      console.error('❌ خاتمه به دلیل خطای دیتابیس');
      return;
    }
    
    // شروع پولینگ
    this.startPolling();
    
    // هندل کردن خاتمه برنامه
    process.on('SIGINT', async () => {
      console.log('\n🛑 دریافت سیگنال خاتمه...');
      await this.stopService();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\n🛑 دریافت سیگنال ترمینیت...');
      await this.stopService();
      process.exit(0);
    });
  }

  async startPolling() {
    const poll = async () => {
      try {
        if (this.isProcessing) {
          console.log('⏸️ در حال پردازش کاربران دیگر، رد شدن از چک');
          return;
        }
        
        this.isProcessing = true;
        
        // دریافت کاربران در انتظار
        const pendingUsers = await this.getPendingUsers();
        
        // پردازش هر کاربر
        for (const user of pendingUsers) {
          // چک کردن اگر کاربر در حال پردازش است
          if (this.activeProcesses.has(user.personalPhoneNumber)) {
            console.log(`⏭️ کاربر ${user.personalPhoneNumber} در حال پردازش است`);
            continue;
          }
          
          // افزودن به لیست پردازش‌های فعال
          this.activeProcesses.set(user.personalPhoneNumber, true);
          
          // پردازش غیرهمزمان
          this.processUser(user).catch(error => {
            console.error(`خطا در پردازش کاربر ${user.personalPhoneNumber}:`, error.message);
            this.activeProcesses.delete(user.personalPhoneNumber);
          });
        }
        
      } catch (error) {
        console.error('❌ خطا در پولینگ:', error.message);
      } finally {
        this.isProcessing = false;
      }
    };
    
    // اجرای اولیه
    await poll();
    
    // تنظیم تایمر برای پولینگ دوره‌ای
    setInterval(poll, CONFIG.POLLING_INTERVAL);
    
    console.log(`✅ پولینگ فعال شد (هر ${CONFIG.POLLING_INTERVAL / 1000} ثانیه)`);
  }

  async stopService() {
    console.log('🛑 توقف سرویس...');
    
    // بستن مرورگر
    await this.closeBrowser();
    
    // بستن اتصال دیتابیس
    if (this.dbClient) {
      await this.dbClient.close();
      console.log('🔒 اتصال دیتابیس بسته شد');
    }
    
    console.log('👋 سرویس متوقف شد');
  }
}

// ==================== اجرای برنامه ====================
if (require.main === module) {
  // مدیریت خطاهای غیرمنتظره
  process.on('uncaughtException', (error) => {
    console.error('🔥 خطای غیرمنتظره:', error);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 ریجکت نشده در:', promise, 'به دلیل:', reason);
  });
  
  // ایجاد و شروع ربات
  const bot = new AbanTetherBot();
  bot.startService().catch(error => {
    console.error('❌ خطای شروع سرویس:', error);
    process.exit(1);
  });
}

module.exports = AbanTetherBot;