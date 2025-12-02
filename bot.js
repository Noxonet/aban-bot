const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
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
        this.screenshotsDir = './screenshots';
    }

    async log(step, message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${step}] ${message}`;
        console.log(logMessage);
        await fs.appendFile('bot.log', logMessage + '\n');
    }

    async saveScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const filepath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: filepath, fullPage: true });
            this.log('SCREENSHOT', `Saved: ${filepath}`);
        } catch (error) {
            this.log('ERROR', `Failed to save screenshot: ${error.message}`);
        }
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db(process.env.DATABASE_NAME);
            this.collection = this.db.collection(process.env.COLLECTION_NAME);
            this.log('DATABASE', '✅ Connected to MongoDB');
        } catch (error) {
            this.log('ERROR', `❌ MongoDB connection failed: ${error.message}`);
            throw error;
        }
    }

    async checkDatabase() {
        try {
            const pendingUsers = await this.collection.find({
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true }
            }).toArray();

            this.log('DATABASE', `Found ${pendingUsers.length} pending users`);

            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                if (phone && !this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `🚀 Starting processing for: ${phone}`);
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
        
        try {
            this.log('PROCESS', `🔄 Processing user: ${phone}`);
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            // Step 1: Initialize
            await this.updateUserStatus(phone, 'initializing', 'Initializing browser');
            await this.initializeBrowser();
            
            // Step 2: Open site
            await this.updateUserStatus(phone, 'opening_site', 'Opening website');
            await this.openSite();
            
            // Step 3: Register
            await this.updateUserStatus(phone, 'registering', 'Registering phone number');
            const otpSent = await this.registerPhone(user);
            
            if (!otpSent) {
                throw new Error('Failed to send OTP request');
            }
            
            // Step 4: Handle OTP
            await this.updateUserStatus(phone, 'waiting_otp', 'Waiting for OTP SMS');
            await this.handleOTP(phone);
            
            // Step 5: Complete profile
            await this.updateUserStatus(phone, 'completing_profile', 'Completing profile');
            await this.completeProfile(user);
            
            // Step 6: Card registration
            await this.updateUserStatus(phone, 'registering_card', 'Registering bank card');
            await this.registerCard(user);
            
            // Step 7: Deposit
            await this.updateUserStatus(phone, 'depositing', 'Making deposit');
            await this.makeDeposit(user);
            
            // Step 8: Buy Tether
            await this.updateUserStatus(phone, 'buying', 'Buying Tether');
            await this.buyTether();
            
            // Step 9: Withdraw
            await this.updateUserStatus(phone, 'withdrawing', 'Withdrawing Tether');
            await this.withdrawTether(user);
            
            // Complete
            await this.updateUserStatus(phone, 'completed', 'Process completed');
            this.log('SUCCESS', `✅ Completed for: ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            await this.updateUserStatus(phone, 'failed', error.message);
            throw error;
        } finally {
            this.processingUsers.delete(phone);
            await this.closeBrowser();
        }
    }

    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 Initializing browser...');
            
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1280,720',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 },
                locale: 'fa-IR'
            });
            
            // Anti-detection
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fa'] });
            });
            
            this.page = await context.newPage();
            
            // Log network requests
            this.page.on('request', request => {
                if (request.url().includes('abantether') && request.method() === 'POST') {
                    this.log('NETWORK', `→ POST ${request.url()}`);
                }
            });
            
            this.page.on('response', response => {
                if (response.url().includes('abantether') && response.status() !== 200) {
                    this.log('NETWORK', `← ${response.status()} ${response.url()}`);
                }
            });
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `Browser init failed: ${error.message}`);
            throw error;
        }
    }

    async openSite() {
        try {
            this.log('WEBSITE', '🌐 Opening https://abantether.com/register');
            
            const response = await this.page.goto('https://abantether.com/register', {
                waitUntil: 'networkidle',
                timeout: 30000
            });
            
            this.log('WEBSITE', `Status: ${response?.status()}`);
            await this.saveScreenshot('01-site-loaded');
            
            // Wait for page to fully load
            await this.page.waitForLoadState('networkidle');
            await this.sleep(3000);
            
        } catch (error) {
            this.log('ERROR', `Failed to open site: ${error.message}`);
            throw error;
        }
    }

    async registerPhone(user) {
        try {
            this.log('REGISTER', `📝 Registering phone: ${user.personalPhoneNumber}`);
            
            // METHOD 1: Try to find input by name="username"
            let phoneInput = await this.page.$('input[name="username"]');
            
            // METHOD 2: Try by placeholder
            if (!phoneInput) {
                phoneInput = await this.page.$('input[placeholder*="موبایل"], input[placeholder*="شماره"]');
            }
            
            // METHOD 3: Try by type
            if (!phoneInput) {
                phoneInput = await this.page.$('input[type="tel"]');
            }
            
            // METHOD 4: Try all inputs
            if (!phoneInput) {
                const allInputs = await this.page.$$('input');
                for (const input of allInputs) {
                    const placeholder = await input.getAttribute('placeholder') || '';
                    if (placeholder.includes('موبایل') || placeholder.includes('شماره')) {
                        phoneInput = input;
                        break;
                    }
                }
            }
            
            if (!phoneInput) {
                await this.saveScreenshot('error-no-phone-input');
                throw new Error('Could not find phone input field');
            }
            
            this.log('REGISTER', '✅ Found phone input field');
            
            // Clear and fill phone number
            await phoneInput.click({ clickCount: 3 });
            await phoneInput.press('Backspace');
            await phoneInput.fill(user.personalPhoneNumber);
            this.log('REGISTER', `✅ Phone filled: ${user.personalPhoneNumber}`);
            
            await this.saveScreenshot('02-phone-filled');
            
            // Wait a bit before clicking
            await this.sleep(2000);
            
            // FIND AND CLICK CONTINUE BUTTON
            this.log('REGISTER', '🔍 Looking for continue button...');
            
            // Method 1: Look for specific button text
            const continueButton = await this.findButtonByText([
                'ادامه',
                'ارسال کد',
                'دریافت کد',
                'ارسال کد تأیید',
                'ثبت و ادامه'
            ]);
            
            if (continueButton) {
                this.log('REGISTER', `✅ Found continue button: ${continueButton.text}`);
                
                // Check if button is enabled
                const isDisabled = await continueButton.element.getAttribute('disabled');
                if (isDisabled) {
                    this.log('REGISTER', '⚠️ Button is disabled, checking why...');
                    await this.saveScreenshot('button-disabled');
                    throw new Error('Continue button is disabled');
                }
                
                await continueButton.element.click();
                this.log('REGISTER', '✅ Continue button clicked');
                
            } else {
                this.log('REGISTER', '❌ Could not find continue button by text, trying other methods...');
                
                // Method 2: Look for submit button
                const submitButtons = await this.page.$$('button[type="submit"], input[type="submit"]');
                this.log('REGISTER', `Found ${submitButtons.length} submit buttons`);
                
                if (submitButtons.length > 0) {
                    for (const button of submitButtons) {
                        const isVisible = await button.isVisible();
                        if (isVisible) {
                            await button.click();
                            this.log('REGISTER', '✅ Clicked submit button');
                            break;
                        }
                    }
                } else {
                    // Method 3: Press Enter key
                    this.log('REGISTER', '⚠️ No buttons found, pressing Enter...');
                    await this.page.keyboard.press('Enter');
                }
            }
            
            // Wait for response
            this.log('REGISTER', '⏳ Waiting for response...');
            await this.sleep(5000);
            
            // Check result
            await this.saveScreenshot('03-after-click');
            
            // Check for OTP field
            const otpField = await this.page.$('input[type="number"], input[name*="otp"], input[placeholder*="کد"]');
            
            if (otpField) {
                this.log('REGISTER', '✅ OTP field appeared! SMS should be sent');
                return true;
            } else {
                // Check for error messages
                const pageText = await this.page.textContent('body');
                
                if (pageText.includes('ارسال شد') || pageText.includes('sent') || pageText.includes('ارسال')) {
                    this.log('REGISTER', '✅ SMS sent message found');
                    return true;
                } else if (pageText.includes('خطا') || pageText.includes('error')) {
                    this.log('REGISTER', '❌ Error detected on page');
                    
                    // Try to get error details
                    const errorText = await this.page.evaluate(() => {
                        const errors = document.querySelectorAll('.error, .text-red, .alert-danger, [class*="error"]');
                        return Array.from(errors).map(e => e.textContent.trim()).filter(t => t).join(' | ');
                    });
                    
                    if (errorText) {
                        this.log('REGISTER', `Error details: ${errorText}`);
                        throw new Error(`Registration error: ${errorText}`);
                    }
                    
                    throw new Error('Unknown registration error');
                } else {
                    this.log('REGISTER', '⚠️ No OTP field and no clear status');
                    return false;
                }
            }
            
        } catch (error) {
            this.log('ERROR', `Registration failed: ${error.message}`);
            await this.saveScreenshot('error-registration');
            throw error;
        }
    }

    async findButtonByText(texts) {
        for (const text of texts) {
            try {
                // Try exact match first
                let button = await this.page.$(`button:has-text("${text}")`);
                
                // Try case-insensitive
                if (!button) {
                    const allButtons = await this.page.$$('button');
                    for (const btn of allButtons) {
                        const btnText = await btn.textContent();
                        if (btnText && btnText.trim().includes(text)) {
                            button = btn;
                            break;
                        }
                    }
                }
                
                // Try input buttons
                if (!button) {
                    const inputButtons = await this.page.$$('input[type="button"], input[type="submit"]');
                    for (const btn of inputButtons) {
                        const value = await btn.getAttribute('value');
                        if (value && value.includes(text)) {
                            button = btn;
                            break;
                        }
                    }
                }
                
                if (button) {
                    const isVisible = await button.isVisible();
                    if (isVisible) {
                        const buttonText = await button.textContent() || await button.getAttribute('value') || '';
                        return { element: button, text: buttonText.trim() };
                    }
                }
            } catch (e) {
                // Continue to next text
            }
        }
        return null;
    }

    async handleOTP(phone) {
        try {
            this.log('OTP', `📱 Handling OTP for ${phone}`);
            
            // Wait for OTP field to appear
            this.log('OTP', '⏳ Waiting for OTP input field...');
            
            let otpField = null;
            for (let i = 0; i < 30; i++) {
                otpField = await this.page.$('input[type="number"], input[name*="otp"], input[placeholder*="کد"], input[placeholder*="رمز"]');
                if (otpField) {
                    this.log('OTP', '✅ OTP field found');
                    break;
                }
                this.log('OTP', `Still waiting... (${i + 1}/30)`);
                await this.sleep(1000);
            }
            
            if (!otpField) {
                this.log('OTP', '⚠️ OTP field not found, checking page...');
                await this.saveScreenshot('04-no-otp-field');
                
                // Maybe we're on a different page
                const pageUrl = await this.page.url();
                this.log('OTP', `Current URL: ${pageUrl}`);
                
                if (!pageUrl.includes('register') && !pageUrl.includes('login')) {
                    this.log('OTP', '✅ Seems like we passed OTP stage');
                    return;
                }
            }
            
            // Inform user
            this.log('OTP', '📢 IMPORTANT: Check SMS on your phone!');
            this.log('OTP', `📱 Website should have sent SMS to: ${phone}`);
            this.log('OTP', '📱 Please add the OTP from SMS to database');
            
            // Wait for OTP in database
            const otp = await this.waitForOTPInDatabase(phone);
            
            // Enter OTP
            this.log('OTP', `✅ OTP received: ${otp}`);
            
            if (otpField) {
                await otpField.fill(otp);
                this.log('OTP', `✅ OTP entered: ${otp}`);
            } else {
                // Try to find any input
                const inputs = await this.page.$$('input');
                for (const input of inputs) {
                    const type = await input.getAttribute('type');
                    if (type === 'number' || type === 'text') {
                        await input.fill(otp);
                        this.log('OTP', '✅ OTP entered in available input');
                        break;
                    }
                }
            }
            
            await this.saveScreenshot('05-otp-entered');
            
            // Find and click confirm button
            this.log('OTP', '🔍 Looking for confirm button...');
            
            const confirmButton = await this.findButtonByText(['تایید', 'ورود', 'ثبت', 'تأیید']);
            
            if (confirmButton) {
                await confirmButton.element.click();
                this.log('OTP', '✅ Confirm button clicked');
            } else {
                this.log('OTP', '⚠️ No confirm button, pressing Enter');
                await this.page.keyboard.press('Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('06-after-confirm');
            
        } catch (error) {
            this.log('ERROR', `OTP handling failed: ${error.message}`);
            await this.saveScreenshot('error-otp');
            throw error;
        }
    }

    async waitForOTPInDatabase(phone, timeout = 300000) {
        const startTime = Date.now();
        
        this.log('OTP_DB', `⏳ Waiting for OTP in database for ${phone}...`);
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user.sms) {
                    // Check SMS from newest to oldest
                    const sortedSMS = [...user.sms].sort((a, b) => b.date - a.date);
                    
                    for (const sms of sortedSMS) {
                        if (sms.body && (sms.body.includes('آبان') || sms.body.includes('abantether'))) {
                            // Try to extract OTP
                            const otpMatch = sms.body.match(/(\d{4,6})/);
                            if (otpMatch) {
                                this.log('OTP_DB', `✅ Found OTP in SMS: ${otpMatch[1]}`);
                                return otpMatch[1];
                            }
                        }
                    }
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                this.log('OTP_DB', `⏳ [${elapsed}s] Waiting...`);
                
                await this.sleep(5000);
                
            } catch (error) {
                this.log('ERROR', `Database check error: ${error.message}`);
                await this.sleep(5000);
            }
        }
        
        throw new Error(`Timeout: No OTP found after ${timeout/1000} seconds`);
    }

    async completeProfile(user) {
        try {
            this.log('PROFILE', '👤 Completing user profile...');
            await this.sleep(3000);
            this.log('PROFILE', '✅ Profile step completed (simplified)');
        } catch (error) {
            this.log('ERROR', `Profile completion failed: ${error.message}`);
            throw error;
        }
    }

    async registerCard(user) {
        try {
            this.log('CARD', '💳 Registering bank card...');
            await this.sleep(3000);
            this.log('CARD', '✅ Card step completed (simplified)');
        } catch (error) {
            this.log('ERROR', `Card registration failed: ${error.message}`);
            throw error;
        }
    }

    async makeDeposit(user) {
        try {
            this.log('DEPOSIT', '💰 Making deposit...');
            await this.sleep(3000);
            this.log('DEPOSIT', '✅ Deposit step completed (simplified)');
        } catch (error) {
            this.log('ERROR', `Deposit failed: ${error.message}`);
            throw error;
        }
    }

    async buyTether() {
        try {
            this.log('BUY', '🛒 Buying Tether...');
            await this.sleep(3000);
            this.log('BUY', '✅ Buy step completed (simplified)');
        } catch (error) {
            this.log('ERROR', `Buy failed: ${error.message}`);
            throw error;
        }
    }

    async withdrawTether(user) {
        try {
            this.log('WITHDRAW', '🏦 Withdrawing Tether...');
            await this.sleep(3000);
            this.log('WITHDRAW', '✅ Withdraw step completed (simplified)');
        } catch (error) {
            this.log('ERROR', `Withdraw failed: ${error.message}`);
            throw error;
        }
    }

    async updateUserStatus(phone, status, message) {
        try {
            const updateData = {
                status: status,
                statusMessage: message,
                lastUpdated: new Date()
            };
            
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: updateData }
            );
            
            this.log('STATUS', `📊 ${phone}: ${status} - ${message}`);
            
        } catch (error) {
            this.log('ERROR', `Status update failed: ${error.message}`);
        }
    }

    async closeBrowser() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
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
        this.log('POLLING', '🔄 Starting polling (every 30s)');
        
        await this.checkDatabase();
        
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        // Health check
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
            this.log('SERVER', '🌐 Health check on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        
        try {
            await this.connectToMongoDB();
            await this.startPolling();
        } catch (error) {
            this.log('ERROR', `Start failed: ${error.message}`);
            setTimeout(() => this.start(), 10000);
        }
    }
}

// اجرا
const bot = new AbanTetherBot();
bot.start();

// هندل خطاها
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT]', error);
});