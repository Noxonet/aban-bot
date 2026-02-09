const https = require('https');

const SERVER_URL = 'https://server-db-jo9j.vercel.app';

async function makeRequest(body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    
    const options = {
      hostname: 'server-db-jo9j.vercel.app',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: e.message, raw: data });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

async function resetAllUsers() {
  try {
    console.log('دریافت لیست کاربران...');
    
    const findResponse = await makeRequest({
      operation: 'find',
      collection: 'zarinapp',
      query: {}
    });
    
    const users = findResponse.result || [];
    console.log(`تعداد کاربران: ${users.length}`);
    
    if (users.length === 0) {
      console.log('هیچ کاربری پیدا نشد');
      return;
    }
    
    let successCount = 0;
    
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const phone = user.personalPhoneNumber;
      
      if (phone) {
        console.log(`(${i + 1}/${users.length}) آپدیت کاربر: ${phone}`);
        
        // تلاش با فرمت‌های مختلف
        let updateResponse;
        
        // فرمت 1: با $set درون data
        updateResponse = await makeRequest({
          operation: 'updateOne',
          collection: 'zarinapp',
          filter: { personalPhoneNumber: phone },
          data: {
            $set: {
              processed: false,
              status: 'pending',
              lastUpdated: new Date().toISOString(),
              retryCount: 0
            }
          }
        });
        
        // اگر فرمت اول کار نکرد، فرمت 2 را امتحان کن
        if (!updateResponse.success && updateResponse.message && 
            updateResponse.message.includes('atomic operators')) {
          console.log('   ⚠️ امتحان فرمت دوم...');
          
          updateResponse = await makeRequest({
            operation: 'updateOne',
            collection: 'zarinapp',
            filter: { personalPhoneNumber: phone },
            data: {
              processed: false,
              status: 'pending',
              lastUpdated: new Date().toISOString(),
              retryCount: 0
            },
            options: { upsert: false }
          });
        }
        
        if (updateResponse.success) {
          successCount++;
          console.log(`   ✅ موفق`);
        } else {
          console.log(`   ❌ خطا:`, updateResponse.message || 'خطای ناشناخته');
          // لاگ کامل پاسخ برای دیباگ
          console.log('   پاسخ سرور:', JSON.stringify(updateResponse, null, 2));
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`\n🎯 عملیات تکمیل شد`);
    console.log(`✅ ${successCount} از ${users.length} کاربر آپدیت شدند`);
    
  } catch (error) {
    console.error('خطا:', error);
  }
}

// اجرا
resetAllUsers();