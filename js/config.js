// Firebase 設定：Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定與配置（Config）
// 專案：pickleball-pairing-3ab26（和 Time Hunter 分開）
// 若改回 'YOUR_API_KEY'，網站會以 DEMO 模式運作（資料只存在本機瀏覽器）
export const firebaseConfig = {
  apiKey: 'AIzaSyBdwQ4Vz7OXQoHuWuMQIfwGQ4dhLDMJ-XI',
  authDomain: 'pickleball-pairing-3ab26.firebaseapp.com',
  projectId: 'pickleball-pairing-3ab26',
  storageBucket: 'pickleball-pairing-3ab26.firebasestorage.app',
  messagingSenderId: '784837310008',
  appId: '1:784837310008:web:193bfd17e190085281d8cd',
};

// 預設場地；場主在網站上按「新增場地」加的場地會自動加在後面
export const DEFAULT_VENUES = ['埔乾國小', '雙連'];
