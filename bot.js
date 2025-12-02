const { MongoClient } = require('mongodb');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

class AbanTetherBot {
    constructor() {
        this.client = new MongoClient(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 10000
        });
        this.db = null;
        this.collection = null;
        this.browser = null;
        this.page = null;
        this.currentUser = null;
        this.processingUsers = new Set();
        this.debugMode = true;
        this.screenshotsDir = './screenshots';
    }

    async log(step, message, data = null) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${step}] ${message}`;
        
        console.log(logMessage);
        
        if (data && this.debugMode) {
            console.log(`[${timestamp}] [${step}] Data:`, JSON.stringify(data, null, 2));
        }
        
        // ذخیره در فایل لاگ
        try {
            await fs.appendFile('bot-debug.log', logMessage + '\n');
        } catch (err) {
            // ignore file errors
        }
    }

    async saveScreenshot(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const screenshotPath = path.join(this.screenshotsDir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: true });
            this.log('SCREENSHOT', `Saved: ${screenshotPath}`);
        } catch (error) {
            this.log('ERROR', `Failed to save screenshot: ${error.message}`);
        }
    }

    async savePageHTML(name) {
        try {
            await fs.mkdir(this.screenshotsDir, { recursive: true });
            const htmlPath = path.join(this.screenshotsDir, `${name}-${Date.now()}.html`);
            const content = await this.page.content();
            await fs.writeFile(htmlPath, content);
            this.log('HTML', `Saved: ${htmlPath}`);
        } catch (error) {
            this.log('ERROR', `Failed to save HTML: ${error.message}`);
        }
    }

    async connectToMongoDB() {
        try {
            await this.client.connect();
            this.db = this.client.db(process.env.DATABASE_NAME);
            this.collection = this.db.collection(process.env.COLLECTION_NAME);
            this.log('DATABASE', '✅ Connected to MongoDB');
            return true;
        } catch (error) {
            this.log('ERROR', `❌ MongoDB connection error: ${error.message}`);
            return false;
        }
    }

    async checkDatabase() {
        try {
            this.log('DATABASE', '🔍 Checking for pending users...');
            
            const pendingUsers = await this.collection.find({
                processed: { $ne: true },
                personalPhoneNumber: { $ne: "", $exists: true }
            }).toArray();

            this.log('DATABASE', `Found ${pendingUsers.length} pending users`, 
                pendingUsers.map(u => ({ phone: u.personalPhoneNumber, status: u.status })));

            for (const user of pendingUsers) {
                const phone = user.personalPhoneNumber;
                
                if (phone && phone.trim() !== "" && !this.processingUsers.has(phone)) {
                    this.log('PROCESSING', `🚀 Starting processing for user: ${phone}`);
                    this.processingUsers.add(phone);
                    this.currentUser = user;
                    
                    this.processUser(user).catch(error => {
                        this.log('ERROR', `Failed for ${phone}: ${error.message}`);
                        this.processingUsers.delete(phone);
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
            await this.updateUserStatus(phone, 'starting', 'Process started');
            
            // Step 1: Initialize browser
            await this.updateUserStatus(phone, 'initializing_browser', 'Launching browser');
            await this.initializeBrowser();
            
            // Step 2: Open website
            await this.updateUserStatus(phone, 'opening_site', 'Opening AbanTether website');
            await this.openWebsite();
            
            // Step 3: Register
            await this.updateUserStatus(phone, 'registration', 'Starting registration');
            await this.registerUser(user);
            
            // Step 4: Wait for SMS and enter OTP
            await this.updateUserStatus(phone, 'waiting_otp', 'Waiting for OTP SMS');
            await this.handleOTP(phone);
            
            // Step 5: Complete profile
            await this.updateUserStatus(phone, 'completing_profile', 'Completing user profile');
            await this.completeProfile(user);
            
            // Step 6: Register card
            await this.updateUserStatus(phone, 'registering_card', 'Registering bank card');
            await this.registerCard(user);
            
            // Step 7: Deposit
            await this.updateUserStatus(phone, 'depositing', 'Making deposit');
            await this.deposit(user);
            
            // Step 8: Buy Tether
            await this.updateUserStatus(phone, 'buying_tether', 'Buying Tether');
            await this.buyTether();
            
            // Step 9: Withdraw
            await this.updateUserStatus(phone, 'withdrawing', 'Withdrawing Tether');
            await this.withdraw(user);
            
            // Step 10: Complete
            await this.updateUserStatus(phone, 'completed', 'Process completed successfully');
            
            this.log('SUCCESS', `✅ Successfully completed for ${phone}`);
            
        } catch (error) {
            this.log('ERROR', `❌ Process failed for ${phone}: ${error.message}`);
            await this.updateUserStatus(phone, 'failed', error.message);
        } finally {
            this.processingUsers.delete(phone);
            await this.cleanup();
        }
    }

    async initializeBrowser() {
        try {
            this.log('BROWSER', '🚀 Initializing browser...');
            
            if (this.browser) {
                await this.browser.close();
            }
            
            this.browser = await chromium.launch({ 
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--window-size=1280,720',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 },
                locale: 'fa-IR'
            });
            
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                window.chrome = { runtime: {} };
            });
            
            this.page = await context.newPage();
            
            // Enable console logging
            this.page.on('console', msg => {
                this.log('BROWSER_CONSOLE', `${msg.type()}: ${msg.text()}`);
            });
            
            // Log network requests
            this.page.on('request', request => {
                if (request.url().includes('abantether')) {
                    this.log('NETWORK_REQUEST', `→ ${request.method()} ${request.url()}`);
                }
            });
            
            this.page.on('response', response => {
                if (response.url().includes('abantether')) {
                    this.log('NETWORK_RESPONSE', `← ${response.status()} ${response.url()}`);
                }
            });
            
            this.log('BROWSER', '✅ Browser initialized');
            
        } catch (error) {
            this.log('ERROR', `❌ Browser initialization failed: ${error.message}`);
            throw error;
        }
    }

    async openWebsite() {
        try {
            this.log('WEBSITE', '🌐 Opening https://abantether.com/register...');
            
            const response = await this.page.goto('https://abantether.com/register', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            this.log('WEBSITE', `Status: ${response?.status()}`);
            
            await this.saveScreenshot('01-website-loaded');
            await this.savePageHTML('01-website-html');
            
            // Check if page loaded correctly
            const pageTitle = await this.page.title();
            this.log('WEBSITE', `Page title: "${pageTitle}"`);
            
            const pageText = await this.page.textContent('body');
            this.log('WEBSITE', `Page contains "آبان": ${pageText.includes('آبان')}`);
            this.log('WEBSITE', `Page contains "تتر": ${pageText.includes('تتر')}`);
            
            await this.sleep(3000);
            
        } catch (error) {
            this.log('ERROR', `❌ Failed to open website: ${error.message}`);
            await this.saveScreenshot('error-website');
            throw error;
        }
    }

    async registerUser(user) {
        const phone = user.personalPhoneNumber;
        
        try {
            this.log('REGISTRATION', `📝 Starting registration for ${phone}`);
            
            // 1. Find phone input
            this.log('REGISTRATION', '🔍 Looking for phone input field...');
            
            const phoneInputs = await this.findInputs(['موبایل', 'شماره', 'تلفن', 'phone', 'mobile']);
            
            if (phoneInputs.length === 0) {
                await this.saveScreenshot('02-no-phone-input');
                throw new Error('No phone input field found');
            }
            
            this.log('REGISTRATION', `Found ${phoneInputs.length} possible phone inputs`);
            
            // 2. Enter phone number
            const phoneInput = phoneInputs[0];
            await phoneInput.fill(phone);
            this.log('REGISTRATION', `✅ Phone number entered: ${phone}`);
            
            await this.saveScreenshot('03-phone-entered');
            
            // 3. Find and click continue button
            this.log('REGISTRATION', '🔍 Looking for continue button...');
            
            const continueButtons = await this.findButtons(['ادامه', 'ارسال', 'دریافت', 'continue', 'send']);
            
            if (continueButtons.length === 0) {
                this.log('REGISTRATION', '⚠️ No continue button found, trying any button...');
                const allButtons = await this.page.$$('button, input[type="submit"], a.btn, .btn');
                
                for (const button of allButtons) {
                    try {
                        const isVisible = await button.isVisible();
                        if (isVisible) {
                            await button.click();
                            this.log('REGISTRATION', '✅ Clicked a visible button');
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            } else {
                await continueButtons[0].click();
                this.log('REGISTRATION', `✅ Clicked button: ${continueButtons[0].text || 'continue button'}`);
            }
            
            await this.saveScreenshot('04-button-clicked');
            await this.sleep(3000);
            
            // 4. Check for OTP field or error messages
            this.log('REGISTRATION', '🔍 Checking for OTP field or error messages...');
            
            const otpInputs = await this.findInputs(['کد', 'رمز', 'otp', 'code', 'verify']);
            const errorMessages = await this.page.$$('.error, .alert, .text-red, [class*="error"], [class*="alert"]');
            
            this.log('REGISTRATION', `Found ${otpInputs.length} OTP inputs`);
            this.log('REGISTRATION', `Found ${errorMessages.length} error elements`);
            
            if (errorMessages.length > 0) {
                for (const error of errorMessages) {
                    const errorText = await error.textContent();
                    this.log('REGISTRATION', `⚠️ Error message: ${errorText}`);
                }
                await this.saveScreenshot('05-error-message');
            }
            
            if (otpInputs.length > 0) {
                this.log('REGISTRATION', '✅ OTP field found! Website should send SMS now');
                await this.saveScreenshot('06-otp-field-found');
            } else {
                this.log('REGISTRATION', '⚠️ OTP field not found, checking page content...');
                await this.saveScreenshot('06-no-otp-field');
                await this.savePageHTML('06-page-content');
                
                const pageContent = await this.page.content();
                this.log('REGISTRATION', 'Page content analysis:');
                this.log('REGISTRATION', `Contains "کد": ${pageContent.includes('کد')}`);
                this.log('REGISTRATION', `Contains "تایید": ${pageContent.includes('تایید')}`);
                this.log('REGISTRATION', `Contains "ارسال": ${pageContent.includes('ارسال')}`);
            }
            
        } catch (error) {
            this.log('ERROR', `❌ Registration failed: ${error.message}`);
            await this.saveScreenshot('error-registration');
            throw error;
        }
    }

    async handleOTP(phone) {
        try {
            this.log('OTP', `📱 Handling OTP for ${phone}`);
            
            // 1. Wait for OTP field to appear (max 30 seconds)
            this.log('OTP', '⏳ Waiting for OTP input field...');
            
            let otpField = null;
            for (let i = 0; i < 30; i++) {
                const inputs = await this.findInputs(['کد', 'رمز', 'otp', 'code']);
                if (inputs.length > 0) {
                    otpField = inputs[0];
                    this.log('OTP', '✅ OTP field appeared');
                    await this.saveScreenshot('07-otp-field-appeared');
                    break;
                }
                
                this.log('OTP', `⏳ Still waiting for OTP field... (${i + 1}/30)`);
                await this.sleep(1000);
            }
            
            if (!otpField) {
                this.log('OTP', '⚠️ OTP field never appeared, but continuing anyway');
            }
            
            // 2. Inform user to check SMS
            this.log('OTP', '📢 IMPORTANT: Check your SMS app!');
            this.log('OTP', `📱 The website should have sent an SMS to: ${phone}`);
            this.log('OTP', '📱 Please add the OTP from SMS to the database');
            this.log('OTP', '⏳ Waiting for OTP in database... (5 minutes max)');
            
            // 3. Wait for OTP in database
            const otp = await this.waitForOTPInDatabase(phone);
            
            // 4. Enter OTP
            this.log('OTP', `✅ OTP received: ${otp}`);
            
            if (otpField) {
                await otpField.fill(otp);
                this.log('OTP', `✅ OTP entered: ${otp}`);
            } else {
                // Try to find any input field
                const inputs = await this.page.$$('input');
                for (const input of inputs) {
                    try {
                        const isVisible = await input.isVisible();
                        const inputType = await input.getAttribute('type');
                        if (isVisible && (!inputType || ['text', 'number', 'tel'].includes(inputType))) {
                            await input.fill(otp);
                            this.log('OTP', `✅ OTP entered in available input`);
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
            
            await this.saveScreenshot('08-otp-entered');
            
            // 5. Find and click confirm button
            this.log('OTP', '🔍 Looking for confirm button...');
            
            const confirmButtons = await this.findButtons(['تایید', 'ورود', 'ثبت', 'verify', 'confirm', 'submit']);
            
            if (confirmButtons.length > 0) {
                await confirmButtons[0].click();
                this.log('OTP', '✅ Confirm button clicked');
            } else {
                this.log('OTP', '⚠️ No confirm button found, trying to press Enter');
                await this.page.keyboard.press('Enter');
            }
            
            await this.sleep(5000);
            await this.saveScreenshot('09-after-confirm');
            
        } catch (error) {
            this.log('ERROR', `❌ OTP handling failed: ${error.message}`);
            await this.saveScreenshot('error-otp');
            throw error;
        }
    }

    async waitForOTPInDatabase(phone, timeout = 300000) {
        const startTime = Date.now();
        const checkInterval = 5000;
        
        this.log('OTP_DATABASE', `⏳ Waiting for OTP for ${phone} in database...`);
        
        while (Date.now() - startTime < timeout) {
            try {
                const user = await this.collection.findOne({ personalPhoneNumber: phone });
                
                if (user && user.sms && Array.isArray(user.sms)) {
                    // Check all SMS messages
                    for (const sms of user.sms) {
                        if (sms.body) {
                            this.log('OTP_DATABASE', `📱 Checking SMS: ${sms.body.substring(0, 50)}...`);
                            
                            // Look for OTP patterns
                            const patterns = [
                                /(\d{6})/,
                                /(\d{5})/,
                                /کد.*?(\d{4,6})/i,
                                /code.*?(\d{4,6})/i,
                                /#(\d{4,6})/,
                                /:.*?(\d{4,6})/
                            ];
                            
                            for (const pattern of patterns) {
                                const match = sms.body.match(pattern);
                                if (match && match[1]) {
                                    const otp = match[1];
                                    this.log('OTP_DATABASE', `🎯 Found OTP with pattern ${pattern}: ${otp}`);
                                    return otp;
                                }
                            }
                        }
                    }
                }
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const remaining = Math.floor((timeout - (Date.now() - startTime)) / 1000);
                
                this.log('OTP_DATABASE', `⏳ [${elapsed}s elapsed, ${remaining}s remaining] No OTP found yet`);
                this.log('OTP_DATABASE', `📱 Expected SMS from AbanTether to: ${phone}`);
                this.log('OTP_DATABASE', `📱 Please add the OTP to database if you received it`);
                
                await this.sleep(checkInterval);
                
            } catch (error) {
                this.log('ERROR', `Database check error: ${error.message}`);
                await this.sleep(checkInterval);
            }
        }
        
        throw new Error(`Timeout: No OTP received after ${timeout/1000} seconds`);
    }

    async findInputs(keywords) {
        const inputs = [];
        
        // Try different selectors
        const selectors = [
            'input[type="text"]',
            'input[type="number"]',
            'input[type="tel"]',
            'input[placeholder]',
            'input[name]'
        ];
        
        for (const selector of selectors) {
            const elements = await this.page.$$(selector);
            for (const element of elements) {
                try {
                    const isVisible = await element.isVisible();
                    if (!isVisible) continue;
                    
                    // Check placeholder or name
                    const placeholder = await element.getAttribute('placeholder') || '';
                    const name = await element.getAttribute('name') || '';
                    const id = await element.getAttribute('id') || '';
                    
                    const text = (placeholder + name + id).toLowerCase();
                    
                    for (const keyword of keywords) {
                        if (text.includes(keyword.toLowerCase())) {
                            inputs.push(element);
                            this.log('FIND_INPUT', `Found input with ${keyword}: placeholder="${placeholder}", name="${name}"`);
                            break;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        return inputs;
    }

    async findButtons(keywords) {
        const buttons = [];
        
        const selectors = ['button', 'input[type="submit"]', 'a.btn', '[role="button"]'];
        
        for (const selector of selectors) {
            const elements = await this.page.$$(selector);
            for (const element of elements) {
                try {
                    const isVisible = await element.isVisible();
                    if (!isVisible) continue;
                    
                    const text = await element.textContent() || '';
                    const value = await element.getAttribute('value') || '';
                    
                    const combinedText = (text + value).toLowerCase();
                    
                    for (const keyword of keywords) {
                        if (combinedText.includes(keyword.toLowerCase())) {
                            buttons.push(element);
                            this.log('FIND_BUTTON', `Found button with ${keyword}: text="${text}", value="${value}"`);
                            break;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        return buttons;
    }

    async completeProfile(user) {
        this.log('PROFILE', '👤 Completing user profile (simplified for now)');
        await this.sleep(2000);
        // TODO: Implement full profile completion
    }

    async registerCard(user) {
        this.log('CARD', '💳 Registering bank card (simplified for now)');
        await this.sleep(2000);
        // TODO: Implement card registration
    }

    async deposit(user) {
        this.log('DEPOSIT', '💰 Making deposit (simplified for now)');
        await this.sleep(2000);
        // TODO: Implement deposit
    }

    async buyTether() {
        this.log('BUY', '🛒 Buying Tether (simplified for now)');
        await this.sleep(2000);
        // TODO: Implement buying
    }

    async withdraw(user) {
        this.log('WITHDRAW', '🏦 Withdrawing Tether (simplified for now)');
        await this.sleep(2000);
        // TODO: Implement withdrawal
    }

    async updateUserStatus(phone, status, message = '') {
        try {
            const updateData = {
                status: status,
                statusMessage: message,
                lastUpdated: new Date(),
                updatedAt: new Date()
            };
            
            await this.collection.updateOne(
                { personalPhoneNumber: phone },
                { $set: updateData },
                { upsert: true }
            );
            
            this.log('STATUS', `📊 ${phone}: ${status} - ${message}`);
            
        } catch (error) {
            this.log('ERROR', `Failed to update status: ${error.message}`);
        }
    }

    async cleanup() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
                this.log('CLEANUP', '✅ Browser closed');
            }
        } catch (error) {
            this.log('ERROR', `Cleanup error: ${error.message}`);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async startPolling() {
        this.log('POLLING', '🔄 Starting database polling (every 30 seconds)');
        
        // First check
        await this.checkDatabase();
        
        // Regular polling
        setInterval(async () => {
            try {
                await this.checkDatabase();
            } catch (error) {
                this.log('ERROR', `Polling error: ${error.message}`);
            }
        }, 30000);
        
        // Health check server
        const http = require('http');
        const server = http.createServer((req, res) => {
            const status = {
                status: 'running',
                timestamp: new Date().toISOString(),
                processing: Array.from(this.processingUsers),
                debugMode: this.debugMode
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status, null, 2));
        });
        
        server.listen(8080, () => {
            this.log('SERVER', '🌐 Health check server running on port 8080');
        });
    }

    async start() {
        this.log('START', '🤖 AbanTether Bot Starting...');
        this.log('CONFIG', `Database: ${process.env.DATABASE_NAME}`);
        this.log('CONFIG', `Collection: ${process.env.COLLECTION_NAME}`);
        
        // Create screenshots directory
        await fs.mkdir(this.screenshotsDir, { recursive: true });
        
        const connected = await this.connectToMongoDB();
        if (!connected) {
            this.log('ERROR', 'Failed to connect to database, retrying in 10 seconds...');
            setTimeout(() => this.start(), 10000);
            return;
        }
        
        await this.startPolling();
    }
}

// Run bot
const bot = new AbanTetherBot();

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED_REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT_EXCEPTION]', error);
    process.exit(1);
});

bot.start();