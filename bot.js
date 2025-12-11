const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

class AbanTetherBot {
    constructor() {
        this.client = new MongoClient(process.env.MONGODB_URI || 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority');
        this.db = null;
        this.collection = null;
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Map();
        this.screenshotsDir = './screenshots';
        this.password = 'Aban@1404T';
        this.maxRetries = 3;
        this.maxSessions = 1;
        this.activeSessions = 0;
    }

    async log(step, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${step}] ${message}`;
        console.log(logMessage);
        await fs.appendFile('bot.log', logMessage + '\n');
    }

    async saveScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const filepath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: filepath });
            this.log('SCREENSHOT', `Saved: ${filepath}`);
        } catch (error) {
            this.log('ERROR', `Screenshot error: ${error.message}`);
        }
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db(process.env.DATABASE_NAME || 'ZarrinApp');
            this.collection = this.db.collection(process.env.COLLECTION_NAME || 'zarinapp');
            this.log('DATABASE', '✅ Connected to MongoDB');
            
            // چاپ نمونه‌ای از دیتا برای دیباگ
            const sampleData = await this.collection.find().limit(1).toArray();
            if (sampleData.length > 0) {
                this.log('DATABASE', `Sample user data: ${JSON.stringify(sampleData[0], null, 2)}`);
            }
        } catch (error) {
            this.log('ERROR', `Database connection failed: ${error.message}`);
            throw error;
        }
    }

    async checkDatabase() {
        try {
            this.log('DATABASE', '🔍 Checking for pending users...');
            
            // کوئری اصلاح شده
            const query = {
                $and: [
                    { personalPhoneNumber: { $exists: true, $ne: null, $ne: "" } },
                    { 
                        $or: [
                            { processed: { $exists: false } },
                            { processed: false },
                            { processed: { $ne: true } }
                        ]
                    },
                    {
                        $or: [
                            { status: { $exists: false } },
                            { status: { $ne: 'completed' } },
                            { 
                                $and: [
                                    { status: 'failed' },
                                    { retryCount: { $lt: this.maxRetries } }
                                ]
                            }
                        ]
                    }
                ]
            };

            // لاگ کوئری برای دیباگ
            this.log('DATABASE', `Query: ${JSON.stringify(query)}`);
            
            const users = await this.collection.find(query).toArray();

            this.log('DATABASE', `Found ${users.length} users matching query`);

            // چاپ برخی اطلاعات کاربران برای دیباگ
            if (users.length > 0) {
                users.slice(0, 3).forEach((user, index) => {
                    this.log('DATABASE', `User ${index + 1}: ${user.personalPhoneNumber}, Processed: ${user.processed}, Status: ${user.status}`);
                });
            }

            for (const user of users) {
                const phone = user.personalPhoneNumber;
                
                if (phone && !this.processingUsers.has(phone) && this.activeSessions < this.maxSessions) {
                    this.log('PROCESSING', `🚀 Starting processing for: ${phone}`);
                    
                    // ذخیره اطلاعات کاربر
                    this.processingUsers.set(phone, {
                        user,
                        retryCount: user.retryCount || 0,
                        startedAt: new Date(),
                        status: 'starting'
                    });
                    this.activeSessions++;
                    
                    // پردازش
                    this.processUser(user).catch(async (error) => {
                        this.log('ERROR', `Failed for ${phone}: ${error.message}`);
                        const userInfo = this.processingUsers.get(phone);
                        if (userInfo) {
                            userInfo.retryCount += 1;
                            await this.handleUserFailure(phone, error.message, userInfo.retryCount);
                        }
                        this.processingUsers.delete(phone);
                        this.activeSessions = Math.max(0, this.activeSessions - 1);
                    });
                } else if (this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `⏭️ User ${phone} is already being processed`);
                } else if (this.activeSessions >= this.maxSessions) {
                    this.log('PROCESSING', `⏸️ Max sessions reached (${this.activeSessions}/${this.maxSessions})`);
                }
            }
        } catch (error) {
            this.log('ERROR', `Database check error: ${error.message}`);
        }
    }

    async handleUserFailure(phone, errorMessage, retryCount) {
        try {
            if (retryCount >= this.maxRetries) {
                await this.collection.updateOne(
                    { personalPhoneNumber: phone },
                    { 
                        $set: {
                            processed: true,
                            status: 'failed',
                            failureReason: `Max retries exceeded: ${errorMessage}`,
                            failedAt: new Date(),
                            retryCount: retryCount
                        }
                    }
                );
                this.log('STATUS', `❌ User ${phone} marked as failed after ${retryCount} attempts`);
            } else {
                await this.collection.updateOne(
                    { personalPhoneNumber: phone },
                    { 
                        $set: {
                            processed: false,
                            status: 'failed_retryable',
                            failureReason: errorMessage,
                            lastRetry: new Date(),
                            retryCount: retryCount
                        }
                    }
                );
                this.log('STATUS', `⚠️ User ${phone} failed (attempt ${retryCount}/${this.maxRetries})`);
            }
        } catch (error) {
            this.log('ERROR', `Failed to update failure status: ${error.message}`);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        const userInfo = this.processingUsers.get(phone);
        const retryCount = userInfo?.retryCount || 0;
        
        try {
            this.log('PROCESS', `🔄 Processing user: ${phone} (Attempt: ${retryCount + 1}/${this.maxRetries})`);
            
            // آپدیت وضعیت شروع
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: {
                        status: 'processing',
                        startedAt: new Date(),
                        retryCount: retryCount + 1
                    }
                }
            );
            
            // Step 1: Initialize browser
            this.log('BROWSER', '🚀 Initializing browser...');
            await this.initializeBrowser();
            
            // Step 2: Register/Login
            await this.registerAndLogin(user);
            
            // Step 3: Check if we need to add card (only if we have card info)
            if (user.cardNumber && user.cardNumber.trim() !== '') {
                await this.addCard(user);
                
                // Wait for card OTP
                this.log('WAIT', '⏳ Waiting for card OTP...');
                const cardOTP = await this.waitForFieldInDB(phone, 'otp_register_card');
                
                if (cardOTP) {
                    await this.registerCardWithOTP(cardOTP);
                }
            }
            
            // Step 4: Check if we need to make payment
            if (user.otp_payment && user.otp_payment.trim() !== '') {
                await this.initiateDeposit();
                
                // Wait for payment OTP
                this.log('WAIT', '⏳ Waiting for payment OTP...');
                const paymentOTP = await this.waitForFieldInDB(phone, 'otp_payment');
                
                if (paymentOTP) {
                    await this.completePayment(paymentOTP);
                }
            }
            
            // Mark as completed
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: { 
                        processed: true,
                        status: "completed",
                        completedAt: new Date()
                    },
                    $unset: {
                        otp_login: "",
                        otp_register_card: "",
                        otp_payment: ""
                    }
                }
            );
            
            this.log('SUCCESS', `✅ Successfully completed for: ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            
            // Update failure status
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: {
                        status: 'failed',
                        failureReason: error.message,
                        failedAt: new Date()
                    }
                }
            );
            
            throw error;
        } finally {
            this.closeBrowser();
            const userInfo = this.processingUsers.get(phone);
            if (userInfo) {
                this.activeSessions = Math.max(0, this.activeSessions - 1);
            }
            this.processingUsers.delete(phone);
        }
    }

    async waitForFieldInDB(phone, fieldName, timeout = 180000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName} in database for ${phone}...`);
        
        const startTime = Date.now();
        const checkInterval = 5000;
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: phone },
                    { projection: { [fieldName]: 1, _id: 0 } }
                );
                
                if (user && user[fieldName] && user[fieldName].toString().trim() !== '') {
                    const value = user[fieldName].toString();
                    this.log('WAIT', `✅ ${fieldName} received: ${value}`);
                    
                    // حذف OTP از دیتابیس
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return value;
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 30 === 0) {
                    this.log('WAIT', `⏳ Still waiting for ${fieldName}... (${elapsed}s elapsed)`);
                }
                
                await this.sleep(checkInterval);
                
            } catch (error) {
                this.log('ERROR', `Error checking ${fieldName}: ${error.message}`);
                await this.sleep(checkInterval);
            }
        }
        
        throw new Error(`Timeout: No ${fieldName} received after ${timeout/1000} seconds`);
    }

    async initializeBrowser() {
        try {
            this.browser = await chromium.launch({
                headless: process.env.NODE_ENV === 'production',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,800'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 800 },
                locale: 'fa-IR'
            });
            
            this.page = await context.newPage();
            this.page.setDefaultTimeout(60000);
            this.page.setDefaultNavigationTimeout(60000);
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async registerAndLogin(user) {
        try {
            this.log('LOGIN', `📱 Starting registration/login for: ${user.personalPhoneNumber}`);
            
            // رفتن به صفحه اصلی
            await this.page.goto('https://abantether.com', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('01-main-page');
            
            // جستجوی دکمه ثبت‌نام یا ورود
            const loginSelectors = [
                'a:has-text("ثبت‌نام")',
                'button:has-text("ثبت‌نام")',
                'a:has-text("ورود")',
                'button:has-text("ورود")',
                'a[href*="/register"]',
                'a[href*="/login"]'
            ];
            
            let loginFound = false;
            for (const selector of loginSelectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        this.log('LOGIN', `✅ Clicked login/register: ${selector}`);
                        loginFound = true;
                        await this.sleep(3000);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!loginFound) {
                // رفتن مستقیم به صفحه ثبت‌نام
                await this.page.goto('https://abantether.com/register', {
                    waitUntil: 'networkidle',
                    timeout: 60000
                });
            }
            
            await this.saveScreenshot('02-login-page');
            
            // ورود شماره موبایل
            await this.enterPhoneNumber(user.personalPhoneNumber);
            await this.saveScreenshot('03-phone-entered');
            
            // کلیک ادامه
            await this.clickContinueButton();
            await this.sleep(5000);
            await this.saveScreenshot('04-after-continue');
            
            // منتظر OTP لاگین در دیتابیس
            this.log('WAIT', '⏳ Waiting for login OTP...');
            const loginOTP = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_login');
            
            if (!loginOTP) {
                throw new Error('No login OTP received');
            }
            
            // ورود OTP
            await this.enterOTP(loginOTP);
            await this.saveScreenshot('05-otp-entered');
            
            // کلیک تأیید
            await this.clickVerifyButton();
            await this.sleep(5000);
            await this.saveScreenshot('06-logged-in');
            
            // بررسی اگر صفحه تنظیم رمز عبور است
            const pageContent = await this.page.content();
            if (pageContent.includes('رمز عبور') || pageContent.includes('گذرواژه')) {
                await this.setPassword();
            }
            
            // بررسی اگر صفحه تکمیل اطلاعات است
            if (pageContent.includes('کد ملی') || pageContent.includes('تاریخ تولد')) {
                await this.completeKYC(user);
            }
            
            this.log('LOGIN', '✅ Login completed successfully');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async enterPhoneNumber(phoneNumber) {
        this.log('PHONE', `🔍 Entering phone number: ${phoneNumber}`);
        
        const phoneSelectors = [
            'input[type="tel"]',
            'input[name*="phone"]',
            'input[name*="mobile"]',
            'input[placeholder*="موبایل"]',
            'input[placeholder*="شماره"]'
        ];
        
        for (const selector of phoneSelectors) {
            try {
                const input = await this.page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill(phoneNumber);
                    this.log('PHONE', `✅ Phone entered via selector: ${selector}`);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error('Could not find phone input field');
    }

    async clickContinueButton() {
        this.log('BUTTON', '🔍 Looking for continue button...');
        
        const buttonTexts = ['ادامه', 'مرحله بعد', 'بعدی', 'ارسال', 'تایید'];
        
        for (const text of buttonTexts) {
            try {
                const xpath = `//*[text()="${text}" or contains(text(), "${text}")]`;
                const elements = await this.page.$$(xpath);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked: "${text}"`);
                            return true;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error('Continue button not found');
    }

    async enterOTP(otp) {
        this.log('OTP', `🔐 Entering OTP: ${otp}`);
        
        // روش 1: فیلدهای جداگانه
        const otpInputs = await this.page.$$('input[type="number"], input[maxlength="1"]');
        if (otpInputs.length >= 4) {
            for (let i = 0; i < Math.min(otpInputs.length, otp.length); i++) {
                await otpInputs[i].fill(otp[i]);
            }
            return true;
        }
        
        // روش 2: فیلد تک
        const singleInput = await this.page.$('input[type="tel"][maxlength="6"], input[type="number"][maxlength="6"]');
        if (singleInput) {
            await singleInput.fill(otp);
            return true;
        }
        
        throw new Error('OTP input field not found');
    }

    async clickVerifyButton() {
        this.log('BUTTON', '🔍 Looking for verify button...');
        
        const verifyTexts = ['تأیید', 'تایید', 'ورود', 'ثبت'];
        
        for (const text of verifyTexts) {
            try {
                const selector = `:has-text("${text}")`;
                const elements = await this.page.$$(selector);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked verify: "${text}"`);
                            return true;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error('Verify button not found');
    }

    async setPassword() {
        try {
            this.log('PASSWORD', '🔐 Setting password...');
            
            const passwordInputs = await this.page.$$('input[type="password"]');
            
            if (passwordInputs.length >= 2) {
                await passwordInputs[0].fill(this.password);
                await passwordInputs[1].fill(this.password);
                
                // کلیک تکمیل
                await this.clickCompleteButton();
                
                await this.sleep(3000);
                await this.saveScreenshot('07-password-set');
            }
            
        } catch (error) {
            this.log('ERROR', `Password setting failed: ${error.message}`);
            throw error;
        }
    }

    async clickCompleteButton() {
        const completeTexts = ['تکمیل ثبت‌نام', 'تکمیل', 'ادامه'];
        
        for (const text of completeTexts) {
            try {
                const selector = `:has-text("${text}")`;
                const elements = await this.page.$$(selector);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked complete: "${text}"`);
                            return true;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error('Complete button not found');
    }

    async completeKYC(user) {
        try {
            this.log('KYC', '📋 Completing KYC...');
            
            const fields = [
                { label: 'نام', value: user.personalName },
                { label: 'کد ملی', value: user.personalNationalCode },
                { label: 'تاریخ تولد', value: user.personalBirthDate },
                { label: 'شهر', value: user.personalCity },
                { label: 'استان', value: user.personalProvince }
            ];
            
            for (const field of fields) {
                if (field.value) {
                    const input = await this.page.$(`input[placeholder*="${field.label}"]`);
                    if (input) {
                        await input.fill(field.value);
                        this.log('KYC', `✅ ${field.label}: ${field.value}`);
                    }
                }
            }
            
            await this.saveScreenshot('08-kyc-filled');
            
            // تأیید
            await this.clickVerifyButton();
            
            await this.sleep(3000);
            await this.saveScreenshot('09-kyc-completed');
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            throw error;
        }
    }

    async addCard(user) {
        try {
            this.log('CARD', '💳 Adding bank card...');
            
            // رفتن به کیف پول
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('10-wallet-page');
            
            // پیدا کردن بخش کارت‌ها
            const cardButton = await this.page.$(':has-text("کارت‌های من"), :has-text("افزودن کارت")');
            if (cardButton) {
                await cardButton.click();
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('11-card-section');
            
            // پر کردن اطلاعات کارت
            const cardFields = [
                { label: 'شماره کارت', value: user.cardNumber },
                { label: 'CVV2', value: user.cvv2 },
                { label: 'ماه', value: user.bankMonth?.toString() },
                { label: 'سال', value: user.bankYear?.toString() }
            ];
            
            for (const field of cardFields) {
                if (field.value) {
                    const input = await this.page.$(`input[placeholder*="${field.label}"]`);
                    if (input) {
                        await input.fill(field.value);
                    }
                }
            }
            
            await this.saveScreenshot('12-card-filled');
            
            // ثبت
            const registerButton = await this.page.$(':has-text("ثبت کارت")');
            if (registerButton) {
                await registerButton.click();
                this.log('CARD', '✅ Card registration submitted');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('13-card-submitted');
            
        } catch (error) {
            this.log('ERROR', `Add card failed: ${error.message}`);
            throw error;
        }
    }

    async registerCardWithOTP(otp) {
        try {
            this.log('CARD_OTP', `🔐 Completing card with OTP: ${otp}`);
            
            await this.enterOTP(otp);
            await this.saveScreenshot('14-card-otp');
            
            await this.clickVerifyButton();
            
            await this.sleep(3000);
            await this.saveScreenshot('15-card-completed');
            
        } catch (error) {
            this.log('ERROR', `Card OTP failed: ${error.message}`);
            throw error;
        }
    }

    async initiateDeposit() {
        try {
            this.log('DEPOSIT', '💰 Initiating deposit...');
            
            // رفتن به کیف پول
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            // کلیک واریز تومان
            const depositButton = await this.page.$(':has-text("واریز تومان")');
            if (depositButton) {
                await depositButton.click();
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('16-deposit-page');
            
            // وارد کردن مبلغ
            const amountInput = await this.page.$('input[placeholder*="مبلغ"]');
            if (amountInput) {
                await amountInput.fill('5000000');
            }
            
            await this.saveScreenshot('17-amount-filled');
            
            // پرداخت
            const payButton = await this.page.$(':has-text("پرداخت")');
            if (payButton) {
                await payButton.click();
                this.log('DEPOSIT', '✅ Payment initiated');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('18-payment-initiated');
            
        } catch (error) {
            this.log('ERROR', `Deposit failed: ${error.message}`);
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT', `💳 Completing payment with OTP: ${otp}`);
            
            await this.enterOTP(otp);
            await this.saveScreenshot('19-payment-otp');
            
            await this.clickVerifyButton();
            
            await this.sleep(3000);
            await this.saveScreenshot('20-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment failed: ${error.message}`);
            throw error;
        }
    }

    async closeBrowser() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
                this.log('BROWSER', '✅ Browser closed');
            }
        } catch (error) {
            this.log('ERROR', `Browser close failed: ${error.message}`);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPolling() {
        this.log('POLLING', '🔄 Starting database polling (every 30 seconds)');
        
        await this.checkDatabase();
        
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        // Health check server
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers.keys()),
                activeSessions: this.activeSessions,
                uptime: process.uptime()
            }));
        });
        
        server.listen(process.env.PORT || 8080, () => {
            this.log('SERVER', `🌐 Health check server running on port ${process.env.PORT || 8080}`);
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        this.log('CONFIG', `Max retries: ${this.maxRetries}`);
        this.log('CONFIG', `Max sessions: ${this.maxSessions}`);
        
        try {
            await this.connectToMongoDB();
            await this.startPolling();
        } catch (error) {
            this.log('ERROR', `Start failed: ${error.message}`);
            setTimeout(() => this.start(), 10000);
        }
    }
}

// اجرای ربات
const bot = new AbanTetherBot();
bot.start();

// هندل خطاها
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
});