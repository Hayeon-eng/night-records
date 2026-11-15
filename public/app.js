'use strict';
/* ================= 공통 ================= */
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const memory={};
const saved={get(k,d=null){try{return JSON.parse(localStorage.getItem(k))??d;}catch{return memory[k]??d;}},set(k,v){memory[k]=v;try{localStorage.setItem(k,JSON.stringify(v));}catch{}}};
let catalog,session=saved.get('nr-session'),state=null,tab='story',archiveId='',invTarget='',pollTimer,busy=false,lastSig='',chatSig='',connected=true,clockOffset=0,chatTarget='',chatOpen=false,justSpent=false;
let lastSeenMsg=0,notifiedMsg=0,notifiedEv=0,primed=false,newShared=0,swReg=null,cineStep=0,cineOn=false;
let drafts=saved.get('nr-drafts',{});const formDrafts={};
const flipped=new Set(),accOpen=new Set(['사건 소개']),justOpened=new Set(),missing=new Set();
const THEME_COLOR={noir:'#0E1A31',school:'#10281F',romance:'#2A0F1C',medieval:'#1B1710'};
const PHASE_DESC={intro:'캐릭터북이 공개됐습니다',r1:'공용 증거 공개 · 조사 토큰 +1',r2:'새 증거 공개 · 조사 토큰 +1',r3:'마지막 증거 공개 · 조사 토큰 +1',final:'최종 추리를 제출하세요',ending:'사건의 진상이 열렸습니다'};
const MODES={story:'me',time:'me',secret:'me',memo:'me',deduce:'me',clues:'inv',board:'shared',evidence:'shared',ending:'ending',archive:'ending'};
const MODEBAR={story:['🔒','내 화면 · 본인 외에는 보여주지 마세요'],time:['🔒','내 화면 · 본인 외에는 보여주지 마세요'],secret:['🔒','내 화면 · 본인 외에는 보여주지 마세요'],memo:['🔒','내 메모 · 이 기기에만 저장됩니다'],deduce:['🔒','내 추리 · 제출 전까지 본인만 봅니다'],
  clues:['🕵','조사 · 내 단서와 다른 인물의 단서'],board:['🗂','단서 · 공개된 단서만 모여 있어요'],evidence:['📁','공용 증거 · 단계마다 모두에게 자동 공개되는 현장 자료'],ending:['📖','엔딩 · 모든 기록이 공개되었습니다'],archive:['📖','전체 기록 · 모든 캐릭터북']};
