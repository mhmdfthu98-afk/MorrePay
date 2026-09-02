const { onCall, HttpsError } = require("firebase-functions/https");
const { onDocumentCreated } = require("firebase-functions/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();
const bucket = getStorage().bucket();

const TRANSFER_FEE_RATE = 0.005;
const MIN_TRANSFER_FEE = 1;
const MAX_TRANSFER_AMOUNT = 100000000;

function assertAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً");
  }
  return request.auth.uid;
}

function calculateFee(amount) {
  return Math.round(Math.max(amount * TRANSFER_FEE_RATE, MIN_TRANSFER_FEE) * 100) / 100;
}

function cleanText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function makeReferralCode() {
  return `MR${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
}

function makeOperationReference(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function generateWalletId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const walletID = String(Math.floor(100000 + Math.random() * 900000));
    const snap = await db.collection("users")
      .where("walletID", "==", walletID)
      .limit(1)
      .get();
    if (snap.empty) return walletID;
  }
  throw new HttpsError("resource-exhausted", "تعذر إنشاء رقم محفظة فريد");
}

exports.initializeWallet = onCall(async (request) => {
  const uid = assertAuth(request);
  const name = cleanText(request.data?.name || "مستخدم MORRE", 80);
  const phone = cleanText(request.auth.token.phone_number || "", 30);

  if (name.length < 2) {
    throw new HttpsError("invalid-argument", "الاسم غير صحيح");
  }
  if (!/^\+249\d{9}$/.test(phone)) {
    throw new HttpsError("failed-precondition", "رقم الهاتف غير مرتبط بحساب موثق");
  }

  const userRef = db.collection("users").doc(uid);
  const existing = await userRef.get();

  if (existing.exists) {
    return { ok: true, walletID: existing.get("walletID") };
  }

  const walletID = await generateWalletId();
  const referralCode = makeReferralCode();

  await userRef.create({
    name,
    email: request.auth.token.email || "",
    phone,
    walletID,
    balance: 0,
    frozenBalance: 0,
    dailyUsed: 0,
    monthlyUsed: 0,
    referralCode,
    referralPoints: 10,
    isAdmin: false,
    isVerified: false,
    kycStatus: "not_submitted",
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastLogin: FieldValue.serverTimestamp()
  });

  logger.info("Wallet initialized", { uid, walletID });
  return { ok: true, walletID };
});

exports.ensureAdminByPhone = onCall(async (request) => {
  const uid = assertAuth(request);
  const phone = cleanText(request.auth.token.phone_number || "", 30);
  const ADMIN_PHONE = "+249907760989";

  if (phone !== ADMIN_PHONE) {
    return { ok: true, admin: Boolean(request.auth.token.admin) };
  }

  await getAuth().setCustomUserClaims(uid, { admin: true });

  await db.collection("users").doc(uid).set({
    isAdmin: true,
    adminPhone: ADMIN_PHONE,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  logger.warn("Admin claim assigned by approved phone", { uid, phone: ADMIN_PHONE });
  return { ok: true, admin: true, refreshToken: true };
});

exports.lookupWalletRecipient = onCall(async (request) => {
  const uid = assertAuth(request);
  const receiverWallet = cleanText(request.data?.receiverWallet, 20);
  if (!/^\d{6}$/.test(receiverWallet)) {
    throw new HttpsError("invalid-argument", "رقم الحساب يجب أن يتكون من 6 أرقام");
  }

  const snap = await db.collection("users")
    .where("walletID", "==", receiverWallet)
    .limit(2)
    .get();

  if (snap.empty) throw new HttpsError("not-found", "رقم الحساب غير موجود");
  if (snap.size > 1) throw new HttpsError("failed-precondition", "رقم الحساب غير فريد");

  const doc = snap.docs[0];
  if (doc.id === uid) throw new HttpsError("invalid-argument", "لا يمكنك التحويل إلى حسابك نفسه");
  const data = doc.data();
  if (data.status === "frozen") throw new HttpsError("failed-precondition", "حساب المستلم مجمد");

  return {
    ok: true,
    receiver: {
      userId: doc.id,
      walletID: data.walletID,
      name: cleanText(data.name || "مستخدم MORRE PAY", 80)
    }
  };
});

exports.transferMoney = onCall(async (request) => {
  const uid = assertAuth(request);

  const receiverWallet = cleanText(request.data?.receiverWallet, 20);
  const description = cleanText(request.data?.description || "تحويل", 200);
  const clientTransactionId = cleanText(request.data?.clientTransactionId, 100);
  const amount = Number(request.data?.amount);

  if (!/^\d{6}$/.test(receiverWallet)) {
    throw new HttpsError("invalid-argument", "رقم المحفظة غير صحيح");
  }
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > MAX_TRANSFER_AMOUNT) {
    throw new HttpsError("invalid-argument", "المبلغ يجب أن يكون رقمًا صحيحًا موجبًا");
  }
  if (!clientTransactionId || clientTransactionId.length > 100) {
    throw new HttpsError("invalid-argument", "معرّف العملية غير صالح");
  }

  const senderRef = db.collection("users").doc(uid);
  const receiverQuery = await db.collection("users")
    .where("walletID", "==", receiverWallet)
    .limit(2)
    .get();

  if (receiverQuery.empty) {
    throw new HttpsError("not-found", "رقم المحفظة غير صحيح");
  }
  if (receiverQuery.size > 1) {
    throw new HttpsError("failed-precondition", "رقم المحفظة غير فريد");
  }

  const receiverRef = receiverQuery.docs[0].ref;
  if (receiverRef.id === uid) {
    throw new HttpsError("invalid-argument", "لا يمكنك التحويل إلى محفظتك نفسها");
  }

  const txnRef = db.collection("transactions").doc(clientTransactionId);
  const fee = calculateFee(amount);
  const totalAmount = amount + fee;

  let result;

  await db.runTransaction(async (tx) => {
    const [senderSnap, receiverSnap, existingTxn] = await Promise.all([
      tx.get(senderRef),
      tx.get(receiverRef),
      tx.get(txnRef)
    ]);

    if (!senderSnap.exists || !receiverSnap.exists) {
      throw new HttpsError("not-found", "بيانات المحفظة غير موجودة");
    }

    if (existingTxn.exists) {
      const existing = existingTxn.data();
      if (existing.senderId !== uid) {
        throw new HttpsError("already-exists", "معرّف العملية مستخدم");
      }
      if (existing.receiverWalletID !== receiverWallet || Number(existing.amount) !== amount) {
        throw new HttpsError("already-exists", "معرّف العملية مرتبط بطلب مختلف");
      }
      result = {
        ok: true,
        transactionId: txnRef.id,
        reference: existing.reference,
        amount: existing.amount,
        fee: existing.fee,
        status: existing.status,
        idempotent: true
      };
      return;
    }

    const sender = senderSnap.data();
    const receiver = receiverSnap.data();

    if (sender.status === "frozen") {
      throw new HttpsError("permission-denied", "المحفظة مجمدة");
    }
    if (receiver.status === "frozen") {
      throw new HttpsError("failed-precondition", "محفظة المستلم مجمدة");
    }

    const senderBalance = Number(sender.balance || 0);
    if (senderBalance < totalAmount) {
      throw new HttpsError("failed-precondition", "الرصيد غير كافي");
    }

    const senderNewBalance = Math.round((senderBalance - totalAmount) * 100) / 100;
    const receiverOldBalance = Number(receiver.balance || 0);
    const receiverNewBalance = Math.round((receiverOldBalance + amount) * 100) / 100;

    const reference = `MR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    tx.update(senderRef, {
      balance: senderNewBalance,
      dailyUsed: FieldValue.increment(amount),
      monthlyUsed: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.update(receiverRef, {
      balance: receiverNewBalance,
      updatedAt: FieldValue.serverTimestamp()
    });

    tx.create(txnRef, {
      id: txnRef.id,
      reference,
      senderId: uid,
      senderName: cleanText(sender.name || "مستخدم MORRE PAY", 80),
      senderWalletID: sender.walletID,
      receiverId: receiverRef.id,
      receiverName: cleanText(receiver.name || "مستخدم MORRE PAY", 80),
      receiverWalletID: receiverWallet,
      amount,
      fee,
      totalAmount,
      netAmount: amount,
      currency: "SDG",
      type: "transfer",
      status: "completed",
      description,
      category: "transfer",
      createdAt: FieldValue.serverTimestamp(),
      completedAt: FieldValue.serverTimestamp()
    });

    tx.create(db.collection("ledger").doc(), {
      userId: uid,
      transactionId: txnRef.id,
      walletId: sender.walletID,
      amount: totalAmount,
      balanceBefore: senderBalance,
      balanceAfter: senderNewBalance,
      type: "debit",
      description: `تحويل إلى #${receiverWallet}`,
      createdAt: FieldValue.serverTimestamp()
    });

    tx.create(db.collection("ledger").doc(), {
      userId: receiverRef.id,
      transactionId: txnRef.id,
      walletId: receiverWallet,
      amount,
      balanceBefore: receiverOldBalance,
      balanceAfter: receiverNewBalance,
      type: "credit",
      description: `استلام من #${sender.walletID}`,
      createdAt: FieldValue.serverTimestamp()
    });

    const senderName = cleanText(sender.name || "مستخدم MORRE PAY", 80);
    const receiverName = cleanText(receiver.name || "مستخدم MORRE PAY", 80);
    const notificationCommon = {
      transactionId: txnRef.id,
      reference,
      amount,
      fee,
      description,
      senderName,
      senderWalletID: sender.walletID,
      receiverName,
      receiverWalletID: receiverWallet,
      currency: "SDG",
      isRead: false,
      createdAt: FieldValue.serverTimestamp()
    };

    tx.create(db.collection("notifications").doc(), {
      userId: receiverRef.id,
      title: "💰 استلام تحويل",
      body: `استلمت ${amount.toLocaleString("en-US")} ج.س من ${senderName} (#${sender.walletID}) — رقم العملية ${reference}`,
      type: "transfer",
      direction: "in",
      ...notificationCommon
    });

    tx.create(db.collection("notifications").doc(), {
      userId: uid,
      title: "✅ تم التحويل",
      body: `تم تحويل ${amount.toLocaleString("en-US")} ج.س إلى ${receiverName} (#${receiverWallet}) — رقم العملية ${reference}`,
      type: "transfer",
      direction: "out",
      ...notificationCommon
    });

    result = {
      ok: true,
      transactionId: txnRef.id,
      reference,
      amount,
      fee,
      status: "completed"
    };
  });

  logger.info("Transfer completed", {
    uid,
    receiverWallet,
    transactionId: result.transactionId,
    amount: result.amount
  });

  return result;
});


