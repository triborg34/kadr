# کادر — اتاق تماشای خصوصی دونفره

وب‌اپلیکیشن فارسی و قابل نصب روی اندروید (PWA) برای دو کاربر ثابت: `triborg` (مدیر) و `kimiblue`. سرور Node.js خودمیزبان، حساب‌های مشخص را تأیید می‌کند، فقط به مدیر اجازهٔ انتخاب فیلم/کنترل پخش می‌دهد و وضعیت اتاق و سیگنال‌های تماس صوتی را همگام می‌کند.

## مصرف منابع و معماری

- برای این اتاق ۴۰۰ MB رم و یک CPU کافی است؛ Node.js تک‌پردازه اجرا می‌شود. اگر از PM2 استفاده کنید، نمونهٔ تنظیمات `ecosystem.config.cjs` سقف restart را روی ۱۰۰ MB می‌گذارد.
- سرور فیلم یا صدای تماس را پخش یا ذخیره نمی‌کند: ویدئو مستقیماً از لینک فیلم به مرورگر هر کاربر می‌رود؛ صدا با WebRTC منتقل می‌شود و سرور فقط پیام‌های لازم برای اتصال را جابه‌جا می‌کند. موقعیت پخش هر ۱٫۸ ثانیه همگام می‌شود و تأخیر شبکه هنگام تنظیم موقعیت جبران می‌شود.
- تماس با STUN شروع می‌شود؛ در بعضی شبکه‌ها ممکن است سرور TURN لازم باشد. در بخش اختیاری TURN شیوهٔ صدور اعتبارنامهٔ موقت را توضیح داده‌ایم.
- مدیر می‌تواند فایل زیرنویس `.srt` را انتخاب کند؛ برنامه آن را در مرورگر به WebVTT تبدیل می‌کند و هر دو نفر می‌بینند. فایل باید کمتر از ۱۶۰ کیلوبایت باشد و فقط تا زمان اجرای سرور در حافظه می‌ماند.
- لینک فیلم باید عمومی و مستقیم HTTP(S) باشد. سرویس‌های DRM، YouTube/Netflix و لینک صفحهٔ تماشا پشتیبانی نمی‌شوند.
- اتاق برای همین دو کاربر طراحی شده؛ هر حساب یک اتصال هم‌زمان دارد.

## اپ اندروید Flutter

نسخهٔ جداگانهٔ Flutter در پوشهٔ [`flutter_app/`](flutter_app/) قرار دارد و از همین سرور Node.js، ورود دونفره، همگام‌سازی پخش، زیرنویس SRT و تماس صوتی WebRTC استفاده می‌کند. راهنمای اجرا و ساخت APK در `flutter_app/README.md` است.

## نیازمندی‌ها

- Ubuntu/Debian، Node.js 20+ و npm.
- دامنه و HTTPS؛ میکروفون گوشی بدون اتصال امن در دسترس نیست.
- Nginx یا Caddy برای HTTPS و WebSocket؛ فایروال فقط SSH و HTTPS را به اینترنت باز کند.

## نصب سرور روی Ubuntu

کد پروژه را در `/opt/kadar` قرار دهید:

```bash
cd /opt/kadar
npm ci --omit=dev
node --version
```

فایل رمزها را خارج از مخزن و فقط برای root قابل خواندن بسازید:

```bash
sudo install -d -m 0700 /etc/kadar
sudo install -m 0600 /dev/null /etc/kadar/kadar.env
sudo nano /etc/kadar/kadar.env
```

در فایل، دو رمز تصادفی و جداگانه (هرکدام دست‌کم ۱۲ نویسه) و سه مقدار محرمانهٔ تصادفی را تنظیم کنید. salt و session secret را بین restartها تغییر ندهید:

```ini
TRIBORG_PASSWORD=REPLACE_WITH_A_LONG_RANDOM_PASSWORD
KIMIBLUE_PASSWORD=REPLACE_WITH_A_DIFFERENT_LONG_RANDOM_PASSWORD
KADAR_TRIBORG_SALT=REPLACE_WITH_A_PERSISTENT_RANDOM_VALUE
KADAR_KIMIBLUE_SALT=REPLACE_WITH_A_DIFFERENT_PERSISTENT_RANDOM_VALUE
KADAR_SESSION_SECRET=REPLACE_WITH_A_PERSISTENT_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
```

رمزها را داخل چت، مخزن عمومی یا Git نگذارید.

سرویس systemd را ایجاد کنید:

```bash
sudo nano /etc/systemd/system/kadar.service
```

این تنظیم را قرار دهید و نام `User` و مسیر Node را مطابق سرورتان تغییر دهید:

