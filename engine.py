"""Transactional game engine. State, clocks, visibility and results live here."""
import copy
import hashlib
import json
import secrets
import sqlite3
import time
from pathlib import Path
import scenario as S

class GameError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message); self.status=status

PHASE_IDS=[p[0] for p in S.PHASES]
ROLE_IDS={r['id'] for r in S.ROLES}
REQUIRED={r['id'] for r in S.ROLES if r['required']}
CLUES={c['id']:c for c in S.CLUES}

def token_hash(token): return hashlib.sha256(token.encode()).hexdigest()
def clean(value, limit, label):
    if not isinstance(value,str): raise GameError(f'{label}을 확인해주세요.')
    value=value.strip()
    if not value or len(value)>limit or any(ord(c)<32 and c not in '\n\t' for c in value):
        raise GameError(f'{label}은 1~{limit}자로 입력해주세요.')
    return value

class Engine:
    def __init__(self, path='data/game.sqlite3', clock=time.time):
        self.path=str(path); self.clock=clock
        Path(self.path).parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL)')
    def connect(self):
        db=sqlite3.connect(self.path,timeout=15,isolation_level=None)
        db.execute('PRAGMA busy_timeout=15000')
        return db
    def create(self,name,size,pace):
        name=clean(name,24,'이름')
        if type(size) is not int or size not in (6,7,8): raise GameError('정원은 6~8명입니다.')
        if pace not in ('normal','quick'): raise GameError('진행 속도를 선택해주세요.')
        token=secrets.token_urlsafe(32); mid=secrets.token_hex(8); now=self.clock()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            # Human-readable invite code, not a participant credential.
            while True:
                code=''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
                if not db.execute('SELECT 1 FROM rooms WHERE code=?',(code,)).fetchone():break
            room=dict(code=code,size=size,pace=pace,scenario=S.ID,phase='lobby',deadline=None,version=1,
                      created=now,members=[self.new_member(mid,name,token,now)],votes=[],claims={},messages=[],submissions={},result=None)
            self.system(room,'사건실이 열렸습니다. 초대 코드를 친구에게 전달해주세요.')
            self.save(db,room)
        return dict(code=code,token=token,member_id=mid)
    @staticmethod
    def new_member(mid,name,token,now):
        return dict(id=mid,name=name,auth=token_hash(token),role=None,ready=False,joined=now,last_seen=now,acquired=[],last_chat=0)
    def save(self,db,room):
        db.execute('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET data=excluded.data,updated=excluded.updated',
                   (room['code'],json.dumps(room,ensure_ascii=False),self.clock()))
    def system(self,room,text): self.message(room,None,None,text)
    def message(self,room,sender,to,text):
        if sender and len(room['messages'])>=2400: raise GameError('이 방의 메시지 한도에 도달했습니다.')
        room['messages'].append(dict(id=len(room['messages'])+1,sender=sender,to=to,text=text,at=self.clock()))
    def member(self,room,token):
        if not isinstance(token,str) or not token: raise GameError('개인 입장권이 필요합니다.',401)
        hashed=token_hash(token)
        for m in room['members']:
            if secrets.compare_digest(m['auth'],hashed):return m
        raise GameError('이 방의 개인 입장권이 아닙니다.',401)
    def mutate(self,code,token,action,body=None):
        body=body or {}
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT data FROM rooms WHERE code=?',(code,)).fetchone()
            if not row: raise GameError('방을 찾을 수 없습니다.',404)
            room=json.loads(row[0]); self.tick(room)
            if action=='join':
                if room['phase']!='lobby':raise GameError('이미 시작한 방입니다.',409)
                if len(room['members'])>=room['size']:raise GameError('정원이 찼습니다.',409)
                name=clean(body.get('name'),24,'이름');new_token=secrets.token_urlsafe(32)
                mid=secrets.token_hex(8);room['members'].append(self.new_member(mid,name,new_token,self.clock()))
                self.system(room,f'{name} 님이 입장했습니다.');room['version']+=1;self.save(db,room)
                db.commit();return dict(code=code,token=new_token,member_id=mid)
            m=self.member(room,token);m['last_seen']=self.clock()
            if action=='leave':
                if room['phase']!='lobby':raise GameError('게임 시작 후에는 자리를 비워도 역할이 유지됩니다.')
                room['members'].remove(m);room['votes']=[]
                self.system(room,f"{m['name']} 님이 대기실을 나갔습니다.")
            elif action=='role':
                if room['phase']!='lobby':raise GameError('시작 후에는 역할을 바꿀 수 없습니다.')
                rid=body.get('role')
                if rid not in ROLE_IDS:raise GameError('역할을 확인해주세요.')
                if room['size']==6 and rid not in REQUIRED:raise GameError('6인 방에서는 필수 역할을 선택해주세요.')
                if any(x['role']==rid and x['id']!=m['id'] for x in room['members']):raise GameError('이미 선택된 역할입니다.',409)
                # Guarantee there are enough unfilled slots for all mandatory roles.
                assigned=[rid if x['id']==m['id'] else x['role'] for x in room['members']]
                missing=len(REQUIRED-set(assigned));free=room['size']-len([v for v in assigned if v])
                if missing>free:raise GameError('남은 자리는 필수 역할을 위해 비워두어야 합니다.')
                m['role']=rid;m['ready']=False
            elif action=='ready':
                if room['phase']!='lobby' or not m['role']:raise GameError('먼저 역할을 선택해주세요.')
                m['ready']=not m['ready']
                if len(room['members'])==room['size'] and all(x['ready'] for x in room['members']) and REQUIRED<=set(x['role'] for x in room['members']):self.advance(room)
            elif action=='vote':
                if room['phase'] in ('lobby','final','ending'):raise GameError('지금은 단계 동의를 받지 않습니다.')
                if m['id'] in room['votes']:room['votes'].remove(m['id'])
                else:room['votes'].append(m['id'])
                if len(room['votes'])==len(room['members']):self.advance(room)
            elif action=='chat':
                if self.clock()-m['last_chat']<.6:raise GameError('메시지를 잠시 후 보내주세요.',429)
                text=clean(body.get('text'),1000,'메시지');to=body.get('to') or None
                if to and (to==m['id'] or not any(x['id']==to for x in room['members'])):raise GameError('귓속말 대상을 확인해주세요.')
                self.message(room,m['id'],to,text);m['last_chat']=self.clock()
            elif action=='investigate':
                if room['phase'] not in ('r1','r2','r3'):raise GameError('조사 단계에서만 열 수 있습니다.')
                cid=body.get('clue');clue=CLUES.get(cid)
                if not clue:raise GameError('단서를 찾을 수 없습니다.')
                if clue['owner']==m['role']:raise GameError('내 단서는 토큰 없이 볼 수 있습니다.')
                if cid in room['claims']:raise GameError('이미 조사한 단서입니다. 조사자에게 공개를 요청하세요.',409)
                if self.tokens(room,m)<=0:raise GameError('남은 조사 토큰이 없습니다.')
                room['claims'][cid]=dict(by=m['id'],shared=False);m['acquired'].append(cid)
            elif action=='share':
                if room['phase'] not in ('r1','r2','r3','final'):raise GameError('조사가 시작된 뒤 공개할 수 있습니다.')
                cid=body.get('clue');clue=CLUES.get(cid);claim=room['claims'].get(cid)
                if not clue or not (clue['owner']==m['role'] or claim and claim['by']==m['id']):raise GameError('공개 권한이 없습니다.',403)
                if not claim: room['claims'][cid]=claim=dict(by=m['id'],shared=False)
                if not claim['shared']:
                    claim['shared']=True;self.system(room,f"{m['name']} 님이 단서 ‘{clue['title']}’를 공개했습니다.")
            elif action=='submit':
                if room['phase']!='final':raise GameError('최종 추리 단계에서 제출할 수 있습니다.')
                if m['id'] in room['submissions']:raise GameError('이미 제출한 답안입니다.',409)
                answer=body.get('answers',{})
                if not isinstance(answer,dict):raise GameError('답안을 확인해주세요.')
                for q in S.QUESTIONS:
                    if answer.get(q['id']) not in [o['id'] for o in q['options']]:raise GameError('네 항목 모두 선택해주세요.')
                note=body.get('note','')
                if not isinstance(note,str) or len(note)>2000:raise GameError('추리 근거는 2000자 이내입니다.')
                room['submissions'][m['id']]=dict(answers={q['id']:answer[q['id']] for q in S.QUESTIONS},note=note.strip())
                if len(room['submissions'])==len(room['members']):self.advance(room)
            elif action!='state':raise GameError('지원하지 않는 동작입니다.',404)
            if action!='state':room['version']+=1
            self.save(db,room);db.commit()
            return dict(ok=True) if action=='leave' else self.project(room,m)
    def tick(self,room):
        # Advance one stage at a time after downtime, giving the resumed group a fresh stage.
        if room['deadline'] and self.clock()>=room['deadline'] and room['phase']!='ending':self.advance(room)
    def advance(self,room):
        idx=PHASE_IDS.index(room['phase'])+1
        if idx>=len(PHASE_IDS):return
        phase,label,minutes=S.PHASES[idx];room['phase']=phase;room['votes']=[];room['version']+=1
        room['deadline']=self.clock()+minutes*60*(.5 if room['pace']=='quick' else 1) if minutes else None
        self.system(room,f'{label} 단계가 시작되었습니다.')
        if phase=='ending':room['result']=self.result(room)
    def tokens(self,room,m):
        total={'r1':1,'r2':2,'r3':3,'final':3,'ending':3}.get(room['phase'],0)
        return max(0,total-len(m['acquired']))
    def names(self,room):
        return {r['id']:next((m['name']+' ('+r['title']+')' for m in room['members'] if m['role']==r['id']),r['title']+' [참고인]') for r in S.ROLES}
    def render(self,value,names):
        if isinstance(value,str):
            for key,name in names.items():value=value.replace('{'+key+'}',name)
            return value
        if isinstance(value,list):return [self.render(v,names) for v in value]
        if isinstance(value,dict):return {k:self.render(v,names) for k,v in value.items()}
        return value
    def result(self,room):
        votes={};scores=[]
        for m in room['members']:
            sub=room['submissions'].get(m['id']);a=sub['answers'] if sub else {}
            if a.get('culprit'):votes[a['culprit']]=votes.get(a['culprit'],0)+1
            marks={k:a.get(k)==v for k,v in S.ANSWERS.items()}
            scores.append(dict(member=m['id'],role=m['role'],score=sum(marks.values()),marks=marks,submitted=bool(sub),answers=a,note=sub['note'] if sub else '미제출'))
        high=max(votes.values(),default=0);leaders=[r for r,n in votes.items() if n==high]
        justice=leaders==['planner'];avg=sum(s['score'] for s in scores)/len(scores)
        past=sum(s['marks']['past'] for s in scores)>len(scores)/2
        grade='unresolved' if len(leaders)!=1 else 'bad' if not justice else 'perfect' if avg>=3.5 and past else 'true' if avg>=2.5 else 'normal'
        stories={
            'perfect':('완벽한 해결','도명석을 죽인 사람과 오래된 누명의 구조가 모두 드러났다. 서정후의 이름이 공식 기록에서 바로잡혔다.'),
            'true':('진실에 닿은 밤','범인은 밝혀졌고 사건의 주요 연결고리도 드러났다. 남은 기록은 추가 조사를 기다린다.'),
            'normal':('범인은 잡았지만','범인은 지목했지만 사건의 방식과 동기에 대한 설명은 충분하지 않았다.'),
            'bad':('빗나간 판결','다수의 지목은 진범을 향하지 않았다. 이제 공개된 진상을 통해 놓친 단서를 다시 살펴본다.'),
            'unresolved':('판결 보류','최다 득표가 동률이거나 유효한 표가 없어 집단 판결을 확정하지 않았다. 사건의 진상은 모두에게 공개된다.')}
        heading,text=stories[grade]
        fate={
            'operator':('실적 조작을 인정하고 수사에 협조했다. 자신의 타격이 사인은 아니었지만 책임은 남았다.','자신의 행동을 숨기려다 정작 죽음의 경로를 놓쳤다.'),
            'auditor':('감사 조직의 조사자로 돌아갔다. 진실을 밝혔지만 자신이 휘두른 손은 오래 기억했다.','정의를 찾으러 들어간 방에서 자기 행동을 숨겼다는 사실이 남았다.'),
            'reviewer':('무독성 시약에 대한 오해를 풀었다. 평범한 검토 과정이 사건의 실마리가 됐다.','자신이 전달한 종이를 다시 떠올리며 놓친 연결을 되짚었다.'),
            'witness':('마지막 생존 목격을 설명하며 보온병에 대한 의심을 풀었다.','매일 보던 손버릇이 왜 중요했는지 진상을 듣고서야 알았다.'),
            'friend':('친구의 마지막 문자를 지우지 않았던 이유를 설명할 수 있게 됐다.','이번에도 진실에 충분히 다가가지 못했다는 아쉬움이 남았다.'),
            'hr':('누락시켰던 기록을 내놓고 과거의 인사 처리에 책임을 지기로 했다.','서둘러 닫았던 징계 기록을 다시 열어봐야 한다는 숙제가 남았다.'),
            'finance':('자신의 채무와 사건을 구분하고 목격한 사실을 설명했다.','복도에서 보았던 조각들이 한 사건으로 이어지는 순간을 놓쳤다.')}
        for s in scores:
            if s['role']=='planner':s['epilogue']='집단 판결은 범행을 정확히 지목했다. 가족을 지킨다는 명분으로 저지른 선택의 책임이 남았다.' if justice else '집단 판결은 범행을 지목하지 못했다. 그러나 공개된 진상에는 자신이 준비한 보고서가 남아 있었다.'
            else:s['epilogue']=fate[s['role']][0 if s['marks']['culprit'] else 1]
        return dict(grade=grade,title=heading,text=text,votes=votes,leaders=leaders,average=round(avg,2),past_solved=past,scores=scores,truth=S.TRUTH)
    def project(self,room,m):
        names=self.names(room);idx=PHASE_IDS.index(room['phase']);ending=room['phase']=='ending'
        members=[dict(id=x['id'],name=x['name'],role=x['role'],ready=x['ready'],online=self.clock()-x['last_seen']<25,submitted=x['id'] in room['submissions']) for x in room['members']]
        roles=[{k:r[k] for k in ('id','title','required','icon','faction','teaser','public')} for r in S.ROLES]
        clues=[]
        for c in S.CLUES:
            claim=room['claims'].get(c['id']);owned=c['owner']==m['role'];readable=idx>=1 and (ending or owned or bool(claim and (claim['by']==m['id'] or claim['shared'])))
            row=dict(id=c['id'],owner=c['owner'],owner_name=names[c['owner']],readable=readable,own=owned,claimed_by=claim['by'] if claim else None,shared=bool(claim and claim['shared']))
            if readable:row.update(title=c['title'],text=c['text'])
            clues.append(row)
        messages=[v for v in room['messages'] if not v['to'] or v['to']==m['id'] or v['sender']==m['id']][-300:]
        out=dict(code=room['code'],size=room['size'],pace=room['pace'],version=room['version'],phase=room['phase'],deadline=room['deadline'],server_now=self.clock(),
                 phases=[dict(id=p[0],title=p[1]) for p in S.PHASES],members=members,roles=roles,votes=room['votes'],
                 me=dict(id=m['id'],name=m['name'],role=m['role'],ready=m['ready'],tokens=self.tokens(room,m),submission=room['submissions'].get(m['id'])),
                 clues=clues,messages=messages,evidence=[e for e in S.EVIDENCE if idx>=PHASE_IDS.index(e['phase'])],
                 book=next((r for r in S.ROLES if r['id']==m['role']),None) if idx>=1 else None,
                 questions=S.QUESTIONS if idx>=PHASE_IDS.index('final') else [],result=room['result'] if ending else None,
                 archive=S.ROLES if ending else [],rules=S.RULES)
        return self.render(copy.deepcopy(out),names)
    def tick_all(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for code,data in db.execute('SELECT code,data FROM rooms').fetchall():
                room=json.loads(data)
                if self.clock()-room['created']>7*86400:db.execute('DELETE FROM rooms WHERE code=?',(code,));continue
                old=room['version'];self.tick(room)
                if room['version']!=old:self.save(db,room)
            db.commit()
