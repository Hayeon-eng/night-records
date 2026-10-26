import copy
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine import Engine, GameError, REQUIRED
import scenario as S

class GameTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.now=1_000_000.;self.e=Engine(Path(self.tmp.name)/'rooms.sqlite3',lambda:self.now)
    def tearDown(self):self.tmp.cleanup()
    def make(self,size=6):
        first=self.e.create('첫 참가자',size,'normal');people=[first]
        for i in range(1,size):people.append(self.e.mutate(first['code'],'','join',{'name':f'친구 {i}'}))
        return people
    def act(self,p,action,body=None):return self.e.mutate(p['code'],p['token'],action,body)
    def start(self,size=6):
        people=self.make(size)
        for p,r in zip(people,S.ROLES):self.act(p,'role',{'role':r['id']})
        for p in people:state=self.act(p,'ready')
        self.assertEqual(state['phase'],'intro');return people
    def next(self,people):
        for p in people:state=self.act(p,'vote')
        return state
    def reach_final(self,people):
        for _ in range(4):state=self.next(people)
        self.assertEqual(state['phase'],'final')
    def test_full_game_6_7_8(self):
        for size in [6,7,8]:
            with self.subTest(size=size):
                p=self.start(size);self.reach_final(p)
                for person in p:state=self.act(person,'submit',{'answers':S.ANSWERS,'note':'원문을 연결했다'})
                self.assertEqual(state['phase'],'ending');self.assertEqual(state['result']['grade'],'perfect')
                self.assertEqual(state['result']['average'],4);self.assertEqual(len(state['archive']),8)
                self.assertTrue(all(c['readable'] for c in state['clues']))
                baseline=state['result']
                for person in p:self.assertEqual(self.act(person,'state')['result'],baseline)
    def test_lobby_does_not_leak_secrets(self):
        p=self.make();state=self.act(p[0],'role',{'role':'planner'})
        self.assertIsNone(state['book']);self.assertEqual(state['archive'],[]);self.assertEqual(state['questions'],[])
        self.assertNotIn('당신은 오래 고민해온',json.dumps(state,ensure_ascii=False))
        self.assertTrue(all('text' not in c and 'title' not in c for c in state['clues']))
    def test_only_self_book_and_clues_available(self):
        p=self.start();s=self.act(p[1],'state');self.assertEqual(s['book']['id'],'operator')
        self.assertTrue(all(not c['readable'] for c in s['clues'] if c['owner']!='operator'))
        self.assertTrue(all(c['readable'] for c in s['clues'] if c['owner']=='operator'))
    def test_auth_cross_room(self):
        p=self.start();other=self.e.create('다른 사람',6,'quick')
        for token in ['',other['token'],'bogus']:
            with self.assertRaises(GameError) as err:self.e.mutate(p[0]['code'],token,'state')
            self.assertEqual(err.exception.status,401)
    def test_private_messages_not_disclosed(self):
        p=self.start();self.act(p[0],'chat',{'text':'개인 메시지','to':p[1]['member_id']})
        self.assertIn('개인 메시지',str(self.act(p[0],'state')['messages']))
        self.assertIn('개인 메시지',str(self.act(p[1],'state')['messages']))
        self.assertNotIn('개인 메시지',str(self.act(p[2],'state')['messages']))
        self.reach_final(p);self.now+=400
        self.assertNotIn('개인 메시지',str(self.act(p[2],'state')['messages']))
    def test_claim_atomic_and_tokens(self):
        p=self.start();self.next(p)
        def investigate(person):
            try:return self.act(person,'investigate',{'clue':'hr-2'})
            except GameError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(investigate,p[:2]))
        self.assertEqual(sum(r is not None for r in results),1)
        winner=p[0] if results[0] else p[1];loser=p[1] if results[0] else p[0]
        self.assertEqual(self.act(winner,'state')['me']['tokens'],0)
        self.assertEqual(self.act(loser,'state')['me']['tokens'],1)
        self.act(winner,'share',{'clue':'hr-2'})
        self.assertTrue(next(c for c in self.act(loser,'state')['clues'] if c['id']=='hr-2')['readable'])
    def test_no_unauthorized_sharing(self):
        p=self.start();self.next(p)
        with self.assertRaises(GameError):self.act(p[0],'share',{'clue':'friend-1'})
        self.act(p[0],'share',{'clue':'planner-1'})
        self.assertTrue(next(c for c in self.act(p[1],'state')['clues'] if c['id']=='planner-1')['readable'])
    def test_evidence_timing_and_tokens(self):
        p=self.start();s=self.act(p[0],'state');self.assertEqual(len(s['evidence']),0)
        for expected in [(1,1),(2,2),(4,3)]:
            s=self.next(p);self.assertEqual((len(s['evidence']),s['me']['tokens']),expected)
    def test_duplicate_and_early_submission_rejected(self):
        p=self.start()
        with self.assertRaises(GameError):self.act(p[0],'submit',{'answers':S.ANSWERS})
        self.reach_final(p)
        with self.assertRaises(GameError):self.act(p[0],'submit',{'answers':{}})
        self.act(p[0],'submit',{'answers':S.ANSWERS})
        with self.assertRaises(GameError):self.act(p[0],'submit',{'answers':S.ANSWERS})
    def test_role_race(self):
        p=self.make()
        def select(person):
            try:self.act(person,'role',{'role':'planner'});return True
            except GameError:return False
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sum(pool.map(select,p[:2])),1)
    def test_capacity_and_late_join(self):
        p=self.start()
        with self.assertRaises(GameError):self.e.mutate(p[0]['code'],'','join',{'name':'추가'})
        with self.assertRaises(GameError):self.act(p[0],'role',{'role':'friend'})
        with self.assertRaises(GameError):self.act(p[0],'leave')
    def test_optional_cannot_displace_mandatory(self):
        p=self.make(7);self.act(p[0],'role',{'role':'hr'})
        with self.assertRaises(GameError):self.act(p[1],'role',{'role':'finance'})
    def test_timers_missing_submission_and_persistence(self):
        p=self.start();self.now+=301;self.e.tick_all();self.assertEqual(self.act(p[0],'state')['phase'],'r1')
        for _ in range(3):self.now+=721;self.e.tick_all()
        self.assertEqual(self.act(p[0],'state')['phase'],'final')
        self.act(p[0],'submit',{'answers':S.ANSWERS});self.now+=361;self.e.tick_all()
        before=self.act(p[0],'state');self.assertEqual(before['phase'],'ending')
        self.assertEqual(before['result']['average'],.67)
        self.e=Engine(self.e.path,lambda:self.now)
        self.assertEqual(self.act(p[0],'state')['result'],before['result'])
    def test_tie_and_arrest_story(self):
        p=self.start();self.reach_final(p)
        for i,person in enumerate(p):
            a=dict(S.ANSWERS,culprit='planner' if i<3 else 'auditor');s=self.act(person,'submit',{'answers':a})
        self.assertEqual(s['result']['grade'],'unresolved')
        self.assertEqual(set(s['result']['leaders']),{'planner','auditor'})
    def test_names_safe_as_data_and_role_ids_stable(self):
        p=self.e.create('<img src=x onerror=x>',6,'normal');s=self.act(p,'state')
        self.assertEqual(s['me']['name'],'<img src=x onerror=x>')
        self.assertEqual(s['roles'][0]['id'],'planner')
    def test_required_paths_present(self):
        allids={e['id'] for e in S.EVIDENCE}|{c['id'] for c in S.CLUES}
        for key,ids in S.DEPENDENCIES.items():
            self.assertTrue(set(ids)<=allids)
            self.assertTrue(any(i in {e['id'] for e in S.EVIDENCE} for i in ids))
        self.assertEqual(REQUIRED,{r['id'] for r in S.ROLES[:6]})
    def test_room_expiry(self):
        p=self.start();self.now+=8*86400;self.e.tick_all()
        with self.assertRaises(GameError) as err:self.act(p[0],'state')
        self.assertEqual(err.exception.status,404)

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();os.environ['DB_PATH']=str(Path(cls.tmp.name)/'http.sqlite3')
        import server
        cls.server=server
    def request(self,path,method='GET',data=None,token=None,origin=None):
        raw=json.dumps(data or {}).encode();env={'PATH_INFO':path,'REQUEST_METHOD':method,'wsgi.input':io.BytesIO(raw),'CONTENT_LENGTH':str(len(raw)),'CONTENT_TYPE':'application/json','REMOTE_ADDR':'127.0.0.1','HTTP_HOST':'localhost:8000'}
        if token:env['HTTP_AUTHORIZATION']='Bearer '+token
        if origin:env['HTTP_ORIGIN']=origin
        info={}
        def start(status,headers):info.update(status=int(status.split()[0]),headers=dict(headers))
        body=b''.join(self.server.application(env,start));return info,body
    def test_static_allowlist_and_api_secrets(self):
        for path in ['/scenario.py','/engine.py','/data/game.sqlite3','/../scenario.py']:
            info,_=self.request(path);self.assertEqual(info['status'],404)
        info,body=self.request('/api/catalog');self.assertEqual(info['status'],200);self.assertNotIn(b'ANSWERS',body);self.assertNotIn('당신은 오래 고민해온',body.decode())
        self.assertEqual(info['headers']['Cache-Control'],'no-store')
    def test_create_state_origin_and_invalid_json(self):
        info,_=self.request('/api/rooms','POST',{'name':'a','size':6},origin='https://evil.example');self.assertEqual(info['status'],403)
        info,body=self.request('/api/rooms','POST',{'name':'a','size':6},origin='http://localhost:8000');self.assertEqual(info['status'],200)
        p=json.loads(body);info,body=self.request('/api/rooms/'+p['code']+'/state',token=p['token']);self.assertEqual(info['status'],200)
        self.assertNotIn('auth',json.loads(body)['me']);self.assertNotIn(p['token'],body.decode())
    def test_entry_assets(self):
        for path in ['/','/app.js','/style.css','/manifest.webmanifest','/icon.svg','/health']:
            info,_=self.request(path);self.assertEqual(info['status'],200)

if __name__=='__main__':unittest.main()
