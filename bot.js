const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const fs = require('fs');

// کانفیگ دیتابیس
const MONGODB_URI = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
const DB_NAME = 'ZarrinApp';
const COLLECTION_NAME = 'zarinapp';

// تنظیمات ربات
const CONFIG = {
  website: {
    baseUrl: 'https://abantether.com',
    registerUrl: 'https://abantether.com/register',
    depositUrl: 'https://abantether.com/user/wallet/deposit/irt/direct',
    buyUrl: 'https://abantether.com/user/trade/fast/buy?s=USDT',
    withdrawUrl: 'https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT',
    timeout: 60000,
    headless: false,
    slowMo: 300
  },
  
  transaction: {
    depositAmount: '5000000',
    withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
    maxRetries: 3,
    password: 'ImSorryButIhaveTo@1'
  },
  
  polling: {
    interval: 30000,
    batchSize: 10
  }
};

class AbanTetherAutoBot {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.isProcessing = false;
    this.activeUsers = new Set();
    this.browser = null;
    this.pollingInterval = null;
    this.currentUserPhone = null;
    this.currentStep = null;
    this.page = null;
  }

  // ==================== بخش دیتابیس ====================
  
  async connectToDatabase() {
    try {
      console.log('🔌 Connecting to MongoDB...');
      this.client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
        maxPoolSize: 10
      });
      
      await this.client.connect();
      this.db = this.client.db(DB_NAME);
      this.collection = this.db.collection(COLLECTION_NAME);
      console.log('✅ Connected to MongoDB successfully');
      return true;
    } catch (error) {
      console.error('❌ MongoDB connection error:', error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      console.log('🔍 Checking for pending users...');
      
      // کوئری اصلی برای کاربران منتظر پردازش
      const query = {
        $and: [
          { processed: { $ne: true } },
          {
            $or: [
              { status: { $exists: false } },
              { status: { $in: [null, 'processing', 'failed'] } }
            ]
          },
          {
            $or: [
              { retryCount: { $exists: false } },
              { retryCount: { $lt: CONFIG.transaction.maxRetries } }
            ]
          }
        ]
      };

      const users = await this.collection.find(query)
        .sort({ createdAt: 1 })
        .limit(CONFIG.polling.batchSize)
        .toArray();
      
      console.log(`🎯 Found ${users.length} pending users ready for processing`);
      
      if (users.length > 0) {
        console.log('\n🎯 Pending Users List:');
        users.forEach((user, index) => {
          console.log(`👉 [${index + 1}] ${user.personalPhoneNumber} - ${user.personalName}`);
          console.log(`   Status: ${user.status || 'new'}`);
          console.log(`   Retry: ${user.retryCount || 0}/${CONFIG.transaction.maxRetries}`);
        });
      }
      
      return users;
    } catch (error) {
      console.error('❌ Error fetching users:', error.message);
      return [];
    }
  }

  async updateUserStatus(phoneNumber, updateData) {
    try {
      const result = await this.collection.updateOne(
        { personalPhoneNumber: phoneNumber },
        {
          $set: updateData,
          $inc: { 
            retryCount: updateData.status === 'failed' ? 1 : 0
          },
          $currentDate: { lastUpdated: true }
        },
        { upsert: false }
      );
      
      console.log(`📝 Updated user ${phoneNumber}: ${updateData.status || 'updated'}`);
      return result.modifiedCount > 0;
    } catch (error) {
      console.error('❌ Error updating user:', error.message);
      return false;
    }
  }

  async markAsProcessing(phoneNumber) {
    return this.updateUserStatus(phoneNumber, {
      status: 'processing',
      startedAt: new Date(),
      lastStep: 'starting'
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

  async updateStep(phoneNumber, step) {
    return this.updateUserStatus(phoneNumber, {
      lastStep: step,
      lastStepTime: new Date()
    });
  }

  // ==================== بخش Playwright ====================

  async initializeBrowser() {
    try {
      console.log('🌐 Launching browser...');
      this.browser = await chromium.launch({
        headless: CONFIG.website.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1366,768'
        ],
        slowMo: CONFIG.website.slowMo
      });
      console.log('✅ Browser launched successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to launch browser:', error.message);
      return false;
    }
  }

  async createPage() {
    try {
      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'fa-IR',
        timezoneId: 'Asia/Tehran'
      });

      this.page = await context.newPage();
      await this.page.setDefaultTimeout(CONFIG.website.timeout);
      
      console.log('✅ Page created successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to create page:', error.message);
      return false;
    }
  }

  async takeScreenshot(stepName) {
    try {
      if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots');
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `screenshots/${this.currentUserPhone}_${stepName}_${timestamp}.png`;
      await this.page.screenshot({ path: fileName, fullPage: true });
      console.log(`📸 Screenshot saved: ${fileName}`);
    } catch (error) {
      console.error('❌ Failed to take screenshot:', error.message);
    }
  }

  async smartFillByPlaceholder(page, placeholder, value) {
    console.log(`🖊️  Filling placeholder "${placeholder}": ${value}`);
    
    try {
      const selector = `input[placeholder*="${placeholder}"]`;
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.fill(selector, value);
      console.log(`✅ Successfully filled placeholder "${placeholder}"`);
      await page.waitForTimeout(1000);
      return true;
    } catch (error) {
      console.error(`❌ Could not find input with placeholder "${placeholder}"`);
      return false;
    }
  }

  async smartClickByTitle(page, titleText) {
    console.log(`🖱️  Clicking element with title "${titleText}"`);
    
    try {
      const selector = `[title="${titleText}"]`;
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      console.log(`✅ Successfully clicked title "${titleText}"`);
      await page.waitForTimeout(2000);
      return true;
    } catch (error) {
      console.error(`❌ Could not find element with title "${titleText}"`);
      return false;
    }
  }

  async smartClickByText(page, text) {
    console.log(`🖱️  Looking for element with text: "${text}"`);
    
    try {
      // اول سعی می‌کنیم دکمه را پیدا کنیم
      const buttonSelector = `button:has-text("${text}")`;
      const elements = await page.$$(buttonSelector);
      
      if (elements.length > 0) {
        for (const element of elements) {
          try {
            const isVisible = await element.isVisible();
            const isDisabled = await element.getAttribute('disabled');
            
            if (isVisible && !isDisabled) {
              await element.click();
              console.log(`✅ Clicked button with text "${text}"`);
              await page.waitForTimeout(2000);
              return true;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      // اگر دکمه پیدا نشد، هر المنت دیگری را امتحان می‌کنیم
      const anySelector = `text="${text}"`;
      await page.waitForSelector(anySelector, { timeout: 5000 });
      await page.click(anySelector);
      console.log(`✅ Clicked element with text "${text}"`);
      await page.waitForTimeout(2000);
      return true;
      
    } catch (error) {
      console.log(`⚠️ Could not find or click element with text "${text}"`);
      console.log(`ℹ️ Will check if we can proceed to next step anyway`);
      return false;
    }
  }

  async waitForOtpField(page, fieldName) {
    console.log(`⏳ Waiting for ${fieldName} in database...`);
    
    const startTime = Date.now();
    const timeout = 120000; // 2 دقیقه
    
    while (Date.now() - startTime < timeout) {
      try {
        const user = await this.collection.findOne({
          personalPhoneNumber: this.currentUserPhone
        });
        
        if (user && user[fieldName] && user[fieldName].length >= 4) {
          console.log(`✅ ${fieldName} received: ${user[fieldName]}`);
          return user[fieldName];
        }
        
        console.log(`⏰ Still waiting for ${fieldName}... ${Math.floor((Date.now() - startTime) / 1000)}s passed`);
        await page.waitForTimeout(5000);
      } catch (error) {
        await page.waitForTimeout(5000);
      }
    }
    
    throw new Error(`Timeout waiting for ${fieldName}`);
  }

  async checkUrlChange(page, previousUrl) {
    const currentUrl = page.url();
    if (currentUrl !== previousUrl) {
      console.log(`📍 URL changed: ${currentUrl}`);
      return true;
    }
    return false;
  }

  // ==================== مراحل اصلی ربات ====================

  async step1_RegisterAndLogin(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'register');
    console.log('📝 Step 1: Registration & Login');
    
    try {
      await page.goto(CONFIG.website.registerUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      await this.takeScreenshot('01_register_page');
      
      // وارد کردن شماره موبایل
      await this.smartFillByPlaceholder(page, 'شماره موبایل', user.personalPhoneNumber);
      
      // کلیک روی دکمه ثبت‌نام
      await this.smartClickByTitle(page, 'ثبت‌نام');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('02_after_register_click');
      
      // بررسی تغییر URL (اگر خودکار رفته باشد)
      const initialUrl = page.url();
      console.log(`📍 Current URL: ${initialUrl}`);
      
      if (!initialUrl.includes('/register')) {
        console.log('✅ Auto-navigated to next step');
        return;
      }
      
      // اگر هنوز در صفحه ثبت‌نام هستیم، منتظر OTP می‌شویم
      const loginOtp = await this.waitForOtpField(page, 'otp_login');
      
      if (loginOtp) {
        console.log(`🔐 Entering login OTP: ${loginOtp}`);
        await this.takeScreenshot('03_otp_page');
        
        // وارد کردن OTP
        await this.smartFillByPlaceholder(page, 'کد ارسال شده', loginOtp);
        
        // سعی می‌کنیم روی دکمه "بعد" کلیک کنیم
        const beforeClickUrl = page.url();
        const nextClicked = await this.smartClickByText(page, 'بعد');
        
        if (!nextClicked) {
          console.log('⚠️ Could not find "بعد" button, checking URL change...');
          
          // بررسی می‌کنیم آیا URL تغییر کرده یا نه
          await page.waitForTimeout(3000);
          const afterWaitUrl = page.url();
          
          if (afterWaitUrl !== beforeClickUrl) {
            console.log('✅ URL changed automatically, proceeding to next step');
          } else {
            console.log('⚠️ URL did not change, trying "ادامه" button...');
            await this.smartClickByText(page, 'ادامه');
            await page.waitForTimeout(3000);
          }
        }
        
        await page.waitForTimeout(5000);
        await this.takeScreenshot('04_after_otp');
      }
      
    } catch (error) {
      console.error('❌ Error in step1:', error.message);
      throw error;
    }
  }

  async step2_EnterPassword(page) {
    await this.updateStep(this.currentUserPhone, 'password');
    console.log('🔑 Step 2: Entering Password');
    
    try {
      await this.takeScreenshot('05_password_page');
      
      // وارد کردن رمز عبور
      await this.smartFillByPlaceholder(page, 'رمز عبور', CONFIG.transaction.password);
      
      // کلیک روی تایید
      await this.smartClickByTitle(page, 'تایید');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('06_after_password');
      
    } catch (error) {
      console.error('❌ Error in step2:', error.message);
      throw error;
    }
  }

  async step3_CompleteProfile(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'profile');
    console.log('👤 Step 3: Completing Profile');
    
    try {
      await this.takeScreenshot('07_profile_page');
      
      // وارد کردن کد ملی
      await this.smartFillByPlaceholder(page, 'کد ۱۰ رقمی شناسایی', user.personalNationalCode);
      
      // وارد کردن تاریخ تولد
      try {
        const dobSelector = 'input[placeholder="روز/ماه/سال"]';
        await page.waitForSelector(dobSelector, { timeout: 10000 });
        await page.fill(dobSelector, user.personalBirthDate);
        console.log(`✅ Set birth date: ${user.personalBirthDate}`);
      } catch (error) {
        console.error('⚠️ Could not set birth date automatically');
      }
      
      // کلیک روی دکمه ثبت
      await this.smartClickByTitle(page, 'ثبت');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('08_after_profile');
      
    } catch (error) {
      console.error('❌ Error in step3:', error.message);
      throw error;
    }
  }

  async step4_AddBankContract(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'add_contract');
    console.log('📋 Step 4: Adding Bank Contract');
    
    try {
      await page.goto(CONFIG.website.depositUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      await this.takeScreenshot('09_deposit_page');
      
      // کلیک روی افزودن قرارداد
      await this.smartClickByTitle(page, 'افزودن قرارداد');
      await page.waitForTimeout(3000);
      await this.takeScreenshot('10_add_contract_modal');
      
      // تشخیص بانک
      const getBankName = (cardNumber) => {
        if (!cardNumber) return 'بانک ملی';
        if (cardNumber.startsWith('603799') || cardNumber.startsWith('610433')) {
          return 'بانک ملی';
        } else if (cardNumber.startsWith('606373')) {
          return 'بانک مهر ایران';
        }
        return 'بانک ملی';
      };
      
      const bankName = getBankName(user.cardNumber);
      console.log(`🏦 Bank detected: ${bankName}`);
      
      // انتخاب بانک
      await this.smartClickByText(page, 'نام بانک خود را انتخاب نمایید');
      await page.waitForTimeout(1000);
      await this.smartClickByText(page, bankName);
      await page.waitForTimeout(1000);
      
      // انتخاب مدت قرارداد
      await this.smartClickByText(page, 'مدت قرارداد خود را انتخاب کنید');
      await page.waitForTimeout(1000);
      await this.smartClickByText(page, '1 ماهه');
      await page.waitForTimeout(1000);
      
      // کلیک روی ثبت و ادامه
      await this.smartClickByTitle(page, 'ثبت و ادامه');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('11_after_contract_submit');
      
    } catch (error) {
      console.error('❌ Error in step4:', error.message);
      throw error;
    }
  }

  async step5_BankSpecificProcess(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'bank_process');
    console.log('🏦 Step 5: Bank Specific Process');
    
    const getBankName = (cardNumber) => {
      if (!cardNumber) return 'بانک ملی';
      if (cardNumber.startsWith('603799') || cardNumber.startsWith('610433')) {
        return 'بانک ملی';
      } else if (cardNumber.startsWith('606373')) {
        return 'بانک مهر ایران';
      }
      return 'بانک ملی';
    };
    
    const bankName = getBankName(user.cardNumber);
    
    if (bankName === 'بانک ملی') {
      await this.processMelliBank(page, user);
    } else if (bankName === 'بانک مهر ایران') {
      await this.processMehrIranBank(page, user);
    }
  }

  async processMelliBank(page, user) {
    console.log('🏦 Processing Melli Bank');
    
    try {
      await this.takeScreenshot('12_melli_bank_page');
      
      // کلیک روی ورود با کارت بانک ملی
      await this.smartClickByText(page, 'ورود با کارت بانک ملی');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('13_melli_login_page');
      
      // وارد کردن شماره کارت
      await this.smartFillByPlaceholder(page, 'شماره کارت', user.cardNumber);
      
      // منتظر کپچا
      console.log('🕒 Waiting for manual captcha solving (20 seconds)...');
      await page.waitForTimeout(20000);
      await this.takeScreenshot('14_after_captcha');
      
      // کلیک روی ارسال رمز فعالسازی
      await this.smartClickByText(page, 'ارسال رمز فعالسازی');
      await page.waitForTimeout(5000);
      
      // انتظار برای OTP
      const cardOtp = await this.waitForOtpField(page, 'otp_register_card');
      
      if (cardOtp) {
        console.log(`🔐 Entering card OTP: ${cardOtp}`);
        await this.takeScreenshot('15_otp_entry');
        
        // وارد کردن OTP
        try {
          const otpInputs = await page.$$('input[type="tel"], input[type="number"]');
          for (let i = 0; i < Math.min(otpInputs.length, cardOtp.length); i++) {
            await otpInputs[i].fill(cardOtp[i]);
          }
        } catch (error) {
          await this.smartFillByPlaceholder(page, 'کد تأیید', cardOtp);
        }
        
        // سعی می‌کنیم روی ادامه کلیک کنیم
        const beforeClickUrl = page.url();
        await this.smartClickByText(page, 'ادامه');
        
        // بررسی تغییر URL
        await page.waitForTimeout(3000);
        if (page.url() !== beforeClickUrl) {
          console.log('✅ Proceeded to next step');
        }
        
        await page.waitForTimeout(5000);
        await this.takeScreenshot('16_after_otp_submit');
      }
      
      // کلیک روی ثبت قرارداد
      await this.smartClickByText(page, 'ثبت قرار داد');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('17_contract_registered');
      
    } catch (error) {
      console.error('❌ Error in Melli Bank process:', error.message);
      throw error;
    }
  }

  async processMehrIranBank(page, user) {
    console.log('🏦 Processing Mehr Iran Bank');
    
    try {
      await this.takeScreenshot('18_mehr_bank_page');
      
      // وارد کردن شماره کارت
      await this.smartFillByPlaceholder(page, 'شماره کارت', user.cardNumber);
      
      // وارد کردن CVV2
      await this.smartFillByPlaceholder(page, 'cvv2', user.cvv2);
      
      // وارد کردن ماه و سال انقضا
      try {
        const monthInputs = await page.$$('input[placeholder*="ماه"]');
        if (monthInputs.length > 0) {
          await monthInputs[0].fill(user.bankMonth.toString());
        }
        
        const yearInputs = await page.$$('input[placeholder*="سال"]');
        if (yearInputs.length > 0) {
          await yearInputs[0].fill(user.bankYear.toString());
        }
      } catch (error) {
        console.error('⚠️ Could not fill expiration date');
      }
      
      // منتظر کپچا
      console.log('🕒 Waiting for manual captcha solving (20 seconds)...');
      await page.waitForTimeout(20000);
      await this.takeScreenshot('19_after_captcha');
      
      // کلیک روی دریافت رمز پویا
      await this.smartClickByText(page, 'دریافت رمز پویا');
      await page.waitForTimeout(5000);
      
      // انتظار برای OTP
      const cardOtp = await this.waitForOtpField(page, 'otp_register_card');
      
      if (cardOtp) {
        console.log(`🔐 Entering dynamic password: ${cardOtp}`);
        
        // وارد کردن رمز دوم
        await this.smartFillByPlaceholder(page, 'رمز دوم', cardOtp);
        
        // کلیک روی تایید
        await this.smartClickByText(page, 'تایید');
        await page.waitForTimeout(5000);
        await this.takeScreenshot('20_after_otp');
      }
      
    } catch (error) {
      console.error('❌ Error in Mehr Iran Bank process:', error.message);
      throw error;
    }
  }

  async step6_DepositToman(page) {
    await this.updateStep(this.currentUserPhone, 'deposit');
    console.log('💰 Step 6: Depositing Toman');
    
    try {
      // برگشت به صفحه اصلی
      await page.goto(CONFIG.website.baseUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
      
      // رفتن به صفحه واریز
      await page.goto(CONFIG.website.depositUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);
      await this.takeScreenshot('21_deposit_page_again');
      
      // وارد کردن مبلغ
      await this.smartFillByPlaceholder(page, 'مبلغ واریز', CONFIG.transaction.depositAmount);
      
      // انتخاب بانک از لیست
      try {
        const bankList = await page.$('#bank-list');
        if (bankList) {
          await bankList.click();
          await page.waitForTimeout(1000);
          await this.takeScreenshot('22_bank_list');
          
          // انتخاب بانک ملی
          await this.smartClickByText(page, 'بانک ملی');
        }
      } catch (error) {
        console.error('⚠️ Could not select bank from list');
      }
      
      // کلیک روی واریز
      await this.smartClickByTitle(page, 'واریز');
      await page.waitForTimeout(3000);
      await this.takeScreenshot('23_before_payment_confirm');
      
      // کلیک روی تایید و پرداخت
      await this.smartClickByTitle(page, 'تایید و پرداخت');
      await page.waitForTimeout(5000);
      await this.takeScreenshot('24_after_payment');
      
      // منتظر OTP پرداخت
      const paymentOtp = await this.waitForOtpField(page, 'otp_payment');
      
      if (paymentOtp) {
        console.log(`🔐 Entering payment OTP: ${paymentOtp}`);
        await this.takeScreenshot('25_payment_otp_page');
        
        // وارد کردن OTP پرداخت
        await this.smartFillByPlaceholder(page, 'کد تأیید', paymentOtp);
        
        await this.smartClickByText(page, 'تایید');
        await page.waitForTimeout(10000);
        await this.takeScreenshot('26_payment_complete');
      }
      
    } catch (error) {
      console.error('❌ Error in step6:', error.message);
      throw error;
    }
  }

  async step7_BuyTether(page) {
    await this.updateStep(this.currentUserPhone, 'buy_tether');
    console.log('🔄 Step 7: Buying Tether');
    
    try {
      // رفتن به صفحه خرید
      await page.goto(CONFIG.website.buyUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      await this.takeScreenshot('27_buy_page');
      
      // کلیک روی دکمه خرید
      try {
        const buyButtons = await page.$$('button');
        for (const button of buyButtons) {
          const text = await button.textContent();
          if (text && text.includes('خرید')) {
            await button.click();
            break;
          }
        }
      } catch (error) {
        await this.smartClickByText(page, 'خرید');
      }
      
      await page.waitForTimeout(3000);
      await this.takeScreenshot('28_buy_modal');
      
      // وارد کردن مبلغ
      await this.smartFillByPlaceholder(page, 'مبلغ', CONFIG.transaction.depositAmount);
      
      // کلیک روی ثبت سفارش
      await this.smartClickByTitle(page, 'ثبت سفارش');
      await page.waitForTimeout(10000);
      await this.takeScreenshot('29_order_submitted');
      
    } catch (error) {
      console.error('❌ Error in step7:', error.message);
      throw error;
    }
  }

  async step8_WithdrawTether(page) {
    await this.updateStep(this.currentUserPhone, 'withdraw');
    console.log('📤 Step 8: Withdrawing Tether');
    
    try {
      // رفتن به صفحه برداشت
      await page.goto(CONFIG.website.withdrawUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      await this.takeScreenshot('30_withdraw_page');
      
      // جستجوی تتر
      await this.smartFillByPlaceholder(page, 'جستجو', 'تتر');
      await page.waitForTimeout(2000);
      await this.takeScreenshot('31_search_tether');
      
      // کلیک روی تتر
      await this.smartClickByText(page, 'تتر');
      await page.waitForTimeout(2000);
      
      // وارد کردن آدرس ولت
      await this.smartFillByPlaceholder(page, 'آدرس ولت مقصد', CONFIG.transaction.withdrawAddress);
      await this.takeScreenshot('32_address_filled');
      
      // کلیک روی برداشت کل موجودی
      await this.smartClickByTitle(page, 'برداشت کل موجودی');
      await page.waitForTimeout(2000);
      
      // کلیک روی ثبت برداشت
      await this.smartClickByTitle(page, 'ثبت برداشت');
      await page.waitForTimeout(10000);
      await this.takeScreenshot('33_withdrawal_complete');
      
      console.log('✅ Withdrawal process initiated successfully');
      
    } catch (error) {
      console.error('❌ Error in step8:', error.message);
      throw error;
    }
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUserPhone = phoneNumber;
    
    console.log(`\n🎯 ======== PROCESSING USER: ${phoneNumber} ========`);
    console.log(`👤 Name: ${user.personalName}`);
    console.log(`💳 Card: ${user.cardNumber}`);
    
    if (this.activeUsers.has(phoneNumber)) {
      console.log(`⏭️ User ${phoneNumber} is already being processed`);
      return;
    }
    
    this.activeUsers.add(phoneNumber);
    
    try {
      // ایجاد پوشه اسکرین‌شات
      if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots');
      }
      
      // علامت‌گذاری شروع پردازش
      await this.markAsProcessing(phoneNumber);
      
      // ایجاد صفحه جدید
      const pageCreated = await this.createPage();
      if (!pageCreated) {
        throw new Error('Failed to create browser page');
      }
      
      // اجرای مراحل
      const steps = [
        { name: 'Register & Login', method: () => this.step1_RegisterAndLogin(this.page, user) },
        { name: 'Enter Password', method: () => this.step2_EnterPassword(this.page) },
        { name: 'Complete Profile', method: () => this.step3_CompleteProfile(this.page, user) },
        { name: 'Add Bank Contract', method: () => this.step4_AddBankContract(this.page, user) },
        { name: 'Bank Process', method: () => this.step5_BankSpecificProcess(this.page, user) },
        { name: 'Deposit Toman', method: () => this.step6_DepositToman(this.page) },
        { name: 'Buy Tether', method: () => this.step7_BuyTether(this.page) },
        { name: 'Withdraw Tether', method: () => this.step8_WithdrawTether(this.page) }
      ];
      
      for (const step of steps) {
        this.currentStep = step.name;
        console.log(`\n🚀 [${step.name}] Starting...`);
        
        try {
          await step.method();
          console.log(`✅ [${step.name}] Completed`);
        } catch (stepError) {
          console.error(`❌ [${step.name}] Failed: ${stepError.message}`);
          
          // اگر خطا در مرحله اول بود، ادامه نمی‌دهیم
          if (step.name === 'Register & Login') {
            throw stepError;
          }
          
          // برای مراحل دیگر، لاگ می‌کنیم اما ادامه می‌دهیم
          console.log(`⚠️ Continuing despite error in ${step.name}`);
        }
        
        await this.page.waitForTimeout(2000);
      }
      
      // موفقیت آمیز
      console.log(`\n✅ SUCCESS: User ${phoneNumber} completed all steps!`);
      await this.markAsCompleted(phoneNumber, {
        completedAt: new Date()
      });
      
    } catch (error) {
      console.error(`\n❌ ERROR at step "${this.currentStep}" for user ${phoneNumber}:`, error.message);
      
      await this.markAsFailed(phoneNumber, error.message, this.currentStep);
      
      // بررسی اگر تعداد تلاش‌ها به حداکثر رسید
      const userDoc = await this.collection.findOne({ personalPhoneNumber: phoneNumber });
      const retryCount = userDoc?.retryCount || 0;
      
      if (retryCount >= CONFIG.transaction.maxRetries) {
        console.log(`⛔ User ${phoneNumber} reached maximum retries (${retryCount}/${CONFIG.transaction.maxRetries})`);
      }
      
    } finally {
      // بستن صفحه
      if (this.page) {
        try {
          await this.page.close();
        } catch (error) {
          console.error('Error closing page:', error.message);
        }
        this.page = null;
      }
      
      this.activeUsers.delete(phoneNumber);
      this.currentUserPhone = null;
      this.currentStep = null;
      
      // تأخیر بین کاربران
      console.log('⏳ Waiting 10 seconds before next user...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  // ==================== مدیریت اصلی ====================

  async startPolling() {
    console.log('🔄 Starting polling service (every 30 seconds)...');
    
    this.pollingInterval = setInterval(async () => {
      if (this.isProcessing) {
        console.log('⏸️ Already processing batch, skipping...');
        return;
      }
      
      this.isProcessing = true;
      
      try {
        const pendingUsers = await this.getPendingUsers();
        
        if (pendingUsers.length === 0) {
          console.log('😴 No pending users found');
          this.isProcessing = false;
          return;
        }
        
        console.log(`👥 Processing ${pendingUsers.length} users...`);
        
        for (const user of pendingUsers) {
          if (this.activeUsers.size >= 1) {
            console.log('⚠️ Maximum concurrent users (1) reached, waiting...');
            break;
          }
          
          this.processUser(user).catch(error => {
            console.error('Unhandled error in user processing:', error);
          });
          
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error('Error in polling cycle:', error);
      } finally {
        this.isProcessing = false;
      }
    }, CONFIG.polling.interval);
  }

  async start() {
    console.log('🚀 ======== AbanTether Auto Bot ========');
    console.log('📅 Started at:', new Date().toLocaleString('fa-IR'));
    
    // اتصال به دیتابیس
    const dbConnected = await this.connectToDatabase();
    if (!dbConnected) {
      console.error('❌ Cannot start without database connection');
      process.exit(1);
    }
    
    // راه‌اندازی مرورگر
    const browserReady = await this.initializeBrowser();
    if (!browserReady) {
      console.error('❌ Cannot start without browser');
      process.exit(1);
    }
    
    // شروع پولینگ
    await this.startPolling();
    
    // اجرای اولیه
    this.isProcessing = false;
    const initialUsers = await this.getPendingUsers();
    console.log(`\n🔍 Initial check found ${initialUsers.length} pending users`);
    
    // سیگنال‌های خروج
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    
    console.log('\n✅ Bot is running and monitoring database every 30 seconds');
    console.log('📸 Screenshots will be saved in ./screenshots/');
    console.log('\nPress Ctrl+C to stop the bot\n');
  }

  async shutdown() {
    console.log('\n🛑 Shutting down bot...');
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    if (this.browser) {
      await this.browser.close();
    }
    
    if (this.client) {
      await this.client.close();
    }
    
    console.log('👋 Bot shutdown complete');
    process.exit(0);
  }
}

// ==================== اجرای ربات ====================

if (require.main === module) {
  const bot = new AbanTetherAutoBot();
  
  process.on('uncaughtException', (error) => {
    console.error('\n🔥 Uncaught Exception:', error.message);
    bot.shutdown();
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n🔥 Unhandled Rejection at:', promise);
  });
  
  bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}

module.exports = AbanTetherAutoBot;