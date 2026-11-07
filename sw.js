const CACHE='edukot-parent-v3-icons';
const ASSETS=['/','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-192-maskable.png','/icons/icon-512-maskable.png','/icons/apple-touch-icon.png','/icons/favicon-32.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).pathname.startsWith('/api/'))return;event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));});
