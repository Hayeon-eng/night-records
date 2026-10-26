"""One-process WSGI application; local runner uses a threaded standard-library server."""
import json
import logging
import mimetypes
import os
from pathlib import Path
import threading
import time
from collections import defaultdict, deque
from socketserver import ThreadingMixIn
from urllib.parse import urlparse
from wsgiref.simple_server import make_server, WSGIServer, WSGIRequestHandler
from engine import Engine, GameError
import scenario as S

ROOT=Path(__file__).parent
engine=Engine(os.environ.get('DB_PATH',str(ROOT/'data/game.sqlite3')))
LIMITS=defaultdict(deque);RATE_LOCK=threading.Lock()
STATIC={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg'}
def limited(key,count,seconds):
    now=time.time()
    with RATE_LOCK:
        q=LIMITS[key]
        while q and q[0]<now-seconds:q.popleft()
        if len(q)>=count:raise GameError('요청이 많습니다. 잠시 후 다시 시도해주세요.',429)
        q.append(now)
        if len(LIMITS)>10000:
            for k in list(LIMITS):
                if not LIMITS[k] or LIMITS[k][-1]<now-3600:del LIMITS[k]

def application(env,start_response):
    headers=[('X-Content-Type-Options','nosniff'),('Referrer-Policy','no-referrer'),('X-Frame-Options','DENY'),
             ('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")]
    path=env.get('PATH_INFO','/');method=env.get('REQUEST_METHOD','GET')
    try:
        if path=='/health':data={'ok':True}
        elif path.startswith('/api/'):
            headers.append(('Cache-Control','no-store'))
            if method not in ('GET','POST'):raise GameError('지원하지 않는 요청입니다.',405)
            ip=env.get('REMOTE_ADDR','unknown');limited(('api',ip),600,60)
            body={}
            if method=='POST':
                origin=env.get('HTTP_ORIGIN')
                expected=os.environ.get('PUBLIC_ORIGIN')
                if origin and (origin!=expected if expected else urlparse(origin).netloc!=env.get('HTTP_HOST')):raise GameError('허용되지 않는 출처입니다.',403)
                if env.get('CONTENT_TYPE','').split(';')[0]!='application/json':raise GameError('JSON 요청만 허용됩니다.',415)
                length=int(env.get('CONTENT_LENGTH') or 0)
                if length<=0 or length>12000:raise GameError('요청 크기를 확인해주세요.',413)
                body=json.loads(env['wsgi.input'].read(length))
                if not isinstance(body,dict):raise GameError('요청 형식이 올바르지 않습니다.')
            if path=='/api/catalog' and method=='GET':
                data=dict(id=S.ID,title=S.TITLE,summary=S.SUMMARY,intro=S.INTRO,rules=S.RULES,roles=[{k:r[k] for k in ('id','title','required','icon','faction','teaser')} for r in S.ROLES])
            elif path=='/api/rooms' and method=='POST':
                limited(('create',ip),15,3600)
                data=engine.create(body.get('name'),body.get('size'),body.get('pace','normal'))
            else:
                parts=path.strip('/').split('/')
                if len(parts)!=4 or parts[:2]!=['api','rooms']:raise GameError('경로를 찾을 수 없습니다.',404)
                code,action=parts[2].upper(),parts[3]
                if action=='state' and method!='GET' or action!='state' and method!='POST':raise GameError('요청 방식을 확인해주세요.',405)
                if action=='join':limited(('join',ip),40,600)
                token=env.get('HTTP_AUTHORIZATION','').removeprefix('Bearer ')
                data=engine.mutate(code,token,action,body)
            payload=json.dumps(data,ensure_ascii=False).encode();headers.append(('Content-Type','application/json; charset=utf-8'));status='200 OK'
        elif path in STATIC and method=='GET':
            file=ROOT/'static'/STATIC[path];payload=file.read_bytes()
            headers.extend([('Content-Type',mimetypes.guess_type(file)[0] or 'application/octet-stream'),('Cache-Control','no-cache')]);status='200 OK'
        else:raise GameError('페이지를 찾을 수 없습니다.',404)
        if path=='/health':payload=json.dumps(data).encode();headers.append(('Content-Type','application/json'));status='200 OK'
    except (GameError,ValueError,json.JSONDecodeError) as exc:
        code=getattr(exc,'status',400);status=f'{code} Error';payload=json.dumps({'error':str(exc)},ensure_ascii=False).encode();headers.append(('Content-Type','application/json; charset=utf-8'))
    except Exception:
        logging.exception('Request failed');status='500 Error';payload=json.dumps({'error':'서버 오류입니다. 입력을 유지하고 다시 시도해주세요.'},ensure_ascii=False).encode();headers.append(('Content-Type','application/json; charset=utf-8'))
    headers.append(('Content-Length',str(len(payload))));start_response(status,headers);return [payload]

def scheduler():
    while True:
        try:engine.tick_all()
        except Exception:logging.exception('Clock update failed')
        time.sleep(2)
threading.Thread(target=scheduler,daemon=True).start()
class ThreadServer(ThreadingMixIn,WSGIServer):daemon_threads=True
class QuietHandler(WSGIRequestHandler):
    def log_message(self,format,*args): pass # No room codes or private tokens in access logs.
if __name__=='__main__':
    port=int(os.environ.get('PORT','8000'))
    print(f'Night Records: http://localhost:{port}',flush=True)
    with make_server('0.0.0.0',port,application,server_class=ThreadServer,handler_class=QuietHandler) as server:server.serve_forever()
