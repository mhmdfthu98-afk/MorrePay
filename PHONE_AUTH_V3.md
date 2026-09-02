# MORRE PAY V3 — Phone/SMS Authentication

## الجديد
- تسجيل الدخول الإجباري برقم الهاتف السوداني +249.
- إرسال رمز OTP عبر Firebase Authentication SMS.
- واجهة OTP من 6 خانات متجاوبة وجميلة.
- لا يمكن فتح المحفظة بحساب Email/Password؛ جلسة المحفظة يجب أن تكون مرتبطة برقم هاتف.
- بعد التحقق يتم إنشاء المحفظة تلقائياً إذا لم تكن موجودة.
- الرقم الإداري المعتمد: +249907760989.
- بعد توثيق الرقم الإداري يتم منح `admin: true` من Cloud Functions فقط.

## إعداد Firebase المطلوب
1. Authentication → Sign-in method → Phone: Enable.
2. Authentication → Settings → SMS region policy: السماح بـ Sudan (+249).
3. إضافة نطاق الاستضافة إلى Authorized domains.
4. نشر Functions وFirestore Rules.

Firebase يستخدم reCAPTCHA لحماية طلبات SMS على الويب، وPhone Auth يرسل OTP عبر SMS ثم يؤكد الرمز باستخدام ConfirmationResult.confirm().