const TAB_HELP={clues:'내 단서는 무료로 읽고, 다른 인물의 봉인된 단서는 조사 토큰으로 열어요. 열어 본 단서는 “공개하기”로 알릴 수 있어요.',board:'누군가 공개해 준 단서만 모여요. 내가 가진 단서와 직접 조사한 단서는 조사 탭에 있어요.',evidence:'단계마다 시스템이 모두에게 자동으로 공개하는 현장 자료예요. 인물별 “단서”와는 다릅니다.'};
const draftKey=()=>session?`${session.code}:${session.member_id}`:'';
const cineKey=()=>'nr-cine:'+draftKey();
const visKey=()=>`nr-vis:${draftKey()}:${state?.phase}`;
function toast(text){const el=$('#toast');el.textContent=text;el.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.style.display='none',4500);}
async function api(path,body){const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?.token?{Authorization:'Bearer '+session.token}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'요청을 처리하지 못했습니다.');return data;}
function confirmInPage(title,text){return new Promise(resolve=>{const dialog=$('#confirm');$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;dialog.returnValue='cancel';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'),{once:true});dialog.showModal();});}
function rememberForm(){document.querySelectorAll('#app input[id],#app textarea[id],#app select[id]').forEach(e=>{formDrafts[e.id]=e.value;});}
function applyTheme(){const t=new URLSearchParams(location.search).get('theme')||catalog?.theme||'noir';document.body.dataset.theme=THEME_COLOR[t]?t:'noir';$('meta[name=theme-color]').content=THEME_COLOR[t]||THEME_COLOR.noir;}

/* ================= 글 표시 규칙 =================
   1) 문장이 끝나면 반드시 줄을 바꾼다(따옴표 안의 마침표는 끊지 않는다).
   2) “21:40 …”처럼 시간으로 시작하는 문장은 시간 순서로 정렬해 시간표 형태로 보여준다.
   앞으로 만드는 모든 글은 fmt()/P()로 출력한다. */
function sentences(text){const t=String(text??'').trim(),out=[];let cur='',q=0;
  for(let i=0;i<t.length;i++){const c=t[i];cur+=c;if(c==='“'||c==='‘')q++;else if((c==='”'||c==='’')&&q>0)q--;
    if(q===0&&'.!?。…'.includes(c)){const nx=t[i+1];if(!nx||/\s/.test(nx)){out.push(cur.trim());cur='';}}}
  if(cur.trim())out.push(cur.trim());return out;}
const TIME_RE=/^(\d{1,2}):(\d{2})(?:\s*~\s*\d{1,2}:\d{2})?/;
const timeKey=s=>{const m=String(s).match(TIME_RE);return m?+m[1]*60+ +m[2]:null;};
function fmt(text){const parts=sentences(text).map((s,i)=>({s,i,k:timeKey(s)}));
  const sorted=parts.filter(x=>x.k!==null).sort((a,b)=>a.k-b.k||a.i-b.i);let j=0;
  return parts.map(x=>x.k===null?x:sorted[j++]).map(x=>{const m=x.s.match(/^(\d{1,2}:\d{2}(?:\s*~\s*\d{1,2}:\d{2})?)\s+([\s\S]*)$/);
    return m?`<span class="ln t"><i>${esc(m[1])}</i><span>${esc(m[2])}</span></span>`:`<span class="ln">${esc(x.s)}</span>`;}).join('');}
const P=(text,cls='')=>`<div class="txt ${cls}">${fmt(text)}</div>`;

/* ================= 이름 표시: 캐릭터 이름을 크게, 직함, 실제 이름은 작게 ================= */
const roleOf=id=>(state?.roles||catalog.roles).find(r=>r.id===id);
const memberByRole=rid=>state?.members.find(m=>m.role===rid);
const memberById=id=>state?.members.find(m=>m.id===id);
function who(rid){const r=roleOf(rid)||{},m=memberByRole(rid);return {name:r.name||'',title:r.title||'',real:m?m.name:'',member:m,absent:!m};}
function whoMember(id){const m=memberById(id);return m?.role?who(m.role):{name:m?.name||'퇴장한 참가자',title:'',real:'',member:m};}
// 캐릭터 이름(굵게) · 직함(선택) · (실제 이름, 작게)
const idInline=(w,title=false)=>`<b class="cn">${esc(w.name)}</b>${title&&w.title?` <small class="cr">${esc(w.title)}</small>`:''}${w.real&&w.real!==w.name?` <small class="cr">(${esc(w.real)})</small>`:''}`;
const idPlain=w=>w.name+(w.real&&w.real!==w.name?`(${w.real})`:'');

/* ================= 공통 조각 ================= */
function slot(kind,id,cls=''){const url=`/img/${kind}/${id}`;if(cls==='wide'&&missing.has(url))return '';return `<div class="slot ${cls}">${missing.has(url)?'':`<img data-slot src="${url}" alt="">`}</div>`;}
const facs=()=>[...new Set((state?.roles||catalog.roles).map(r=>r.faction))];
const fCls=f=>['h','m','n'][Math.min(facs().indexOf(f),2)]||'n';
const fBadge=f=>`<span class="badge ${{h:'b-han',m:'b-mou',n:'b-non'}[fCls(f)]}">${esc(f)}</span>`;
const acc=(t,body,label)=>`<div class="acc ${accOpen.has(t)?'open':''}"><button data-action="acc" data-id="${esc(t)}">${esc(label||t)}<span class="chev">›</span></button><div class="body">${body}</div></div>`;
const list=a=>`<ul class="plain">${a.map(x=>`<li>${fmt(x)}</li>`).join('')}</ul>`;
function topbar(title,kicker,right='',back=false){return `<header class="top"><div class="wrap">${back?'<button class="back" data-action="home" aria-label="시작 화면">‹</button>':''}<div class="ttl">${esc(title)}<small>${kicker}</small></div>${right}</div></header>`;}
function titleblk(kicker){return `<div class="titleblk">${catalog.stamp?`<div class="stamp">${esc(catalog.stamp)}</div>`:''}<div class="kicker">${kicker}</div><h1>${esc(catalog.title)}</h1><p class="tag">${esc(catalog.summary)}</p></div>`;}

/* ================= 시작 화면 ================= */
// 공통 게임 방법: 에피소드와 무관한 규칙만 담는다. 에피소드별 내용은 catalog.scenarios(카드)와 대기실 '진행 방법'에서 보여준다.
// **굵게** 표시한 문구는 rich()가 강조(굵기+컬러)로 바꾼다.
const rich=t=>esc(t).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
const FLOW=[['01','🎭','역할 선택'],['02','📖','캐릭터북 확인'],['03','🔎','단서 조사 및 대화'],['04','🧩','최종 추리']];
const HOWTO=[
  {icon:'🎭',title:'각자의 역할을 선택해요',lines:['친구들과 사건실에 입장한 뒤 **각자 원하는 캐릭터**를 선택해요.','캐릭터마다 **직업, 성격, 관계, 사건과 얽힌 이야기**가 달라요.']},
  {icon:'📖',title:'나만의 캐릭터북을 읽어요',lines:['**나에게만 공개되는 캐릭터북**을 확인해요.','공개된 이야기뿐 아니라 **개인적인 비밀, 사건 당일의 시간표, 개인 미션**이 포함될 수 있어요.','다른 사람에게 무엇을 공개하고 숨길지는 **각자의 선택**이에요.']},
  {icon:'🔎',title:'단서를 조사해요',lines:['내가 가진 단서는 **자유롭게** 확인할 수 있어요.','다른 인물의 봉인된 단서는 **조사 토큰**을 사용해 조사해요.','조사 결과는 **먼저 조사한 사람에게만** 공개돼요.']},
  {icon:'🗣️',title:'대화하고 단서를 공유해요',lines:['**공개 채팅 또는 귓속말**로 친구들과 정보를 주고받아요.','단서는 **모두에게** 공개하거나 **특정 플레이어에게만** 공유할 수 있어요.','누가 진실을 말하고 누가 무언가를 숨기는지 추리해요.']},
  {icon:'🧩',title:'최종 추리를 제출해요',lines:['모든 조사가 끝나면 **범인, 범행 방법, 동기** 등 사건의 핵심 질문에 답해요.','추리 결과가 모이면 **사건의 진상과 각 인물의 이야기**가 공개돼요.','마지막에 **내 추리가 얼마나 정확했는지** 확인할 수 있어요.']}
];
const HOWTO_NOTE='※ 에피소드에 따라 인원수, 조사 방식, 세부 규칙은 달라질 수 있어요.';
let tutIdx=0;

// 에피소드 카드: catalog.scenarios(서버 데이터)만 사용한다. 새 에피소드가 등록되면 카드가 자동으로 늘어난다.
const epReady=s=>(s.status||'available')==='available';
function epPlayers(s){if(s.players_label)return s.players_label;
  const a=[...new Set(s.players||[])].sort((x,y)=>x-y),g=[];
  a.forEach(n=>{const l=g[g.length-1];if(l&&n===l[l.length-1]+1)l.push(n);else g.push([n]);});
  return g.length?g.map(l=>l.length>1?`${l[0]}–${l[l.length-1]}`:`${l[0]}`).join(' · ')+'명':'';}
function episodeCards(){
  const list=catalog.scenarios||[{id:catalog.id,title:catalog.title,summary:catalog.summary,status:'available'}],first=list.find(epReady);
  return list.map(s=>{const ok=epReady(s),pl=epPlayers(s);
    return `<label class="ep${ok?'':' off'}"><input type="radio" name="scenario" value="${esc(s.id)}" ${s===first?'checked':''} ${ok?'':'disabled'}><span class="ep-card"><span class="ep-top"><span class="ep-stamp">${esc(s.stamp||'CASE FILE')}</span>${s.genre?`<span class="ep-genre">${esc(s.genre)}</span>`:''}<span class="ep-state${ok?' on':''}">${ok?'플레이 가능':'준비 중'}</span></span><b class="ep-title">${esc(s.title)}</b>${s.tagline?`<span class="ep-line">${esc(s.tagline)}</span>`:''}${s.summary?`<span class="ep-syn">${esc(s.summary)}</span>`:''}${pl||s.duration?`<span class="ep-meta">${pl?`<span><small>권장 인원</small>${esc(pl)}</span>`:''}${s.duration?`<span><small>예상 시간</small>${esc(s.duration)}</span>`:''}</span>`:''}</span></label>`;}).join('');}

function landing(){clearTimeout(pollTimer);state=null;lastSig='';chatSig='';chatOpen=false;primed=false;$('#chat').classList.remove('open');$('#fab').hidden=true;document.body.dataset.mode='home';applyTheme();
const invite=new URLSearchParams(location.search).get('room')||'';
$('#app').innerHTML=`${topbar('머더 미스터리','PLAY WITH FRIENDS')}<main class="wrap">
<section class="brand-hero${session?' compact':''}"><div class="hero-eyebrow"><span class="live-dot"></span> MOBILE MURDER MYSTERY</div><div class="hero-title">친구들과 함께<br><em>진실을 밝혀보세요.</em></div><p class="hero-copy">각자의 역할과 숨겨진 단서로<br>대화하고 추리하는 모바일 게임.</p><div class="hero-tags"><span>친구들과 플레이</span><span>진행자 없이 플레이</span><span>에피소드 선택 가능</span></div>${session?'':'<div class="hero-art"><div class="art-ring"></div><div class="art-file"><span>CASE</span><b>01</b><small>THE TRUTH IS HIDDEN</small></div><div class="art-chip chip-a">🔎 단서</div><div class="art-chip chip-b">♟ 용의자</div><div class="art-chip chip-c">?</div></div>'}</section>
<section class="lp-flow" aria-label="게임 진행 방식"><div class="lp-flow-head"><span class="mini-kicker">HOW TO PLAY</span><h2>이렇게 진행돼요</h2></div><ol class="lp-steps">${FLOW.map(([n,ic,t])=>`<li><span class="lp-ic" aria-hidden="true">${ic}</span><span class="lp-n">${n}</span><b>${t}</b></li>`).join('')}</ol><button class="btn ghost lp-more" type="button" data-action="tutorial">게임 방법 자세히 보기 <span aria-hidden="true">→</span></button></section>
${session?`<div class="stagebar lp-resume"><div><b>진행하던 사건실이 있어요</b><small>${esc(session.code)} · 이 기기에서 참여 중인 방입니다.</small></div><button class="btn sm" data-action="resume">이어하기</button></div>`:''}
<section class="paper lp-case"><span class="lp-tab">NEW CASE</span><h2>새로운 사건</h2><form id="create-form"><fieldset class="ep-pick"><legend>플레이할 에피소드</legend>${episodeCards()}</fieldset><label for="create-name">내 이름 또는 닉네임 (친구들이 알아볼 이름)</label><input id="create-name" name="name" maxlength="24" required placeholder="예: 하연"><div class="two"><div><label for="size">함께할 인원</label><select id="size" name="size"><option value="2">2명 (테스트)</option><option value="6">6명</option><option value="7">7명</option><option value="8">8명</option></select></div><div><label for="pace">진행 속도</label><select id="pace" name="pace"><option value="normal">여유롭게 · 약 50분</option><option value="quick">빠르게 · 약 25분</option></select></div></div><button class="btn" type="submit">사건실 만들기 →</button></form></section>
<section class="paper"><h2>초대받은 사건</h2><form id="join-form"><label for="join-code">8자리 초대 코드</label><input id="join-code" name="code" maxlength="8" minlength="8" required value="${esc(invite)}" placeholder="예: AB23CD45" autocomplete="off"><label for="join-name">내 이름 또는 닉네임 (친구들이 알아볼 이름)</label><input id="join-name" name="name" maxlength="24" required placeholder="예: 하연"><button class="btn" type="submit">초대 코드로 입장 →</button></form></section>
${acc('개인정보 및 데이터 안내','<p>이름과 대화는 같은 방의 참가자에게만 제공됩니다. 귓속말은 송수신자에게만 표시되며 서버에 저장됩니다. 방과 기록은 생성 7일 후 삭제됩니다. 실명 대신 닉네임을 사용해도 됩니다. 음성·영상 통화는 지원하지 않습니다.</p>')}
<div class="foot">${esc(catalog.title)} · PLAYABLE BETA</div></main>`;}
async function enter(s){session=s;saved.set('nr-session',s);state=null;tab='story';lastSig='';chatSig='';primed=false;notifiedMsg=0;notifiedEv=0;newShared=0;lastSeenMsg=saved.get('nr-seen:'+draftKey(),0);await poll();window.scrollTo({top:0,behavior:'instant'});}

/* ================= 대기실 ================= */
function roleCard(r){const member=memberByRole(r.id),mine=member?.id===state.me.id,off=member&&!mine||(state.size===6||state.size===2)&&!r.required;
return `<div class="flip ${flipped.has(r.id)?'flipped':''} ${mine?'isme':''}" id="card-${r.id}"><button class="face front idb" data-action="flip" data-id="${r.id}" aria-label="${esc(r.name)} 소개 열기"><div class="strip ${fCls(r.faction)}"><span>${esc(catalog.strip||'CASE FILE')}</span><span>${esc(r.faction)}</span></div><div class="hole"></div><div class="body">${slot('photos',r.id)}<div><div class="nm">${esc(r.name)}</div><div class="gp">${esc(r.title)}${r.required?'':' · 추가 역할'}${member?`<br><span class="rl">${esc(member.name)}</span>`:''}</div></div></div><div class="bar"></div>${mine?'<span class="lk ok">내 캐릭터</span>':member?'<span class="lk">선택됨</span>':''}<span class="tapme">탭 → 소개</span></button><div class="face back"><div class="bh"><span>${esc(r.name)} · ${esc(r.title)}</span><button class="x" data-action="flip" data-id="${r.id}" aria-label="닫기">×</button></div><div class="bb">${P(r.teaser)}<div class="hint">${fmt(r.public)}</div><button class="btn ${mine?'ghost':''}" data-action="role" data-id="${r.id}" ${off?'disabled':''}>${mine?'내가 선택한 역할':member?esc(member.name)+' 님이 선택':'이 캐릭터로 시작'}</button></div></div></div>`;}
function invitePanel(){return `<section class="invite invite-primary" aria-label="친구 초대"><div class="iv-eyebrow">ROOM CREATED · 친구 초대</div><div class="iv-k">친구에게 이 코드를 보내주세요</div><div class="iv-code" aria-label="초대 코드">${esc(state.code)}</div><div class="iv-btns"><button class="btn sm iv-copy" data-action="copy-code">초대 코드 복사</button><button class="btn sm ghost" data-action="invite">초대 링크 복사</button>${navigator.share?'<button class="btn sm ghost" data-action="share-invite">공유하기</button>':''}</div><p class="iv-h">코드 또는 링크를 카톡방에 보내면 친구들이 바로 입장할 수 있어요.</p><div class="iv-next">${state.members.length}/${state.size}명 입장 · 모두 모이면 역할을 선택하고 게임을 시작해요</div></section>`;}
function notifBar(){if(!('Notification' in window)||Notification.permission!=='default'||saved.get('nr-notif-dismiss'))return '';return `<div class="notifbar"><span>🔔 친구가 채팅을 보내면 알려드릴까요?</span><button class="btn sm" data-action="notif-ask">알림 켜기</button><button class="nx" data-action="notif-dismiss" aria-label="닫기">×</button></div>`;}
function lobby(){const miss=(state.size===2||state.size>=6)?state.roles.filter(r=>r.required&&!state.members.some(m=>m.role===r.id)):[];
return `${invitePanel()}${titleblk('CASE FILE · 대기실')}${notifBar()}
<div class="members">${state.members.map(m=>{const r=m.role?roleOf(m.role):null;return `<span class="member ${m.ready?'ready':''}"><b>${esc(m.name)}</b>${r?' → '+esc(r.name):''} · ${m.ready?'준비 완료':r?'역할 선택':'입장'}${m.online?'':' · 자리 비움'}</span>`;}).join('')}</div>
${acc('사건 소개',catalog.intro.map(p=>P(p)).join(''))}${acc('진행 방법',list(state.rules))}
<div class="section-h"><span>오늘 밤, 어떤 인물이 될까요?</span><small>카드를 눌러 소개 확인</small></div><div class="grid">${state.roles.map(roleCard).join('')}</div>
<div class="stagebar"><div><b>${state.members.filter(m=>m.ready).length}/${state.size}명 준비 완료</b><small>${miss.length?'필수 역할 '+miss.length+'개가 남았습니다.':'모든 필수 역할이 선택됐습니다.'}</small></div><button class="btn sm ${state.me.ready?'ghost':''}" data-action="ready" ${state.me.role?'':'disabled'}>${state.me.ready?'준비 취소':'준비 완료'}</button></div>
<div class="footbtns"><button class="btn sm" data-action="tutorial">게임 설명 다시 보기</button><button class="btn sm" data-action="leave">대기실 나가기</button></div>`;}

/* ================= 캐릭터북 ================= */
function bookHead(b){const w=who(b.id);return `<div class="doc book"><div class="bookhead" data-label="${esc(catalog.title)}"><div class="ph"><span class="clip"></span>${slot('photos',b.id)}</div><div><div class="nm">${esc(b.name)}</div><div class="job">${esc(b.title)}</div><div class="meta">${w.real?'플레이어 · '+esc(w.real):'참고인'}</div><div class="mt6">${fBadge(b.faction)}</div></div></div></div>`;}
const paneStory=b=>`<div class="panel"><h3>공개 소개</h3>${P(b.public)}</div><div class="story">${b.story.map(t=>`<p>${fmt(t)}</p>`).join('')}</div>`;
const paneTime=b=>`<ul class="tl">${[...b.timeline].sort((a,c)=>(timeKey(a[0])??0)-(timeKey(c[0])??0)).map(([t,d])=>`<li><div class="t">${esc(t)}</div><div class="d">${fmt(d)}</div></li>`).join('')}</ul>`;
const paneSecret=b=>`<div class="panel c-red"><h3>당신만의 비밀</h3>${P(b.secret)}</div><h3 class="sec">말하기 규칙</h3><div class="lie"><div class="hide"><b>거짓말 · 숨김 허용 범위</b>${fmt(b.lie)}</div></div><h3 class="sec">개인 미션</h3><div class="panel">${P(b.mission)}</div>`;
function paneMemo(){const v=saved.get('nr-memo:'+draftKey(),'');return `<p class="hint">나만 보는 추리 노트입니다. 이 기기에만 저장됩니다.</p><textarea class="memo" id="memo" maxlength="4000" placeholder="누가 무엇을 숨기고 있나요?">${esc(v)}</textarea><div class="savebar"><span class="st" id="memost">저장됨</span></div>`;}

/* ================= 단서 ================= */
const SHARE_PHASES=['r1','r2','r3','final'];
function provOf(c){
  const names=ids=>(ids||[]).map(id=>whoMember(id).name).join(', ');
  if(c.via==='own')return {cls:'v-own',label:'내 단서',detail:c.shared?'모두에게 공개함':c.granted_to?.length?names(c.granted_to)+'에게 공개함':'나만 알고 있어요'};
  if(c.via==='investigated')return {cls:'v-inv',label:'내가 조사한 단서',detail:`${who(c.owner).name}의 단서`+(c.shared?' · 모두에게 공개함':c.granted_to?.length?' · '+names(c.granted_to)+'에게 공개함':'')};
  if(c.via==='public')return {cls:'v-pub',label:'모두에게 공개된 단서',detail:c.shared_by?`${whoMember(c.shared_by).name} 공개`:`${who(c.owner).name}의 단서`};
  if(c.via==='granted')return {cls:'v-grant',label:'나에게만 공개된 단서',detail:`${whoMember(c.granted_by).name} → 나`};
  return {cls:'v-end',label:'엔딩 공개',detail:`${who(c.owner).name}의 단서`};}
function clueCard(c){
  const n=c.id.split('-').pop(),opened=justOpened.has(c.id),w=who(c.owner),tag=`${esc(w.name)} · ${n}`;
  if(c.readable){const pv=provOf(c),canShare=!c.shared&&(c.own||c.claimed_by===state.me.id)&&SHARE_PHASES.includes(state.phase);
    return `<div class="clue ${pv.cls} ${opened?'reveal':''}">${opened?'<div class="unseal"><div>OPEN</div></div>':''}<div class="prov ${pv.cls}"><b>${esc(pv.label)}</b><span>${esc(pv.detail)}</span></div><div class="ch"><b>${esc(c.title)}</b><span class="ev">${tag}</span></div><div class="im">${slot('clues',c.id,'wide')}</div><div class="ct">${fmt(c.text)}</div>${canShare?`<div class="cf"><span class="tag">공개 범위를 고를 수 있어요</span><button class="btn sm" data-action="share" data-id="${c.id}">📣 공개하기</button></div>`:''}</div>`;}
  const taker=c.claimed_by?whoMember(c.claimed_by):null,can=state.me.tokens>0&&['r1','r2','r3'].includes(state.phase);
  return `<div class="clue v-seal ${taker?'taken':''}"><div class="prov v-seal"><b>봉인된 단서</b><span>${esc(w.name)}의 것</span></div><div class="ch"><b>${taker?'조사된 단서':'봉인된 단서'}</b><span class="ev">${tag}</span></div><div class="sealface"><div><span class="seal ${taker?'':'blink'}">${taker?'조사됨':'SEALED'}</span><p>${taker?esc(idPlain(taker))+' 님이 조사했습니다. 공개를 요청해보세요.':'내용은 조사한 사람에게만 공개됩니다.'}</p>${taker?'':`<button class="btn sm" data-action="investigate" data-id="${c.id}" ${can?'':'disabled'}>봉투 뜯기 · 토큰 1개</button>`}</div></div></div>`;}
function paneClues(){
  const total={r1:1,r2:2,r3:3,final:3,ending:3}[state.phase]||0,left=state.me.tokens;
  const coins=(justSpent?'<span class="coin fly">1</span>':'')+Array.from({length:Math.max(total,left)},(_,i)=>`<span class="coin ${i<left?'':'ghost'}">1</span>`).join('');
  const others=state.roles.filter(r=>r.id!==state.me.role);if(!others.some(r=>r.id===invTarget))invTarget=others[0]?.id||'';
  const t=others.find(r=>r.id===invTarget),mine=state.clues.filter(c=>c.own);
  const info=r=>{const w=who(r.id),cs=state.clues.filter(c=>c.owner===r.id);return `${esc(w.real||'참고인')} · 조사 ${cs.filter(c=>c.claimed_by).length}/${cs.length}`;};
  return `<p class="tabhelp">${esc(TAB_HELP.clues)}</p><div class="tokbar"><span class="lbl">조사 토큰 · 단계마다 1개 지급</span><div class="coins">${coins}</div></div>
<h3 class="sec">내 단서 <small>토큰 없이 열람</small></h3>${mine.map(clueCard).join('')||'<div class="empty">조사가 시작되면 단서가 공개됩니다.</div>'}
<h3 class="sec">다른 인물 조사</h3><div class="invlist">${others.map(r=>`<button class="${r.id===invTarget?'on':''}" data-action="inv" data-id="${r.id}">${slot('photos',r.id)}<span><b>${esc(r.name)}</b><small>${esc(r.title)}</small><small>${info(r)}</small></span></button>`).join('')}</div>
${t?`<div class="doc invhead"><div class="ph">${slot('photos',t.id)}</div><div><div class="nm">${esc(t.name)}</div><div class="job">${esc(t.title)}</div><div class="meta">${info(t)}</div>${fBadge(t.faction)}</div></div>${state.clues.filter(c=>c.owner===t.id).map(clueCard).join('')}`:''}`;}
function paneBoard(){
  const pub=state.clues.filter(c=>c.shared&&c.readable),toMe=state.clues.filter(c=>c.readable&&c.granted_by&&!c.shared),byMe=state.clues.filter(c=>c.readable&&c.granted_to?.length&&!c.shared);
  const sec=(t,none,arr)=>`<h3 class="sec">${t} <small>${arr.length}건</small></h3>${arr.length?arr.map(clueCard).join(''):`<div class="empty sm">${none}</div>`}`;
  return `<p class="tabhelp">${esc(TAB_HELP.board)}</p>${sec('나에게만 공개된 단서','아직 나에게만 건네진 단서는 없어요.',toMe)}${sec('모두에게 공개된 단서','아직 공개된 단서가 없어요. 조사 탭에서 단서를 열고 “공개하기”로 알려 보세요.',pub)}${sec('내가 일부에게 공개한 단서','고른 사람에게만 공개한 단서가 여기에 표시돼요.',byMe)}`;}
function paneEvidence(){return `<p class="tabhelp">${esc(TAB_HELP.evidence)}</p>`+(state.evidence.length?state.evidence.map(e=>`<div class="clue v-evd"><div class="prov v-evd"><b>공용 증거</b><span>시스템이 모두에게 공개</span></div><div class="ch"><b>${esc(e.title)}</b><span class="ev">${esc(state.phases.find(p=>p.id===e.phase).title)}</span></div><div class="im">${slot('evidence',e.id,'wide')}</div><div class="ct">${fmt(e.text)}</div></div>`).join(''):'<div class="empty">현장 조사 단계부터 공용 증거가 공개됩니다.<br>지금은 자신의 이야기부터 읽어보세요.</div>');}

/* ================= 추리 ================= */
const optLabel=(q,o)=>{if(q.id!=='culprit')return esc(o.label);const r=roleOf(o.id),m=memberByRole(o.id);return `<b>${esc(r.name)}</b> · ${esc(r.title)} <small class="cr">${esc(m?m.name:'참고인')}</small>`;};
function paneDeduce(){if(!['final','ending'].includes(state.phase))return '<div class="empty">최종 추리 단계에서 답안을 제출합니다.<br>채팅과 단서를 통해 가설을 정리해보세요.</div>';
  if(state.me.submission)return `<div class="locked-note"><span>제출 완료 · 수정 불가</span><span>${state.members.filter(m=>m.submitted).length}/${state.size}명 제출</span></div>${state.questions.map(q=>{const o=q.options.find(o=>o.id===state.me.submission.answers[q.id]);return `<div class="fld"><label>${esc(q.title)}</label><div class="ans">${o?optLabel(q,o):''}</div></div>`;}).join('')}<p class="hint">전원 제출 또는 제한시간 종료 후 진상이 공개됩니다.</p>`;
  const d=drafts[draftKey()]||{};
  return `<p class="hint">네 가지 선택 항목을 각 1점으로 채점합니다. 시간 종료 시 미제출자는 0점 처리됩니다.</p><form id="deduction-form">${state.questions.map(q=>`<div class="panel"><h3>${esc(q.title)}</h3><div class="opts">${q.options.map(o=>`<label class="chk"><input type="radio" name="${q.id}" value="${o.id}" required ${d[q.id]===o.id?'checked':''}><span>${optLabel(q,o)}</span></label>`).join('')}</div></div>`).join('')}<div class="fld"><label for="ded-note">추리 근거 · 선택 사항</label><textarea id="ded-note" name="note" maxlength="2000" placeholder="어떤 단서를 연결했나요?">${esc(d.note||'')}</textarea></div><div class="alignr"><button class="btn" type="submit">최종 추리 제출</button></div></form>`;}

/* ================= 엔딩 (연출 + 전체 기록) ================= */
const cnLines=(arr,start=0,cls='')=>arr.flatMap(sentences).map((t,i)=>`<p class="cn-line ${cls}" data-d="${(start+i*.9).toFixed(2)}">${esc(t)}</p>`).join('');
const cnClose=(text,start)=>sentences(text).map((t,i)=>`<p class="cn-line cn-close" data-d="${(start+i*1.1).toFixed(2)}">${esc(t)}</p>`).join('');
function endingSteps(){
  const r=state.result,E=r.ending,out=[];
  const arrestH={perfect:'범인 검거',true:'범인 검거',normal:'범인 검거',bad:'엉뚱한 지목',unresolved:'판결 보류'}[r.grade];
  const rows=state.members.map(m=>{const s=r.scores.find(x=>x.member===m.id),a=s?.answers?.culprit;return {w:m.role?who(m.role):{name:m.name,real:''},to:a?roleOf(a):null};});
  const d0=.5+rows.length*.6+.4;
  out.push({id:'jury',cls:'jury',html:`<div class="cn-k">VERDICT</div><h2 class="cn-h">배심원단의 판결</h2><div class="cn-votes">${rows.map((x,i)=>`<div class="cn-vote cn-line" data-d="${(.5+i*.6).toFixed(2)}"><span class="who">${idInline(x.w)}</span><i>→</i><span class="to">${x.to?`<b class="cn">${esc(x.to.name)}</b> <small class="cr">${esc(x.to.title)}</small>`:'<span class="abst">기권</span>'}</span></div>`).join('')}</div><div class="cn-stamp ${esc(r.grade)} cn-line" data-d="${d0.toFixed(2)}">${esc(r.stamp)}</div><div class="cn-grade cn-line" data-d="${(d0+.5).toFixed(2)}">${esc(r.title)}</div><div class="cn-sub cn-line" data-d="${(d0+.9).toFixed(2)}">전원 평균 ${r.average} / 4</div>`});
  out.push({id:'intro',cls:'intro',html:`<div class="cn-k">VERDICT</div><h2 class="cn-h">판결이 말해 주는 것</h2>${cnLines(E.intro,.3)}`});
  out.push({id:'arrest',cls:'arrest',html:`<div class="cn-k">ARREST</div><h2 class="cn-h">${arrestH}</h2>${cnLines(E.arrest,.3,'cn-scene')}`});
  const tl=[...E.timeline].sort((a,b)=>(timeKey(a[0])??0)-(timeKey(b[0])??0)),dt=.3+E.truth.flatMap(sentences).length*.9+.3;
  out.push({id:'truth',cls:'truth',html:`<div class="cn-k">TRUTH</div><h2 class="cn-h">사건의 진상</h2>${cnLines(E.truth,.3)}<h3 class="cn-g cn-line" data-d="${dt.toFixed(2)}">그날 밤의 시간순 기록</h3><ol class="cn-tl">${tl.map(([t,d],i)=>`<li class="cn-line" data-d="${(dt+.4+i*.35).toFixed(2)}"><time>${esc(t)}</time><span>${fmt(d)}</span></li>`).join('')}</ol>`});
  let d=.3,fh=`<div class="cn-k">EPILOGUE</div><h2 class="cn-h">각자의 밤</h2>`;
  const label={culprit:'진범',right:'진실을 짚은 사람들',wrong:'진실을 놓친 사람들'};
  for(const g of E.groups){fh+=`<h3 class="cn-g cn-line" data-d="${d.toFixed(2)}">${label[g.kind]}</h3>`;d+=.5;
    if(g.link){fh+=`<p class="cn-line cn-link" data-d="${d.toFixed(2)}">${esc(g.link)}</p>`;d+=.6;}
    for(const id of g.members){const s=r.scores.find(x=>x.member===id),m=memberById(id),w=m?.role?who(m.role):{name:m?.name||'',title:'',real:''};
      fh+=`<div class="cn-card cn-line" data-d="${d.toFixed(2)}"><div class="cn-who">${idInline(w,true)}<em>${s.score}/4</em></div>${P(s.epilogue,'cn-p')}</div>`;d+=.6;}}
  if(E.absent.length){fh+=`<h3 class="cn-g cn-line" data-d="${d.toFixed(2)}">그 밤 자리에 없던 사람들</h3>`;d+=.5;
    for(const a of E.absent){fh+=`<div class="cn-card cn-line" data-d="${d.toFixed(2)}"><div class="cn-who"><b class="cn">${esc(roleOf(a.role).name)}</b> <span class="cj">${esc(roleOf(a.role).title)}</span><em>참고인</em></div>${a.lines.map(l=>P(l,'cn-p')).join('')}</div>`;d+=.6;}}
  out.push({id:'fates',cls:'fates',html:fh});
  const da=.3+E.aftermath.flatMap(sentences).length*.9+.4;
  out.push({id:'after',cls:'after',html:`<div class="cn-k">AFTER</div><h2 class="cn-h">그 후</h2>${cnLines(E.aftermath,.3)}${cnClose(E.closing,da)}`});
  out.push({id:'end',cls:'end',html:`<div class="cn-k">THE END</div><div class="cn-stamp ${esc(r.grade)}">${esc(r.stamp)}</div><div class="cn-grade">${esc(r.title)}</div><div class="cn-sub">전원 평균 ${r.average} / 4 · 답안 ${r.scores.filter(s=>s.submitted).length}/${state.size}명 제출</div>${cnClose(E.closing,.4)}<div class="cn-btns"><button class="btn" data-action="cine-close">전체 기록 보러 가기</button><button class="btn ghost" data-action="cine-replay">처음부터 다시 보기</button></div>`});
  return out;}
const applyDelays=root=>root.querySelectorAll('[data-d]').forEach(e=>e.style.setProperty('--d',e.dataset.d+'s'));
function startCine(){if(!state?.result)return;cineOn=true;cineStep=0;renderCine();}
function renderCine(){const steps=endingSteps(),s=steps[cineStep],last=cineStep===steps.length-1;
  $('#cine').innerHTML=`<div class="cn-wrap ${s.cls}"><div class="cn-bars"></div><button class="cn-skip" data-action="cine-close">건너뛰기 ✕</button><div class="cn-body" id="cn-body" tabindex="-1">${s.html}</div><div class="cn-nav"><button class="btn sm ghost" data-action="cine-prev" ${cineStep?'':'disabled'}>‹ 이전</button><div class="cn-dots">${steps.map((_,i)=>`<i class="${i===cineStep?'on':i<cineStep?'done':''}"></i>`).join('')}</div><button class="btn sm ghost" data-action="cine-all">모두 표시</button>${last?'':'<button class="btn sm" data-action="cine-next">다음 ›</button>'}</div></div>`;
  applyDelays($('#cine'));$('#cine').classList.add('on');document.body.classList.add('cine-open');$('#cn-body')?.focus({preventScroll:true});}
function closeCine(){cineOn=false;saved.set(cineKey(),true);$('#cine').classList.remove('on');$('#cine').innerHTML='';document.body.classList.remove('cine-open');tab='ending';lastSig='';renderRoom();window.scrollTo(0,0);}
function paneEnding(){const r=state.result;if(!r)return '';
  return `<div class="cn-top"><div class="cn-stamp ${esc(r.grade)}">${esc(r.stamp)}</div><div class="cn-grade">${esc(r.title)}</div><div class="cn-sub">전원 평균 ${r.average} / 4 · 답안 ${r.scores.filter(s=>s.submitted).length}/${state.size}명 제출</div><button class="btn" data-action="cine-replay">▶ 엔딩 연출 다시 보기</button></div>
<div class="cn-static">${endingSteps().filter(s=>s.id!=='end').map(s=>`<section class="cn-sec ${s.cls}">${s.html}</section>`).join('')}</div>
<h3 class="sec">점수</h3><div class="bars">${r.scores.map(s=>{const m=memberById(s.member),w=m?.role?who(m.role):{name:m?.name||'',real:''};return `<div class="bar-row"><span>${idInline(w)}</span><i class="s${s.score}"></i><b>${s.score}</b></div>`;}).join('')}</div>
<h3 class="sec">제출 답안과 정답</h3>${r.scores.map(s=>{const m=memberById(s.member),w=m?.role?who(m.role):{name:m?.name||'',title:'',real:''};return `<details class="ansdet"><summary><span>${idInline(w,true)}</span><em>${s.score} / 4</em></summary>${state.questions.map(q=>{const o=q.options.find(o=>o.id===s.answers[q.id]);return `<p>${esc(q.title)}<br>${s.marks[q.id]?'✓':'✕'} ${o?optLabel(q,o):'미제출'}</p>`;}).join('')}<p>근거: ${esc(s.note||'미작성')}</p></details>`;}).join('')}
<details><summary class="hint">집단 판정 기준</summary><p class="hint">단독 최다 득표가 진범이면 평균 점수로 NORMAL·TRUE·PERFECT를 판정합니다. TRUE는 평균 2.5 이상, PERFECT는 평균 3.5 이상이면서 과반수가 과거 사건을 맞혔을 때입니다. 동률 또는 무투표는 판결 보류입니다. 미제출자도 평균의 분모에 포함됩니다.</p></details>`;}
function paneArchive(){const b=state.archive.find(x=>x.id===archiveId)||state.archive[0];
  return `<p class="hint">모든 인물의 원래 이야기가 열렸습니다. 조사 탭에서 모든 단서도 읽을 수 있어요.</p><div class="invlist">${state.archive.map(r=>`<button class="${r.id===b.id?'on':''}" data-action="archive" data-id="${r.id}">${slot('photos',r.id)}<span><b>${esc(r.name)}</b><small>${esc(r.title)}</small><small>${esc(who(r.id).real||'참고인')}</small></span></button>`).join('')}</div>${bookHead(b)}<h3 class="sec">이야기</h3>${paneStory(b)}<h3 class="sec">시간표</h3>${paneTime(b)}<h3 class="sec">비밀</h3>${paneSecret(b)}`;}


/* ================= 공개 대화상자 · 방 화면 ================= */
function openShare(cid){const c=state.clues.find(x=>x.id===cid);if(!c)return;const others=state.members.filter(m=>m.id!==state.me.id),done=new Set(c.granted_to||[]);
  $('#share-title').textContent=`“${c.title}”`;
  $('#share-list').innerHTML=`<label class="chk all"><input type="checkbox" id="share-all"><span><b>모두에게 공개</b> · 전체 선택</span></label>`+others.map(m=>{const w=m.role?who(m.role):{name:m.name,real:''};return `<label class="chk"><input type="checkbox" name="to" value="${m.id}" ${done.has(m.id)?'checked disabled':''}><span>${idInline(w,true)}${done.has(m.id)?' · 이미 공개':''}</span></label>`;}).join('');
  $('#sharebox').dataset.clue=cid;$('#sharebox').showModal();}
function syncShareAll(source){const boxes=[...document.querySelectorAll('#share-list input[name=to]:not(:disabled)')],all=$('#share-all');if(!all)return;
  if(source==='all')boxes.forEach(b=>b.checked=all.checked);else all.checked=boxes.length>0&&boxes.every(b=>b.checked);}

const hlTab=()=>{const g=catalog.guide?.[state?.phase];return g&&!saved.get(visKey())?g.tab:null;};
function guideCard(){const g=catalog.guide?.[state.phase];if(!g)return '';const id='guide-'+state.phase;
  return `<div class="guidecard ${accOpen.has(id)?'open':''}"><button data-action="acc" data-id="${id}"><span>📌 지금 할 일 · ${esc(g.title)}</span><span class="chev">›</span></button><div class="body"><ol>${g.steps.map(s=>`<li>${fmt(s)}</li>`).join('')}</ol><button class="btn sm" data-action="goto" data-id="${g.tab}">${esc(g.cta)}</button></div></div>`;}
function stagebar(){const g=catalog.guide?.[state.phase];if(!g||state.phase==='ending')return '';
  if(state.phase==='final'){const n=state.members.filter(m=>m.submitted).length;return `<div class="stagebar"><div><b>${n}/${state.size}명 제출</b><small>${esc(g.agree)}</small></div><button class="btn sm" data-action="goto" data-id="deduce">추리 탭으로</button></div>`;}
  const voted=state.votes.includes(state.me.id),names=state.votes.map(id=>whoMember(id).name).join(', ');
  return `<div class="stagebar agree"><div><b>${state.votes.length}/${state.size}명이 다음 단계에 동의했어요</b>${names?`<small>동의한 사람: ${esc(names)}</small>`:''}<small>${esc(g.agree)}</small></div><button class="btn sm ${voted?'ghost':''}" data-action="vote">${voted?'동의 취소':'다 했어요 · 다음 단계 동의'}</button></div>`;}
function renderRoom(){rememberForm();const idx=state.phases.findIndex(p=>p.id===state.phase),phase=state.phases[idx];
  const steps=`<div class="step-row">${state.phases.map((p,i)=>`<span class="${i===idx?'cur':i<idx?'done':''}">${String(i+1).padStart(2,'0')} ${esc(p.title)}</span>`).join('')}</div>`;
  const lobbyPhase=state.phase==='lobby';
  const tabs=lobbyPhase?[]:[['story','이야기'],['time','시간표'],['secret','비밀'],['clues','조사'],['board','단서'],['evidence','공용 증거'],['memo','메모'],['deduce','추리'],...(state.phase==='ending'?[['ending','엔딩'],['archive','전체 기록']]:[])];
  if(!lobbyPhase&&!tabs.some(t=>t[0]===tab))tab='story';
  if(tab==='board')newShared=0;
  const g=catalog.guide?.[state.phase];if(g&&tab===g.tab)saved.set(visKey(),true);
  const hl=lobbyPhase?null:hlTab();
  const mode=lobbyPhase?'home':MODES[tab];document.body.dataset.mode=mode;
  const me=memberById(state.me.id),mw=state.me.role?who(state.me.role):null;
  const right=`<span class="act" id="clock"></span>${lobbyPhase?'':`<span class="act tok">🪙 ${state.me.tokens}</span>`}<button class="act chatb" data-action="chat-open" aria-label="채팅 열기">💬 채팅<span class="dot hidden" id="unread"></span></button>`;
  const kick=`${mw?esc(mw.name)+' <span class="cr">'+esc(mw.real)+'</span>':esc(me?.name||'')} · ${esc(phase.title)} · <span class="conn ${connected?'':'off'}" id="connection">${connected?'● 연결됨':'● 재연결 중'}</span>`;
  let body;
  if(lobbyPhase)body=lobby();
  else{const b=state.book,pv=['story','time','secret','memo','deduce'].includes(tab);
    const content={story:()=>paneStory(b),time:()=>paneTime(b),secret:()=>paneSecret(b),clues:paneClues,board:paneBoard,evidence:paneEvidence,memo:paneMemo,deduce:paneDeduce,ending:paneEnding,archive:paneArchive}[tab]();
    body=`${steps}${notifBar()}${guideCard()}${stagebar()}${tab==='archive'||tab==='ending'?'':bookHead(b)}<nav class="tabs">${tabs.map(([k,l])=>`<button class="tab ${tab===k?'on':''} ${k===hl&&tab!==k?'hl':''} ${['story','time','secret','memo','deduce'].includes(k)?'pv':''}" data-action="tab" data-id="${k}">${l}${k===hl&&tab!==k?'<span class="new">NEW</span>':''}${k==='board'&&newShared>0&&tab!=='board'?`<span class="new">${newShared}</span>`:''}</button>`).join('')}</nav><section class="pane on ${pv?'pv':''}" data-wm="PRIVATE · 본인 열람" id="main">${content}</section>`;}
  const bar=MODEBAR[tab];
  $('#app').innerHTML=`${topbar(catalog.title,kick,right,true)}${bar&&!lobbyPhase?`<div class="modebar ${mode}"><span class="ic">${bar[0]}</span>${bar[1]}</div>`:''}<main class="wrap">${body}</main>`;
  const id=document.activeElement?.id;if(id&&document.getElementById(id)){const el=document.getElementById(id);if(formDrafts[id]!==undefined)el.value=formDrafts[id];}
  markUnread();updateClock();}


/* ================= 채팅 ================= */
const incoming=m=>m.sender&&m.sender!==state.me.id;
const unreadCount=()=>state?state.messages.filter(m=>incoming(m)&&m.id>lastSeenMsg).length:0;
function seenAll(){const mx=state.messages.reduce((a,m)=>Math.max(a,m.id),0);if(mx>lastSeenMsg){lastSeenMsg=mx;saved.set('nr-seen:'+draftKey(),mx);}}
function markUnread(){const fab=$('#fab');if(!state){fab.hidden=true;return;}
  const n=chatOpen?0:unreadCount(),txt=n>99?'99+':String(n),el=$('#unread'),f=$('#fabn');
  if(el){el.textContent=txt;el.classList.toggle('hidden',!n);}
  f.textContent=txt;f.hidden=!n;fab.hidden=chatOpen||cineOn;
  document.title=n&&document.hidden?`(${n}) 머더 미스터리`:'모바일 머더 미스터리 | 친구들과 함께하는 추리 게임';}
function renderChat(force=false){
  const signature=JSON.stringify([state.messages.length,state.messages.at(-1)?.id,state.members.map(m=>[m.id,m.name,m.role]),chatTarget]);
  if(!force&&signature===chatSig)return;chatSig=signature;
  const select=$('#chat-target'),log=$('#chat-log');
  select.innerHTML='<option value="">모두에게 · 공개 대화</option>'+state.members.filter(m=>m.id!==state.me.id).map(m=>`<option value="${m.id}" ${chatTarget===m.id?'selected':''}>${esc(idPlain(whoMember(m.id)))}에게 귓속말</option>`).join('');
  $('#chat-label').textContent=chatTarget?'선택한 친구와 나만 읽습니다':'공개 대화';
  const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<70,oldTop=log.scrollTop;
  const messages=state.messages.filter(m=>chatTarget?m.sender===state.me.id&&m.to===chatTarget||m.sender===chatTarget&&m.to===state.me.id:!m.to);
  log.innerHTML=messages.map(m=>{if(!m.sender)return `<div class="msg system">${esc(m.text)}</div>`;
    return `<div class="msg ${m.sender===state.me.id?'mine':''} ${m.to?'private':''}"><small>${idInline(whoMember(m.sender))} · ${new Date(m.at*1000).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}${m.to?' · 귓속말':''}</small><p>${esc(m.text)}</p></div>`;}).join('')||'<p class="empty">첫 메시지를 보내보세요.</p>';
  if(bottom||force)log.scrollTop=log.scrollHeight;else log.scrollTop=oldTop;
  if(chatOpen)seenAll();}
function setChat(open){chatOpen=open;$('#chat').classList.toggle('open',open);if(open){renderChat(true);seenAll();}markUnread();}

/* ================= 알림: 앱 안 팝업 + 브라우저 알림 ================= */
let actx=null;
const unlockAudio=()=>{try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();actx.resume?.();}catch{}};
function beep(){try{if(!actx)return;const o=actx.createOscillator(),g=actx.createGain(),t=actx.currentTime;o.type='sine';o.frequency.value=880;o.connect(g);g.connect(actx.destination);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.12,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.25);o.start(t);o.stop(t+.26);}catch{}}
const hasBatchim=w=>{const c=(String(w).trim().slice(-1)||'').charCodeAt(0)-0xAC00;return c>=0&&c<11172&&c%28!==0;};
const eul=w=>hasBatchim(w)?'을':'를';
const notifAskable=()=>'Notification' in window&&Notification.permission==='default';
async function regSW(){if('serviceWorker' in navigator){try{swReg=await navigator.serviceWorker.register('/sw.js');}catch{}}}
function sysNotify(title,body,tag){
  if(!('Notification' in window)||Notification.permission!=='granted'||!document.hidden)return;
  try{if(swReg?.showNotification)swReg.showNotification(title,{body,tag,icon:'/icon.svg',renotify:true});else{const n=new Notification(title,{body,tag,icon:'/icon.svg'});n.onclick=()=>{window.focus();n.close();};}}catch{}}
async function askNotif(){try{const p=await Notification.requestPermission();toast(p==='granted'?'알림을 켰어요. 다른 탭에 있어도 새 채팅과 단서 공개를 알려드려요.':'알림이 꺼져 있어요. 브라우저 설정에서 허용하면 켤 수 있어요.');}catch{toast('이 브라우저에서는 알림을 켤 수 없어요.');}if(state&&state.phase)renderRoom();}
function pushNotif({icon='💬',title,text,btn,action,id,kind=''}){
  const box=$('#notifs'),el=document.createElement('div');el.className='notif k-'+kind;
  el.innerHTML=`<div class="ni" aria-hidden="true">${icon}</div><div class="nb"><b>${esc(title)}</b><p>${esc(text)}</p></div>${btn?`<button class="btn sm" data-action="${action}" data-id="${esc(id||'')}">${esc(btn)}</button>`:''}<button class="nx" data-action="notif-x" aria-label="닫기">×</button>`;
  box.appendChild(el);while(box.children.length>3)box.firstChild.remove();setTimeout(()=>el.remove(),9000);beep();try{navigator.vibrate?.([60,40,60]);}catch{}}
function evInfo(ev){
  const by=idPlain(whoMember(ev.by)),to=(ev.to||[]).map(id=>whoMember(id).name).join(', ');
  if(ev.all)return {icon:'📣',title:'단서가 공개되었어요',text:`${by}님이 단서 ‘${ev.title}’${eul(ev.title)} 모두에게 공개했습니다.`,where:'단서 탭 › 모두에게 공개된 단서'};
  if(ev.to_me)return {icon:'🔐',title:'나에게만 공개된 단서',text:`${by}님이 나에게만 단서 ‘${ev.title}’${eul(ev.title)} 공개했습니다.`,where:'단서 탭 › 나에게만 공개된 단서'};
  return {icon:'🔒',title:'단서 공개 알림',text:`${by}님이 ${to}에게 단서를 공개했습니다. (내용은 비공개)`,where:''};}
function handleIncoming(){
  const mx=state.messages.reduce((a,m)=>Math.max(a,m.id),0),fresh=state.messages.filter(m=>m.id>notifiedMsg&&incoming(m));notifiedMsg=Math.max(notifiedMsg,mx);
  if(!primed||!fresh.length)return;
  const last=fresh.at(-1),w=whoMember(last.sender),active=chatOpen&&!document.hidden&&(last.to?chatTarget===last.sender:!chatTarget);
  if(active)return;
  const title=`${idPlain(w)}${last.to?' · 귓속말':''}`,text=fresh.length>1?`새 메시지 ${fresh.length}개 · ${last.text}`:last.text;
  pushNotif({icon:last.to?'🤫':'💬',title,text:text.slice(0,90),btn:'채팅 열기',action:'notif-chat',id:last.to?last.sender:'',kind:'chat'});
  sysNotify(title,text.slice(0,120),'chat');}
function handleEvents(){
  const evs=state.events||[],mx=evs.reduce((a,e)=>Math.max(a,e.id),0),fresh=evs.filter(e=>e.id>notifiedEv&&!e.mine);notifiedEv=Math.max(notifiedEv,mx);
  if(!primed)return;
  for(const ev of fresh){const i=evInfo(ev);if(ev.all||ev.to_me)newShared++;
    pushNotif({icon:i.icon,title:i.title,text:i.text+(i.where?`\n📍 ${i.where}`:''),btn:i.where?'단서 탭 보기':'',action:'notif-tab',id:'board',kind:'clue'});sysNotify(i.title,i.text,'clue');}}

/* ================= 단계 안내 팝업 · 튜토리얼 ================= */
function showOverlay(prev,next){
  const nm=id=>state.phases.find(p=>p.id===id)?.title||id,g=catalog.guide?.[next];
  $('#overlay').innerHTML=`<div class="rov"><div class="rov-in">${prev&&prev!=='lobby'?`<div class="rov-end">${esc(nm(prev))} 종료</div>`:''}<div class="rov-stamp">${esc(nm(next))}</div><div class="rov-sub">시작</div><div class="rov-desc">${esc(PHASE_DESC[next]||'')}</div>${g?`<div class="rov-guide"><h4>이번 단계에서 할 일</h4><ol>${g.steps.map(s=>`<li>${fmt(s)}</li>`).join('')}</ol><div class="rov-agree"><b>다음 단계로 넘어가려면</b>${fmt(g.agree)}</div></div><div class="rov-btns"><button class="btn" data-action="rov-go" data-id="${g.tab}">${esc(g.cta)}</button><button class="btn ghost" data-action="rov-close">닫고 직접 볼게요</button></div>`:'<button class="btn" data-action="rov-close">확인</button>'}</div></div>`;
  try{navigator.vibrate?.([80,40,80]);}catch{}}
function showTutorial(i=0){
  const slides=HOWTO,n=slides.length;i=Math.max(0,Math.min(n-1,i));tutIdx=i;const s=slides[i],last=i===n-1,two=v=>String(v).padStart(2,'0');
  $('#tutorial').innerHTML=`<div class="tut" role="dialog" aria-modal="true" aria-label="게임 방법"><div class="tut-card"><button class="tut-x" data-action="tut-close" aria-label="닫기">✕</button><div class="tut-step">STEP ${two(i+1)}<span> / ${two(n)}</span></div><div class="tut-ic" aria-hidden="true">${s.icon}</div><h2>${esc(s.title)}</h2><div class="tut-lines">${s.lines.map(l=>`<p>${rich(l)}</p>`).join('')}</div>${last?`<p class="tut-note">${esc(HOWTO_NOTE)}</p>`:''}<div class="tut-dots" aria-label="${i+1} / ${n} 단계">${slides.map((_,k)=>`<button type="button" class="${k===i?'on':''}" data-action="tut-go" data-id="${k}" aria-label="${k+1}단계로 이동" ${k===i?'aria-current="step"':''}></button>`).join('')}</div><div class="tut-nav"><button class="btn ghost" data-action="tut-go" data-id="${i-1}" ${i?'':'disabled'}>이전</button>${last?(notifAskable()?'<button class="btn" data-action="tut-notif">🔔 알림 켜고 시작</button>':'<button class="btn" data-action="tut-close">시작하기</button>'):`<button class="btn" data-action="tut-go" data-id="${i+1}">다음</button>`}</div>${last?(notifAskable()?'<button class="tut-link" data-action="tut-close">알림 없이 시작</button>':''):'<button class="tut-link" data-action="tut-close">건너뛰기</button>'}</div></div>`;
  $('#tutorial').classList.add('on');}
function closeTutorial(){saved.set('nr-tutorial-seen',1);$('#tutorial').classList.remove('on');$('#tutorial').innerHTML='';}

/* ================= 상태 루프 ================= */
function update(data){
  const prior=state?.phase;state=data;if(state.scenario_meta)catalog={...catalog,...state.scenario_meta};clockOffset=state.server_now*1000-Date.now();
  if(prior&&prior!==state.phase){lastSig='';
    if(state.phase==='ending')tab='ending';
    else{if(state.phase==='intro')tab='story';else if(state.phase!=='final')tab='evidence';accOpen.add('guide-'+state.phase);showOverlay(prior,state.phase);}}
  else if(!prior&&state.phase==='ending')tab='ending';
  handleIncoming();handleEvents();
  const signature=JSON.stringify([state.version,state.members.map(m=>[m.id,m.role,m.ready,m.online,m.submitted]),tab,archiveId,invTarget,connected,newShared,hlTab()]);
  if(signature!==lastSig){lastSig=signature;renderRoom();}
  renderChat();markUnread();updateClock();primed=true;
  if(state.phase==='ending'&&state.result&&!cineOn&&!saved.get(cineKey()))startCine();}
function updateClock(){const el=$('#clock');if(!el||!state)return;if(!state.deadline){el.textContent=state.phase==='ending'?'CLOSED':'LOBBY';return;}const left=Math.max(0,Math.ceil((state.deadline*1000-Date.now()-clockOffset)/1000));el.textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');}
async function poll(){clearTimeout(pollTimer);if(!session)return;try{const data=await api(`rooms/${session.code}/state`);connected=true;session.member_id=data.me.id;saved.set('nr-session',session);update(data);}catch(e){connected=false;const el=$('#connection');if(el){el.classList.add('off');el.textContent='● 재연결 중';}else{toast(e.message);landing();return;}}pollTimer=setTimeout(poll,document.hidden?4000:2500);}
async function act(action,body={}){if(busy)return false;busy=true;try{const data=await api(`rooms/${session.code}/${action}`,body);connected=true;if(action==='leave'){saved.set('nr-session',null);session=null;landing();}else update(data);return true;}catch(e){toast(e.message);return false;}finally{busy=false;}}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('복사했습니다. 친구에게 바로 보내세요!');return true;}catch{const d=$('#confirm');$('#confirm-title').textContent='아래 내용을 길게 눌러 복사해주세요';$('#confirm-text').textContent=text;d.showModal();return false;}}

