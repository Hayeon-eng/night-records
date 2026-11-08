'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const memory={};
const saved={get(k,d=null){try{return JSON.parse(localStorage.getItem(k))??d;}catch{return memory[k]??d;}},set(k,v){memory[k]=v;try{localStorage.setItem(k,JSON.stringify(v));}catch{}}};
let catalog,session=saved.get('nr-session'),state=null,tab='story',archiveId='',invTarget='',pollTimer,busy=false,lastSig='',chatSig='',connected=true,clockOffset=0,chatTarget='',chatOpen=false,seenMsgs=0,justSpent=false;
let drafts=saved.get('nr-drafts',{});const formDrafts={};
const flipped=new Set(),accOpen=new Set(['사건 소개']),justOpened=new Set(),missing=new Set();
const THEME_COLOR={noir:'#0E1A31',school:'#10281F',romance:'#2A0F1C',medieval:'#1B1710'};
const DESC={intro:'캐릭터북이 공개됐습니다<br>자신의 이야기부터 읽어보세요',r1:'현장 조사 시작 · 공용 증거 공개<br>조사 토큰 +1',r2:'엇갈린 증언 · 새 증거 공개<br>조사 토큰 +1',r3:'마지막 증거 공개<br>조사 토큰 +1',final:'최종 추리를 작성해 제출하세요',ending:'사건의 진상이 열렸습니다'};
const MODES={story:'me',time:'me',secret:'me',memo:'me',deduce:'me',clues:'inv',evidence:'shared',ending:'ending',archive:'ending'};
const MODEBAR={me:['🔒','내 화면 · 본인 외에는 보여주지 마세요'],inv:['🕵','조사 화면 · 다른 인물의 단서를 조사합니다'],shared:['📂','공용 증거 · 모두에게 공개된 자료'],ending:['📖','엔딩 · 모든 기록이 공개되었습니다']};
function draftKey(){return session?`${session.code}:${session.member_id}`:'';}
function toast(text){const el=$('#toast');el.textContent=text;el.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.style.display='none',4500);}
async function api(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?.token?{Authorization:'Bearer '+session.token}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'요청을 처리하지 못했습니다.');return data;}
function confirmInPage(title,text){return new Promise(resolve=>{const dialog=$('#confirm');$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;dialog.returnValue='cancel';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'),{once:true});dialog.showModal();});}
function rememberForm(){document.querySelectorAll('#app input[id],#app textarea[id],#app select[id]').forEach(e=>{formDrafts[e.id]=e.value;});}
function applyTheme(){const t=new URLSearchParams(location.search).get('theme')||catalog?.theme||'noir';document.body.dataset.theme=THEME_COLOR[t]?t:'noir';$('meta[name=theme-color]').content=THEME_COLOR[t]||THEME_COLOR.noir;}
/* ---------- shared pieces ---------- */
function slot(kind,id,cls=''){const url=`/img/${kind}/${id}`;return `<div class="slot ${cls}">${missing.has(url)?'':`<img data-slot src="${url}" alt="">`}</div>`;}
const facs=()=>[...new Set((state?.roles||catalog.roles).map(r=>r.faction))];
const fCls=f=>['h','m','n'][Math.min(facs().indexOf(f),2)]||'n';
const fBadge=f=>`<span class="badge ${{h:'b-han',m:'b-mou',n:'b-non'}[fCls(f)]}">${esc(f)}</span>`;
const acc=(t,body)=>`<div class="acc ${accOpen.has(t)?'open':''}"><button data-action="acc" data-id="${esc(t)}">${esc(t)}<span class="chev">›</span></button><div class="body">${body}</div></div>`;
const list=a=>`<ul class="plain">${a.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
function topbar(title,kicker,right='',back=false){return `<header class="top"><div class="wrap">${back?'<button class="back" data-action="home" aria-label="시작 화면">‹</button>':''}<div class="ttl">${esc(title)}<small>${kicker}</small></div>${right}</div></header>`;}
function titleblk(kicker){return `<div class="titleblk">${catalog.stamp?`<div class="stamp">${esc(catalog.stamp)}</div>`:''}<div class="kicker">${kicker}</div><h1>${esc(catalog.title)}</h1><p class="tag">${esc(catalog.summary)}</p></div>`;}
function showOverlay(prev,next){const nm=id=>state.phases.find(p=>p.id===id)?.title||id;$('#overlay').innerHTML=`<div class="rov"><div class="rov-in">${prev&&prev!=='lobby'?`<div class="rov-end">${esc(nm(prev))} 종료</div>`:''}<div class="rov-stamp">${esc(nm(next))}</div><div class="rov-sub">${next==='ending'?'':'시작'}</div><div class="rov-desc">${DESC[next]||''}</div><button class="btn" data-action="rov-close">확인</button></div></div>`;if(navigator.vibrate)try{navigator.vibrate([80,40,80]);}catch{}}
/* ---------- landing ---------- */
function landing(){clearTimeout(pollTimer);state=null;lastSig='';chatSig='';chatOpen=false;$('#chat').classList.remove('open');document.body.dataset.mode='home';applyTheme();const invite=new URLSearchParams(location.search).get('room')||'';
$('#app').innerHTML=`${topbar('밤의 기록','NIGHT RECORDS')}<main class="wrap">${titleblk('CASE FILE · 6–8명 · 진행자 없음')}
${session?`<div class="stagebar"><div><b>진행하던 사건실이 있어요</b><small>${esc(session.code)} · 이 기기에 입장권이 보관되어 있습니다.</small></div><button class="btn sm" data-action="resume">이어하기</button></div>`:''}
<section class="paper"><h2>새로운 사건</h2><form id="create-form"><label for="create-name">내 이름 또는 닉네임</label><input id="create-name" name="name" maxlength="24" required placeholder="게임에서 부를 이름"><div class="two"><div><label for="size">함께할 인원</label><select id="size" name="size"><option value="2">2명 (테스트)</option><option value="6">6명</option><option value="7">7명</option><option value="8">8명</option></select></div><div><label for="pace">진행 속도</label><select id="pace" name="pace"><option value="normal">여유롭게 · 약 50분</option><option value="quick">빠르게 · 약 25분</option></select></div></div><button class="btn" type="submit">사건실 만들기 →</button></form></section>
<section class="paper"><h2>초대받은 사건</h2><form id="join-form"><label for="join-code">8자리 초대 코드</label><input id="join-code" name="code" maxlength="8" minlength="8" required value="${esc(invite)}" placeholder="예: AB23CD45" autocomplete="off"><label for="join-name">내 이름 또는 닉네임</label><input id="join-name" name="name" maxlength="24" required placeholder="친구들이 알아볼 이름"><button class="btn" type="submit">초대 코드로 입장 →</button></form><details><summary>다른 기기에서 돌아오셨나요? 개인 입장권으로 복구</summary><form id="recover-form"><label for="recovery-code">초대 코드</label><input id="recovery-code" name="code" required maxlength="8"><label for="recovery-token">저장해둔 개인 입장권</label><input id="recovery-token" name="token" required autocomplete="off"><button class="btn ghost" type="submit">내 자리로 돌아가기</button></form></details></section>
<div class="section-h"><span>안내</span></div>${acc('게임 규칙',list(catalog.rules))}${acc('데이터 안내','<p>이름과 대화는 같은 방의 참가자에게만 제공됩니다. 귓속말은 송수신자에게만 표시되며 서버에 저장됩니다. 방과 기록은 생성 7일 후 삭제됩니다. 실명 대신 닉네임을 사용해도 됩니다. 음성·영상 통화는 지원하지 않습니다.</p>')}
<div class="foot">${esc(catalog.title)} · PLAYABLE BETA</div></main>`;}
async function enter(s){session=s;saved.set('nr-session',s);state=null;tab='story';lastSig='';chatSig='';seenMsgs=0;await poll();}
/* ---------- lobby ---------- */
function roleCard(r){const member=state.members.find(m=>m.role===r.id),mine=member?.id===state.me.id,off=member&&!mine||state.size===6&&!r.required;
return `<div class="flip ${flipped.has(r.id)?'flipped':''} ${mine?'isme':''}" id="card-${r.id}"><button class="face front idb" data-action="flip" data-id="${r.id}" aria-label="${esc(r.title)} 소개 열기"><div class="strip ${fCls(r.faction)}"><span>${esc(catalog.strip||'CASE FILE')}</span><span>${esc(r.faction)}</span></div><div class="hole"></div><div class="body">${slot('photos',r.id)}<div><div class="nm">${esc(r.title)}</div><div class="gp">${r.required?'필수 역할':'추가 역할'}${member?'<br>'+esc(member.name):''}</div></div></div><div class="bar"></div>${mine?'<span class="lk ok">내 캐릭터</span>':member?'<span class="lk">선택됨</span>':''}<span class="tapme">탭 → 소개</span></button><div class="face back"><div class="bh"><span>${esc(r.title)} · 소개</span><button class="x" data-action="flip" data-id="${r.id}" aria-label="닫기">×</button></div><div class="bb"><p>${esc(r.teaser)}</p><p class="hint">${esc(r.public)}</p><button class="btn ${mine?'ghost':''}" data-action="role" data-id="${r.id}" ${off?'disabled':''}>${mine?'내가 선택한 역할':member?esc(member.name)+' 님이 선택':'이 역할 선택'}</button></div></div></div>`;}
function lobby(){const miss=state.size<6?[]:state.roles.filter(r=>r.required&&!state.members.some(m=>m.role===r.id));
return `${titleblk('CASE FILE · 초대 코드 '+esc(state.code))}<div class="members">${state.members.map(m=>`<span class="member ${m.ready?'ready':''}"><b>${esc(m.name)}</b> · ${m.ready?'준비 완료':m.role?'역할 선택':'입장'}${m.online?'':' · 자리 비움'}</span>`).join('')}</div>
${acc('사건 소개',catalog.intro.map(p=>`<p>${esc(p)}</p>`).join(''))}${acc('진행 방법',list(state.rules))}
<div class="section-h"><span>오늘 밤, 어떤 인물이 될까요?</span><small>카드를 눌러 소개 확인</small></div><div class="grid">${state.roles.map(roleCard).join('')}</div>
<div class="stagebar"><div><b>${state.members.filter(m=>m.ready).length}/${state.size}명 준비 완료</b><small>${miss.length?'필수 역할 '+miss.length+'개가 남았습니다.':'모든 필수 역할이 선택됐습니다.'}</small></div><button class="btn sm ${state.me.ready?'ghost':''}" data-action="ready" ${state.me.role?'':'disabled'}>${state.me.ready?'준비 취소':'준비 완료'}</button></div>
<div class="footbtns"><button class="btn sm" data-action="invite">초대 링크 복사</button><button class="btn sm" data-action="recovery">개인 입장권 보관</button><button class="btn sm" data-action="leave">대기실 나가기</button></div>`;}
/* ---------- character book ---------- */
function bookHead(b){return `<div class="doc book"><div class="bookhead" data-label="${esc(catalog.title)}"><div class="ph"><span class="clip"></span>${slot('photos',b.id)}</div><div><div class="nm">${esc(b.title)}</div><div class="meta">${esc(state.members.find(m=>m.role===b.id)?.name||'참고인')}</div><div class="mt6">${fBadge(b.faction)}</div></div></div></div>`;}
const paneStory=b=>`<div class="panel"><h3>공개 소개</h3><p>${esc(b.public)}</p></div><div class="story">${b.story.map(t=>`<p>${esc(t)}</p>`).join('')}</div>`;
const paneTime=b=>`<ul class="tl">${b.timeline.map(([t,d])=>`<li><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div></li>`).join('')}</ul>`;
const paneSecret=b=>`<div class="panel c-red"><h3>당신만의 비밀</h3><p>${esc(b.secret)}</p></div><h3 class="sec">말하기 규칙</h3><div class="lie"><div class="hide"><b>거짓말 · 숨김 허용 범위</b>${esc(b.lie)}</div></div><h3 class="sec">개인 미션</h3><div class="panel"><p>${esc(b.mission)}</p></div>`;
function paneMemo(){const v=saved.get('nr-memo:'+draftKey(),'');return `<p class="hint">나만 보는 추리 노트입니다. 이 기기에만 저장됩니다.</p><textarea class="memo" id="memo" maxlength="4000" placeholder="누가 무엇을 숨기고 있나요?">${esc(v)}</textarea><div class="savebar"><span class="st" id="memost">저장됨</span></div>`;}
/* ---------- investigation ---------- */
function clueCard(c){const taker=state.members.find(m=>m.id===c.claimed_by);const n=c.id.split('-').pop();const opened=justOpened.has(c.id);
if(c.readable){const canShare=!c.shared&&(c.own||c.claimed_by===state.me.id)&&['r1','r2','r3','final'].includes(state.phase);
return `<div class="clue ${opened?'reveal':''}">${opened?'<div class="unseal"><div>OPEN</div></div>':''}<div class="ch"><b>${esc(c.title)}</b><span class="ev">${esc(c.owner_name.split(' (')[0])} · ${n}</span></div><div class="im">${slot('clues',c.id,'wide')}</div><div class="ct">${esc(c.text)}</div><div class="cf"><span class="tag">${c.shared?'모두에게 공개':c.own?'내 단서':'내가 조사함'}</span>${canShare?`<button class="btn sm" data-action="share" data-id="${c.id}">📣 공개하기</button>`:''}</div></div>`;}
const can=state.me.tokens>0&&['r1','r2','r3'].includes(state.phase);
return `<div class="clue ${taker?'taken':''}"><div class="ch"><b>봉인된 단서</b><span class="ev">${esc(c.owner_name.split(' (')[0])} · ${n}</span></div><div class="sealface"><div><span class="seal ${taker?'':'blink'}">${taker?'조사됨':'SEALED'}</span><p>${taker?esc(taker.name)+' 님이 조사했습니다. 공개를 요청해보세요.':'내용은 조사한 사람에게만 공개됩니다.'}</p>${taker?'':`<button class="btn sm" data-action="investigate" data-id="${c.id}" ${can?'':'disabled'}>봉투 뜯기 · 토큰 1개</button>`}</div></div></div>`;}
function paneClues(){const total={r1:1,r2:2,r3:3,final:3,ending:3}[state.phase]||0,left=state.me.tokens;
const coins=(justSpent?'<span class="coin fly">1</span>':'')+Array.from({length:Math.max(total,left)},(_,i)=>`<span class="coin ${i<left?'':'ghost'}">1</span>`).join('');
const others=state.roles.filter(r=>r.id!==state.me.role);if(!others.some(r=>r.id===invTarget))invTarget=others[0]?.id||'';
const t=others.find(r=>r.id===invTarget);const mine=state.clues.filter(c=>c.own);
const info=r=>{const m=state.members.find(x=>x.role===r.id);const cs=state.clues.filter(c=>c.owner===r.id);return `${m?esc(m.name):'참고인'} · 조사 ${cs.filter(c=>c.claimed_by).length}/${cs.length}`;};
return `<div class="tokbar"><span class="lbl">조사 토큰 · 단계마다 1개 지급</span><div class="coins">${coins}</div></div><h3 class="sec">내 단서 · 토큰 없이 열람</h3>${mine.map(clueCard).join('')||'<div class="empty">조사가 시작되면 단서가 공개됩니다.</div>'}
<h3 class="sec">다른 인물 조사</h3><div class="invlist">${others.map(r=>`<button class="${r.id===invTarget?'on':''}" data-action="inv" data-id="${r.id}">${slot('photos',r.id)}<span><b>${esc(r.title)}</b><small>${info(r)}</small></span></button>`).join('')}</div>
${t?`<div class="doc invhead"><div class="ph">${slot('photos',t.id)}</div><div><div class="nm">${esc(t.title)}</div><div class="meta">${info(t)}</div>${fBadge(t.faction)}</div></div>${state.clues.filter(c=>c.owner===t.id).map(clueCard).join('')}`:''}`;}
function paneEvidence(){return state.evidence.length?state.evidence.map(e=>`<div class="clue"><div class="ch"><b>${esc(e.title)}</b><span class="ev">${esc(state.phases.find(p=>p.id===e.phase).title)}</span></div><div class="im">${slot('evidence',e.id,'wide')}</div><div class="ct">${esc(e.text)}</div></div>`).join(''):'<div class="empty">현장 조사 단계부터 공용 증거가 공개됩니다.<br>지금은 자신의 이야기부터 읽어보세요.</div>';}
/* ---------- deduction / ending ---------- */
function paneDeduce(){if(!['final','ending'].includes(state.phase))return '<div class="empty">최종 추리 단계에서 답안을 제출합니다.<br>채팅과 단서를 통해 가설을 정리해보세요.</div>';
if(state.me.submission)return `<div class="locked-note"><span>제출 완료 · 수정 불가</span><span>${state.members.filter(m=>m.submitted).length}/${state.size}명 제출</span></div>${state.questions.map(q=>`<div class="fld"><label>${esc(q.title)}</label><div class="ans">${esc(q.options.find(o=>o.id===state.me.submission.answers[q.id])?.label)}</div></div>`).join('')}<p class="hint">전원 제출 또는 제한시간 종료 후 진상이 공개됩니다.</p>`;
const d=drafts[draftKey()]||{};
return `<p class="hint">네 가지 선택 항목을 각 1점으로 채점합니다. 시간 종료 시 미제출자는 0점 처리됩니다.</p><form id="deduction-form">${state.questions.map(q=>`<div class="panel"><h3>${esc(q.title)}</h3><div class="opts">${q.options.map(o=>`<label class="chk"><input type="radio" name="${q.id}" value="${o.id}" required ${d[q.id]===o.id?'checked':''}><span>${esc(o.label)}${q.id==='culprit'?' · '+esc(state.members.find(m=>m.role===o.id)?.name||'참고인'):''}</span></label>`).join('')}</div></div>`).join('')}<div class="fld"><label for="ded-note">추리 근거 · 선택 사항</label><textarea id="ded-note" name="note" maxlength="2000" placeholder="어떤 단서를 연결했나요?">${esc(d.note||'')}</textarea></div><div class="alignr"><button class="btn" type="submit">최종 추리 제출</button></div></form>`;}
function paneEnding(){const r=state.result;if(!r)return '';const title=id=>state.roles.find(x=>x.id===id)?.title||'';
return `<div class="result"><div class="rstamp">CASE CLOSED</div><div class="big ${esc(r.grade)}">${esc(r.title)}</div><div class="sc">전원 평균 ${r.average} / 4 · 답안 ${r.scores.filter(s=>s.submitted).length}/${state.size}</div><p>${esc(r.text)}</p></div>
<h3 class="sec">사건의 진상</h3><div class="story">${r.truth.map(t=>`<p>${esc(t)}</p>`).join('')}</div>
<h3 class="sec">점수</h3><div class="bars">${r.scores.map(s=>`<div class="bar-row"><span>${esc(state.members.find(m=>m.id===s.member).name)}</span><i class="s${s.score}"></i><b>${s.score}</b></div>`).join('')}</div>
<h3 class="sec">각자의 밤</h3>${r.scores.map(s=>{const m=state.members.find(m=>m.id===s.member);return `<div class="clue"><div class="ch"><b>${esc(m.name)} · ${esc(title(s.role))}</b><span class="ev">${s.score} / 4</span></div><div class="ct">${esc(s.epilogue)}<details><summary>제출 답안과 정답 확인</summary>${state.questions.map(q=>`<p>${esc(q.title)}<br>${s.marks[q.id]?'✓':'✕'} ${esc(q.options.find(o=>o.id===s.answers[q.id])?.label||'미제출')}</p>`).join('')}<p>근거: ${esc(s.note||'미작성')}</p></details></div></div>`;}).join('')}
<details><summary class="hint">집단 판정 기준</summary><p class="hint">단독 최다 득표가 진범이면 평균 점수로 NORMAL·TRUE·PERFECT를 판정합니다. TRUE는 평균 2.5 이상, PERFECT는 평균 3.5 이상이면서 과반수가 과거 사건을 맞혔을 때입니다. 동률 또는 무투표는 판결 보류입니다. 미제출자도 평균의 분모에 포함됩니다.</p></details>`;}
function paneArchive(){const b=state.archive.find(x=>x.id===archiveId)||state.archive[0];
return `<p class="hint">모든 인물의 원래 이야기가 열렸습니다. 조사 탭에서 모든 단서도 읽을 수 있어요.</p><div class="invlist">${state.archive.map(r=>`<button class="${r.id===b.id?'on':''}" data-action="archive" data-id="${r.id}">${slot('photos',r.id)}<span><b>${esc(r.title)}</b><small>${esc(r.faction)}</small></span></button>`).join('')}</div>${bookHead(b)}<h3 class="sec">이야기</h3>${paneStory(b)}<h3 class="sec">시간표</h3>${paneTime(b)}<h3 class="sec">비밀</h3>${paneSecret(b)}`;}
/* ---------- room ---------- */
function renderRoom(){rememberForm();const idx=state.phases.findIndex(p=>p.id===state.phase),phase=state.phases[idx];
const steps=`<div class="step-row">${state.phases.map((p,i)=>`<span class="${i===idx?'cur':i<idx?'done':''}">${String(i+1).padStart(2,'0')} ${esc(p.title)}</span>`).join('')}</div>`;
const lobbyPhase=state.phase==='lobby';
const tabs=lobbyPhase?[]:[['story','이야기'],['time','시간표'],['secret','비밀'],['clues','조사'],['evidence','증거'],['memo','메모'],['deduce','추리'],...(state.phase==='ending'?[['ending','엔딩'],['archive','전체 기록']]:[])];
if(!lobbyPhase&&!tabs.some(t=>t[0]===tab))tab='story';
const mode=lobbyPhase?'home':MODES[tab];document.body.dataset.mode=mode;
const right=`<span class="act" id="clock"></span>${lobbyPhase?'':`<span class="act tok">🪙 ${state.me.tokens}</span>`}<button class="act" data-action="chat-open" aria-label="대화 열기">💬<span class="dot hidden" id="unread"></span></button>`;
const kick=`${esc(phase.title)} · <span class="conn ${connected?'':'off'}" id="connection">${connected?'● 연결됨':'● 재연결 중'}</span>`;
let body;
if(lobbyPhase)body=lobby();
else{const b=state.book;const pv=['story','time','secret','memo','deduce'].includes(tab);
const content={story:()=>paneStory(b),time:()=>paneTime(b),secret:()=>paneSecret(b),clues:paneClues,evidence:paneEvidence,memo:paneMemo,deduce:paneDeduce,ending:paneEnding,archive:paneArchive}[tab]();
body=`${steps}${['final','ending'].includes(state.phase)?'':`<div class="stagebar"><div><b>${state.votes.length}/${state.size}명 다음 단계에 동의</b><small>전원이 동의하거나 시간이 끝나면 넘어갑니다.</small></div><button class="btn sm ${state.votes.includes(state.me.id)?'ghost':''}" data-action="vote">${state.votes.includes(state.me.id)?'동의 취소':'다음 단계 동의'}</button></div>`}${tab==='archive'?'':bookHead(b)}<nav class="tabs">${tabs.map(([k,l])=>`<button class="tab ${tab===k?'on':''} ${['story','time','secret','memo','deduce'].includes(k)?'pv':''}" data-action="tab" data-id="${k}">${l}</button>`).join('')}</nav><section class="pane on ${pv?'pv':''}" data-wm="PRIVATE · 본인 열람" id="main">${content}</section><div class="footbtns"><button class="btn sm" data-action="invite">초대 링크 복사</button><button class="btn sm" data-action="recovery">개인 입장권 보관</button></div>`;}
const bar=MODEBAR[mode];
$('#app').innerHTML=`${topbar(catalog.title,kick,right,true)}${bar?`<div class="modebar ${mode}"><span class="ic">${bar[0]}</span>${bar[1]}</div>`:''}<main class="wrap">${body}</main>`;
const id=document.activeElement?.id;
if(id&&document.getElementById(id)){const el=document.getElementById(id);if(formDrafts[id]!==undefined)el.value=formDrafts[id];}
markUnread();updateClock();}
/* ---------- chat ---------- */
function markUnread(){const el=$('#unread');if(!el||!state)return;el.classList.toggle('hidden',chatOpen||state.messages.length<=seenMsgs);}
function renderChat(force=false){const signature=JSON.stringify([state.messages,state.members.map(m=>[m.id,m.name,m.role]),chatTarget]);if(!force&&signature===chatSig)return;chatSig=signature;const select=$('#chat-target'),log=$('#chat-log');
select.innerHTML='<option value="">모두에게 · 공개 대화</option>'+state.members.filter(m=>m.id!==state.me.id).map(m=>`<option value="${m.id}" ${chatTarget===m.id?'selected':''}>${esc(m.name)}에게 귓속말</option>`).join('');
$('#chat-label').textContent=chatTarget?'선택한 친구와 나만 읽습니다':'공개 대화';
const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<70,oldTop=log.scrollTop;
const messages=state.messages.filter(m=>chatTarget?m.sender===state.me.id&&m.to===chatTarget||m.sender===chatTarget&&m.to===state.me.id:!m.to);
log.innerHTML=messages.map(m=>{if(!m.sender)return `<div class="msg system">${esc(m.text)}</div>`;const sender=state.members.find(x=>x.id===m.sender);return `<div class="msg ${m.sender===state.me.id?'mine':''} ${m.to?'private':''}"><small>${esc(sender?.name||'퇴장한 참가자')} · ${new Date(m.at*1000).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}${m.to?' · 귓속말':''}</small><p>${esc(m.text)}</p></div>`;}).join('')||'<p class="empty">첫 메시지를 보내보세요.</p>';
if(bottom||force)log.scrollTop=log.scrollHeight;else log.scrollTop=oldTop;if(chatOpen)seenMsgs=state.messages.length;}
function setChat(open){chatOpen=open;$('#chat').classList.toggle('open',open);if(open){renderChat(true);seenMsgs=state.messages.length;}markUnread();}
/* ---------- state loop ---------- */
function update(data){const prior=state?.phase;state=data;clockOffset=state.server_now*1000-Date.now();
if(prior&&prior!==state.phase){tab=state.phase==='ending'?'ending':state.phase==='final'?'deduce':state.phase==='intro'?'story':'evidence';lastSig='';showOverlay(prior,state.phase);}
const signature=JSON.stringify([state.version,state.members.map(m=>[m.id,m.role,m.ready,m.online,m.submitted]),tab,archiveId,invTarget,connected]);
if(signature!==lastSig){lastSig=signature;renderRoom();}
renderChat();markUnread();updateClock();}
function updateClock(){const el=$('#clock');if(!el||!state)return;if(!state.deadline){el.textContent=state.phase==='ending'?'CLOSED':'LOBBY';return;}const left=Math.max(0,Math.ceil((state.deadline*1000-Date.now()-clockOffset)/1000));el.textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');}
async function poll(){clearTimeout(pollTimer);if(!session)return;try{const data=await api(`rooms/${session.code}/state`);connected=true;session.member_id=data.me.id;saved.set('nr-session',session);update(data);}catch(e){connected=false;const el=$('#connection');if(el){el.classList.add('off');el.textContent='● 재연결 중';}else{toast(e.message);landing();return;}}pollTimer=setTimeout(poll,1800);}
async function act(action,body={}){if(busy)return false;busy=true;try{const data=await api(`rooms/${session.code}/${action}`,body);connected=true;if(action==='leave'){saved.set('nr-session',null);session=null;landing();}else update(data);return true;}catch(e){toast(e.message);return false;}finally{busy=false;}}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('복사했습니다.');}catch{const d=$('#confirm');$('#confirm-title').textContent='아래 내용을 길게 눌러 복사해주세요';$('#confirm-text').textContent=text;d.showModal();}}
/* ---------- events ---------- */
document.addEventListener('error',e=>{const t=e.target;if(t.tagName==='IMG'&&t.hasAttribute('data-slot')){missing.add(t.getAttribute('src'));t.remove();}},true);
document.addEventListener('click',async event=>{
 const img=event.target.closest('.clue .slot>img,.bookhead .slot>img,.invhead .slot>img');if(img){$('#zoomimg').src=img.src;$('#zoom').classList.add('on');return;}
 const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action,id=button.dataset.id;
 if(action==='zoom-close'){$('#zoom').classList.remove('on');return;}
 if(action==='rov-close'){$('#overlay').innerHTML='';return;}
 if(action==='resume'){await enter(session);return;}
 if(action==='acc'){accOpen.has(id)?accOpen.delete(id):accOpen.add(id);button.closest('.acc').classList.toggle('open');return;}
 if(action==='flip'){flipped.has(id)?flipped.delete(id):flipped.add(id);document.getElementById('card-'+id)?.classList.toggle('flipped');return;}
 if(action==='tab'){tab=id;renderRoom();window.scrollTo(0,0);return;}
 if(action==='inv'){invTarget=id;renderRoom();return;}
 if(action==='archive'){archiveId=id;renderRoom();return;}
 if(action==='home'){if(state&&!await confirmInPage('시작 화면으로 갈까요?','방은 유지됩니다. 시작 화면의 ‘이어하기’로 돌아올 수 있어요.'))return;landing();return;}
 if(action==='invite'){await copy(location.origin+'/?room='+state.code);return;}
 if(action==='recovery'){await copy('초대 코드: '+session.code+'\n개인 입장권: '+session.token);return;}
 if(action==='chat-open'||action==='chat-close'){setChat(action==='chat-open');return;}
 if(action==='leave'&&!await confirmInPage('대기실을 나갈까요?','선택한 역할과 자리를 다른 사람이 사용할 수 있습니다.'))return;
 if(action==='investigate'&&!await confirmInPage('이 봉투를 뜯을까요?','조사 토큰 1개를 사용합니다. 내용은 먼저 조사한 나에게만 공개됩니다.'))return;
 if(action==='share'&&!await confirmInPage('모두에게 공개할까요?','공개한 단서는 같은 방의 모든 참가자가 읽을 수 있으며 되돌릴 수 없습니다.'))return;
 if(action==='investigate'){justOpened.add(id);justSpent=true;lastSig='';}
 const ok=await act(action,action==='role'?{role:id}:['share','investigate'].includes(action)?{clue:id}:{});
 if(action==='role'&&ok)flipped.delete(id);
 if(action==='investigate'){if(!ok)justOpened.delete(id);setTimeout(()=>{justOpened.delete(id);justSpent=false;},1800);}
});
document.addEventListener('input',e=>{
 if(e.target.closest('#deduction-form')){const form=new FormData($('#deduction-form'));drafts[draftKey()]=Object.fromEntries(form);saved.set('nr-drafts',drafts);}
 if(e.target.id==='memo'){const st=$('#memost');st.textContent='저장 중…';st.classList.add('dirty');clearTimeout(input.t);input.t=setTimeout(()=>{saved.set('nr-memo:'+draftKey(),e.target.value);st.textContent='저장됨 · 이 기기에만 보관';st.classList.remove('dirty');},500);}
});
function input(){}
document.addEventListener('change',e=>{if(e.target.id==='chat-target'){chatTarget=e.target.value;renderChat(true);}});
document.addEventListener('submit',async e=>{const form=e.target;if(!['create-form','join-form','chat-form','deduction-form','recover-form'].includes(form.id))return;e.preventDefault();const values=Object.fromEntries(new FormData(form));const button=form.querySelector('[type=submit]');button.disabled=true;
 try{
 if(form.id==='create-form'||form.id==='join-form'){
  if(session&&!await confirmInPage('새로운 자리로 입장할까요?','현재 기기의 입장권이 바뀝니다. 기존 방으로 돌아오려면 개인 입장권을 먼저 보관하세요.'))return;
  const result=form.id==='create-form'?await api('rooms',{name:values.name,size:Number(values.size),pace:values.pace}):await api(`rooms/${values.code.trim().toUpperCase()}/join`,{name:values.name});await enter(result);
 }else if(form.id==='recover-form'){
  const prior=session;session={code:values.code.trim().toUpperCase(),token:values.token.trim()};try{const data=await api(`rooms/${session.code}/state`);session.member_id=data.me.id;await enter(session);}catch(e){session=prior;throw e;}
 }else if(form.id==='chat-form'){
  const text=values.text.trim();if(!text)return;const data=await api(`rooms/${session.code}/chat`,{text,to:chatTarget||null});$('#chat-input').value='';update(data);
 }else if(form.id==='deduction-form'){
  if(!await confirmInPage('추리를 제출할까요?','제출 후에는 수정할 수 없습니다. 전원 제출 또는 시간 종료 후 진상이 공개됩니다.'))return;
  const {note,...answers}=values;const data=await api(`rooms/${session.code}/submit`,{answers,note});update(data);toast('추리가 제출됐습니다.');
 }
 }catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
});
setInterval(updateClock,1000);
(async()=>{try{catalog=await api('catalog');applyTheme();landing();}catch(e){$('#app').innerHTML='<div class="boot">서버에 연결하지 못했습니다. 서버가 실행 중인지 확인 후 새로고침해주세요.</div>';}})();
