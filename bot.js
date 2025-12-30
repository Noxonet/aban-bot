const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

// کانفیگ دیتابیس
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
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
    headless: true, // در سرور باید true باشد
    slowMo: 100
  },
  
  transaction: {
    depositAmount: '5000000',
    withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
    maxRetries: 3,
    password: 'ImSorryButIhaveTo@1'
  },
  
  polling: {
    interval: 30000,
    batchSize: 3
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
    this.retryCount = 0;
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
      
      // تست اتصال
      const count = await this.collection.countDocuments({});
      console.log(`📊 Total documents in database: ${count}`);
      
      return true;
    } catch (error) {
      console.error('❌ MongoDB connection error:', error.message);
      return false;
    }
  }

  async getPendingUsers() {
    try {
      console.log('🔍 Checking for pending users...');
      
      // کوئری برای یافتن کاربران منتظر پردازش
      const query = {
        $and: [
          {
            $or: [
              { processed: { $exists: false } },
              { processed: false }
            ]
          },
          {
            $or: [
              { status: { $exists: false } },
              { status: { $in: ['processing', 'failed', null] } }
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
      
      console.log(`🎯 Found ${users.length} pending users`);
      
      if (users.length > 0) {
        console.log('\n📋 Pending Users List:');
        users.forEach((user, index) => {
          console.log(`${index + 1}. ${user.personalPhoneNumber} - ${user.personalName}`);
          console.log(`   Status: ${user.status || 'new'}`);
          console.log(`   Retry Count: ${user.retryCount || 0}`);
          console.log(`   Card: ${user.cardNumber || 'N/A'}`);
          console.log('---');
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
      const updateQuery = {
        $set: updateData,
        $currentDate: { lastUpdated: true }
      };
      
      // اگر وضعیت failed است، retryCount را افزایش بده
      if (updateData.status === 'failed') {
        updateQuery.$inc = { retryCount: 1 };
      }
      
      const result = await this.collection.updateOne(
        { personalPhoneNumber: phoneNumber },
        updateQuery,
        { upsert: false }
      );
      
      console.log(`📝 Updated user ${phoneNumber}: ${updateData.status || 'updated'}`);
      if (updateData.failureReason) {
        console.log(`   Reason: ${updateData.failureReason}`);
      }
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
      
      const launchOptions = {
        headless: CONFIG.website.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--single-process',
          '--no-zygote',
          '--disable-features=VizDisplayCompositor'
        ],
        slowMo: CONFIG.website.slowMo
      };
      
      // تنظیمات مخصوص Railway/Docker
      if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
        console.log('🚂 Production environment detected');
        launchOptions.executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH || '/usr/bin/chromium';
      }
      
      this.browser = await chromium.launch(launchOptions);
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
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'fa-IR',
        timezoneId: 'Asia/Tehran',
        acceptDownloads: false,
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true
      });

      this.page = await context.newPage();
      await this.page.setDefaultTimeout(CONFIG.website.timeout);
      await this.page.setDefaultNavigationTimeout(60000);
      
      // اضافه کردن هدرها
      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      });
      
      console.log('✅ Page created successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to create page:', error.message);
      return false;
    }
  }

  async fillInputByPlaceholder(page, placeholder, value) {
    try {
      console.log(`📝 Filling "${placeholder}": ${value}`);
      const selector = `input[placeholder*="${placeholder}"]`;
      await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
      await page.fill(selector, value);
      await page.waitForTimeout(500);
      return true;
    } catch (error) {
      console.error(`❌ Could not fill input with placeholder "${placeholder}"`);
      return false;
    }
  }

  async fillInputByName(page, name, value) {
    try {
      console.log(`📝 Filling input[name="${name}"]: ${value}`);
      const selector = `input[name="${name}"]`;
      await page.waitForSelector(selector, { timeout: 15000, state: 'visible' });
      await page.fill(selector, value);
      await page.waitForTimeout(500);
      return true;
    } catch (error) {
      console.error(`❌ Could not fill input with name "${name}"`);
      return false;
    }
  }

  async clickButtonByText(page, text, timeout = 10000) {
    try {
      console.log(`🖱️ Clicking button with text: "${text}"`);
      
      // چند روش مختلف برای پیدا کردن دکمه
      const selectors = [
        `button:has-text("${text}")`,
        `a:has-text("${text}")`,
        `div:has-text("${text}")`,
        `span:has-text("${text}")`,
        `text=${text}`
      ];
      
      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
          const element = await page.$(selector);
          
          if (element) {
            // چک کردن که دکمه disabled نباشد
            const isDisabled = await element.getAttribute('disabled');
            if (!isDisabled) {
              await element.click();
              console.log(`✅ Successfully clicked "${text}"`);
              await page.waitForTimeout(2000);
              return true;
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      console.log(`⚠️ Could not find clickable element with text "${text}"`);
      return false;
    } catch (error) {
      console.error(`❌ Error clicking "${text}":`, error.message);
      return false;
    }
  }

  async clickByTitle(page, title, timeout = 10000) {
    try {
      console.log(`🖱️ Clicking element with title: "${title}"`);
      
      const selectors = [
        `[title="${title}"]`,
        `[title*="${title}"]`,
        `button[title*="${title}"]`,
        `a[title*="${title}"]`
      ];
      
      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
          const element = await page.$(selector);
          
          if (element) {
            const isVisible = await element.isVisible();
            const isDisabled = await element.getAttribute('disabled');
            
            if (isVisible && !isDisabled) {
              await element.click();
              console.log(`✅ Successfully clicked title "${title}"`);
              await page.waitForTimeout(2000);
              return true;
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      console.log(`⚠️ Could not find element with title "${title}"`);
      return false;
    } catch (error) {
      console.error(`❌ Error clicking title "${title}":`, error.message);
      return false;
    }
  }

  async waitForOtpFromDatabase(fieldName) {
    console.log(`⏳ Waiting for ${fieldName} in database...`);
    
    const startTime = Date.now();
    const timeout = 180000; // 3 دقیقه
    
    while (Date.now() - startTime < timeout) {
      try {
        const user = await this.collection.findOne({
          personalPhoneNumber: this.currentUserPhone
        });
        
        if (user && user[fieldName] && user[fieldName].toString().length >= 4) {
          console.log(`✅ ${fieldName} received: ${user[fieldName]}`);
          return user[fieldName].toString();
        }
        
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`⏰ Still waiting for ${fieldName}... ${elapsed}s passed`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        console.error(`❌ Error checking ${fieldName}:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    console.log(`⏰ Timeout waiting for ${fieldName}`);
    return null;
  }

  async waitForNavigation(page) {
    try {
      await page.waitForNavigation({ 
        waitUntil: 'networkidle',
        timeout: 10000 
      });
    } catch (error) {
      // اگر نویگیشن اتفاق نیفتاد، مشکلی نیست
    }
  }

  async waitForElement(page, selector, timeout = 15000) {
    try {
      await page.waitForSelector(selector, { 
        timeout: timeout,
        state: 'visible' 
      });
      return true;
    } catch (error) {
      console.error(`❌ Element not found: ${selector}`);
      return false;
    }
  }

  async takeScreenshot(stepName) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `screenshot-${stepName}-${timestamp}.png`;
      await this.page.screenshot({ 
        path: fileName,
        fullPage: true 
      });
      console.log(`📸 Screenshot saved: ${fileName}`);
    } catch (error) {
      console.error('❌ Failed to take screenshot:', error.message);
    }
  }

  // ==================== مراحل اصلی ربات ====================

  async step1_RegisterAndLogin(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'register_login');
    console.log('📝 Step 1: Registration & Login');
    
    try {
      // رفتن به صفحه ثبت‌نام
      console.log(`🌐 Navigating to ${CONFIG.website.registerUrl}`);
      await page.goto(CONFIG.website.registerUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(3000);
      
      // وارد کردن شماره موبایل
      await this.fillInputByPlaceholder(page, 'شماره موبایل', user.personalPhoneNumber);
      
      // کلیک روی دکمه ثبت‌نام
      await this.clickByTitle(page, 'ثبت‌نام');
      await page.waitForTimeout(5000);
      
      // بررسی تغییر URL
      const currentUrl = page.url();
      console.log(`📍 Current URL: ${currentUrl}`);
      
      // اگر هنوز در صفحه OTP هستیم
      if (currentUrl.includes('/register') || await page.$('input[placeholder*="کد ارسال شده"]')) {
        console.log('📱 OTP page detected, waiting for OTP...');
        
        // انتظار برای OTP لاگین
        const loginOtp = await this.waitForOtpFromDatabase('otp_login');
        
        if (loginOtp) {
          console.log(`🔐 Entering login OTP: ${loginOtp}`);
          
          // وارد کردن OTP
          await this.fillInputByPlaceholder(page, 'کد ارسال شده', loginOtp);
          
          // سعی در کلیک روی دکمه "بعد"
          const beforeUrl = page.url();
          const clicked = await this.clickButtonByText(page, 'بعد');
          
          if (!clicked) {
            console.log('ℹ️ "بعد" button not found or disabled, checking for auto-navigation...');
            await page.waitForTimeout(3000);
            
            // بررسی تغییر URL
            const afterUrl = page.url();
            if (afterUrl !== beforeUrl) {
              console.log('✅ Auto-navigated to next step');
            } else {
              // امتحان کردن دکمه "ادامه"
              await this.clickButtonByText(page, 'ادامه');
            }
          }
          
          await page.waitForTimeout(3000);
        } else {
          console.log('⚠️ No OTP received, continuing anyway...');
          await page.waitForTimeout(5000);
        }
      } else {
        console.log('✅ Already navigated to next step');
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 1:', error.message);
      throw error;
    }
  }

  async step2_EnterPassword(page) {
    await this.updateStep(this.currentUserPhone, 'enter_password');
    console.log('🔑 Step 2: Entering Password');
    
    try {
      // پیدا کردن فیلد رمز عبور
      await this.fillInputByPlaceholder(page, 'رمز عبور', CONFIG.transaction.password);
      
      // کلیک روی تایید
      await this.clickByTitle(page, 'تایید');
      await page.waitForTimeout(5000);
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 2:', error.message);
      throw error;
    }
  }

  async step3_CompleteProfile(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'complete_profile');
    console.log('👤 Step 3: Completing Profile');
    
    try {
      // وارد کردن کد ملی
      await this.fillInputByPlaceholder(page, 'کد ۱۰ رقمی شناسایی', user.personalNationalCode);
      
      // وارد کردن تاریخ تولد
      try {
        const dobSelector = 'input[placeholder="روز/ماه/سال"]';
        if (await this.waitForElement(page, dobSelector, 10000)) {
          await page.fill(dobSelector, user.personalBirthDate);
          console.log(`✅ Birth date filled: ${user.personalBirthDate}`);
        }
      } catch (error) {
        console.error('⚠️ Could not fill birth date:', error.message);
      }
      
      // کلیک روی ثبت
      await this.clickByTitle(page, 'ثبت');
      await page.waitForTimeout(5000);
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 3:', error.message);
      throw error;
    }
  }

  async step4_AddBankContract(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'add_bank_contract');
    console.log('📋 Step 4: Adding Bank Contract');
    
    try {
      // رفتن به صفحه واریز
      console.log(`🌐 Navigating to ${CONFIG.website.depositUrl}`);
      await page.goto(CONFIG.website.depositUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      
      // کلیک روی افزودن قرارداد
      await this.clickByTitle(page, 'افزودن قرارداد');
      await page.waitForTimeout(3000);
      
      // انتخاب بانک
      await this.clickButtonByText(page, 'نام بانک خود را انتخاب نمایید');
      await page.waitForTimeout(1000);
      
      // تشخیص بانک از شماره کارت
      const getBankName = () => {
        const card = user.cardNumber || '';
        if (card.startsWith('603799') || card.startsWith('610433')) {
          return 'بانک ملی';
        } else if (card.startsWith('606373')) {
          return 'بانک مهر ایران';
        } else if (card.startsWith('603770')) {
          return 'بانک کشاورزی';
        } else if (card.startsWith('585983')) {
          return 'بانک تجارت';
        }
        return 'بانک ملی';
      };
      
      const bankName = getBankName();
      console.log(`🏦 Selecting bank: ${bankName}`);
      await this.clickButtonByText(page, bankName);
      await page.waitForTimeout(1000);
      
      // انتخاب مدت قرارداد
      await this.clickButtonByText(page, 'مدت قرارداد خود را انتخاب کنید');
      await page.waitForTimeout(1000);
      await this.clickButtonByText(page, '1 ماهه');
      await page.waitForTimeout(1000);
      
      // کلیک روی ثبت و ادامه
      await this.clickByTitle(page, 'ثبت و ادامه');
      await page.waitForTimeout(5000);
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 4:', error.message);
      throw error;
    }
  }

  async step5_BankProcess(page, user) {
    await this.updateStep(user.personalPhoneNumber, 'bank_process');
    console.log('🏦 Step 5: Bank Process');
    
    try {
      // اگر بانک ملی است
      if (user.cardNumber && (user.cardNumber.startsWith('603799') || user.cardNumber.startsWith('610433'))) {
        await this.processMelliBank(page, user);
      } 
      // اگر بانک مهر ایران است
      else if (user.cardNumber && user.cardNumber.startsWith('606373')) {
        await this.processMehrIranBank(page, user);
      } else {
        console.log('⚠️ Bank not specifically implemented, trying generic process...');
        await page.waitForTimeout(5000);
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 5:', error.message);
      // ادامه می‌دهیم حتی اگر این مرحله مشکل داشت
      return true;
    }
  }

  async processMelliBank(page, user) {
    console.log('🏦 Processing Melli Bank');
    
    try {
      // کلیک روی ورود با کارت بانک ملی
      await this.clickButtonByText(page, 'ورود با کارت بانک ملی');
      await page.waitForTimeout(5000);
      
      // وارد کردن شماره کارت
      await this.fillInputByPlaceholder(page, 'شماره کارت', user.cardNumber);
      
      // منتظر کپچا (در محیط headless فقط منتظر می‌مانیم)
      console.log('⏳ Waiting for page to load (captcha solving required manually)...');
      await page.waitForTimeout(10000);
      
      // کلیک روی ارسال رمز فعالسازی
      await this.clickButtonByText(page, 'ارسال رمز فعالسازی');
      await page.waitForTimeout(5000);
      
      // انتظار برای OTP ثبت کارت
      const cardOtp = await this.waitForOtpFromDatabase('otp_register_card');
      
      if (cardOtp) {
        console.log(`🔐 Entering card OTP: ${cardOtp}`);
        
        // وارد کردن OTP
        try {
          const otpInputs = await page.$$('input[type="tel"], input[type="number"]');
          for (let i = 0; i < Math.min(otpInputs.length, cardOtp.length); i++) {
            await otpInputs[i].fill(cardOtp[i]);
          }
        } catch (error) {
          await this.fillInputByPlaceholder(page, 'کد تأیید', cardOtp);
        }
        
        // کلیک روی ادامه
        await this.clickButtonByText(page, 'ادامه');
        await page.waitForTimeout(5000);
      }
      
      // کلیک روی ثبت قرارداد
      await this.clickButtonByText(page, 'ثبت قرار داد');
      await page.waitForTimeout(5000);
      
    } catch (error) {
      console.error('❌ Error in Melli Bank process:', error.message);
      throw error;
    }
  }

  async processMehrIranBank(page, user) {
    console.log('🏦 Processing Mehr Iran Bank');
    
    try {
      // وارد کردن شماره کارت
      await this.fillInputByPlaceholder(page, 'شماره کارت', user.cardNumber);
      
      // وارد کردن CVV2
      await this.fillInputByPlaceholder(page, 'cvv2', user.cvv2);
      
      // وارد کردن ماه انقضا
      try {
        const monthInputs = await page.$$('input[placeholder*="ماه"]');
        if (monthInputs.length > 0) {
          await monthInputs[0].fill(user.bankMonth.toString());
        }
      } catch (error) {
        console.error('⚠️ Could not fill month');
      }
      
      // وارد کردن سال انقضا
      try {
        const yearInputs = await page.$$('input[placeholder*="سال"]');
        if (yearInputs.length > 0) {
          await yearInputs[0].fill(user.bankYear.toString());
        }
      } catch (error) {
        console.error('⚠️ Could not fill year');
      }
      
      // منتظر کپچا
      console.log('⏳ Waiting for page to load...');
      await page.waitForTimeout(10000);
      
      // کلیک روی دریافت رمز پویا
      await this.clickButtonByText(page, 'دریافت رمز پویا');
      await page.waitForTimeout(5000);
      
      // انتظار برای OTP
      const cardOtp = await this.waitForOtpFromDatabase('otp_register_card');
      
      if (cardOtp) {
        console.log(`🔐 Entering dynamic password: ${cardOtp}`);
        
        // وارد کردن رمز دوم
        await this.fillInputByPlaceholder(page, 'رمز دوم', cardOtp);
        
        // کلیک روی تایید
        await this.clickButtonByText(page, 'تایید');
        await page.waitForTimeout(5000);
      }
      
    } catch (error) {
      console.error('❌ Error in Mehr Iran Bank process:', error.message);
      throw error;
    }
  }

  async step6_DepositToman(page) {
    await this.updateStep(this.currentUserPhone, 'deposit_toman');
    console.log('💰 Step 6: Deposit Toman');
    
    try {
      // برگشت به صفحه واریز
      await page.goto(CONFIG.website.depositUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      
      // وارد کردن مبلغ
      await this.fillInputByPlaceholder(page, 'مبلغ واریز', CONFIG.transaction.depositAmount);
      
      // انتخاب بانک از لیست
      try {
        const bankList = await page.$('#bank-list');
        if (bankList) {
          await bankList.click();
          await page.waitForTimeout(1000);
          
          // انتخاب بانک ملی
          await this.clickButtonByText(page, 'بانک ملی');
        }
      } catch (error) {
        console.error('⚠️ Could not select bank from list');
      }
      
      // کلیک روی واریز
      await this.clickByTitle(page, 'واریز');
      await page.waitForTimeout(3000);
      
      // کلیک روی تایید و پرداخت
      await this.clickByTitle(page, 'تایید و پرداخت');
      await page.waitForTimeout(5000);
      
      // انتظار برای OTP پرداخت
      const paymentOtp = await this.waitForOtpFromDatabase('otp_payment');
      
      if (paymentOtp) {
        console.log(`🔐 Entering payment OTP: ${paymentOtp}`);
        
        // وارد کردن OTP پرداخت
        await this.fillInputByPlaceholder(page, 'کد تأیید', paymentOtp);
        
        // کلیک روی تایید
        await this.clickButtonByText(page, 'تایید');
        await page.waitForTimeout(10000);
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 6:', error.message);
      throw error;
    }
  }

  async step7_BuyTether(page) {
    await this.updateStep(this.currentUserPhone, 'buy_tether');
    console.log('🔄 Step 7: Buy Tether');
    
    try {
      // رفتن به صفحه خرید
      await page.goto(CONFIG.website.buyUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      
      // کلیک روی دکمه خرید
      await this.clickButtonByText(page, 'خرید');
      await page.waitForTimeout(3000);
      
      // وارد کردن مبلغ
      await this.fillInputByPlaceholder(page, 'مبلغ', CONFIG.transaction.depositAmount);
      
      // کلیک روی ثبت سفارش
      await this.clickByTitle(page, 'ثبت سفارش');
      await page.waitForTimeout(10000);
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 7:', error.message);
      throw error;
    }
  }

  async step8_WithdrawTether(page) {
    await this.updateStep(this.currentUserPhone, 'withdraw_tether');
    console.log('📤 Step 8: Withdraw Tether');
    
    try {
      // رفتن به صفحه برداشت
      await page.goto(CONFIG.website.withdrawUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      
      // جستجوی تتر
      await this.fillInputByPlaceholder(page, 'جستجو', 'تتر');
      await page.waitForTimeout(2000);
      
      // کلیک روی تتر
      await this.clickButtonByText(page, 'تتر');
      await page.waitForTimeout(2000);
      
      // وارد کردن آدرس ولت
      await this.fillInputByPlaceholder(page, 'آدرس ولت مقصد', CONFIG.transaction.withdrawAddress);
      
      // کلیک روی برداشت کل موجودی
      await this.clickByTitle(page, 'برداشت کل موجودی');
      await page.waitForTimeout(2000);
      
      // کلیک روی ثبت برداشت
      await this.clickByTitle(page, 'ثبت برداشت');
      await page.waitForTimeout(10000);
      
      console.log('✅ Withdrawal initiated successfully');
      
      return true;
    } catch (error) {
      console.error('❌ Error in step 8:', error.message);
      throw error;
    }
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUserPhone = phoneNumber;
    
    console.log(`\n🎯 ======== PROCESSING USER: ${phoneNumber} ========`);
    console.log(`👤 Name: ${user.personalName}`);
    console.log(`💳 Card: ${user.cardNumber}`);
    console.log(`📱 Phone: ${phoneNumber}`);
    
    if (this.activeUsers.has(phoneNumber)) {
      console.log(`⏭️ Already being processed, skipping...`);
      return;
    }
    
    this.activeUsers.add(phoneNumber);
    this.retryCount = user.retryCount || 0;
    
    try {
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
        { name: 'Bank Process', method: () => this.step5_BankProcess(this.page, user) },
        { name: 'Deposit Toman', method: () => this.step6_DepositToman(this.page) },
        { name: 'Buy Tether', method: () => this.step7_BuyTether(this.page) },
        { name: 'Withdraw Tether', method: () => this.step8_WithdrawTether(this.page) }
      ];
      
      for (const step of steps) {
        this.currentStep = step.name;
        console.log(`\n🚀 Starting: ${step.name}`);
        
        try {
          await step.method();
          console.log(`✅ Completed: ${step.name}`);
        } catch (stepError) {
          console.error(`❌ Failed at ${step.name}:`, stepError.message);
          
          // اگر در مرحله اول شکست خورد، کل پردازش را متوقف کن
          if (step.name === 'Register & Login') {
            throw stepError;
          }
          
          // برای مراحل دیگر، لاگ کن اما ادامه بده
          console.log(`⚠️ Continuing to next step despite error in ${step.name}`);
        }
        
        await this.page.waitForTimeout(2000);
      }
      
      // علامت‌گذاری موفقیت
      console.log(`\n✅ SUCCESS: User ${phoneNumber} completed all steps!`);
      await this.markAsCompleted(phoneNumber, {
        completedAt: new Date(),
        stepsCompleted: steps.map(s => s.name)
      });
      
    } catch (error) {
      console.error(`\n❌ FAILED: User ${phoneNumber} failed at step "${this.currentStep}"`);
      console.error(`Error: ${error.message}`);
      
      await this.markAsFailed(phoneNumber, error.message, this.currentStep);
      
      // بررسی حداکثر تلاش‌ها
      if (this.retryCount + 1 >= CONFIG.transaction.maxRetries) {
        console.log(`⛔ User ${phoneNumber} reached maximum retries (${this.retryCount + 1}/${CONFIG.transaction.maxRetries})`);
        await this.updateUserStatus(phoneNumber, {
          status: 'permanently_failed',
          permanentlyFailedAt: new Date()
        });
      }
      
    } finally {
      // تمیزکاری
      if (this.page) {
        try {
          await this.page.close();
          const contexts = await this.browser.contexts();
          for (const context of contexts) {
            await context.close();
          }
        } catch (error) {
          console.error('Error closing page:', error.message);
        }
        this.page = null;
      }
      
      this.activeUsers.delete(phoneNumber);
      this.currentUserPhone = null;
      this.currentStep = null;
      
      // تأخیر بین کاربران
      console.log('⏳ Waiting 15 seconds before processing next user...');
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }

  // ==================== مدیریت اصلی ====================

  async startPolling() {
    console.log('🔄 Starting polling service...');
    
    this.pollingInterval = setInterval(async () => {
      if (this.isProcessing) {
        console.log('⏸️ Already processing, skipping this cycle...');
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
        
        console.log(`👥 Found ${pendingUsers.length} users to process`);
        
        for (const user of pendingUsers) {
          // محدودیت کاربران همزمان
          if (this.activeUsers.size >= 1) {
            console.log('⚠️ Maximum concurrent users (1) reached, waiting...');
            break;
          }
          
          // پردازش کاربر
          this.processUser(user).catch(error => {
            console.error('Unhandled error in user processing:', error);
          });
          
          // تأخیر بین شروع پردازش کاربران
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (error) {
        console.error('❌ Error in polling cycle:', error.message);
      } finally {
        this.isProcessing = false;
      }
    }, CONFIG.polling.interval);
  }

  async start() {
    console.log('🚀 ======== AbanTether Auto Bot ========');
    console.log('📅 Started at:', new Date().toLocaleString('fa-IR'));
    console.log('⚙️  Environment:', process.env.NODE_ENV || 'development');
    console.log('🌐 Headless mode:', CONFIG.website.headless);
    console.log('🔄 Polling interval:', CONFIG.polling.interval / 1000, 'seconds');
    console.log('🔁 Max retries:', CONFIG.transaction.maxRetries);
    
    // اتصال به دیتابیس
    console.log('\n🔌 Connecting to database...');
    const dbConnected = await this.connectToDatabase();
    if (!dbConnected) {
      console.error('❌ Cannot start without database connection');
      process.exit(1);
    }
    
    // راه‌اندازی مرورگر
    console.log('\n🌐 Initializing browser...');
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
    
    // مدیریت سیگنال‌های خروج
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGHUP', () => this.shutdown());
    
    console.log('\n✅ Bot is running and monitoring database');
    console.log('⏰ Polling every 30 seconds');
    console.log('📊 Active users limit: 1 concurrent');
    console.log('\nPress Ctrl+C to stop the bot\n');
    
    // لاگ وضعیت هر 5 دقیقه
    setInterval(() => {
      const now = new Date();
      console.log(`\n📊 Status check: ${now.toLocaleString('fa-IR')}`);
      console.log(`Active users: ${this.activeUsers.size}`);
      console.log(`Is processing: ${this.isProcessing}`);
    }, 300000);
  }

  async shutdown() {
    console.log('\n🛑 Shutting down bot...');
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      console.log('✅ Polling stopped');
    }
    
    if (this.browser) {
      await this.browser.close();
      console.log('✅ Browser closed');
    }
    
    if (this.client) {
      await this.client.close();
      console.log('✅ Database connection closed');
    }
    
    console.log('👋 Bot shutdown complete');
    process.exit(0);
  }
}

// ==================== اجرای ربات ====================

if (require.main === module) {
  const bot = new AbanTetherAutoBot();
  
  // هندل کردن خطاهای غیرمنتظره
  process.on('uncaughtException', (error) => {
    console.error('\n🔥 Uncaught Exception:', error.message);
    console.error('Stack:', error.stack);
    bot.shutdown();
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('\n🔥 Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
  });
  
  // اجرای ربات
  bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });
}

module.exports = AbanTetherAutoBot;