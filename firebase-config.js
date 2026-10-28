(function (root) {
  // Firebase コンソール > プロジェクトの設定 > 全般 > Webアプリ の値を貼り付けます。
  // ここに入る値はWeb公開用設定です。サービスアカウント秘密鍵は絶対に入れないでください。
  root.TODO_FIREBASE_CONFIG = {
    apiKey: "AIzaSyCXVr_cXJI3uiS9rHDYxr5ImunZZp5soyE",
    authDomain: "todo-manager-push.firebaseapp.com",
    projectId: "todo-manager-push",
    storageBucket: "todo-manager-push.firebasestorage.app",
    messagingSenderId: "493532964763",
    appId: "1:493532964763:web:a263bb16326b62be91633e"
  };

  // Firebase コンソール > プロジェクトの設定 > Cloud Messaging
  // Web Push 証明書の公開鍵（VAPID key）を貼り付けます。
  root.TODO_FIREBASE_VAPID_KEY = "BMV4vloTPCp3z4LR6DPtWPRQ8EFWmLq7rzf99pnXuRNnL3lRNkJawZSpbqY8J6yd2HIN2pn0-83q8I23C1bcKSY";
})(typeof self !== "undefined" ? self : window);
