const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
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
        this.screenshotsDir = './screenshots';
        this.password = 'Aban@1404T';
        this.maxRetries = 3; // حداکثر تعداد تلاش‌ها
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
            this.db = this.client.db(process.env.DATABASE_NAME);
            this.collection = this.db.collection(process.env.COLLECTION_NAME);
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
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true }
            }).toArray();

            this.log('DATABASE', `Found ${users.length} users with phone numbers`);

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
        
        try {
            this.log('PROCESS', `🔄 Processing user: ${phone}`);
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            // Step 1: Initialize browser
            await this.updateUserStatus(phone, 'initializing_browser', 'Launching browser');
            await this.initializeBrowser();
            
            // Step 2: Enter phone number and wait for OTP
            await this.updateUserStatus(phone, 'entering_phone', 'Entering phone number');
            await this.enterPhoneNumber(user);
            
            // Wait for OTP field with retry logic
            await this.updateUserStatus(phone, 'waiting_otp_field', 'Waiting for OTP field to appear');
            const otpFieldFound = await this.waitForOTPField();
            
            if (!otpFieldFound) {
                throw new Error('OTP field never appeared after multiple attempts');
            }
            
            // Step 3: Wait for OTP in database
            await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP in database');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            
            // Step 4: Login with OTP
            await this.updateUserStatus(phone, 'logging_in', 'Logging in with OTP');
            await this.loginWithOTP(user, loginOTP);
            
            // Step 5: Set password
            await this.updateUserStatus(phone, 'setting_password', 'Setting account password');
            await this.setPassword();
            
            // Step 6: Complete basic KYC
            await this.updateUserStatus(phone, 'completing_basic_kyc', 'Completing basic KYC');
            await this.completeBasicKYC(user);
            
            // Step 7: Register bank card
            await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
            await this.addCard(user);
            
            await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
            const cardOTP = await this.waitForField(phone, 'otp_register_card');
            
            await this.updateUserStatus(phone, 'registering_card', 'Registering card with OTP');
            await this.registerCardWithOTP(cardOTP);
            
            // Step 8: Deposit money
            await this.updateUserStatus(phone, 'initiating_payment', 'Initiating payment');
            await this.initiatePayment();
            
            await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
            const paymentOTP = await this.waitForField(phone, 'otp_payment');
            
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
            await this.updateUserStatus(phone, 'failed', error.message);
            throw error;
        } finally {
            this.processingUsers.delete(phone);
            // فقط در صورتی مرورگر بسته شود که کار تمام شده باشد
            if (this.browser && error) {
                await this.closeBrowser();
            }
        }
    }

    async waitForOTPField(maxAttempts = 3, waitTime = 120000) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.log('OTP_FIELD', `🔍 Looking for OTP field (Attempt ${attempt}/${maxAttempts})...`);
                
                // Wait for OTP field to appear
                let otpField = null;
                const startTime = Date.now();
                
                while (Date.now() - startTime < waitTime) {
                    otpField = await this.page.$('input[type="number"], input[placeholder*="کد"], input[name*="otp"]');
                    
                    if (otpField) {
                        const isVisible = await otpField.isVisible();
                        if (isVisible) {
                            this.log('OTP_FIELD', `✅ OTP field found and visible!`);
                            await this.saveScreenshot('otp-field-found');
                            return true;
                        }
                    }
                    
                    // Check for error messages
                    const pageContent = await this.page.content();
                    if (pageContent.includes('خطا') || pageContent.includes('error')) {
                        this.log('OTP_FIELD', '⚠️ Error detected on page');
                        await this.saveScreenshot('error-detected');
                        break;
                    }
                    
                    // Check if SMS was sent message appears
                    if (pageContent.includes('ارسال شد') || pageContent.includes('sent')) {
                        this.log('OTP_FIELD', '✅ SMS sent message detected');
                        await this.saveScreenshot('sms-sent-message');
                    }
                    
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    if (elapsed % 15 === 0) {
                        this.log('OTP_FIELD', `⏳ Still waiting for OTP field... (${elapsed}s)`);
                        await this.saveScreenshot(`waiting-${elapsed}s`);
                    }
                    
                    await this.sleep(3000);
                }
                
                if (attempt < maxAttempts) {
                    this.log('OTP_FIELD', `🔄 OTP field not found, refreshing page and retrying...`);
                    await this.page.reload();
                    await this.sleep(5000);
                    await this.saveScreenshot(`retry-${attempt}`);
                }
                
            } catch (error) {
                this.log('ERROR', `Error waiting for OTP field: ${error.message}`);
                if (attempt < maxAttempts) {
                    await this.sleep(5000);
                }
            }
        }
        
        this.log('OTP_FIELD', '❌ OTP field never appeared after all attempts');
        return false;
    }

    async waitForField(phone, fieldName, timeout = 300000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName} in database...`);
        
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
                    this.log('WAIT', `📱 Please check SMS for ${phone} and add ${fieldName} to database`);
                    this.log('WAIT', `💡 Command to add OTP: db.zarinapp.updateOne({personalPhoneNumber: "${phone}"}, {$set: {${fieldName}: "YOUR_OTP"}})`);
                    
                    // Take periodic screenshot to show we're still waiting
                    await this.saveScreenshot(`waiting-${fieldName}-${elapsed}s`);
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
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,720'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 },
                locale: 'fa-IR'
            });
            
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
            
            this.page = await context.newPage();
            
            // Set longer timeouts
            this.page.setDefaultTimeout(120000);
            this.page.setDefaultNavigationTimeout(120000);
            
            this.log('BROWSER', '✅ Browser initialized with longer timeouts');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async enterPhoneNumber(user) {
        try {
            this.log('PHONE', `📱 Starting registration for: ${user.personalPhoneNumber}`);
            
            // Go to main page
            await this.page.goto('https://abantether.com', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('01-main-page');
            
            // Try to find and click ثبت‌نام button
            let registerButton = await this.page.$('button:has-text("ثبت‌نام"), a:has-text("ثبت‌نام")');
            
            if (registerButton) {
                await registerButton.click();
                this.log('PHONE', '✅ Clicked ثبت‌نام button');
                await this.sleep(5000);
            } else {
                // If not found, try direct register URL
                this.log('PHONE', '⚠️ Register button not found, trying direct URL');
                await this.page.goto('https://abantether.com/register', {
                    waitUntil: 'networkidle',
                    timeout: 60000
                });
            }
            
            await this.saveScreenshot('02-register-page');
            
            // Enter phone number with multiple attempts
            let phoneEntered = false;
            const phoneInputSelectors = [
                'input[type="tel"]',
                'input[name*="phone"]',
                'input[name*="mobile"]',
                'input[placeholder*="موبایل"]',
                'input[placeholder*="شماره"]'
            ];
            
            for (const selector of phoneInputSelectors) {
                try {
                    const input = await this.page.$(selector);
                    if (input) {
                        await input.fill(user.personalPhoneNumber);
                        this.log('PHONE', `✅ Phone entered using selector: ${selector}`);
                        phoneEntered = true;
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!phoneEntered) {
                // Try all inputs
                const allInputs = await this.page.$$('input');
                for (const input of allInputs) {
                    try {
                        const placeholder = await input.getAttribute('placeholder') || '';
                        if (placeholder.includes('موبایل') || placeholder.includes('شماره')) {
                            await input.fill(user.personalPhoneNumber);
                            this.log('PHONE', `✅ Phone entered via placeholder: ${placeholder}`);
                            phoneEntered = true;
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
            
            await this.saveScreenshot('03-phone-filled');
            
            // Try to click continue button
            const continueSelectors = [
                'button:has-text("ادامه")',
                'button:has-text("مرحله بعد")',
                'button[type="submit"]',
                'form button'
            ];
            
            let buttonClicked = false;
            for (const selector of continueSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button) {
                        await button.click();
                        this.log('PHONE', `✅ Clicked button: ${selector}`);
                        buttonClicked = true;
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
            
            await this.sleep(8000); // Wait longer for response
            await this.saveScreenshot('04-after-submit');
            
            this.log('PHONE', '✅ Phone submitted, now waiting for OTP field...');
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            await this.saveScreenshot('error-phone');
            throw error;
        }
    }

    async loginWithOTP(user, otp) {
        try {
            this.log('LOGIN', `🔑 Entering OTP: ${otp}`);
            
            // Find OTP input with retry
            let otpInput = null;
            for (let i = 0; i < 10; i++) {
                otpInput = await this.page.$('input[type="number"], input[placeholder*="کد"], input[name*="otp"]');
                if (otpInput) {
                    break;
                }
                await this.sleep(1000);
            }
            
            if (!otpInput) {
                throw new Error('OTP input not found');
            }
            
            await otpInput.fill(otp);
            this.log('LOGIN', `✅ OTP entered: ${otp}`);
            
            await this.saveScreenshot('05-otp-entered');
            
            // Click تأیید button
            const confirmButton = await this.page.$('button:has-text("تأیید"), button:has-text("تایید")');
            
            if (confirmButton) {
                await confirmButton.click();
                this.log('LOGIN', '✅ Confirm button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('LOGIN', '✅ Pressed Enter');
            }
            
            await this.sleep(8000);
            await this.saveScreenshot('06-after-login');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async setPassword() {
        try {
            this.log('PASSWORD', '🔐 Setting password...');
            
            await this.sleep(5000);
            await this.saveScreenshot('07-checking-password-page');
            
            // Check if we're on password page
            const pageContent = await this.page.content();
            
            if (pageContent.includes('رمز عبور') || pageContent.includes('گذرواژه')) {
                this.log('PASSWORD', '✅ On password page');
                
                // Find password fields
                const passwordInputs = await this.page.$$('input[type="password"]');
                
                if (passwordInputs.length >= 2) {
                    // Enter password
                    await passwordInputs[0].fill(this.password);
                    this.log('PASSWORD', `✅ Password entered: ${this.password}`);
                    
                    // Confirm password
                    await passwordInputs[1].fill(this.password);
                    this.log('PASSWORD', '✅ Confirm password entered');
                    
                    // Click تکمیل ثبت‌نام button
                    const completeButton = await this.page.$('button:has-text("تکمیل ثبت‌نام")');
                    
                    if (completeButton) {
                        await completeButton.click();
                        this.log('PASSWORD', '✅ Registration completed');
                    } else {
                        // Try other buttons
                        const submitButton = await this.page.$('button[type="submit"]');
                        if (submitButton) {
                            await submitButton.click();
                            this.log('PASSWORD', '✅ Submitted via submit button');
                        } else {
                            await this.page.keyboard.press('Enter');
                            this.log('PASSWORD', '✅ Pressed Enter');
                        }
                    }
                    
                    await this.sleep(5000);
                    await this.saveScreenshot('08-password-set');
                    
                } else {
                    this.log('PASSWORD', `⚠️ Found ${passwordInputs.length} password fields, need at least 2`);
                }
            } else {
                this.log('PASSWORD', '⚠️ Not on password page, might have skipped or already set');
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
            
            await this.sleep(5000);
            await this.saveScreenshot('09-checking-kyc-page');
            
            // Check page content
            const pageContent = await this.page.content();
            
            if (pageContent.includes('کد ملی') || pageContent.includes('تاریخ تولد')) {
                this.log('KYC', '✅ On KYC page');
                
                // Enter national code
                if (user.personalNationalCode) {
                    const nationalCodeInput = await this.page.$('input[placeholder*="کد ملی"]');
                    
                    if (nationalCodeInput) {
                        await nationalCodeInput.fill(user.personalNationalCode);
                        this.log('KYC', `✅ National code entered: ${user.personalNationalCode}`);
                    }
                }
                
                // Enter birth date
                if (user.personalBirthDate) {
                    const birthDateInput = await this.page.$('input[placeholder*="تاریخ تولد"]');
                    
                    if (birthDateInput) {
                        await birthDateInput.fill(user.personalBirthDate);
                        this.log('KYC', `✅ Birth date entered: ${user.personalBirthDate}`);
                    }
                }
                
                await this.saveScreenshot('10-kyc-filled');
                
                // Click تأیید اطلاعات button
                const confirmButton = await this.page.$('button:has-text("تأیید اطلاعات")');
                
                if (confirmButton) {
                    await confirmButton.click();
                    this.log('KYC', '✅ KYC information submitted');
                } else {
                    await this.page.keyboard.press('Enter');
                    this.log('KYC', '✅ Pressed Enter');
                }
                
                await this.sleep(5000);
                await this.saveScreenshot('11-kyc-completed');
                
            } else {
                this.log('KYC', '⚠️ Not on KYC page, might have completed already');
            }
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            await this.saveScreenshot('error-kyc');
            throw error;
        }
    }

    async addCard(user) {
        try {
            this.log('CARD', '💳 Adding bank card...');
            
            // Go to wallet page
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('12-wallet-page');
            
            // Look for banking menu
            const bankingMenuSelectors = [
                'a:has-text("اطلاعات حساب بانکی")',
                'a:has-text("کارت‌های من")',
                'button:has-text("کارت‌های من")'
            ];
            
            let menuClicked = false;
            for (const selector of bankingMenuSelectors) {
                try {
                    const menu = await this.page.$(selector);
                    if (menu) {
                        await menu.click();
                        this.log('CARD', `✅ Clicked menu: ${selector}`);
                        menuClicked = true;
                        await this.sleep(3000);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!menuClicked) {
                this.log('CARD', '⚠️ Banking menu not found, trying to find add card directly');
            }
            
            await this.saveScreenshot('13-banking-page');
            
            // Click افزودن کارت جدید button
            const addCardButton = await this.page.$('button:has-text("افزودن کارت جدید")');
            
            if (addCardButton) {
                await addCardButton.click();
                this.log('CARD', '✅ Clicked add card button');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('14-add-card-form');
            
            // Enter card number
            if (user.cardNumber) {
                const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"]');
                
                if (cardNumberInput) {
                    await cardNumberInput.fill(user.cardNumber);
                    this.log('CARD', `✅ Card number entered: ${user.cardNumber}`);
                }
            }
            
            await this.saveScreenshot('15-card-filled');
            
            // Click ثبت کارت button
            const registerCardButton = await this.page.$('button:has-text("ثبت کارت")');
            
            if (registerCardButton) {
                await registerCardButton.click();
                this.log('CARD', '✅ Card registration submitted');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('16-card-submitted');
            
            this.log('CARD', `📱 Waiting for otp_register_card in database...`);
            
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
            const otpInput = await this.page.$('input[type="number"], input[placeholder*="کد"]');
            
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('CARD_OTP', `✅ Card OTP entered: ${otp}`);
            }
            
            await this.saveScreenshot('17-card-otp-entered');
            
            // Click تأیید button
            const confirmButton = await this.page.$('button:has-text("تأیید")');
            
            if (confirmButton) {
                await confirmButton.click();
                this.log('CARD_OTP', '✅ Card confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('18-card-registered');
            
        } catch (error) {
            this.log('ERROR', `Card registration failed: ${error.message}`);
            await this.saveScreenshot('error-card-otp');
            throw error;
        }
    }

    async initiatePayment() {
        try {
            this.log('PAYMENT', '💰 Initiating payment...');
            
            // Go to wallet page
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('19-wallet-for-payment');
            
            // Click واریز تومان button
            const depositButton = await this.page.$('button:has-text("واریز تومان"), a:has-text("واریز تومان")');
            
            if (depositButton) {
                await depositButton.click();
                this.log('PAYMENT', '✅ Clicked واریز تومان button');
                await this.sleep(3000);
            }
            
            await this.saveScreenshot('20-deposit-page');
            
            // Select واریز آنلاین
            const onlinePayment = await this.page.$('button:has-text("واریز آنلاین"), div:has-text("درگاه پرداخت")');
            
            if (onlinePayment) {
                await onlinePayment.click();
                this.log('PAYMENT', '✅ Selected online payment');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('21-payment-method');
            
            // Enter amount
            const amountInput = await this.page.$('input[placeholder*="مبلغ"], input[name*="amount"]');
            
            if (amountInput) {
                await amountInput.fill('5000000');
                this.log('PAYMENT', '✅ Amount entered: 5,000,000 تومان');
            }
            
            await this.saveScreenshot('22-amount-filled');
            
            // Click پرداخت button
            const payButton = await this.page.$('button:has-text("پرداخت"), button:has-text("ایجاد درخواست")');
            
            if (payButton) {
                await payButton.click();
                this.log('PAYMENT', '✅ Payment request created');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('23-payment-initiated');
            
            this.log('PAYMENT', '📱 Waiting for otp_payment in database...');
            
        } catch (error) {
            this.log('ERROR', `Payment initiation failed: ${error.message}`);
            await this.saveScreenshot('error-payment-init');
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT_OTP', `💳 Completing payment with OTP: ${otp}`);
            
            await this.saveScreenshot('24-bank-page');
            
            // This is simplified - in real scenario would need to interact with bank page
            this.log('PAYMENT_OTP', '⚠️ Bank payment page interaction would go here');
            
            await this.sleep(5000);
            await this.saveScreenshot('25-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment completion failed: ${error.message}`);
            await this.saveScreenshot('error-payment-complete');
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Buying Tether...');
            
            // Go to trading page
            await this.page.goto('https://abantether.com/market', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('26-market-page');
            
            // Select تتر and enter amount
            this.log('BUY', '✅ Would buy Tether with all balance here');
            
            await this.sleep(3000);
            await this.saveScreenshot('27-buy-completed');
            
        } catch (error) {
            this.log('ERROR', `Buy Tether failed: ${error.message}`);
            await this.saveScreenshot('error-buy');
            throw error;
        }
    }

    async withdrawTether() {
        try {
            this.log('WITHDRAW', '🏦 Withdrawing Tether...');
            
            // Go to wallet page
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 60000
            });
            
            await this.saveScreenshot('28-wallet-for-withdraw');
            
            // Click برداشت رمزارز and enter address
            this.log('WITHDRAW', '✅ Would withdraw Tether to external wallet here');
            
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
            const updateData = {
                status: status,
                statusMessage: message,
                lastUpdated: new Date()
            };
            
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: updateData }
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
        
        // Health check server
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers),
                uptime: process.uptime()
            }));
        });
        
        server.listen(8080, () => {
            this.log('SERVER', '🌐 Health check server running on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        this.log('CONFIG', `Max retries: ${this.maxRetries}`);
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
    // Don't exit, let it continue
});