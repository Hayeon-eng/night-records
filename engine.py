"""Transactional game engine. State, clocks, visibility and results live here."""
import copy
import hashlib
import json
import re
import secrets
import time
from pathlib import Path
import scenario as S
from scenario_registry import get_scenario, DEFAULT_SCENARIO_ID
from store import SqliteStore

class GameError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message); self.status=status

# Scenario-specific identifiers are resolved from each room, never process-global.
# Backward-compatible exports for existing tests/tools; runtime rooms resolve their own scenario.
PHASE_IDS=[p[0] for p in S.PHASES]
ROLE_IDS={r['id'] for r in S.ROLES}
REQUIRED={r['id'] for r in S.ROLES if r['required']}
CLUES={c['id']:c for c in S.CLUES}

# 이름 토큰: {planner}, {planner:n}(이름), {planner:t}(직함), {planner:p}(플레이어 실제 이름). 뒤따르는 조사는 받침에 맞게 자동 교정한다.
TOKEN=re.compile(r'(\{[A-Za-z_]+(?::[a-z])?\})(?:(이다|으로|이|가|은|는|을|를|와|과|로|다)(?![가-힣]))?')
def josa(name,part):
    last=name[-1:] if name else '';code=ord(last)-0xAC00 if last else -1;batchim=0<=code<11172 and code%28!=0
    if part in ('이','가'):return '이' if batchim else '가'
    if part in ('은','는'):return '은' if batchim else '는'
    if part in ('을','를'):return '을' if batchim else '를'
    if part in ('와','과'):return '과' if batchim else '와'
    if part in ('으로','로'):return '으로' if batchim and code%28!=8 else '로'
    if part in ('이다','다'):return '이다' if batchim else '다'
    return part
def fill(text,names):
    def sub(m):
        key=m.group(1)[1:-1]
        if key not in names:return m.group(0)
        name=names[key];part=m.group(2)
        return name+(josa(name,part) if part else '')
    return TOKEN.sub(sub,text)

def token_hash(token): return hashlib.sha256(token.encode()).hexdigest()
def clean(value, limit, label):
    if not isinstance(value,str): raise GameError(f'{label}을 확인해주세요.')
    value=value.strip()
    if not value or len(value)>limit or any(ord(c)<32 and c not in '\n\t' for c in value):
        raise GameError(f'{label}은 1~{limit}자로 입력해주세요.')
    return value