function validateMoneyAmount(value, max = 100000000) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > max) {
    throw new HttpsError("invalid-argument", "المبلغ يجب أن يكون رقمًا صحيحًا موجبًا");
  }
  return amount;
}



function assertAdmin(request) {
  assertAuth(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "صلاحية المدير مطلوبة");
  }
  return request.auth.uid;
}

exports.bootstrapAdmin = onCall(async (request) => {
  const uid = assertAuth(request);
  const allowedEmail = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  if (!allowedEmail || !email || email !== allowedEmail) {
    throw new HttpsError("permission-denied", "هذا الحساب غير مخول لتهيئة المدير");
  }

  const userRecord = await getAuth().getUser(uid);
  const existingClaims = userRecord.customClaims || {};
  await getAuth().setCustomUserClaims(uid, { ...existingClaims, admin: true });
  await db.collection("users").doc(uid).set({
    isAdmin: true,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { ok: true, admin: true, message: "تم تفعيل صلاحيات المدير. سجّل الخروج ثم الدخول لتحديث التوكن." };
});


exports.registerSecuritySession = onCall(async (request) => {
  const uid = assertAuth(request);
  const sessionId = cleanText(request.data?.sessionId, 120);
  const deviceLabel = cleanText(request.data?.deviceLabel || "جهاز غير معروف", 120);
  const platform = cleanText(request.data?.platform || "web", 40);
  if (!sessionId || !/^[A-Za-z0-9_-]{12,120}$/.test(sessionId)) {
    throw new HttpsError("invalid-argument", "معرّف الجلسة غير صالح");
  }
  const ref = db.collection("users").doc(uid).collection("securitySessions").doc(sessionId);
  const snap = await ref.get();
  if (snap.exists && snap.get("revoked") === true) {
    await ref.update({ lastSeenAt: FieldValue.serverTimestamp() });
    return { ok: true, revoked: true };
  }
  const payload = {
    sessionId,
    deviceLabel,
    platform,
    userAgent: cleanText(request.data?.userAgent || "", 300),
    lastSeenAt: FieldValue.serverTimestamp(),
    revoked: false
  };
  if (!snap.exists) payload.createdAt = FieldValue.serverTimestamp();
  await ref.set(payload, { merge: true });
  return { ok: true, revoked: false };
});

exports.checkSecuritySession = onCall(async (request) => {
  const uid = assertAuth(request);
  const sessionId = cleanText(request.data?.sessionId, 120);
  if (!sessionId) throw new HttpsError("invalid-argument", "معرّف الجلسة مطلوب");
  const snap = await db.collection("users").doc(uid).collection("securitySessions").doc(sessionId).get();
  return { ok: true, revoked: snap.exists && snap.get("revoked") === true };
});

exports.getSecuritySessions = onCall(async (request) => {
  const uid = assertAuth(request);
  const snap = await db.collection("users").doc(uid).collection("securitySessions")
    .orderBy("lastSeenAt", "desc").limit(20).get();
  return {
    ok: true,
    sessions: snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  };
});

exports.revokeSecuritySession = onCall(async (request) => {
  const uid = assertAuth(request);
  const sessionId = cleanText(request.data?.sessionId, 120);
  if (!sessionId) throw new HttpsError("invalid-argument", "معرّف الجلسة مطلوب");
  const ref = db.collection("users").doc(uid).collection("securitySessions").doc(sessionId);
  await ref.set({ revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.revokeAllSecuritySessions = onCall(async (request) => {
  const uid = assertAuth(request);
  const currentSessionId = cleanText(request.data?.currentSessionId || "", 120);
  const snap = await db.collection("users").doc(uid).collection("securitySessions").get();
  const batch = db.batch();
  let count = 0;
  snap.docs.forEach(doc => {
    if (!currentSessionId || doc.id !== currentSessionId) {
      batch.set(doc.ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
      count++;
    }
  });
  if (count) await batch.commit();
  await db.collection("auditLogs").add({ actorUserId: uid, action: "user_revoked_all_sessions", targetUserId: uid, count, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, count };
});

exports.updateAccountName = onCall(async (request) => {
  const uid = assertAuth(request);
  const name = cleanText(request.data?.name, 80);
  if (name.length < 2) throw new HttpsError("invalid-argument", "اسم الحساب يجب أن يحتوي على حرفين على الأقل");
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "الحساب غير موجود");
  if (snap.get("status") === "frozen") throw new HttpsError("permission-denied", "الحساب مجمد");
  await ref.update({ name, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, name };
});

exports.freezeUser = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const userId = cleanText(request.data?.userId, 128);
  const reason = cleanText(request.data?.reason || "تم تجميد الحساب من الإدارة", 300);
  if (!userId) throw new HttpsError("invalid-argument", "معرّف المستخدم مطلوب");
  if (userId === adminUid) throw new HttpsError("failed-precondition", "لا يمكنك تجميد حسابك الإداري");
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
  await ref.update({ status: "frozen", freezeReason: reason, frozenAt: FieldValue.serverTimestamp(), frozenBy: adminUid, updatedAt: FieldValue.serverTimestamp() });
  await db.collection("notifications").add({ userId, title: "🔒 تم تجميد الحساب", body: reason, type: "security", isRead: false, createdAt: FieldValue.serverTimestamp() });
  await db.collection("auditLogs").add({ adminId: adminUid, action: "user_frozen", targetUserId: userId, reason, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, status: "frozen" };
});

exports.unfreezeUser = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const userId = cleanText(request.data?.userId, 128);
  if (!userId) throw new HttpsError("invalid-argument", "معرّف المستخدم مطلوب");
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
  await ref.update({ status: "active", freezeReason: FieldValue.delete(), frozenAt: FieldValue.delete(), frozenBy: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  await db.collection("notifications").add({ userId, title: "🔓 تم إلغاء تجميد الحساب", body: "تمت إعادة تفعيل حسابك ويمكنك استخدام MORRE PAY.", type: "security", isRead: false, createdAt: FieldValue.serverTimestamp() });
  await db.collection("auditLogs").add({ adminId: adminUid, action: "user_unfrozen", targetUserId: userId, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, status: "active" };
});

exports.getAdminOverview = onCall(async (request) => {
  assertAdmin(request);
  const [usersSnap, txnSnap, kycSnap, depositsSnap, withdrawalsSnap, usersData] = await Promise.all([
    db.collection("users").count().get(),
    db.collection("transactions").count().get(),
    db.collection("users").where("kycStatus", "==", "pending").count().get(),
    db.collection("depositRequests").where("status", "==", "pending").count().get(),
    db.collection("withdrawRequests").where("status", "==", "pending").count().get(),
    db.collection("users").select("balance", "status").get()
  ]);
  let totalBalance = 0, frozenUsers = 0;
  usersData.docs.forEach(doc => {
    totalBalance += Number(doc.get("balance") || 0);
    if (doc.get("status") === "frozen") frozenUsers++;
  });
  return {
    ok: true,
    totalUsers: usersSnap.data().count || 0,
    activeUsers: Math.max((usersSnap.data().count || 0) - frozenUsers, 0),
    frozenUsers,
    totalBalance,
    totalTransactions: txnSnap.data().count || 0,
    pendingKYC: kycSnap.data().count || 0,
    pendingDeposits: depositsSnap.data().count || 0,
    pendingWithdrawals: withdrawalsSnap.data().count || 0
  };
});

exports.getAdminUsers = onCall(async (request) => {
  assertAdmin(request);
  const limit = Math.min(Math.max(Number(request.data?.limit || 50), 1), 100);
  const snap = await db.collection("users").orderBy("createdAt", "desc").limit(limit).get();
  return {
    ok: true,
    users: snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  };
});

exports.getAdminTransactions = onCall(async (request) => {
  assertAdmin(request);
  const limit = Math.min(Math.max(Number(request.data?.limit || 50), 1), 100);
  const filter = cleanText(request.data?.status || "all", 30);
  let q = db.collection("transactions").orderBy("createdAt", "desc");
  if (filter !== "all") q = q.where("status", "==", filter).orderBy("createdAt", "desc");
  const snap = await q.limit(limit).get();
  return {
    ok: true,
    transactions: snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
  };
});

function storagePathFromValue(value) {
  if (!value || typeof value !== "string") return null;
  if (!value.startsWith("http")) return value;
  try {
    const marker = "/o/";
    const i = value.indexOf(marker);
    if (i === -1) return null;
    const rest = value.slice(i + marker.length);
    const encodedPath = rest.split("?")[0];
    return decodeURIComponent(encodedPath);
  } catch (_) {
    return null;
  }
}

async function makeKycSignedUrl(value) {
  const path = storagePathFromValue(value);
  if (!path || !path.startsWith("kyc/")) return null;
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 5 * 60 * 1000
  });
  return url;
}

function kycDocumentMeta(docValue) {
  if (!docValue) return null;
  return {
    number: cleanText(docValue.number || "", 100),
    hasImage: Boolean(storagePathFromValue(docValue.image)),
    hasSelfie: Boolean(storagePathFromValue(docValue.selfie))
  };
}

function kycDocValueByType(kycData, documentType) {
  const map = {
    passportImage: ["passport", "image"],
    passportSelfie: ["passport", "selfie"],
    nationalIdImage: ["nationalId", "image"],
    nationalIdSelfie: ["nationalId", "selfie"]
  };
  const pair = map[documentType];
  if (!pair) return null;
  return kycData?.[pair[0]]?.[pair[1]] || null;
}

exports.getAdminKYC = onCall(async (request) => {
  assertAdmin(request);
  const snap = await db.collection("users").where("kycStatus", "==", "pending").limit(100).get();
  const requests = await Promise.all(snap.docs.map(async doc => {
    const data = doc.data();
    const k = data.kycData || {};
    return {
      id: doc.id,
      ...data,
      kycData: {
        dob: cleanText(k.dob || "", 20),
        country: cleanText(k.country || "", 80),
        city: cleanText(k.city || "", 120),
        address: cleanText(k.address || "", 300),
        passport: kycDocumentMeta(k.passport),
        nationalId: kycDocumentMeta(k.nationalId)
      }
    };
  }));
  return { ok: true, requests };
});

exports.getKycDocumentUrl = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const userId = cleanText(request.data?.userId, 128);
  const documentType = cleanText(request.data?.documentType, 30);
  const allowed = new Set(["passportImage", "passportSelfie", "nationalIdImage", "nationalIdSelfie"]);
  if (!userId || !allowed.has(documentType)) {
    throw new HttpsError("invalid-argument", "بيانات المستند غير صحيحة");
  }

  const userSnap = await db.collection("users").doc(userId).get();
  if (!userSnap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
  const pathOrUrl = kycDocValueByType(userSnap.get("kycData") || {}, documentType);
  const path = storagePathFromValue(pathOrUrl);
  if (!path || !path.startsWith(`kyc/${userId}/`)) {
    throw new HttpsError("not-found", "المستند غير موجود");
  }

  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("not-found", "ملف المستند غير موجود في التخزين");

  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + 5 * 60 * 1000,
    responseDisposition: "inline"
  });

  await db.collection("auditLogs").add({
    adminId: adminUid,
    action: "kyc_document_viewed",
    targetUserId: userId,
    documentType,
    createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true, url, expiresInSeconds: 300 };
});

exports.setKYCStatus = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const userId = cleanText(request.data?.userId, 128);
  const status = cleanText(request.data?.status, 20);
  const reason = cleanText(request.data?.reason || "", 300);
  if (!userId || !["approved", "rejected"].includes(status)) {
    throw new HttpsError("invalid-argument", "بيانات KYC غير صحيحة");
  }

  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
  if (userSnap.get("kycStatus") !== "pending") {
    throw new HttpsError("failed-precondition", "طلب KYC تمت معالجته مسبقًا");
  }

  const update = {
    isVerified: status === "approved",
    kycStatus: status,
    updatedAt: FieldValue.serverTimestamp()
  };
  if (status === "approved") {
    update.verifiedBy = adminUid;
    update.verifiedAt = FieldValue.serverTimestamp();
  } else {
    update.rejectedBy = adminUid;
    update.rejectionReason = reason || "لم يتم اجتياز التحقق";
    update.rejectedAt = FieldValue.serverTimestamp();
  }

  await userRef.update(update);
  await db.collection("notifications").add({
    userId,
    title: status === "approved" ? "✅ تم قبول التحقق" : "❌ تم رفض التحقق",
    body: status === "approved" ? "تم توثيق حسابك بنجاح." : `تم رفض طلب التحقق. ${reason || "يمكنك إعادة المحاولة."}`,
    type: "kyc",
    isRead: false,
    createdAt: FieldValue.serverTimestamp()
  });
  await db.collection("auditLogs").add({
    adminId: adminUid,
    action: `kyc_${status}`,
    targetUserId: userId,
    reason,
    createdAt: FieldValue.serverTimestamp()
  });
  return { ok: true, status };
});

async function listMoneyRequests(collectionName, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit || 50), 1), 100);
  const snap = await db.collection(collectionName).where("status", "==", "pending").orderBy("createdAt", "desc").limit(safeLimit).get();
  const items = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    let user = null;
    if (data.userId) {
      const userSnap = await db.collection("users").doc(data.userId).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        user = { name: u.name || "مستخدم", phone: u.phone || "", email: u.email || "", walletID: u.walletID || data.walletID || "" };
      }
    }
    items.push({ id: doc.id, ...data, user });
  }
  return items;
}

