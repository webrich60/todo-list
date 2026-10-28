/* TODO管理 v2.6.0 Firebase Messaging Service Worker */
importScripts('./firebase-config.js');
importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging-compat.js');

const config = self.TODO_FIREBASE_CONFIG || {};
const isConfigured = Boolean(
  config.apiKey &&
  config.projectId &&
  config.messagingSenderId &&
  config.appId &&
  !String(config.apiKey).includes('YOUR_')
);

if (isConfigured) {
  firebase.initializeApp(config);
  firebase.messaging();
}
