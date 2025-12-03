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
            
            // کاربرانی که پردازش نشده‌اند و اطلاعات لازم را دارند
            const users = await this.collection.find({
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true },
                personalName: { $ne: "", $exists: true },
                cardNumber: { $ne: "", $exists: true }
            }).toArray();

            this.log('DATABASE', `Found ${users.length} users with complete data`);

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
            
            // دریافت وضعیت فعلی OTPها
            const currentUser = await this.collection.findOne({ personalPhoneNumber: phone });
            const otpStatus = {
                otp_login: currentUser?.otp_login || '',
                otp_register_card: currentUser?.otp_register_card || '',
                otp_payment: currentUser?.otp_payment || ''
            };
            
            this.log('OTP_STATUS', `Login: "${otpStatus.otp_login}", Card: "${otpStatus.otp_register_card}", Payment: "${otpStatus.otp_payment}"`);
            
            // Step 1: Initialize browser
            await this.updateUserStatus(phone, 'initializing_browser', 'Launching browser');
            await this.initializeBrowser();
            
            // Step 2: Login or Register
            if (otpStatus.otp_login && otpStatus.otp_login.trim() !== '') {
                await this.updateUserStatus(phone, 'logging_in', 'Logging in with existing OTP');
                await this.loginWithOTP(user, otpStatus.otp_login);
            } else {
                await this.updateUserStatus(phone, 'registering', 'Registering phone number');
                await this.registerPhone(user);
                
                await this.updateUserStatus(phone, 'waiting_login_otp', 'Waiting for login OTP');
                const loginOTP = await this.waitForField(phone, 'otp_login');
                await this.loginWithOTP(user, loginOTP);
            }
            
            // Step 3: Register card
            if (otpStatus.otp_register_card && otpStatus.otp_register_card.trim() !== '') {
                await this.updateUserStatus(phone, 'registering_card', 'Registering bank card with existing OTP');
                await this.registerCardWithOTP(user, otpStatus.otp_register_card);
            } else {
                await this.updateUserStatus(phone, 'adding_card', 'Adding bank card');
                await this.addCard(user);
                
                await this.updateUserStatus(phone, 'waiting_card_otp', 'Waiting for card OTP');
                const cardOTP = await this.waitForField(phone, 'otp_register_card');
                await this.registerCardWithOTP(user, cardOTP);
            }
            
            // Step 4: Make payment
            if (otpStatus.otp_payment && otpStatus.otp_payment.trim() !== '') {
                await this.updateUserStatus(phone, 'making_payment', 'Making payment with existing OTP');
                await this.makePaymentWithOTP(user, otpStatus.otp_payment);
            } else {
                await this.updateUserStatus(phone, 'initiating_payment', 'Initiating payment');
                await this.initiatePayment(user);
                
                await this.updateUserStatus(phone, 'waiting_payment_otp', 'Waiting for payment OTP');
                const paymentOTP = await this.waitForField(phone, 'otp_payment');
                await this.makePaymentWithOTP(user, paymentOTP);
            }
            
            // Step 5: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 6: Withdraw Tether
            await this.updateUserStatus(phone, 'withdrawing', 'Withdrawing Tether');
            await this.withdrawTether(user);
            
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
                    
                    // پاک کردن OTP بعد از استفاده
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return otp;
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 10 === 0) {
                    this.log('WAIT', `⏳ Still waiting for ${fieldName}... (${elapsed}s passed)`);
                    this.log('WAIT', `📱 Please add ${fieldName} to database for ${phone}`);
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

    async registerPhone(user) {
        try {
            this.log('REGISTER', `📝 Registering phone: ${user.personalPhoneNumber}`);
            
            // باز کردن صفحه ثبت‌نام
            await this.page.goto('https://abantether.com/register', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('01-register-page');
            
            // پیدا کردن فیلد شماره
            await this.page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await this.page.fill('input[name="username"]', user.personalPhoneNumber);
            this.log('REGISTER', `✅ Phone entered: ${user.personalPhoneNumber}`);
            
            await this.saveScreenshot('02-phone-filled');
            
            // پیدا کردن دکمه ادامه
            this.log('REGISTER', '🔍 Looking for continue button...');
            
            // چند روش مختلف برای پیدا کردن دکمه
            const buttonSelectors = [
                'button:has-text("ادامه")',
                'button:has-text("ارسال کد")',
                'button[type="submit"]',
                'form button'
            ];
            
            let buttonClicked = false;
            for (const selector of buttonSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button && await button.isVisible()) {
                        await button.click();
                        this.log('REGISTER', `✅ Clicked button with selector: ${selector}`);
                        buttonClicked = true;
                        break;
                    }
                } catch (e) {
                    // ignore
                }
            }
            
            if (!buttonClicked) {
                // فشار دادن Enter
                this.log('REGISTER', '⚠️ No button found, pressing Enter');
                await this.page.keyboard.press('Enter');
            }
            
            // منتظر پاسخ
            await this.sleep(5000);
            await this.saveScreenshot('03-after-submit');
            
            // بررسی اینکه آیا فیلد OTP ظاهر شده
            const otpField = await this.page.$('input[type="number"], input[name*="otp"], input[placeholder*="کد"]');
            
            if (otpField) {
                this.log('REGISTER', '✅ OTP field appeared!');
                this.log('REGISTER', `📱 Please enter otp_login in database for ${user.personalPhoneNumber}`);
                this.log('REGISTER', '💡 Command: db.zarinapp.updateOne({personalPhoneNumber: "09921106021"}, {$set: {otp_login: "123456"}})');
                return true;
            } else {
                this.log('REGISTER', '⚠️ OTP field not found');
                throw new Error('OTP field did not appear after submitting phone');
            }
            
        } catch (error) {
            this.log('ERROR', `Registration failed: ${error.message}`);
            await this.saveScreenshot('error-register');
            throw error;
        }
    }

    async loginWithOTP(user, otp) {
        try {
            this.log('LOGIN', `🔑 Logging in with OTP: ${otp}`);
            
            // وارد کردن OTP
            await this.page.fill('input[type="number"], input[name*="otp"], input[placeholder*="کد"]', otp);
            this.log('LOGIN', `✅ OTP entered: ${otp}`);
            
            await this.saveScreenshot('04-otp-entered');
            
            // پیدا کردن دکمه تأیید
            const confirmSelectors = [
                'button:has-text("تایید")',
                'button:has-text("ورود")',
                'button[type="submit"]'
            ];
            
            for (const selector of confirmSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button && await button.isVisible()) {
                        await button.click();
                        this.log('LOGIN', `✅ Clicked confirm button: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // ignore
                }
            }
            
            // منتظر لاگین
            await this.sleep(5000);
            await this.saveScreenshot('05-after-login');
            
            // پر کردن اطلاعات پروفایل
            this.log('LOGIN', '👤 Filling profile information...');
            
            if (user.personalName) {
                await this.fillField('نام', user.personalName);
            }
            
            if (user.personalNationalCode) {
                await this.fillField('کد ملی', user.personalNationalCode);
            }
            
            // تاریخ تولد
            if (user.personalBirthDate) {
                try {
                    // فرض می‌کنیم تاریخ به فرمت YYYY/MM/DD یا YYYY-MM-DD است
                    const dateStr = user.personalBirthDate.toString();
                    const parts = dateStr.split(/[/\-]/);
                    
                    if (parts.length >= 3) {
                        const year = parts[0];
                        const month = parts[1];
                        const day = parts[2];
                        
                        await this.fillField('سال', year);
                        await this.fillField('ماه', month);
                        await this.fillField('روز', day);
                    }
                } catch (e) {
                    this.log('ERROR', `Failed to parse birth date: ${e.message}`);
                }
            }
            
            if (user.personalCity) {
                await this.fillField('شهر', user.personalCity);
            }
            
            if (user.personalProvince) {
                await this.fillField('استان', user.personalProvince);
            }
            
            // ذخیره اطلاعات
            const saveButtons = await this.page.$$('button:has-text("ذخیره"), button:has-text("ثبت"), button:has-text("تایید")');
            if (saveButtons.length > 0) {
                await saveButtons[0].click();
                this.log('LOGIN', '✅ Profile information saved');
                await this.sleep(3000);
            }
            
            await this.saveScreenshot('06-profile-completed');
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            await this.saveScreenshot('error-login');
            throw error;
        }
    }

    async fillField(fieldName, value) {
        try {
            // جستجو با placeholder
            const selector = `input[placeholder*="${fieldName}"], input[name*="${fieldName}"]`;
            const field = await this.page.$(selector);
            
            if (field) {
                await field.fill(value);
                this.log('FILL', `✅ Filled ${fieldName}: ${value}`);
                return true;
            }
            
            // جستجو با label
            const xpath = `//label[contains(text(), "${fieldName}")]/following-sibling::input`;
            const fieldXpath = await this.page.$(`xpath=${xpath}`);
            if (fieldXpath) {
                await fieldXpath.fill(value);
                this.log('FILL', `✅ Filled ${fieldName} via label: ${value}`);
                return true;
            }
            
            this.log('WARN', `Field not found: ${fieldName}`);
            return false;
        } catch (error) {
            this.log('ERROR', `Failed to fill ${fieldName}: ${error.message}`);
            return false;
        }
    }

    async addCard(user) {
        try {
            this.log('CARD', '💳 Going to add bank card...');
            
            // رفتن به صفحه کیف پول
            await this.page.goto('https://abantether.com/wallet', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('07-wallet-page');
            
            // پیدا کردن دکمه اضافه کردن کارت
            const addCardButtons = await this.page.$$('button:has-text("اضافه کردن کارت"), button:has-text("ثبت کارت جدید")');
            
            if (addCardButtons.length > 0) {
                await addCardButtons[0].click();
                this.log('CARD', '✅ Clicked add card button');
            } else {
                this.log('CARD', '⚠️ Add card button not found, trying direct form');
            }
            
            await this.sleep(2000);
            await this.saveScreenshot('08-add-card-form');
            
            // پر کردن اطلاعات کارت
            if (user.cardNumber) {
                await this.fillField('شماره کارت', user.cardNumber);
            }
            
            if (user.cvv2) {
                await this.fillField('CVV2', user.cvv2);
            }
            
            if (user.bankMonth) {
                await this.fillField('ماه', user.bankMonth.toString());
            }
            
            if (user.bankYear) {
                await this.fillField('سال', user.bankYear.toString());
            }
            
            // ارسال فرم
            const submitButtons = await this.page.$$('button:has-text("ثبت کارت"), button[type="submit"]');
            if (submitButtons.length > 0) {
                await submitButtons[0].click();
                this.log('CARD', '✅ Card form submitted');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('09-card-submitted');
            
            this.log('CARD', `📱 Please enter otp_register_card in database for ${user.personalPhoneNumber}`);
            this.log('CARD', '💡 Command: db.zarinapp.updateOne({personalPhoneNumber: "09921106021"}, {$set: {otp_register_card: "654321"}})');
            
        } catch (error) {
            this.log('ERROR', `Add card failed: ${error.message}`);
            await this.saveScreenshot('error-add-card');
            throw error;
        }
    }

    async registerCardWithOTP(user, otp) {
        try {
            this.log('CARD_OTP', `🔐 Registering card with OTP: ${otp}`);
            
            // وارد کردن OTP کارت
            await this.page.fill('input[type="number"], input[name*="otp"], input[placeholder*="کد"]', otp);
            this.log('CARD_OTP', `✅ Card OTP entered: ${otp}`);
            
            await this.saveScreenshot('10-card-otp-entered');
            
            // تأیید
            const confirmButtons = await this.page.$$('button:has-text("تایید")');
            if (confirmButtons.length > 0) {
                await confirmButtons[0].click();
                this.log('CARD_OTP', '✅ Card confirmed');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('11-card-registered');
            
        } catch (error) {
            this.log('ERROR', `Card registration failed: ${error.message}`);
            await this.saveScreenshot('error-card-otp');
            throw error;
        }
    }

    async initiatePayment(user) {
        try {
            this.log('PAYMENT', '💰 Going to make payment...');
            
            // رفتن به صفحه واریز
            await this.page.goto('https://abantether.com/deposit', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('12-deposit-page');
            
            // وارد کردن مبلغ
            await this.fillField('مبلغ', '5000000');
            this.log('PAYMENT', '✅ Amount entered: 5,000,000 تومان');
            
            // ارسال درخواست واریز
            const depositButtons = await this.page.$$('button:has-text("واریز"), button:has-text("پرداخت")');
            if (depositButtons.length > 0) {
                await depositButtons[0].click();
                this.log('PAYMENT', '✅ Payment initiated');
            }
            
            await this.sleep(3000);
            await this.saveScreenshot('13-payment-initiated');
            
            this.log('PAYMENT', `📱 Please enter otp_payment in database for ${user.personalPhoneNumber}`);
            this.log('PAYMENT', '💡 Command: db.zarinapp.updateOne({personalPhoneNumber: "09921106021"}, {$set: {otp_payment: "987654"}})');
            
        } catch (error) {
            this.log('ERROR', `Payment initiation failed: ${error.message}`);
            await this.saveScreenshot('error-payment');
            throw error;
        }
    }

    async makePaymentWithOTP(user, otp) {
        try {
            this.log('PAYMENT_OTP', `💳 Making payment with OTP: ${otp}`);
            
            // وارد کردن OTP پرداخت
            await this.page.fill('input[type="number"], input[name*="otp"], input[placeholder*="کد"]', otp);
            this.log('PAYMENT_OTP', `✅ Payment OTP entered: ${otp}`);
            
            await this.saveScreenshot('14-payment-otp-entered');
            
            // تأیید پرداخت
            const confirmButtons = await this.page.$$('button:has-text("تایید")');
            if (confirmButtons.length > 0) {
                await confirmButtons[0].click();
                this.log('PAYMENT_OTP', '✅ Payment confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('15-payment-completed');
            
        } catch (error) {
            this.log('ERROR', `Payment failed: ${error.message}`);
            await this.saveScreenshot('error-payment-otp');
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Going to buy Tether...');
            
            // رفتن به بازار
            await this.page.goto('https://abantether.com/market', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('16-market-page');
            
            // پیدا کردن دکمه خرید تتر
            const buyButtons = await this.page.$$('button:has-text("خرید تتر")');
            if (buyButtons.length > 0) {
                await buyButtons[0].click();
                this.log('BUY', '✅ Clicked buy Tether button');
            }
            
            await this.sleep(2000);
            await this.saveScreenshot('17-buy-form');
            
            // انتخاب "همه موجودی"
            const allBalanceButtons = await this.page.$$('button:has-text("همه موجودی")');
            if (allBalanceButtons.length > 0) {
                await allBalanceButtons[0].click();
                this.log('BUY', '✅ Selected all balance');
            }
            
            // تأیید خرید
            const confirmBuyButtons = await this.page.$$('button:has-text("خرید"), button:has-text("تأیید خرید")');
            if (confirmBuyButtons.length > 0) {
                await confirmBuyButtons[0].click();
                this.log('BUY', '✅ Purchase confirmed');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('18-buy-completed');
            
        } catch (error) {
            this.log('ERROR', `Buy Tether failed: ${error.message}`);
            await this.saveScreenshot('error-buy');
            throw error;
        }
    }

    async withdrawTether(user) {
        try {
            this.log('WITHDRAW', '🏦 Going to withdraw Tether...');
            
            // رفتن به صفحه برداشت
            await this.page.goto('https://abantether.com/withdraw', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            await this.saveScreenshot('19-withdraw-page');
            
            // وارد کردن آدرس
            const withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
            await this.fillField('آدرس', withdrawAddress);
            this.log('WITHDRAW', `✅ Withdraw address entered: ${withdrawAddress}`);
            
            // برداشت
            const withdrawButtons = await this.page.$$('button:has-text("برداشت")');
            if (withdrawButtons.length > 0) {
                await withdrawButtons[0].click();
                this.log('WITHDRAW', '✅ Withdraw initiated');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('20-withdraw-completed');
            
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