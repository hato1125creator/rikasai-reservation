const CACHE_NAME = 'rikasai-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/student/index.html',
  '/student/fairytale.css',
  '/guest/index.html',
  '/admin/index.html',
  '/privacy.html',
  '/manifest.json'
];

// インストール時に静的ファイルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 古いキャッシュの削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
});

// フェッチ要求の処理
self.addEventListener('fetch', (event) => {
  // APIリクエストはキャッシュしない（常にネットワーク）
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      // キャッシュがあればそれを返し、なければネットワークから取得
      return response || fetch(event.request).then((fetchResponse) => {
        // 取得したファイルをキャッシュに追加（動的キャッシュ）
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, fetchResponse.clone());
          return fetchResponse;
        });
      });
    }).catch(() => {
      // オフラインでキャッシュもない場合のフォールバック（必要なら）
      if (event.request.mode === 'navigate') {
        return caches.match('/student/index.html');
      }
    })
  );
});