class Engine:
    def __init__(self, store='data/game.sqlite3', clock=time.time):
        # store: 경로(문자열/Path)면 SQLite, load/save 를 가진 객체면 그대로 사용 (store.py)
        self.clock=clock;self.store=store if hasattr(store,'load') else SqliteStore(store);self.path=getattr(self.store,'path',None)
    def create(self,name,size,pace,scenario_id=None):
        name=clean(name,24,'이름')
        scenario = get_scenario(scenario_id)
        if scenario is None: raise GameError('선택한 에피소드를 찾을 수 없습니다.',404)
        if type(size) is not int or size not in getattr(scenario,'SIZES',(2,6,7,8)): raise GameError(getattr(scenario,'SIZE_ERROR','정원은 2명 테스트 또는 6~8명입니다.'))
        if pace not in ('normal','quick'): raise GameError('진행 속도를 선택해주세요.')
        token=secrets.token_urlsafe(32); mid=secrets.token_hex(8); now=self.clock()
        for _ in range(20):
            # 사람이 읽을 수 있는 초대 코드이며 참가자 인증 정보가 아니다.
            code=''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
            room=dict(code=code,size=size,pace=pace,scenario=scenario.ID,phase='lobby',deadline=None,version=1,
                      created=now,members=[self.new_member(mid,name,token,now)],votes=[],claims={},shares={},events=[],ev_seq=0,messages=[],submissions={},result=None)
            self.system(room,'사건실이 열렸습니다. 초대 코드를 친구에게 전달해주세요.')
            if self.store.save(code,room,None):return dict(code=code,token=token,member_id=mid)
        raise GameError('방을 만들지 못했습니다. 다시 시도해주세요.',503)
    @staticmethod
    def new_member(mid,name,token,now):
        return dict(id=mid,name=name,auth=token_hash(token),role=None,ready=False,joined=now,last_seen=now,acquired=[],last_chat=0)
    def system(self,room,text): self.message(room,None,None,text)
    def event(self,room,clue,by,to):
        # 단서 공개 알림 기록. 채팅이 아니라 별도 알림으로 전달된다. to=None 이면 전체 공개.
        room['ev_seq']=room.get('ev_seq',0)+1
        room['events'].append(dict(id=room['ev_seq'],clue=clue,by=by,to=to,at=self.clock(),phase=room['phase']))
        del room['events'][:-80]
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
        for _ in range(12):  # 동시에 같은 방을 고치면 한쪽이 다시 읽고 재시도한다.
            loaded=self.store.load(code)
            if not loaded:raise GameError('방을 찾을 수 없습니다.',404)
            room,rev=loaded;room.setdefault('scenario',DEFAULT_SCENARIO_ID);room.setdefault('events',[]);room.setdefault('shares',{});room.setdefault('ev_seq',0)
            result,dirty=self._apply(room,code,token,action,body)
            if not dirty or self.store.save(code,room,rev):return result
        raise GameError('요청이 한꺼번에 몰렸습니다. 잠시 후 다시 시도해주세요.',409)
    def _apply(self,room,code,token,action,body):
        v0=room['version'];self.tick(room);moved=room['version']!=v0
        S=self.scenario(room); PHASE_IDS=[p[0] for p in S.PHASES]; ROLE_IDS={r['id'] for r in S.ROLES}; REQUIRED={r['id'] for r in S.ROLES if r['required']}; CLUES={c['id']:c for c in S.CLUES}
        REQUIRED = set(getattr(S, 'REQUIRED_BY_SIZE', {}).get(room['size'], REQUIRED))
        strict = room['size']>=6 or room['size'] in getattr(S, 'REQUIRED_BY_SIZE', {})
        reveal = getattr(S,'TOKEN_MODE','investigate')=='reveal'
        if action=='join':
            if room['phase']!='lobby':raise GameError('이미 시작한 방입니다.',409)
            if len(room['members'])>=room['size']:raise GameError('정원이 찼습니다.',409)
            name=clean(body.get('name'),24,'이름');new_token=secrets.token_urlsafe(32)
            mid=secrets.token_hex(8);room['members'].append(self.new_member(mid,name,new_token,self.clock()))
            self.system(room,f'{name} 님이 입장했습니다.');room['version']+=1
            return dict(code=code,token=new_token,member_id=mid),True
        m=self.member(room,token);stale=self.clock()-m['last_seen']>=8;m['last_seen']=self.clock()
        if action=='leave':
            if room['phase']!='lobby':raise GameError('게임 시작 후에는 자리를 비워도 역할이 유지됩니다.')
            room['members'].remove(m);room['votes']=[]
            self.system(room,f"{m['name']} 님이 대기실을 나갔습니다.")
        elif action=='role':
            if room['phase']!='lobby':raise GameError('시작 후에는 역할을 바꿀 수 없습니다.')
            rid=body.get('role')
            if rid not in ROLE_IDS:raise GameError('역할을 확인해주세요.')
            if room['size'] in getattr(S, 'REQUIRED_BY_SIZE', {}) and rid not in REQUIRED:
                raise GameError('이 테스트/인원 구성에서 선택할 수 없는 역할입니다.')
            if any(x['role']==rid and x['id']!=m['id'] for x in room['members']):raise GameError('이미 선택된 역할입니다.',409)
            # Guarantee there are enough unfilled slots for all mandatory roles.
            assigned=[rid if x['id']==m['id'] else x['role'] for x in room['members']]
            missing=len(REQUIRED-set(assigned)) if strict else 0;free=room['size']-len([v for v in assigned if v])
            if missing>free:raise GameError('남은 자리는 필수 역할을 위해 비워두어야 합니다.')
            m['role']=rid;m['ready']=False
        elif action=='ready':
            if room['phase']!='lobby' or not m['role']:raise GameError('먼저 역할을 선택해주세요.')
            m['ready']=not m['ready']
            if len(room['members'])==room['size'] and all(x['ready'] for x in room['members']) and (not strict or REQUIRED<=set(x['role'] for x in room['members'])):self.advance(room)
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
            if reveal:raise GameError('이 에피소드에서는 다른 사람의 봉인 기록을 열 수 없습니다. 기록의 주인이 공개해야 볼 수 있어요.',409)
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
            if claim and claim['shared']:raise GameError('이미 모두에게 공개한 단서입니다.',409)
            others=[x['id'] for x in room['members'] if x['id']!=m['id']];to=body.get('to','all')
            if to!='all':
                if not isinstance(to,list) or not to or any(not isinstance(v,str) for v in to):raise GameError('공개할 사람을 선택해주세요.')
                if any(v not in others for v in to):raise GameError('공개 대상을 확인해주세요.')
                to=list(dict.fromkeys(to))
                if others and set(to)>=set(others):to='all'
            if to=='all':
                if reveal and clue['owner']==m['role'] and self.tokens(room,m)<=0:raise GameError('정보공개 토큰이 없습니다. 토큰 없이도 말로 설명하거나, 일부에게만 보여줄 수 있어요.')
                if not claim:room['claims'][cid]=claim=dict(by=m['id'],shared=False)
                claim['shared']=True;claim['shared_by']=m['id'];self.event(room,cid,m['id'],None)
            else:
                grants=room['shares'].setdefault(cid,dict(grants={}))['grants'];new=[v for v in to if v not in grants]
                if not new:raise GameError('선택한 사람에게는 이미 공개했습니다.',409)
                for v in new:grants[v]=m['id']
                self.event(room,cid,m['id'],new)
        elif action=='submit':
            if room['phase']!='final':raise GameError('최종 추리 단계에서 제출할 수 있습니다.')
            if m['id'] in room['submissions']:raise GameError('이미 제출한 답안입니다.',409)
            answer=body.get('answers',{})
            if not isinstance(answer,dict):raise GameError('답안을 확인해주세요.')
            for q in self.scenario(room).QUESTIONS:
                if answer.get(q['id']) not in [o['id'] for o in q['options']]:raise GameError('모든 항목을 선택해주세요.')
            note=body.get('note','')
            if not isinstance(note,str) or len(note)>2000:raise GameError('추리 근거는 2000자 이내입니다.')
            room['submissions'][m['id']]=dict(answers={q['id']:answer[q['id']] for q in self.scenario(room).QUESTIONS},note=note.strip())
            if len(room['submissions'])==len(room['members']):self.advance(room)
        elif action!='state':raise GameError('지원하지 않는 동작입니다.',404)
        if action!='state':room['version']+=1
        out=dict(ok=True) if action=='leave' else self.project(room,m)
        # 상태 조회는 시간이 흐르거나 접속 표시가 오래됐을 때만 저장한다(저장소 요청 수 절감).
        return out,(action!='state' or moved or stale)
    @staticmethod
    def scenario(room):
        scenario = get_scenario(room.get('scenario'))
        if scenario is None: raise GameError('이 방의 에피소드 버전을 찾을 수 없습니다.',500)
        return scenario
    def tick(self,room):
        # Advance one stage at a time after downtime, giving the resumed group a fresh stage.
        if room['deadline'] and self.clock()>=room['deadline'] and room['phase']!='ending':self.advance(room)
    def advance(self,room):
        S=self.scenario(room); PHASE_IDS=[p[0] for p in S.PHASES]
        idx=PHASE_IDS.index(room['phase'])+1
        if idx>=len(PHASE_IDS):return
        phase,label,minutes=S.PHASES[idx];room['phase']=phase;room['votes']=[];room['version']+=1
        room['deadline']=self.clock()+minutes*60*(.5 if room['pace']=='quick' else 1) if minutes else None
        self.system(room,f'{label} 단계가 시작되었습니다.')
        if phase=='ending':room['result']=self.result(room)
    def token_total(self,room):
        table=getattr(self.scenario(room),'TOKEN_TOTALS',None) or {'r1':1,'r2':2,'r3':3,'final':3,'ending':3}
        return table.get(room['phase'],0)
    def tokens(self,room,m):
        S=self.scenario(room)
        if getattr(S,'TOKEN_MODE','investigate')=='reveal':
            # 내 봉인 기록을 모두에게 공개한 횟수만큼 사용한 것으로 센다.
            owner={c['id']:c['owner'] for c in S.CLUES}
            used=sum(1 for cid,cl in room['claims'].items() if cl.get('shared_by')==m['id'] and owner.get(cid)==m['role'])
        else:used=len(m['acquired'])
        return max(0,self.token_total(room)-used)
    def names(self,room):
        S=self.scenario(room); out={}
        for r in S.ROLES:
            mem=next((m for m in room['members'] if m['role']==r['id']),None)
            out[r['id']]=out[r['id']+':n']=r['name'];out[r['id']+':t']=r['title'];out[r['id']+':p']=mem['name'] if mem else ''
        return out
    def render(self,value,names):
        if isinstance(value,str):return fill(value,names)
        if isinstance(value,list):return [self.render(v,names) for v in value]
        if isinstance(value,dict):return {k:self.render(v,names) for k,v in value.items()}
        return value
    def result(self,room):
        S=self.scenario(room); votes={};scores=[]
        for m in room['members']:
            sub=room['submissions'].get(m['id']);a=sub['answers'] if sub else {}
            if a.get('culprit'):votes[a['culprit']]=votes.get(a['culprit'],0)+1
            marks={k:a.get(k)==v for k,v in S.ANSWERS.items()}
            pts=getattr(S,'POINTS',None);score=sum(pts[k] for k,ok in marks.items() if ok) if pts else sum(marks.values())
            scores.append(dict(member=m['id'],role=m['role'],score=score,marks=marks,submitted=bool(sub),answers=a,note=sub['note'] if sub else '미제출'))
        high=max(votes.values(),default=0);leaders=[r for r,n in votes.items() if n==high]
        culprit_role=getattr(S, 'CULPRIT_ROLE', 'planner');justice=leaders==[culprit_role];avg=sum(s['score'] for s in scores)/len(scores)
        rates={k:sum(s['marks'][k] for s in scores)/len(scores) for k in S.ANSWERS}
        past=rates.get('past',0)>.5
        if hasattr(S,'grade'):grade=S.grade(leaders=leaders,justice=justice,rates=rates,avg=avg)
        else:grade='unresolved' if len(leaders)!=1 else 'bad' if not justice else 'perfect' if avg>=3.5 and past else 'true' if avg>=2.5 else 'normal'
        E=S.ENDING[grade];accused=leaders[0] if len(leaders)==1 else None;nm=self.names(room)
        if accused:nm['accused']=nm['accused:n']=nm[accused];nm['accused:t']=nm[accused+':t'];nm['accused:p']=nm[accused+':p']
        f=lambda v:fill(v,nm) if isinstance(v,str) else [fill(x,nm) for x in v]
        culprit,right,wrong=[],[],[]
        for s in scores:
            if s['role']==culprit_role:s['epilogue']=S.PLANNER_FATE[0 if justice else 1];culprit.append(s['member'])
            elif s['role'] in S.FATE:
                s['epilogue']=S.FATE[s['role']][0 if s['marks']['culprit'] else 1];(right if s['marks']['culprit'] else wrong).append(s['member'])
            else:s['epilogue']=''
            s['epilogue']=fill(s['epilogue'],nm)
        good=grade in ('perfect','true');absent=[]
        for r in S.ROLES:
            if any(m['role']==r['id'] for m in room['members']):continue
            lines=[S.ABSENT.get(r['id'],S.ABSENT_DEFAULT)[0 if good else 1]];who=[]
            for cid,claim in room['claims'].items():
                if CLUES[cid]['owner']!=r['id']:continue
                mm=next((x for x in room['members'] if x['id']==claim['by']),None)
                if mm and mm['role'] and nm[mm['role']] not in who:who.append(nm[mm['role']])
            if who:lines.append(S.ABSENT_INVESTIGATED[0 if good else 1])
            local=dict(nm,n=r['name'],who=', '.join(who));absent.append(dict(role=r['id'],lines=[fill(x,local) for x in lines]))
        groups=[g for g in (dict(kind='culprit',members=culprit,link=''),dict(kind='right',members=right,link=f(E['good_link'])),dict(kind='wrong',members=wrong,link=f(E['bad_link']))) if g['members']]
        ending=dict(intro=f(E['intro']),arrest=f(E['arrest']),timeline=[[a,fill(b,nm)] for a,b in S.NIGHT_TIMELINE],truth=f(S.TRUTH),groups=groups,absent=absent,aftermath=f(E['aftermath']),closing=f(E['closing']))
        return dict(grade=grade,title=E['title'],stamp=E['stamp'],text=ending['intro'][0],votes=votes,leaders=leaders,accused=accused,average=round(avg,2),max_score=sum(S.POINTS.values()) if getattr(S,'POINTS',None) else len(S.ANSWERS),past_solved=past,scores=scores,truth=S.TRUTH,ending=ending)
    def project(self,room,m):
        S=self.scenario(room); PHASE_IDS=[p[0] for p in S.PHASES]; CLUES={c['id']:c for c in S.CLUES}
        names=self.names(room);idx=PHASE_IDS.index(room['phase']);ending=room['phase']=='ending'
        members=[dict(id=x['id'],name=x['name'],role=x['role'],ready=x['ready'],online=self.clock()-x['last_seen']<25,submitted=x['id'] in room['submissions']) for x in room['members']]
        required_for_size=set(getattr(S, 'REQUIRED_BY_SIZE', {}).get(room['size'], {r['id'] for r in S.ROLES if r['required']}))
        fixed=room['size'] in getattr(S,'REQUIRED_BY_SIZE',{})
        roles=[{**{k:r[k] for k in ('id','name','title','icon','faction','teaser','public')},'required':r['id'] in required_for_size,'selectable':(r['id'] in required_for_size) if fixed else True} for r in S.ROLES]
        played={x['role'] for x in room['members'] if x['role']}
        clues=[];shares=room.get('shares',{})
        for c in S.CLUES:
            claim=room['claims'].get(c['id']);grants=shares.get(c['id'],{}).get('grants',{})
            owned=c['owner']==m['role'];pub=bool(claim and claim['shared']);mine=bool(claim and claim['by']==m['id']);granted=m['id'] in grants
            readable=idx>=1 and (ending or owned or mine or pub or granted)
            via='own' if owned else 'investigated' if mine else 'public' if pub else 'granted' if granted else 'ending' if ending else None
            row=dict(id=c['id'],owner=c['owner'],owner_name=names[c['owner']],owner_title=names[c['owner']+':t'],owner_real=names[c['owner']+':p'],readable=readable,own=owned,via=via,
                     claimed_by=claim['by'] if claim else None,shared=pub,shared_by=claim.get('shared_by') if pub else None,granted_by=grants.get(m['id']),
                     granted_to=[r for r,b in grants.items() if b==m['id']])
            if readable:row.update(title=c['title'],text=c['text'])
            clues.append(row)
        events=[]
        for ev in room.get('events',[]):
            to=ev['to'];mine_ev=ev['by']==m['id'];to_me=bool(to) and m['id'] in to;known=to is None or mine_ev or to_me
            events.append(dict(id=ev['id'],by=ev['by'],to=to,all=to is None,mine=mine_ev,to_me=to_me,at=ev['at'],clue=ev['clue'] if known else None,title=CLUES[ev['clue']]['title'] if known else None))
        messages=[v for v in room['messages'] if not v['to'] or v['to']==m['id'] or v['sender']==m['id']][-300:]
        out=dict(code=room['code'],size=room['size'],pace=room['pace'],scenario=room.get('scenario'),scenario_meta=dict(id=S.ID,title=S.TITLE,summary=S.SUMMARY,intro=S.INTRO,rules=S.RULES,theme=getattr(S,'THEME','noir'),stamp=getattr(S,'STAMP',''),strip=getattr(S,'STRIP','CASE FILE'),tutorial=S.TUTORIAL,guide=S.PHASE_GUIDE,
                                 token_mode=getattr(S,'TOKEN_MODE','investigate'),tab_help=getattr(S,'TAB_HELP',{}),scoring_note=getattr(S,'SCORING_NOTE','')),version=room['version'],phase=room['phase'],deadline=room['deadline'],server_now=self.clock(),
                 phases=[dict(id=p[0],title=p[1]) for p in S.PHASES],members=members,roles=roles,votes=room['votes'],
                 me=dict(id=m['id'],name=m['name'],role=m['role'],ready=m['ready'],tokens=self.tokens(room,m),tokens_total=self.token_total(room),submission=room['submissions'].get(m['id'])),
                 clues=clues,events=events,messages=messages,evidence=[e for e in S.EVIDENCE if idx>=PHASE_IDS.index(e['phase']) and (e.get('npc') is None or e['npc'] not in played)],
                 book=({k:v for k,v in next((r for r in S.ROLES if r['id']==m['role']),{}).items() if ending or k!='final'} or None) if idx>=1 else None,
                 questions=S.QUESTIONS if idx>=PHASE_IDS.index('final') else [],result=room['result'] if ending else None,
                 archive=S.ROLES if ending else [],rules=S.RULES)
        return self.render(copy.deepcopy(out),names)
    def tick_all(self):
        # 로컬 서버 전용 주기 작업(만료 방 삭제, 시간 진행). Vercel 에서는 요청이 올 때마다 tick() 으로 계산한다.
        for code in self.store.codes():
            loaded=self.store.load(code)
            if not loaded:continue
            room,rev=loaded
            if self.clock()-room['created']>7*86400:self.store.delete(code);continue
            old=room['version'];self.tick(room)
            if room['version']!=old:self.store.save(code,room,rev)