/* ================= 이벤트 ================= */
document.addEventListener('error',e=>{const t=e.target;if(t.tagName==='IMG'&&t.hasAttribute('data-slot')){missing.add(t.getAttribute('src'));const wide=t.closest('.slot.wide');if(wide)(wide.closest('.im')||wide).remove();else t.remove();}},true);
document.addEventListener('visibilitychange',()=>{if(state)markUnread();});
document.addEventListener('keydown',e=>{if(!$('#tutorial').classList.contains('on'))return;if(e.key==='Escape')closeTutorial();else if(e.key==='ArrowRight')showTutorial(tutIdx+1);else if(e.key==='ArrowLeft')showTutorial(tutIdx-1);});
document.addEventListener('click',async event=>{
  unlockAudio();
  if(event.target.classList?.contains('tut')){closeTutorial();return;}
  const img=event.target.closest('.clue .slot>img,.bookhead .slot>img,.invhead .slot>img');if(img){$('#zoomimg').src=img.src;$('#zoom').classList.add('on');return;}
  const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action,id=button.dataset.id;
  if(action==='zoom-close'){$('#zoom').classList.remove('on');return;}
  if(action==='rov-close'){$('#overlay').innerHTML='';return;}
  if(action==='rov-go'||action==='goto'){if(action==='rov-go')$('#overlay').innerHTML='';tab=id;lastSig='';renderRoom();window.scrollTo(0,0);return;}
  if(action==='notif-x'){button.closest('.notif')?.remove();return;}
  if(action==='notif-chat'){button.closest('.notif')?.remove();chatTarget=id||'';setChat(true);renderChat(true);return;}
  if(action==='notif-tab'){button.closest('.notif')?.remove();tab=id;newShared=0;lastSig='';renderRoom();window.scrollTo(0,0);return;}
  if(action==='notif-ask'||action==='tut-notif'){if(action==='tut-notif')closeTutorial();await askNotif();return;}
  if(action==='notif-dismiss'){saved.set('nr-notif-dismiss',1);renderRoom();return;}
  if(action==='tutorial'){showTutorial(0);return;}
  if(action==='tut-go'){showTutorial(Number(id));return;}
  if(action==='tut-close'){closeTutorial();return;}
  if(action==='cine-next'){cineStep++;renderCine();return;}
  if(action==='cine-prev'){cineStep=Math.max(0,cineStep-1);renderCine();return;}
  if(action==='cine-all'){$('#cine').classList.toggle('all');return;}
  if(action==='cine-close'){closeCine();return;}
  if(action==='cine-replay'){startCine();return;}
  if(action==='resume'){await enter(session);return;}
  if(action==='acc'){accOpen.has(id)?accOpen.delete(id):accOpen.add(id);button.closest('.acc,.guidecard')?.classList.toggle('open');return;}
  if(action==='flip'){flipped.has(id)?flipped.delete(id):flipped.add(id);document.getElementById('card-'+id)?.classList.toggle('flipped');return;}
  if(action==='tab'){tab=id;renderRoom();window.scrollTo(0,0);return;}
  if(action==='inv'){invTarget=id;renderRoom();return;}
  if(action==='archive'){archiveId=id;renderRoom();return;}
  if(action==='home'){if(state&&!await confirmInPage('시작 화면으로 갈까요?','방은 유지됩니다. 시작 화면의 ‘이어하기’로 돌아올 수 있어요.'))return;landing();return;}
  if(action==='copy-code'){const ok=await copy(state.code);if(ok){button.textContent='복사 완료 ✓';button.classList.add('copied');setTimeout(()=>{if(button.isConnected){button.textContent='초대 코드 복사';button.classList.remove('copied');}},2200);}return;}
  if(action==='invite'){await copy(location.origin+'/?room='+state.code);return;}
  if(action==='share-invite'){try{await navigator.share({title:catalog.title,text:`${catalog.title} 초대 코드 ${state.code}`,url:location.origin+'/?room='+state.code});}catch{}return;}
  if(action==='chat-open'||action==='chat-close'){setChat(action==='chat-open');return;}
  if(action==='share'){openShare(id);return;}
  if(action==='share-cancel'){$('#sharebox').close();return;}
  if(action==='leave'&&!await confirmInPage('대기실을 나갈까요?','선택한 역할과 자리를 다른 사람이 사용할 수 있습니다.'))return;
  if(action==='investigate'&&!await confirmInPage('이 봉투를 뜯을까요?','조사 토큰 1개를 사용합니다. 내용은 먼저 조사한 나에게만 공개됩니다.'))return;
  if(action==='investigate'){justOpened.add(id);justSpent=true;lastSig='';}
  const ok=await act(action,action==='role'?{role:id}:action==='investigate'?{clue:id}:{});
  if(action==='role'&&ok)flipped.delete(id);
  if(action==='investigate'){if(!ok)justOpened.delete(id);setTimeout(()=>{justOpened.delete(id);justSpent=false;},1800);}
});
document.addEventListener('input',e=>{
  if(e.target.closest('#deduction-form')){const form=new FormData($('#deduction-form'));drafts[draftKey()]=Object.fromEntries(form);saved.set('nr-drafts',drafts);}
  if(e.target.id==='memo'){const st=$('#memost');st.textContent='저장 중…';st.classList.add('dirty');clearTimeout(input.t);input.t=setTimeout(()=>{saved.set('nr-memo:'+draftKey(),e.target.value);st.textContent='저장됨 · 이 기기에만 보관';st.classList.remove('dirty');},500);}
});
function input(){}
document.addEventListener('change',e=>{
  if(e.target.id==='chat-target'){chatTarget=e.target.value;renderChat(true);}
  if(e.target.id==='share-all')syncShareAll('all');else if(e.target.name==='to'&&e.target.closest('#share-list'))syncShareAll('one');});
