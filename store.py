"""방 저장소.

- 로컬 개발/테스트: SQLite 파일 (SqliteStore)
- Vercel 배포: Redis REST (Upstash Redis / Vercel Marketplace 의 Redis·KV 연동) (RedisStore)

Vercel 함수는 요청마다 다른 인스턴스에서 실행되고 파일 시스템이 유지되지 않으므로 SQLite 파일을 쓸 수 없다.
두 저장소 모두 낙관적 잠금(rev)으로 동시 수정을 막는다. 엔진은 save()가 False 를 돌려주면 다시 읽고 재시도한다.
"""
import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path

ROOM_TTL=7*86400  # 방은 마지막 저장 후 7일이 지나면 사라진다.


class StoreError(Exception):
    status=503


class SqliteStore:
    def __init__(self,path):
        self.path=str(path);Path(self.path).parent.mkdir(parents=True,exist_ok=True)
        db=self._db()
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL)')
            try:db.execute('ALTER TABLE rooms ADD COLUMN rev INTEGER NOT NULL DEFAULT 0')
            except sqlite3.OperationalError:pass  # 이미 있음
        finally:db.close()
    def _db(self):
        db=sqlite3.connect(self.path,timeout=15,isolation_level=None);db.execute('PRAGMA busy_timeout=15000');return db
    def load(self,code):
        db=self._db()
        try:row=db.execute('SELECT data,rev FROM rooms WHERE code=?',(code,)).fetchone()
        finally:db.close()
        return (json.loads(row[0]),row[1]) if row else None
    def save(self,code,room,rev):
        """rev=None 이면 새 방 만들기(이미 있으면 False). 아니면 읽었던 rev 와 같을 때만 저장."""
        data=json.dumps(room,ensure_ascii=False);db=self._db()
        try:
            db.execute('BEGIN IMMEDIATE')
            if rev is None:ok=db.execute('INSERT OR IGNORE INTO rooms(code,data,updated,rev) VALUES(?,?,?,1)',(code,data,time.time())).rowcount==1
            else:ok=db.execute('UPDATE rooms SET data=?,updated=?,rev=rev+1 WHERE code=? AND rev=?',(data,time.time(),code,rev)).rowcount==1
            db.execute('COMMIT' if ok else 'ROLLBACK');return ok
        finally:db.close()
    def delete(self,code):
        db=self._db()
        try:db.execute('DELETE FROM rooms WHERE code=?',(code,))
        finally:db.close()
    def codes(self):
        db=self._db()
        try:return [r[0] for r in db.execute('SELECT code FROM rooms').fetchall()]
        finally:db.close()


class RedisStore:
    """Upstash Redis REST API. 방 하나 = 해시 하나(rev, data). 의존 패키지 없이 urllib 만 사용한다."""
    SAVE=("local r=redis.call('HGET',KEYS[1],'rev') "
          "if (r==false and ARGV[1]=='0') or r==ARGV[1] then "
          "redis.call('HSET',KEYS[1],'rev',tostring(tonumber(ARGV[1])+1),'data',ARGV[2]) "
          "redis.call('EXPIRE',KEYS[1],ARGV[3]) return 1 end return 0")
    def __init__(self,url,token):self.url=url.rstrip('/');self.token=token
    def _cmd(self,*args):
        req=urllib.request.Request(self.url,data=json.dumps(list(args)).encode(),method='POST',headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=8) as res:out=json.load(res)
        except Exception as exc:raise StoreError('저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.') from exc
        if isinstance(out,dict) and out.get('error'):raise StoreError('저장소 오류: '+str(out['error'])[:120])
        return out.get('result') if isinstance(out,dict) else None
    @staticmethod
    def _key(code):return 'nr:room:'+code
    def load(self,code):
        r=self._cmd('HMGET',self._key(code),'data','rev')
        if not r or r[0] is None:return None
        return json.loads(r[0]),int(r[1] or 0)
    def save(self,code,room,rev):
        return self._cmd('EVAL',self.SAVE,'1',self._key(code),str(0 if rev is None else rev),json.dumps(room,ensure_ascii=False),str(ROOM_TTL))==1
    def delete(self,code):self._cmd('DEL',self._key(code))
    def codes(self):return []  # 만료는 Redis TTL 이 처리한다. 시간 진행은 요청이 올 때마다 계산한다.


class MissingStore:
    """Vercel 에 저장소 환경변수가 없을 때: 원인을 바로 알 수 있게 안내한다."""
    def _fail(self,*a,**k):raise StoreError('저장소가 연결되지 않았습니다. Vercel 프로젝트에 Upstash Redis를 연결하고(KV_REST_API_URL, KV_REST_API_TOKEN) 다시 배포해주세요.')
    load=save=delete=_fail
    def codes(self):return []


def make_store(default_path):
    url=os.environ.get('KV_REST_API_URL') or os.environ.get('UPSTASH_REDIS_REST_URL')
    token=os.environ.get('KV_REST_API_TOKEN') or os.environ.get('UPSTASH_REDIS_REST_TOKEN')
    if url and token:return RedisStore(url,token)
    if os.environ.get('VERCEL'):return MissingStore()
    return SqliteStore(os.environ.get('DB_PATH',default_path))