exports.listPendingDeposits = onCall(async (request) => {
  assertAdmin(request);
  return { ok: true, requests: await listMoneyRequests("depositRequests", request.data?.limit) };
});

exports.listPendingWithdrawals = onCall(async (request) => {
  assertAdmin(request);
  return { ok: true, requests: await listMoneyRequests("withdrawRequests", request.data?.limit) };
});

exports.rejectDeposit = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const requestId = cleanText(request.data?.requestId, 120);
  const reason = cleanText(request.data?.reason || "", 300);
  if (!requestId) throw new HttpsError("invalid-argument", "رقم الطلب مطلوب");
  const ref = db.collection("depositRequests").doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "طلب الإيداع غير موجود");
  const data = snap.data();
  if (data.status !== "pending") throw new HttpsError("failed-precondition", "الطلب تمت معالجته مسبقًا");
  await ref.update({ status: "rejected", rejectedBy: adminUid, rejectionReason: reason || "تم رفض الطلب", rejectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await db.collection("notifications").add({ userId: data.userId, title: "❌ تم رفض طلب الإيداع", body: `${reason || "تم رفض طلب الإيداع."} — رقم الطلب ${data.requestReference || requestId}`, type: "deposit", requestId, requestReference: data.requestReference || requestId, reference: data.requestReference || requestId, amount: Number(data.amount || 0), direction: "in", method: data.method || null, description: data.description || "إيداع", reason: reason || "تم رفض الطلب", senderName: "MORRE PAY", senderWalletID: "MORRE PAY", receiverName: data.userName || "مستخدم MORRE PAY", receiverWalletID: data.walletID || null, isRead: false, createdAt: FieldValue.serverTimestamp() });
  await db.collection("auditLogs").add({ adminId: adminUid, action: "deposit_rejected", requestId, targetUserId: data.userId, reason, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, status: "rejected" };
});

exports.rejectWithdraw = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const requestId = cleanText(request.data?.requestId, 120);
  const reason = cleanText(request.data?.reason || "", 300);
  if (!requestId) throw new HttpsError("invalid-argument", "رقم الطلب مطلوب");
  const ref = db.collection("withdrawRequests").doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "طلب السحب غير موجود");
  const data = snap.data();
  if (data.status !== "pending") throw new HttpsError("failed-precondition", "الطلب تمت معالجته مسبقًا");
  await ref.update({ status: "rejected", rejectedBy: adminUid, rejectionReason: reason || "تم رفض الطلب", rejectedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await db.collection("notifications").add({ userId: data.userId, title: "❌ تم رفض طلب السحب", body: `${reason || "تم رفض طلب السحب."} — رقم الطلب ${data.requestReference || requestId}`, type: "withdraw", requestId, requestReference: data.requestReference || requestId, reference: data.requestReference || requestId, amount: Number(data.amount || 0), direction: "out", method: data.method || null, destination: data.destination || null, description: data.description || "سحب", reason: reason || "تم رفض الطلب", senderName: data.userName || "مستخدم MORRE PAY", senderWalletID: data.walletID || null, receiverName: "MORRE PAY", receiverWalletID: "MORRE PAY", isRead: false, createdAt: FieldValue.serverTimestamp() });
  await db.collection("auditLogs").add({ adminId: adminUid, action: "withdraw_rejected", requestId, targetUserId: data.userId, reason, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, status: "rejected" };
});


exports.getMoneyRequestDetails = onCall(async (request) => {
  const uid = assertAuth(request);
  const requestId = cleanText(request.data?.requestId, 120);
  const type = cleanText(request.data?.type, 20);
  if (!requestId || !["deposit", "withdraw"].includes(type)) throw new HttpsError("invalid-argument", "بيانات الطلب غير صالحة");
  const collection = type === "deposit" ? "depositRequests" : "withdrawRequests";
  const snap = await db.collection(collection).doc(requestId).get();
  if (!snap.exists) throw new HttpsError("not-found", "طلب العملية غير موجود");
  const d = snap.data();
  if (d.userId !== uid && request.auth.token.admin !== true) throw new HttpsError("permission-denied", "لا يمكنك مشاهدة هذا الطلب");
  return { ok: true, request: { id: snap.id, type, ...d, amount: Number(d.amount || 0) } };
});

exports.getTransactionReceipt = onCall(async (request) => {
  const uid = assertAuth(request);
  const transactionId = cleanText(request.data?.transactionId, 120);
  if (!transactionId) throw new HttpsError("invalid-argument", "معرّف العملية مطلوب");

  const snap = await db.collection("transactions").doc(transactionId).get();
  if (!snap.exists) throw new HttpsError("not-found", "العملية غير موجودة");
  const t = snap.data();
  const isAdmin = request.auth.token.admin === true;
  if (!isAdmin && t.senderId !== uid && t.receiverId !== uid) {
    throw new HttpsError("permission-denied", "لا يمكنك مشاهدة هذه العملية");
  }

  const userIds = [t.senderId, t.receiverId].filter(id => id && id !== "system");
  const userSnaps = await Promise.all(userIds.map(id => db.collection("users").doc(id).get()));
  const users = {};
  userSnaps.forEach((u, i) => { if (u.exists) users[userIds[i]] = u.data(); });
  const sender = users[t.senderId] || {};
  const receiver = users[t.receiverId] || {};
  const direction = t.receiverId === uid && t.senderId !== uid ? "in" : "out";

  return {
    ok: true,
    transaction: {
      id: snap.id, reference: t.reference || snap.id, type: t.type || "transaction", status: t.status || "unknown",
      amount: Number(t.amount || 0), fee: Number(t.fee || 0), totalAmount: Number(t.totalAmount || t.amount || 0),
      currency: t.currency || "SDG", description: t.description || "عملية MORRE PAY",
      senderId: t.senderId || null, receiverId: t.receiverId || null,
      senderWalletID: t.senderWalletID || sender.walletID || null, receiverWalletID: t.receiverWalletID || receiver.walletID || null,
      senderName: t.senderName || sender.name || (t.senderId === "system" ? "MORRE PAY" : null),
      receiverName: t.receiverName || receiver.name || (t.receiverId === "system" ? "MORRE PAY" : null),
      senderPhone: sender.phone || null, receiverPhone: receiver.phone || null,
      ownerName: receiver.name || sender.name || null, ownerPhone: receiver.phone || sender.phone || null,
      direction, method: t.method || null, destination: t.destination || null,
      createdAt: t.createdAt?.toMillis?.() || null, completedAt: t.completedAt?.toMillis?.() || null
    }
  };
});

exports.registerPushToken = onCall(async (request) => {
  const uid = assertAuth(request);
  const token = cleanText(request.data?.token, 4096);
  const platform = cleanText(request.data?.platform || "web", 30);
  if (!token || token.length < 20) throw new HttpsError("invalid-argument", "رمز الإشعارات غير صالح");

  const ref = db.collection("users").doc(uid).collection("pushTokens").doc(token);
  await ref.set({ token, platform, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.removePushToken = onCall(async (request) => {
  const uid = assertAuth(request);
  const token = cleanText(request.data?.token, 4096);
  if (!token) return { ok: true };
  await db.collection("users").doc(uid).collection("pushTokens").doc(token).delete();
  return { ok: true };
});

exports.pushNotificationOnCreate = onDocumentCreated("notifications/{notificationId}", async (event) => {
  const data = event.data?.data();
  if (!data?.userId || !data?.title || !data?.body) return;

  const tokenSnap = await db.collection("users").doc(data.userId).collection("pushTokens").get();
  if (tokenSnap.empty) return;

  const tokens = tokenSnap.docs.map(d => d.id).filter(Boolean);
  const response = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: String(data.title).slice(0, 120), body: String(data.body).slice(0, 1000) },
    data: {
      type: String(data.type || "info"),
      transactionId: String(data.transactionId || ""),
      notificationId: event.params.notificationId
    },
  });

  const stale = [];
  response.responses.forEach((r, i) => {
    const code = r.error?.code || "";
    if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
      stale.push(tokenSnap.docs.find(d => d.id === tokens[i]));
    }
  });
  await Promise.all(stale.filter(Boolean).map(d => d.ref.delete()));
  logger.info("Push notification sent", { notificationId: event.params.notificationId, successCount: response.successCount, failureCount: response.failureCount });
});

exports.sendAdminBroadcast = onCall(async (request) => {
  const adminUid = assertAdmin(request);
  const title = cleanText(request.data?.title, 120);
  const body = cleanText(request.data?.body, 1000);
  if (!title || !body) throw new HttpsError("invalid-argument", "العنوان والنص مطلوبان");
  const usersSnap = await db.collection("users").select().get();
  const chunks = [];
  let batch = db.batch();
  let count = 0;
  for (const doc of usersSnap.docs) {
    const ref = db.collection("notifications").doc();
    batch.create(ref, { userId: doc.id, title, body, type: "info", isRead: false, createdAt: FieldValue.serverTimestamp() });
    count++;
    if (count % 450 === 0) { chunks.push(batch.commit()); batch = db.batch(); }
  }
  if (count % 450 !== 0) chunks.push(batch.commit());
  await Promise.all(chunks);
  await db.collection("auditLogs").add({ adminId: adminUid, action: "broadcast_notification", title, body, recipientCount: count, createdAt: FieldValue.serverTimestamp() });
  return { ok: true, count };
});


// =========================
// V17 — Payment Requests
// =========================
exports.createPaymentRequest = onCall(async (request) => {
  const uid = assertAuth(request);
  const payerWallet = cleanText(request.data?.payerWallet, 20);
  const amount = Number(request.data?.amount);
  const description = cleanText(request.data?.description || "طلب دفع", 200);
  const expiresHours = Math.min(Math.max(Number(request.data?.expiresHours || 48), 1), 168);
  if (!/^\d{6}$/.test(payerWallet)) throw new HttpsError("invalid-argument", "رقم محفظة الدافع غير صحيح");
  if (!Number.isInteger(amount) || amount < 100 || amount > MAX_TRANSFER_AMOUNT) throw new HttpsError("invalid-argument", "المبلغ يجب أن يكون بين 100 و100,000,000 ج.س");
  const requesterRef = db.collection("users").doc(uid);
  const payerQuery = await db.collection("users").where("walletID", "==", payerWallet).limit(2).get();
  if (payerQuery.empty) throw new HttpsError("not-found", "رقم المحفظة غير موجود");
  if (payerQuery.size > 1) throw new HttpsError("failed-precondition", "رقم المحفظة غير فريد");
  const payerDoc = payerQuery.docs[0];
  if (payerDoc.id === uid) throw new HttpsError("invalid-argument", "لا يمكنك طلب الدفع من محفظتك نفسها");
  if (payerDoc.get("status") === "frozen") throw new HttpsError("failed-precondition", "محفظة الدافع مجمدة");
  const requesterSnap = await requesterRef.get();
  if (!requesterSnap.exists) throw new HttpsError("not-found", "المحفظة غير موجودة");
  if (requesterSnap.get("status") === "frozen") throw new HttpsError("permission-denied", "المحفظة مجمدة");
  const requestRef = db.collection("paymentRequests").doc();
  const reference = makeOperationReference("PAYREQ");
  const expiresAt = new Date(Date.now() + expiresHours * 3600000);
  const requesterName = cleanText(requesterSnap.get("name") || "مستخدم MORRE PAY", 80);
  const payerName = cleanText(payerDoc.get("name") || "مستخدم MORRE PAY", 80);
  await requestRef.set({
    requesterId: uid, requesterWallet: requesterSnap.get("walletID"), requesterName,
    payerId: payerDoc.id, payerWallet, payerName, amount, currency: "SDG", description,
    reference, status: "pending", createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(), expiresAt
  });
  await db.collection("notifications").add({
    userId: payerDoc.id, title: "💸 طلب دفع جديد",
    body: `${requesterName} يطلب منك ${amount.toLocaleString("en-US")} ج.س — ${reference}`,
    type: "payment_request", paymentRequestId: requestRef.id, reference, amount,
    direction: "out", description, senderName: payerName, senderWalletID: payerWallet,
    receiverName: requesterName, receiverWalletID: requesterSnap.get("walletID"),
    isRead: false, createdAt: FieldValue.serverTimestamp()
  });
  return { ok: true, requestId: requestRef.id, reference, status: "pending", expiresAt: expiresAt.toISOString() };
});

exports.respondPaymentRequest = onCall(async (request) => {
  const uid = assertAuth(request);
  const requestId = cleanText(request.data?.requestId, 120);
  const action = cleanText(request.data?.action, 20).toLowerCase();
  if (!requestId || !["pay", "reject", "cancel"].includes(action)) throw new HttpsError("invalid-argument", "بيانات الطلب غير صحيحة");
  const reqRef = db.collection("paymentRequests").doc(requestId);
  let result;
  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "طلب الدفع غير موجود");
    const r = reqSnap.data();
    if (r.status !== "pending") throw new HttpsError("failed-precondition", "الطلب تمت معالجته مسبقًا");
    if (r.expiresAt?.toMillis && r.expiresAt.toMillis() <= Date.now()) {
      tx.update(reqRef, { status: "expired", updatedAt: FieldValue.serverTimestamp() });
      throw new HttpsError("failed-precondition", "انتهت صلاحية طلب الدفع");
    }
    if (action === "cancel" && r.requesterId !== uid) throw new HttpsError("permission-denied", "يمكن لصاحب الطلب إلغاؤه فقط");
    if (action !== "reject" && action !== "cancel" && r.payerId !== uid) throw new HttpsError("permission-denied", "هذا الطلب ليس موجهًا إليك");
    if (action === "reject") {
      if (r.payerId !== uid) throw new HttpsError("permission-denied", "يمكن للدافع رفض الطلب فقط");
      tx.update(reqRef, { status: "rejected", processedBy: uid, processedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      result = { status: "rejected", reference: r.reference };
      return;
    }
    if (action === "cancel") {
      tx.update(reqRef, { status: "cancelled", processedBy: uid, processedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      result = { status: "cancelled", reference: r.reference };
      return;
    }
    const payerRef = db.collection("users").doc(r.payerId);
    const receiverRef = db.collection("users").doc(r.requesterId);
    const payerSnap = await tx.get(payerRef);
    const receiverSnap = await tx.get(receiverRef);
    if (!payerSnap.exists || !receiverSnap.exists) throw new HttpsError("not-found", "أحد الحسابات غير موجود");
    if (payerSnap.get("status") === "frozen" || receiverSnap.get("status") === "frozen") throw new HttpsError("failed-precondition", "لا يمكن تنفيذ الطلب على حساب مجمد");
    const amount = Number(r.amount || 0);
    const fee = calculateFee(amount);
    const total = amount + fee;
    const balance = Number(payerSnap.get("balance") || 0);
    if (balance < total) throw new HttpsError("failed-precondition", `الرصيد غير كافي. المطلوب ${total.toLocaleString("en-US")} ج.س شامل الرسوم`);
    const txRef = db.collection("transactions").doc();
    tx.update(payerRef, { balance: FieldValue.increment(-total), dailyUsed: FieldValue.increment(total), monthlyUsed: FieldValue.increment(total), updatedAt: FieldValue.serverTimestamp() });
    tx.update(receiverRef, { balance: FieldValue.increment(amount), updatedAt: FieldValue.serverTimestamp() });
    tx.set(txRef, {
      type: "transfer", status: "completed", senderId: r.payerId, receiverId: r.requesterId,
      senderName: r.payerName, senderWalletID: r.payerWallet, receiverName: r.requesterName,
      receiverWalletID: r.requesterWallet, amount, fee, totalAmount: total, description: r.description || "طلب دفع",
      reference: makeOperationReference("TRX"), paymentRequestId: requestId, paymentRequestReference: r.reference,
      createdAt: FieldValue.serverTimestamp()
    });
    const senderLedger = db.collection("ledger").doc();
    const receiverLedger = db.collection("ledger").doc();
    tx.set(senderLedger, { userId: r.payerId, transactionId: txRef.id, type: "debit", amount: total, balanceBefore: balance, balanceAfter: balance-total, createdAt: FieldValue.serverTimestamp() });
    tx.set(receiverLedger, { userId: r.requesterId, transactionId: txRef.id, type: "credit", amount, createdAt: FieldValue.serverTimestamp() });
    tx.update(reqRef, { status: "paid", transactionId: txRef.id, processedBy: uid, processedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(db.collection("notifications").doc(), { userId: r.payerId, title: "✅ تم دفع طلب الدفع", body: `تم دفع ${amount.toLocaleString("en-US")} ج.س إلى ${r.requesterName}`, type: "transfer", transactionId: txRef.id, reference: r.reference, amount, direction: "out", description: r.description || "طلب دفع", senderName: r.payerName, senderWalletID: r.payerWallet, receiverName: r.requesterName, receiverWalletID: r.requesterWallet, isRead:false, createdAt:FieldValue.serverTimestamp() });
    tx.create(db.collection("notifications").doc(), { userId: r.requesterId, title: "💰 تم استلام طلب الدفع", body: `استلمت ${amount.toLocaleString("en-US")} ج.س من ${r.payerName}`, type: "transfer", transactionId: txRef.id, reference: r.reference, amount, direction: "in", description: r.description || "طلب دفع", senderName: r.payerName, senderWalletID: r.payerWallet, receiverName: r.requesterName, receiverWalletID: r.requesterWallet, isRead:false, createdAt:FieldValue.serverTimestamp() });
    result = { status: "paid", reference: r.reference, transactionId: txRef.id, amount, fee, totalAmount: total };
  });
  if (result.status === "rejected") {
    const r = (await reqRef.get()).data();
    await db.collection("notifications").add({ userId: r.requesterId, title:"❌ تم رفض طلب الدفع", body:`تم رفض طلب الدفع ${r.reference}`, type:"payment_request", paymentRequestId:requestId, reference:r.reference, amount:r.amount, direction:"in", description:r.description||"طلب دفع", isRead:false, createdAt:FieldValue.serverTimestamp() });
  } else if (result.status === "cancelled") {
    const r = (await reqRef.get()).data();
    await db.collection("notifications").add({ userId: r.payerId, title:"🚫 تم إلغاء طلب الدفع", body:`تم إلغاء طلب الدفع ${r.reference}`, type:"payment_request", paymentRequestId:requestId, reference:r.reference, amount:r.amount, direction:"out", description:r.description||"طلب دفع", isRead:false, createdAt:FieldValue.serverTimestamp() });
  }
  return { ok: true, ...result };
});

exports.listPaymentRequests = onCall(async (request) => {
  const uid = assertAuth(request);
  const limit = Math.min(Math.max(Number(request.data?.limit || 50), 1), 100);
  const [incoming, outgoing] = await Promise.all([
    db.collection("paymentRequests").where("payerId", "==", uid).orderBy("createdAt", "desc").limit(limit).get(),
    db.collection("paymentRequests").where("requesterId", "==", uid).orderBy("createdAt", "desc").limit(limit).get()
  ]);
  const m = new Map();
  incoming.forEach(d => m.set(d.id, { id:d.id, role:"payer", ...d.data() }));
  outgoing.forEach(d => m.set(d.id, { id:d.id, role:"requester", ...d.data() }));
  return { ok:true, requests:[...m.values()].sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0)) };
});

exports.createDepositRequest = onCall(async (request) => {
  const uid = assertAuth(request);
  const amount = validateMoneyAmount(request.data?.amount);
  const method = cleanText(request.data?.method || "manual", 40);
  const reference = cleanText(request.data?.reference || "", 100);
  const description = cleanText(request.data?.description || "إيداع", 200);

  if (amount < 100) throw new HttpsError("invalid-argument", "الحد الأدنى للإيداع 100 ج.س");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "المحفظة غير موجودة");
  if (userSnap.get("status") === "frozen") throw new HttpsError("permission-denied", "المحفظة مجمدة");

  const requestRef = db.collection("depositRequests").doc();
  const requestReference = makeOperationReference("DPR");
  const userName = cleanText(userSnap.get("name") || "مستخدم MORRE PAY", 80);
  const walletID = userSnap.get("walletID");
  await requestRef.set({
    userId: uid, walletID, userName, amount, currency: "SDG", method, reference, description,
    requestReference, status: "pending", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  await db.collection("notifications").add({
    userId: uid, title: "⏳ طلب إيداع قيد المراجعة",
    body: `طلب إيداع ${amount.toLocaleString("en-US")} ج.س — رقم الطلب ${requestReference}`,
    type: "deposit", requestId: requestRef.id, requestReference, amount, direction: "in",
    method, description, senderName: "MORRE PAY", receiverName: userName, receiverWalletID: walletID,
    reference: requestReference, isRead: false, createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true, requestId: requestRef.id, requestReference, status: "pending" };
});

exports.createWithdrawRequest = onCall(async (request) => {
  const uid = assertAuth(request);
  const amount = validateMoneyAmount(request.data?.amount);
  const method = cleanText(request.data?.method || "manual", 40);
  const destination = cleanText(request.data?.destination || "", 120);
  const description = cleanText(request.data?.description || "سحب", 200);

  if (amount < 100) throw new HttpsError("invalid-argument", "الحد الأدنى للسحب 100 ج.س");
  if (!destination) throw new HttpsError("invalid-argument", "أدخل وجهة السحب");

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) throw new HttpsError("not-found", "المحفظة غير موجودة");
  if (userSnap.get("status") === "frozen") throw new HttpsError("permission-denied", "المحفظة مجمدة");

  const balance = Number(userSnap.get("balance") || 0);
  if (balance < amount) throw new HttpsError("failed-precondition", "الرصيد غير كافي");

  const requestRef = db.collection("withdrawRequests").doc();
  const requestReference = makeOperationReference("WDRQ");
  const userName = cleanText(userSnap.get("name") || "مستخدم MORRE PAY", 80);
  const walletID = userSnap.get("walletID");
  await requestRef.set({
    userId: uid, walletID, userName, amount, currency: "SDG", method, destination, description,
    requestReference, status: "pending", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  });
  await db.collection("notifications").add({
    userId: uid, title: "⏳ طلب سحب قيد المراجعة",
    body: `طلب سحب ${amount.toLocaleString("en-US")} ج.س — رقم الطلب ${requestReference}`,
    type: "withdraw", requestId: requestRef.id, requestReference, amount, direction: "out",
    method, destination, description, senderName: userName, senderWalletID: walletID, receiverName: "MORRE PAY",
    reference: requestReference, isRead: false, createdAt: FieldValue.serverTimestamp()
  });

  return { ok: true, requestId: requestRef.id, requestReference, status: "pending" };
});

exports.approveDeposit = onCall(async (request) => {
  const uid = assertAuth(request);
  const isAdmin = request.auth.token.admin === true;
  if (!isAdmin) throw new HttpsError("permission-denied", "صلاحية المدير مطلوبة");

  const requestId = cleanText(request.data?.requestId, 120);
  if (!requestId) throw new HttpsError("invalid-argument", "رقم الطلب مطلوب");

  const reqRef = db.collection("depositRequests").doc(requestId);
  let result;
  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "طلب الإيداع غير موجود");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "الطلب تمت معالجته مسبقًا");

    const userRef = db.collection("users").doc(req.userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
    if (userSnap.get("status") === "frozen") throw new HttpsError("failed-precondition", "المحفظة مجمدة");

    const before = Number(userSnap.get("balance") || 0);
    const after = before + Number(req.amount);
    const transactionRef = db.collection("transactions").doc();
    const reference = `DEP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    tx.update(userRef, { balance: after, updatedAt: FieldValue.serverTimestamp() });
    tx.update(reqRef, { status: "approved", approvedBy: uid, approvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), transactionId: transactionRef.id });
    tx.create(transactionRef, {
      reference, senderId: "system", senderName: "MORRE PAY", senderWalletID: "MORRE PAY",
      receiverId: req.userId, receiverName: req.userName || "مستخدم MORRE PAY", receiverWalletID: req.walletID,
      receiverPhone: userSnap.get("phone") || null,
      amount: Number(req.amount), fee: 0, totalAmount: Number(req.amount), netAmount: Number(req.amount),
      currency: "SDG", type: "deposit", status: "completed", method: req.method,
      requestId, requestReference: req.requestReference || null, externalReference: req.reference || null,
      description: req.description || `إيداع عبر ${req.method}`,
      createdAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("ledger").doc(), {
      userId: req.userId, transactionId: transactionRef.id, walletId: req.walletID,
      amount: Number(req.amount), balanceBefore: before, balanceAfter: after, type: "credit",
      description: "إيداع معتمد", createdAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("notifications").doc(), {
      userId: req.userId, title: "💰 تم اعتماد الإيداع",
      body: `تمت إضافة ${Number(req.amount).toLocaleString("en-US")} ج.س إلى محفظتك — رقم العملية ${reference}`,
      type: "deposit", transactionId: transactionRef.id, requestId, requestReference: req.requestReference || null,
      reference, amount: Number(req.amount), fee: 0, direction: "in", method: req.method,
      description: req.description || `إيداع عبر ${req.method}`, senderName: "MORRE PAY", senderWalletID: "MORRE PAY",
      receiverName: req.userName || "مستخدم MORRE PAY", receiverWalletID: req.walletID,
      receiverPhone: userSnap.get("phone") || null, isRead: false, createdAt: FieldValue.serverTimestamp()
    });
    result = { ok: true, requestId, transactionId: transactionRef.id, targetUserId: req.userId, status: "approved" };
  });
  await db.collection("auditLogs").add({ adminId: uid, action: "deposit_approved", requestId, targetUserId: result.targetUserId || null, transactionId: result.transactionId, createdAt: FieldValue.serverTimestamp() });
  return result;
});

exports.approveWithdraw = onCall(async (request) => {
  const uid = assertAuth(request);
  if (request.auth.token.admin !== true) throw new HttpsError("permission-denied", "صلاحية المدير مطلوبة");
  const requestId = cleanText(request.data?.requestId, 120);
  if (!requestId) throw new HttpsError("invalid-argument", "رقم الطلب مطلوب");

  const reqRef = db.collection("withdrawRequests").doc(requestId);
  let result;
  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "طلب السحب غير موجود");
    const req = reqSnap.data();
    if (req.status !== "pending") throw new HttpsError("failed-precondition", "الطلب تمت معالجته مسبقًا");

    const userRef = db.collection("users").doc(req.userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("not-found", "المستخدم غير موجود");
    const before = Number(userSnap.get("balance") || 0);
    const amount = Number(req.amount);
    if (before < amount) throw new HttpsError("failed-precondition", "الرصيد أصبح غير كافي");
    if (userSnap.get("status") === "frozen") throw new HttpsError("failed-precondition", "المحفظة مجمدة");

    const after = before - amount;
    const transactionRef = db.collection("transactions").doc();
    const reference = `WDR-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    tx.update(userRef, { balance: after, updatedAt: FieldValue.serverTimestamp() });
    tx.update(reqRef, { status: "approved", approvedBy: uid, approvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), transactionId: transactionRef.id });
    tx.create(transactionRef, {
      reference, senderId: req.userId, senderName: req.userName || "مستخدم MORRE PAY", senderWalletID: req.walletID,
      senderPhone: userSnap.get("phone") || null, receiverId: "system", receiverName: "MORRE PAY", receiverWalletID: "MORRE PAY",
      amount, fee: 0, totalAmount: amount, netAmount: amount, currency: "SDG", type: "withdraw", status: "completed",
      method: req.method, destination: req.destination, requestId, requestReference: req.requestReference || null,
      description: req.description || `سحب عبر ${req.method}`, createdAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("ledger").doc(), {
      userId: req.userId, transactionId: transactionRef.id, walletId: req.walletID,
      amount, balanceBefore: before, balanceAfter: after, type: "debit",
      description: "سحب معتمد", createdAt: FieldValue.serverTimestamp()
    });
    tx.create(db.collection("notifications").doc(), {
      userId: req.userId, title: "💸 تم اعتماد السحب",
      body: `تم اعتماد سحب ${amount.toLocaleString("en-US")} ج.س — رقم العملية ${reference}`, type: "withdraw",
      transactionId: transactionRef.id, requestId, requestReference: req.requestReference || null, reference, amount, fee: 0, direction: "out",
      method: req.method, destination: req.destination, description: req.description || `سحب عبر ${req.method}`,
      senderName: req.userName || "مستخدم MORRE PAY", senderWalletID: req.walletID, senderPhone: userSnap.get("phone") || null,
      receiverName: "MORRE PAY", receiverWalletID: "MORRE PAY", isRead: false, createdAt: FieldValue.serverTimestamp()
    });
    result = { ok: true, requestId, transactionId: transactionRef.id, targetUserId: req.userId, status: "approved" };
  });
  await db.collection("auditLogs").add({ adminId: uid, action: "withdraw_approved", requestId, targetUserId: result.targetUserId || null, transactionId: result.transactionId, createdAt: FieldValue.serverTimestamp() });
  return result;
});