document.addEventListener('submit',async e=>{
  const form=e.target;if(!['create-form','join-form','chat-form','deduction-form','share-form'].includes(form.id))return;e.preventDefault();
  const values=Object.fromEntries(new FormData(form)),button=form.querySelector('[type=submit]');button.disabled=true;
  try{
    if(form.id==='create-form'||form.id==='join-form'){
      if(session&&!await confirmInPage('새로운 방으로 입장할까요?','이 기기에서는 한 번에 하나의 방에만 참여할 수 있어요. 새 방으로 들어가면 지금 방으로는 이 기기로 돌아올 수 없습니다.'))return;
      const result=form.id==='create-form'?await api('rooms',{name:values.name,size:Number(values.size),pace:values.pace,scenario:values.scenario||catalog.default_scenario||catalog.id}):await api(`rooms/${values.code.trim().toUpperCase()}/join`,{name:values.name});await enter(result);
    }else if(form.id==='chat-form'){
      const text=values.text.trim();if(!text)return;const data=await api(`rooms/${session.code}/chat`,{text,to:chatTarget||null});$('#chat-input').value='';update(data);
    }else if(form.id==='share-form'){
      const boxes=[...document.querySelectorAll('#share-list input[name=to]:not(:disabled)')],chosen=boxes.filter(b=>b.checked).map(b=>b.value),everyone=$('#share-all').checked;
      if(!chosen.length){toast('공개할 사람을 선택해주세요.');return;}
      const cid=$('#sharebox').dataset.clue;$('#sharebox').close();
      if(await act('share',{clue:cid,to:everyone?'all':chosen}))toast(everyone?'모두에게 공개했어요. 단서 탭에서 확인할 수 있어요.':'선택한 사람에게만 공개했어요.');
    }else if(form.id==='deduction-form'){
      if(!await confirmInPage('추리를 제출할까요?','제출 후에는 수정할 수 없습니다. 전원 제출 또는 시간 종료 후 진상이 공개됩니다.'))return;
      const {note,...answers}=values;const data=await api(`rooms/${session.code}/submit`,{answers,note});update(data);toast('추리가 제출됐습니다.');
    }
  }catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
});
setInterval(updateClock,1000);
(async()=>{try{catalog=await api('catalog');applyTheme();regSW();landing();}catch(e){$('#app').innerHTML='<div class="boot">서버에 연결하지 못했습니다. 서버가 실행 중인지 확인 후 새로고침해주세요.</div>';}})();
