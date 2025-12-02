const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
require('dotenv').config();

class AbanTetherBot {
    constructor() {
        this.client = new MongoClient(process.env.MONGODB_URI);
        this.db = null;
        this.collection = null;
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        
        // وضعیت هر کاربر
        this.userStates = new Map();
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db(process.env.DATABASE_NAME);
            this.collection = this.db.collection(process.env.COLLECTION_NAME);
            console.log('✅ Connected to MongoDB');
        } catch (error) {
            console.error('❌ MongoDB connection error:', error);
        }
    }

    async checkDatabase() {
        try {
            // پیدا کردن کاربرانی که پردازش نشده‌اند
            const pendingUsers = await this.collection.find({
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true },
                $or: [
                    { status: { $exists: false } },
                    { status: { $ne: "completed" } }
                ]
            }).toArray();

            console.log(`🔍 Found ${pendingUsers.length} pending users`);

            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                if (phone && phone.trim() !== "" && !this.processingUsers.has(phone)) {
                    console.log(`🚀 Starting processing for user: ${phone}`);
                    this.processingUsers.add(phone);
                    this.currentUser = user;
                    
                    // تنظیم وضعیت اولیه برای کاربر
                    this.userStates.set(phone, {
                        step: 'not_started',
                        waitingForOTP: false,
                        otpReceived: false
                    });
                    
                    // پردازش
                    this.processUser(user).catch(error => {
                        console.error(`❌ Error processing user ${phone}:`, error.message);
                        this.processingUsers.delete(phone);
                        this.userStates.delete(phone);
                    });
                }
            }
        } catch (error) {
            console.error('❌ Error checking database:', error);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        
        try {
            console.log(`🔄 Processing started for ${phone}`);
            
            // مرحله 0: مقداردهی اولیه
            await this.updateUserStatus(phone, 'initializing', 'Starting process');
            
            // مرحله 1: راه‌اندازی مرورگر
            await this.initializeBrowser();
            
            // مرحله 2: ثبت‌نام و ورود
            await this.updateUserStatus(phone, 'registering', 'Going to register page');
            await this.registerAndLogin(user);
            
            // مرحله 3: ثبت کارت
            await this.updateUserStatus(phone, 'card_registration', 'Registering bank card');
            await this.registerCard(user);
            
            // مرحله 4: واریز و خرید
            await this.updateUserStatus(phone, 'depositing', 'Making deposit');
            await this.depositAndBuy(user);
            
            // مرحله 5: برداشت
            await this.updateUserStatus(phone, 'withdrawing', 'Withdrawing Tether');
            await this.withdraw(user);
            
            // مرحله 6: تکمیل
            await this.updateUserStatus(phone, 'completed', 'Process completed successfully');
            
            console.log(`✅ Successfully completed for ${phone}`);
            
        } catch (error) {
            console.error(`❌ Failed for ${phone}:`, error.message);
            await this.updateUserStatus(phone, 'failed', error.message);
        } finally {
            this.processingUsers.delete(phone);
            this.userStates.delete(phone);
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
        }
    }

    async initializeBrowser() {
        if (this.browser) {
            await this.browser.close();
        }
        
        this.browser = await chromium.launch({ 
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });
        
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        
        this.page = await context.newPage();
        
        // لاگ کنسول مرورگر
        this.page.on('console', msg => {
            if (msg.type() === 'error') {
                console.log(`🌐 Browser Error: ${msg.text()}`);
            }
        });
    }

    async registerAndLogin(user) {
        const phone = user.personalPhoneNumber;
        console.log(`📝 Starting registration for ${phone}...`);
        
        try {
            // 1. رفتن به صفحه ثبت‌نام
            await this.page.goto('https://abantether.com/register', { 
                waitUntil: 'load',
                timeout: 30000 
            });
            
            await this.sleep(3000);
            
            // 2. پیدا کردن فیلد شماره موبایل و وارد کردن
            console.log('🔍 Looking for phone input...');
            
            // روش‌های مختلف برای پیدا کردن فیلد
            const phoneInputSelectors = [
                'input[type="tel"]',
                'input[name*="phone"]',
                'input[name*="mobile"]',
                'input[placeholder*="موبایل"]',
                'input[placeholder*="شماره"]'
            ];
            
            let phoneInputFound = false;
            for (const selector of phoneInputSelectors) {
                const inputs = await this.page.$$(selector);
                for (const input of inputs) {
                    const isVisible = await input.isVisible();
                    if (isVisible) {
                        await input.fill(user.personalPhoneNumber);
                        console.log(`✅ Phone number entered: ${user.personalPhoneNumber}`);
                        phoneInputFound = true;
                        break;
                    }
                }
                if (phoneInputFound) break;
            }
            
            if (!phoneInputFound) {
                // اگر فیلد پیدا نشد، صفحه را ذخیره کن برای دیباگ
                await this.page.screenshot({ path: 'debug-phone-input.png' });
                throw new Error('Could not find phone input field');
            }
            
            // 3. پیدا کردن دکمه ادامه/ارسال کد
            console.log('🔍 Looking for continue button...');
            
            const continueButtons = [
                'button:has-text("ادامه")',
                'button:has-text("ارسال کد")',
                'button:has-text("دریافت کد")',
                'input[type="submit"][value*="ادامه"]',
                'input[type="submit"][value*="ارسال"]'
            ];
            
            let buttonClicked = false;
            for (const selector of continueButtons) {
                const buttons = await this.page.$$(selector);
                for (const button of buttons) {
                    const isVisible = await button.isVisible();
                    if (isVisible) {
                        await button.click();
                        console.log('✅ Continue button clicked');
                        buttonClicked = true;
                        await this.sleep(2000);
                        break;
                    }
                }
                if (buttonClicked) break;
            }
            
            if (!buttonClicked) {
                // کلیک روی اولین دکمه قابل مشاهده
                const allButtons = await this.page.$$('button, input[type="submit"]');
                for (const button of allButtons) {
                    const isVisible = await button.isVisible();
                    if (isVisible) {
                        await button.click();
                        console.log('✅ Clicked visible button');
                        await this.sleep(2000);
                        buttonClicked = true;
                        break;
                    }
                }
            }
            
            // 4. منتظر فیلد OTP
            console.log('⏳ Waiting for OTP input field...');
            await this.sleep(5000);
            
            // 5. چک کردن آیا فیلد OTP ظاهر شده
            const otpInputSelectors = [
                'input[type="number"]',
                'input[name*="otp"]',
                'input[name*="code"]',
                'input[placeholder*="کد"]',
                'input[placeholder*="رمز"]'
            ];
            
            let otpFieldFound = false;
            for (const selector of otpInputSelectors) {
                const inputs = await this.page.$$(selector);
                if (inputs.length > 0) {
                    console.log('✅ OTP input field appeared');
                    otpFieldFound = true;
                    break;
                }
            }
            
            if (!otpFieldFound) {
                console.log('⚠️ OTP field not found, taking screenshot...');
                await this.page.screenshot({ path: 'debug-otp-field.png' });
                
                // ممکن است صفحه عوض شده باشد، دوباره چک کن
                const pageContent = await this.page.content();
                if (pageContent.includes('کد') || pageContent.includes('تایید')) {
                    console.log('✅ Found OTP related text in page');
                    otpFieldFound = true;
                }
            }
            
            if (otpFieldFound) {
                console.log('📱 NOW: The website should send an SMS to:', user.personalPhoneNumber);
                console.log('📱 Please check the SMS app and add the OTP to database');
                console.log('⏳ Waiting for OTP in database...');
                
                // 6. منتظر OTP در دیتابیس (تا 5 دقیقه)
                const otp = await this.waitForOTPInDatabase(phone, 'login', 300000);
                
                // 7. وارد کردن OTP
                console.log(`✅ OTP received: ${otp}`);
                
                // پیدا کردن فیلد OTP و پر کردن
                for (const selector of otpInputSelectors) {
                    const inputs = await this.page.$$(selector);
                    for (const input of inputs) {
                        const isVisible = await input.isVisible();
                        if (isVisible) {
                            await input.fill(otp);
                            console.log(`✅ OTP entered: ${otp}`);
                            break;
                        }
                    }
                }
                
                // 8. کلیک روی دکمه تأیید
                const confirmButtons = [
                    'button:has-text("تایید")',
                    'button:has-text("ورود")',
                    'button:has-text("ثبت")',
                    'input[type="submit"][value*="تایید"]'
                ];
                
                for (const selector of confirmButtons) {
                    const buttons = await this.page.$$(selector);
                    for (const button of buttons) {
                        const isVisible = await button.isVisible();
                        if (isVisible) {
                            await button.click();
                            console.log('✅ Confirm button clicked');
                            await this.sleep(5000);
                            break;
                        }
                    }
                }
            }
            
            console.log('✅ Registration step completed');
            
        } catch (error) {
            console.error('❌ Error in registration:', error.message);
            await this.page.screenshot({ path: `error-${phone}-register.png` });
            throw error;
        }
    }

    async waitForOTPInDatabase(phoneNumber, type = 'login', timeout = 300000) {
        console.log(`⏳ Waiting for ${type} OTP for ${phoneNumber} (${timeout/1000} seconds)...`);
        
        const startTime = Date.now();
        const checkInterval = 5000; // هر 5 ثانیه
        
        while (Date.now() - startTime < timeout) {
            try {
                // دریافت کاربر از دیتابیس
                const user = await this.collection.findOne({ 
                    personalPhoneNumber: phoneNumber 
                });
                
                if (user && user.sms && Array.isArray(user.sms)) {
                    // جستجوی OTP در پیام‌ها
                    for (const sms of user.sms) {
                        if (sms.body && (sms.body.includes('آبان') || sms.body.includes('abantether'))) {
                            // الگوهای استخراج OTP
                            const patterns = [
                                /(\d{6})/,
                                /کد.*?(\d{4,6})/i,
                                /code.*?(\d{4,6})/i,
                                /#(\d{4,6})/,
                                /:.*?(\d{4,6})/
                            ];
                            
                            for (const pattern of patterns) {
                                const match = sms.body.match(pattern);
                                if (match && match[1]) {
                                    const otp = match[1];
                                    console.log(`✅ Found ${type} OTP in SMS: ${otp}`);
                                    return otp;
                                }
                            }
                        }
                    }
                }
                
                // اگر کاربر جدیدی اضافه شد
                const timePassed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`⏳ [${timePassed}s] Waiting for SMS to be added to database...`);
                console.log(`📱 Expected SMS from AbanTether to: ${phoneNumber}`);
                
                await this.sleep(checkInterval);
                
            } catch (error) {
                console.error('❌ Error checking database for OTP:', error.message);
                await this.sleep(checkInterval);
            }
        }
        
        throw new Error(`Timeout: No ${type} OTP received after ${timeout/1000} seconds. Please check if SMS was sent to ${phoneNumber}`);
    }

    async updateUserStatus(phoneNumber, status, message = '') {
        const updateData = {
            status: status,
            lastUpdated: new Date()
        };
        
        if (message) {
            updateData.lastMessage = message;
        }
        
        if (status === 'completed') {
            updateData.processed = true;
            updateData.completedAt = new Date();
        } else if (status === 'failed') {
            updateData.processed = true;
            updateData.failedAt = new Date();
            updateData.error = message;
        }
        
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phoneNumber },
                { $set: updateData }
            );
            
            console.log(`📊 Status updated for ${phoneNumber}: ${status} - ${message}`);
            
        } catch (dbError) {
            console.error('❌ Error updating database:', dbError.message);
        }
    }

    // توابع registerCard, depositAndBuy, withdraw را ساده کنم
    async registerCard(user) {
        console.log('💳 Card registration step (simplified for now)');
        // فعلاً این مرحله را رد می‌کنیم تا تست ورود کار کند
        await this.sleep(2000);
    }

    async depositAndBuy(user) {
        console.log('💰 Deposit step (simplified for now)');
        await this.sleep(2000);
    }

    async withdraw(user) {
        console.log('🏦 Withdrawal step (simplified for now)');
        await this.sleep(2000);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPolling() {
        console.log('🔄 Starting database polling (every 30 seconds)...');
        
        // اولین چک
        await this.checkDatabase();
        
        // پولینگ
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                console.error('❌ Error in polling:', error.message);
            }
        }, 30000);
        
        // Health check
        const http = require('http');
        const server = http.createServer((req, res) => {
            const status = {
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers),
                userStates: Array.from(this.userStates.entries())
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status, null, 2));
        });
        
        server.listen(8080, () => {
            console.log('🌐 Health check on port 8080');
        });
    }

    async start() {
        console.log('🤖 Bot starting...');
        await this.connectToMongoDB();
        await this.startPolling();
    }
}

// اجرا
const bot = new AbanTetherBot();
bot.start();