```ini
[Unit]
Description=Kadar private watch room
After=network.target

[Service]
Type=simple
User=kadar
WorkingDirectory=/opt/kadar
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8080
EnvironmentFile=/etc/kadar/kadar.env
ExecStart=/usr/bin/node /opt/kadar/server.js
Restart=on-failure
RestartSec=3
MemoryMax=160M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

سپس:

```bash
sudo chown root:root /etc/kadar/kadar.env
sudo chmod 600 /etc/kadar/kadar.env
sudo systemctl daemon-reload
sudo systemctl enable --now kadar
sudo systemctl status kadar
curl http://127.0.0.1:8080/healthz
```

## ماندگاری نشست و کوکی ورود

بعد از یک بار وارد کردن رمز صحیح، سرور کوکی نشست امضاشده با HttpOnly و SameSite=Strict و انقضای ۳۰روزه ثبت می‌کند؛ روی HTTPS این کوکی Secure هم هست. رمز داخل کوکی یا localStorage ذخیره نمی‌شود و جاوااسکریپت صفحه به خود توکن کوکی دسترسی ندارد. مرورگر در بازدیدهای بعدی نام کاربر را از نشست می‌شناسد و ورود تکراری لازم نیست. برای خروج، دکمهٔ خروج بالای صفحه را بزنید. مقادیر salt و session secret باید روی سرور ثابت بمانند؛ اگر عوض شوند، رمزها یا نشست‌های ذخیره‌شده دیگر معتبر نیستند.

## HTTPS و Nginx

برای دامنه گواهی TLS معتبر (مثلاً با Let's Encrypt) بگیرید و در `server { listen 443 ssl; ... }` پیکربندی Nginx قرار دهید. مسیر گواهی TLS را با تنظیم واقعی خودتان عوض کنید:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

`sudo nginx -t && sudo systemctl reload nginx` را اجرا کنید؛ پورت `8080` را مستقیم در فایروال اینترنتی باز نکنید. فقط URL HTTPS را برای دو کاربر بفرستید.

## تماس صوتی در شبکه‌های نیازمند TURN (اختیاری)

اگر STUN در شبکهٔ یکی از گوشی‌ها کافی نبود، روی VPS یا یک سرویس معتبر Coturn/TURN نصب کنید. TURN می‌تواند صدا را relay کند و به پورت باز و پهنای‌باند نیاز دارد.

در فایل خصوصی `/etc/kadar/kadar.env` مقدارهای زیر را تنظیم کنید:

```ini
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=REPLACE_WITH_THE_SAME_RANDOM_SECRET_AS_COTURN
```

`TURN_SECRET` باید دست‌کم ۳۲ نویسهٔ تصادفی و با shared secret سرور Coturn یکسان باشد. برنامه برای مرورگرها اعتبارنامهٔ کوتاه‌مدت ایجاد می‌کند و secret اصلی را ارسال نمی‌کند. پس از تنظیم TURN، `sudo systemctl restart kadar` بزنید و پورت‌های TURN را هم مطابق تنظیم Coturn در فایروال باز کنید.

## استفاده از برنامه

1. در آدرس HTTPS با `triborg` یا `kimiblue` وارد شوید؛ رمز هر کاربر همان متغیر محیطی اختصاصی سرور است.
2. مدیر از «گذاشتن لینک فیلم» URL مستقیم MP4/HLS را وارد کند. هر دو دستگاه باید بتوانند به لینک فیلم دسترسی داشته باشند. برای زیرنویس، مدیر «افزودن زیرنویس SRT» را می‌زند؛ فایل از مرورگر انتخاب می‌شود و برای هر دو نفر نمایش داده می‌شود. برای حذف آن «حذف زیرنویس» را بزنید.
3. هر دو دکمهٔ «اتصال» را بزنند و دسترسی میکروفون را تأیید کنند؛ مدیر تماس را آغاز می‌کند و در صورت نیاز، پس از ورود کاربر دوم offer دوباره فرستاده می‌شود.
4. برای نصب روی اندروید: Chrome → منو → **Install app / Add to Home screen**.

## اجرای محلی

```bash
npm ci
TRIBORG_PASSWORD='use-a-long-random-password' KIMIBLUE_PASSWORD='use-a-different-random-password' KADAR_TRIBORG_SALT='persistent-random-value-triborg' KADAR_KIMIBLUE_SALT='persistent-random-value-kimiblue' KADAR_SESSION_SECRET='persistent-random-secret-at-least-32-characters' npm start
```

سپس `http://localhost:8080` را باز کنید. برای دسترسی میکروفون از گوشی در محیط توسعه HTTPS لازم است.
