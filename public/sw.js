/* 브라우저 알림 표시 전용 서비스 워커 (오프라인 캐시 없음). Android Chrome은 서비스 워커를 통해서만 알림을 띄울 수 있다. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if('focus' in c)return c.focus();}
    return self.clients.openWindow?self.clients.openWindow('/'):undefined;
  }));
});
