importScripts("https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDywz3Cn2KkpbeBvkR-YQNJzdxENLHuqSk",
  authDomain: "morre-pay.firebaseapp.com",
  projectId: "morre-pay",
  storageBucket: "morre-pay.firebasestorage.app",
  messagingSenderId: "1047255810990",
  appId: "1:1047255810990:web:8e067d8bc827072474be3f"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || "MORRE PAY", {
    body: n.body || "لديك إشعار جديد",
    data: payload.data || {}
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    for (const client of list) { if ("focus" in client) return client.focus(); }
    return clients.openWindow("./index.html");
  }));
});
