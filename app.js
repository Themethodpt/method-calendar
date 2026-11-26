{
const CFG=window.METHOD_CONFIG||{};
const COLORS=['#b5583a','#3f7d5a','#b08a2e','#5a5aa6','#3a7ca5','#c7783a','#6b7a3a','#a14f7a','#2f8f86','#8a5a3c','#7d6bb0','#5f7f99'];
const TYPES=['Single session','Partner session','Assessment'];
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const OPEN=5,CLOSE=21;
const pad=n=>String(n).padStart(2,'0');
const iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const parse=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const addDays=(d,n)=>{const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()+n);return x};
const satOf=d=>addDays(d,-((d.getDay()+1)%7));
const hh=h=>(h%12||12)+':00 '+(h<12?'AM':'PM');
const md=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const app=document.getElementById('app');

const configured=CFG.url&&CFG.anonKey&&window.supabase;
const sb=configured?window.supabase.createClient(CFG.url,CFG.anonKey):null;

// ---------- state ----------
let S={trainers:[],clients:[],sessions:[],checkins:{},tvNames:'first',spotlight:null,profiles:[],totals:{},extra:{}};
let U=null;          // {uid,email,name,role,trainer}
let viewAs=null;     // admin previewing a trainer
let range=null;      // loaded session date range
let authMode='in';   // in | up | forgot | recovery
let authMsg='',authErr='';
let tvData=null;
const V={tab:'week',week:satOf(new Date()),filter:'all',day:iso(new Date()),q:''};

const T=id=>S.trainers.find(t=>t.id===id)||{id,name:'Unknown',color:'#888',hours:{}};
const C=id=>S.clients.find(c=>c.id===id)||(S.extra[id]?{id,name:S.extra[id].name,trainer:S.extra[id].trainer,active:true,prior:0}:null);
const isAdmin=()=>U&&U.role==='admin'&&!viewAs;
const me=()=>viewAs||(U&&U.role==='trainer'?U.trainer:null);
const inWeek=(s,w)=>{const d=parse(s.date);return d>=w&&d<addDays(w,7)};
const visible=()=>S.sessions.filter(s=>me()?s.trainer===me():true);
const cover=s=>{const c=C(s.client);return c&&c.trainer&&c.trainer!==s.trainer};
const short=n=>{const p=n.split(' ');return p[0]+(p[1]?' '+p[1][0]+'.':'')};

function toast(msg,bad){const t=document.createElement('div');t.className='toast'+(bad?' bad':'');t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),bad?6000:2600)}
async function q(p){const {data,error}=await p;if(error)throw error;return data}
async function act(fn,okMsg){
  document.body.classList.add('busy');
  try{await fn();await load();render();if(okMsg)toast(okMsg)}
  catch(e){console.error(e);toast('That didn’t save: '+(e.message||e),true)}
  finally{document.body.classList.remove('busy')}
}

// ---------- loading ----------
async function pageAll(build){let out=[],from=0;for(;;){const d=await q(build().range(from,from+999));out=out.concat(d);if(d.length<1000)return out;from+=1000}}
async function load(){
  if(!U)return;
  if(!range)range={from:iso(addDays(satOf(new Date()),-56)),to:iso(addDays(satOf(new Date()),26*7))};
  const wk=iso(satOf(new Date()));
  const [tr,cl,se,ck,st,tot]=await Promise.all([
    q(sb.from('trainers').select('*').order('name')),
    pageAll(()=>sb.from('clients').select('*').order('first_name')),
    pageAll(()=>sb.from('sessions').select('*').gte('date',range.from).lte('date',range.to).order('date')),
    q(sb.from('checkins').select('*').eq('week_start',wk)),
    q(sb.from('settings').select('*')),
    q(sb.rpc('client_totals'))
  ]);
  S.trainers=tr.map(t=>({id:t.id,name:t.name,full:t.full_name,color:t.color,hours:t.hours||{},active:t.active}));
  S.clients=cl.map(c=>({id:c.id,first:c.first_name,last:c.last_name,name:(c.first_name+' '+(c.last_name||'')).trim(),trainer:c.trainer_id||'',active:c.active,prior:c.prior_sessions,since:c.member_since,bday:c.birthday,left:c.sessions_left,pet:c.pet_name?{name:c.pet_name,type:c.pet_type||'',photo:c.pet_photo}:null}));
  S.sessions=se.map(s=>({id:s.id,date:s.date,hour:s.hour,client:s.client_id,trainer:s.trainer_id,type:s.type}));
  S.checkins={[wk]:Object.fromEntries(ck.map(c=>[c.client_id,c.status]))};
  S.totals=Object.fromEntries(tot.map(r=>[r.id,r.total]));
  const set=Object.fromEntries(st.map(r=>[r.key,r.value]));
  S.tvNames=set.tv_names||'first';
  const missing=[...new Set(S.sessions.map(s=>s.client))].filter(id=>!S.clients.some(c=>c.id===id));
  S.extra={};
  if(missing.length){const r=await q(sb.rpc('session_client_names',{ids:missing}));r.forEach(x=>S.extra[x.id]={name:x.name,trainer:x.trainer_id||''})}
  if(U.role==='admin')S.profiles=await q(sb.from('profiles').select('*').order('created_at'));
}
async function ensureRange(d){
  const k=iso(d),k2=iso(addDays(d,7));
  if(k>=range.from&&k2<=range.to)return;
  range={from:k<range.from?iso(addDays(d,-28)):range.from,to:k2>range.to?iso(addDays(d,56)):range.to};
  await load();
}

async function whoAmI(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){U=null;return}
  const p=await q(sb.from('profiles').select('*').eq('id',session.user.id).maybeSingle());
  U={uid:session.user.id,email:session.user.email,name:p?.display_name||session.user.email,role:p?.role||'pending',trainer:p?.trainer_id||null};
  if(U.role==='trainer'&&!U.trainer)U.role='pending';
}

// ---------- routing ----------
function render(){
  if(!configured)return setupNeeded();
  if(location.hash==='#tv')return tvLoad();
  if(authMode==='recovery')return login();
  if(!U)return login();
  if(U.role==='pending')return pending();
  app.innerHTML=shell();
}
function setupNeeded(){app.innerHTML=`<div class="wait"><div class="box"><h2>Almost ready</h2><p class="muted">This copy of The Method Calendar isn’t connected to its database yet. Add the Supabase URL and key to <b>config.js</b>.</p></div></div>`}
function pending(){app.innerHTML=`<div class="wait"><div class="box"><div class="logo"><i>M</i><div>THE METHOD<small>Trainer schedule</small></div></div><h2>Thanks, ${esc(U.name)}.</h2><p>Your account is set up. Craig or Wyatt now needs to approve it and link it to your trainer name. Once they do, refresh this page.</p><div class="row" style="display:flex;gap:8px"><button class="btn" data-act="refresh">Refresh</button><button class="btn" data-act="logout">Sign out</button></div></div></div>`}

function login(){
  const m=authMode;
  const title={in:'Sign in',up:'Create your account',forgot:'Reset your password',recovery:'Choose a new password'}[m];
  const form=m==='in'?`<form class="authf" id="af"><input id="ae" type="email" placeholder="Email" autocomplete="email" autocapitalize="none" required><input id="ap" type="password" placeholder="Password" autocomplete="current-password" required><div class="row"><button class="btn pri">Sign in</button><button type="button" class="linkbtn" data-auth="forgot">Forgot password?</button></div><div class="muted" style="font-size:14px">New trainer? <button type="button" class="linkbtn" data-auth="up">Create an account</button></div></form>`
   :m==='up'?`<form class="authf" id="af"><input id="an" placeholder="Your first name" required><input id="ae" type="email" placeholder="Email" autocomplete="email" autocapitalize="none" required><input id="ap" type="password" placeholder="Choose a password (8+ characters)" minlength="8" autocomplete="new-password" required><div class="row"><button class="btn pri">Create account</button><button type="button" class="linkbtn" data-auth="in">Back to sign in</button></div><div class="muted" style="font-size:13px">After you sign up, Craig or Wyatt approves your account and links it to your trainer name.</div></form>`
   :m==='forgot'?`<form class="authf" id="af"><input id="ae" type="email" placeholder="Email" autocomplete="email" autocapitalize="none" required><div class="row"><button class="btn pri">Email me a reset link</button><button type="button" class="linkbtn" data-auth="in">Back to sign in</button></div></form>`
   :`<form class="authf" id="af"><input id="ap" type="password" placeholder="New password (8+ characters)" minlength="8" autocomplete="new-password" required><div class="row"><button class="btn pri">Save new password</button></div></form>`;
  app.innerHTML=`<div class="login"><div class="lbrand"><div class="logo"><i>M</i><div>THE METHOD<small>Trainer schedule</small></div></div>
  <div><h1>One calendar for the whole team.</h1><p>Admins see every trainer’s sessions and the payroll week. Each trainer signs in privately to manage their own schedule and clients. The gym TV shows who is training today.</p></div><span></span></div>
  <div class="lpane"><h2>${title}</h2>${form}${authErr?`<div class="err">${esc(authErr)}</div>`:''}${authMsg?`<div class="ok">${esc(authMsg)}</div>`:''}
  <button class="tvlink" data-go="tv"><svg width="44" height="34" viewBox="0 0 44 34"><rect x="1" y="1" width="42" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 33h16M22 27v6" stroke="currentColor" stroke-width="2"/><path d="M8 9h12M8 15h20M8 21h9" stroke="var(--ac)" stroke-width="3"/></svg><span><b>Gym TV display</b><br><span class="muted" style="font-size:13px">Public screen for the gym. No sign-in needed.</span></span></button></div></div>`;
}

// ---------- check-in ----------
const curWk=()=>satOf(new Date());
const wkKey=()=>iso(curWk());
const ciOf=id=>(S.checkins[wkKey()]||{})[id];
const noSess=c=>!S.sessions.some(s=>s.client===c.id&&inWeek(s,curWk()));
const needs=tid=>S.clients.filter(c=>c.active&&(tid?c.trainer===tid:c.trainer)&&noSess(c)&&!ciOf(c.id));
const lastSess=c=>{const t=iso(new Date());const l=S.sessions.filter(s=>s.client===c.id&&s.date<t).sort((a,b)=>b.date.localeCompare(a.date))[0];return l?parse(l.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'not in the last 8 weeks'};
function checkin(){
  const list=needs(me()).sort((a,b)=>a.name.localeCompare(b.name));const w=curWk();
  const away=S.clients.filter(c=>c.trainer===me()&&ciOf(c.id)==='away');
  const rng=`Sat ${md(w)} – Fri ${md(addDays(w,6))}`;
  if(!list.length)return`<div class="ci done">✓ Weekly check-in is done for ${rng}.${away.length?` Out of town this week: ${away.map(c=>esc(c.name)).join(', ')}.`:''}</div>`;
  return`<div class="ci"><div class="cih"><h3>Weekly check-in: ${list.length} client${list.length===1?'':'s'} to reach out to</h3><p>These clients have nothing booked this week (${rng}). Get in touch, then book them or mark them out of town or inactive.</p></div>
  ${list.map(c=>`<div class="cir"><b>${esc(c.name)}</b><span class="muted">Last session: ${lastSess(c)}</span><span class="sp"></span><button class="btn sm pri" data-book="${c.id}">Book session</button><button class="btn sm" data-ci="${c.id}|away">Out of town</button><button class="btn sm" data-ci="${c.id}|inactive">Inactive</button></div>`).join('')}</div>`;
}
function stats(){
  const wk=visible().filter(s=>inWeek(s,V.week));
  const st=(b,s)=>`<div class="stat"><b>${b}</b><span>${s}</span></div>`;
  if(me()){const mc=S.clients.filter(c=>c.trainer===me()&&c.active).length;const nx=visible().filter(s=>s.date>iso(new Date())||(s.date===iso(new Date())&&s.hour>=new Date().getHours())).sort((a,b)=>(a.date+pad(a.hour)).localeCompare(b.date+pad(b.hour)))[0];
    return st(wk.length,'My sessions this payroll week')+st(wk.filter(cover).length,'Coverage sessions this week')+st(mc,'Clients on my roster')+st(nx?DOW[parse(nx.date).getDay()]+' '+hh(nx.hour):'None','Next session'+(nx?' · '+esc(C(nx.client)?.name||''):''))}
  return st(S.clients.filter(c=>c.active).length,'Active clients on roster')+st(S.trainers.filter(t=>t.active).length,'Trainers')+st(wk.length,'Sessions this payroll week')+st(needs(null).length,'Clients still needing a weekly check-in');
}

function shell(){
  const admin=isAdmin();const t=me()&&T(me());
  const tabs=admin?[['week','Week'],['day','Day'],['clients','Clients'],['trainers','Trainers & logins'],['payroll','Payroll']]:[['week','My week'],['day','Day'],['clients','My clients'],['hours','My hours']];
  if(!tabs.some(x=>x[0]===V.tab))V.tab='week';
  const pend=admin?S.profiles.filter(p=>p.role==='pending').length:0;
  return`<div class="top"><div class="wrap"><div class="logo"><i>M</i><div>THE METHOD<small>Trainer schedule</small></div></div><span class="sp"></span>
  <span class="who">Signed in as <b>${esc(U.name)}</b> · ${viewAs?'Previewing '+esc(T(viewAs).name)+'’s view':admin?'Admin, full schedule':'Trainer, private view'}</span>
  ${viewAs?`<button class="btn sm" data-act="back">Back to admin</button>`:''}
  <button class="btn sm ghost" data-go="tv">TV display</button><button class="btn sm" data-act="logout">Sign out</button></div></div>
  <div class="wrap"><div class="head"><div><h1>${admin?'Master calendar':esc(t.name)+'’s schedule'}</h1><p>${admin?'Every trainer, every session. Payroll weeks run Saturday to Friday.':'Only you can see this page. Your sessions and clients, Saturday to Friday.'}</p></div><span class="sp"></span>
  <div class="acts">${admin?`<button class="btn" data-act="addclient">Add client</button>`:''}<button class="btn pri" data-act="new">+ Add appointment</button></div></div>
  ${pend?`<div class="ci" style="margin-bottom:12px"><div class="cih"><h3>${pend} new login${pend===1?'':'s'} waiting for approval</h3><p>Open <button class="linkbtn" data-tab="trainers">Trainers & logins</button> to approve and link them to a trainer.</p></div></div>`:''}
  <div class="stats">${stats()}</div>${me()?checkin():''}
  <div class="tabs">${tabs.map(([k,l])=>`<button class="tab ${V.tab===k?'on':''}" data-tab="${k}">${l}</button>`).join('')}</div>
  ${({week,day,clients,trainers,payroll,hours})[V.tab]()}
  <div class="foot">The Method · Trainer schedule <button class="btn sm" data-act="refresh">Refresh</button></div></div>`;
}

function weekNav(){const w=V.week,e=addDays(w,6);return`<div class="nav"><button class="btn sm" data-act="wk-1">←</button><button class="btn sm" data-act="wk0">This week</button><button class="btn sm" data-act="wk1">→</button></div><span class="muted num" style="font-size:13px">Sat ${md(w)} – Fri ${md(e)}</span>`}
function card(s){const t=T(s.trainer),c=C(s.client);return`<button class="appt" data-id="${s.id}" style="--c:${t.color}"><span class="t">${hh(s.hour)}</span><b>${esc(c?c.name:'Client')}${cover(s)?'<span class="tag">Cover</span>':''}</b><span>${me()?esc(s.type):esc(t.name)+' · '+esc(s.type)}</span></button>`}

function week(){
  const all=visible().filter(s=>inWeek(s,V.week));const ss=V.filter==='all'?all:all.filter(s=>s.trainer===V.filter);
  const chips=isAdmin()?`<div class="chips"><button class="chip ${V.filter==='all'?'on':''}" data-f="all">Everyone <em>${all.length}</em></button>${S.trainers.filter(t=>t.active).map(t=>`<button class="chip ${V.filter===t.id?'on':''}" data-f="${t.id}"><span class="dot" style="--c:${t.color}"></span>${esc(t.name)} <em>${all.filter(s=>s.trainer===t.id).length}</em></button>`).join('')}</div>`:'';
  const today=iso(new Date());
  return`<div class="panel"><div class="ph"><div><h2>${isAdmin()?'Everyone’s appointments':'My appointments'}</h2><p>Tap a day for its hour-by-hour view. Tap a session to change or remove it.</p></div><span class="sp"></span>${weekNav()}</div>${chips}
  <div class="week">${[0,1,2,3,4,5,6].map(i=>{const d=addDays(V.week,i),k=iso(d);const list=ss.filter(s=>s.date===k).sort((a,b)=>a.hour-b.hour);
  return`<div class="day ${k===today?'today':''}"><div class="dh" data-day="${k}"><div>${DOW[d.getDay()]}<small>${list.length} session${list.length===1?'':'s'}</small></div><b>${d.getDate()}</b></div><div class="dl">${list.map(card).join('')}<button class="add" data-new="${k}">+ Add</button></div></div>`}).join('')}</div></div>`;
}

function day(){
  const d=parse(V.day),k=V.day,dw=d.getDay();
  const ss=visible().filter(s=>s.date===k);
  const cols=me()?[T(me())]:S.trainers.filter(t=>t.active&&(t.hours[dw]||ss.some(s=>s.trainer===t.id)));
  const rows=CLOSE-OPEN;
  let g=`<div class="tl" style="grid-template-columns:5.6em repeat(${Math.max(1,cols.length)},minmax(150px,1fr));grid-template-rows:auto repeat(${rows},66px)"><div class="colh"></div>`;
  cols.forEach((t,i)=>g+=`<div class="colh" style="grid-column:${i+2}"><span class="dot" style="--c:${t.color}"></span>${esc(t.name)}<span class="muted" style="font-weight:400;font-size:12px">${t.hours[dw]?hh(t.hours[dw][0]).replace(':00','')+'–'+hh(t.hours[dw][1]).replace(':00',''):'off'}</span></div>`);
  for(let h=OPEN;h<CLOSE;h++){const r=h-OPEN+2;g+=`<div class="hr" style="grid-row:${r};grid-column:1">${hh(h)}</div>`;
    cols.forEach((t,i)=>{const on=t.hours[dw]&&h>=t.hours[dw][0]&&h<t.hours[dw][1];g+=`<div class="slot ${on?'':'off'}" style="grid-row:${r};grid-column:${i+2}" ${on?`data-slot="${t.id}|${h}"`:''}></div>`})}
  ss.forEach(s=>{const i=cols.findIndex(t=>t.id===s.trainer);if(i<0)return;g+=`<div style="grid-row:${s.hour-OPEN+2};grid-column:${i+2};display:flex;z-index:1">${card(s)}</div>`});
  g+='</div>';
  return`<div class="panel"><div class="ph"><div><h2>${d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</h2><p>${ss.length} sessions. Striped hours are outside a trainer’s working hours. Tap an open hour to book it.</p></div><span class="sp"></span>
  <div class="nav"><button class="btn sm" data-act="d-1">←</button><button class="btn sm" data-act="d0">Today</button><button class="btn sm" data-act="d1">→</button></div></div><div class="scroll">${g}</div></div>`;
}

const lifeTotal=c=>S.totals[c.id]??(c.prior||0);
function clients(){
  const admin=isAdmin();const wk=S.sessions.filter(s=>inWeek(s,V.week));
  let list=S.clients.filter(c=>admin||c.trainer===me());const ql=V.q.toLowerCase();if(ql)list=list.filter(c=>c.name.toLowerCase().includes(ql));
  list.sort((a,b)=>(b.active-a.active)||a.name.localeCompare(b.name));
  const opts=c=>`<option value="">Unassigned</option>`+S.trainers.filter(t=>t.active).map(t=>`<option value="${t.id}" ${c.trainer===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
  return`<div class="panel"><div class="ph"><div><h2>${admin?'Client roster':'My clients'}</h2><p>${admin?'Move a client to another trainer, to Unassigned, or to inactive. Check-in shows this week’s status.':'Clients on your regular roster. Tap Pet to add their pet for the gym TV. Ask an admin to add or move a client.'}</p></div><span class="sp"></span><input id="q" placeholder="Search clients" value="${esc(V.q)}" style="padding:8px 12px;border-radius:10px;border:1px solid var(--ln);background:var(--sf);font-size:16px"></div>
  <div class="scroll"><table><thead><tr><th>Client</th><th>Regular trainer</th><th>Status</th><th class="hide-s">Birthday</th><th class="num hide-s">Lifetime</th><th class="num hide-s">Left on package</th><th class="num">This week</th><th>Check-in</th><th>Pet</th>${admin?'<th></th>':''}</tr></thead><tbody>
  ${list.map(c=>`<tr class="${c.active?'':'muted'}"><td>${esc(c.name)}</td><td>${admin?`<select data-move="${c.id}">${opts(c)}</select>`:esc(T(c.trainer)?.name||'Unassigned')}</td><td>${admin?`<button class="btn sm" data-act="toggle" data-c="${c.id}">${c.active?'Active':'Inactive'}</button>`:(c.active?'Active':'Inactive')}</td><td class="hide-s">${c.bday?parse('2000-'+c.bday).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'<span class="muted">–</span>'}</td><td class="num hide-s">${lifeTotal(c)}</td><td class="num hide-s">${esc(c.left??'')}</td><td class="num">${wk.filter(s=>s.client===c.id).length}</td><td>${!c.active?'':!noSess(c)?'<span class="pill">Booked</span>':ciOf(c.id)==='away'?'<span class="pill">Out of town</span>':'<span class="pill w">Needs check-in</span>'}</td><td><button class="btn sm" data-pet="${c.id}">${c.pet?esc(c.pet.name):'+ Add pet'}</button></td>${admin?`<td><button class="btn sm" data-editc="${c.id}">Edit</button></td>`:''}</tr>`).join('')}
  </tbody></table></div>${admin?`<div class="form"><button class="btn pri" data-act="addclient">+ Add client</button></div>`:''}</div>`;
}

function trainers(){
  const wk=S.sessions.filter(s=>inWeek(s,V.week));
  const hs=t=>[6,0,1,2,3,4,5].filter(d=>t.hours[d]).map(d=>DOW[d]).join(', ')||'No hours set';
  const loginOf=t=>S.profiles.filter(p=>p.trainer_id===t.id);
  const topt=(sel)=>`<option value="">No trainer link</option>`+S.trainers.filter(t=>t.active).map(t=>`<option value="${t.id}" ${sel===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
  return`<div class="panel"><div class="ph"><div><h2>Logins</h2><p>Trainers create their own account on the sign-in page. Approve each one here and link it to their trainer name. Only linked trainers can see their own clients.</p></div></div>
  <div class="scroll"><table class="logins"><thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Trainer</th><th></th></tr></thead><tbody>
  ${S.profiles.map(p=>`<tr><td>${esc(p.display_name||'')}</td><td>${esc(p.email||'')}</td><td><select id="pr-${p.id}"><option value="pending" ${p.role==='pending'?'selected':''}>Not approved</option><option value="trainer" ${p.role==='trainer'?'selected':''}>Trainer</option><option value="admin" ${p.role==='admin'?'selected':''}>Admin</option></select></td><td><select id="pt-${p.id}">${topt(p.trainer_id)}</select></td><td><button class="btn sm ${p.role==='pending'?'pri':''}" data-saveprof="${p.id}">${p.role==='pending'?'Approve':'Save'}</button></td></tr>`).join('')}
  </tbody></table></div>
  <div class="ph" style="border-top:1px solid var(--ln)"><div><h2>Trainers</h2><p>The names shown on the calendar and TV.</p></div></div>
  <div class="tcards">${S.trainers.filter(t=>t.active).map(t=>`<div class="tc"><h3><span class="dot" style="--c:${t.color};width:12px;height:12px"></span>${esc(t.name)}</h3>
  <div class="row"><span class="muted">Login</span><span>${loginOf(t).map(p=>esc(p.email)).join(', ')||'<span class="muted">Not linked yet</span>'}</span></div>
  <div class="row"><span class="muted">Works</span><span style="text-align:right">${hs(t)}</span></div>
  <div class="row"><span class="muted">This week</span><span>${wk.filter(s=>s.trainer===t.id).length} sessions · ${S.clients.filter(c=>c.trainer===t.id&&c.active).length} clients</span></div>
  <div class="acts"><button class="btn sm" data-act="viewas" data-t="${t.id}">View as ${esc(t.name)}</button><button class="btn sm danger" data-act="remove" data-t="${t.id}">Remove</button></div></div>`).join('')}</div>
  <form class="form" id="tf"><input id="tn" placeholder="New trainer’s first name" required><button class="btn pri">Add trainer</button></form>
  <div class="ph" style="border-top:1px solid var(--ln)"><div><h2>Gym TV</h2><p>What the public screen shows for each session.</p></div><span class="sp"></span>
  <select id="tvn" style="padding:8px 12px;border-radius:10px;border:1px solid var(--ln);background:var(--sf);font-size:15px">${[['first','Client first name only'],['full','Client full name'],['none','Trainer only, no client names']].map(([k,l])=>`<option value="${k}" ${S.tvNames===k?'selected':''}>${l}</option>`).join('')}</select><button class="btn" data-go="tv">Open TV display</button></div>
  <p class="note">Badges on the TV are automatic: birthdays, 10th/25th/50th/100th sessions, “New member” for a client’s first two weeks, and streaks of 3+ weeks in a row (not shown for 100/200/300 Club members, since the club already shows their commitment). The corner box picks up to 4 highlights about clients in the Now and Next columns (birthdays, milestones, new members, close to a club, streaks) and rotates every 8 seconds. Nobody has to pick anything.</p></div>`;
}

function payroll(){
  const wk=S.sessions.filter(s=>inWeek(s,V.week));
  const rows=S.trainers.filter(t=>t.active).map(t=>{const m=wk.filter(s=>s.trainer===t.id);return{t,n:m.length,cv:m.filter(cover).length,given:wk.filter(s=>s.trainer!==t.id&&C(s.client)?.trainer===t.id).length}}).sort((a,b)=>b.n-a.n);
  const mx=Math.max(1,...rows.map(r=>r.n));
  return`<div class="panel"><div class="ph"><div><h2>Payroll week</h2><p>Sessions count for the trainer who ran them, including coverage. Clients stay on their regular trainer’s roster.</p></div><span class="sp"></span>${weekNav()}</div>
  <div class="scroll"><table><thead><tr><th>Trainer</th><th class="num">Sessions</th><th class="num">Covered for others</th><th class="num hide-s">Covered by others</th><th style="width:38%" class="hide-s"></th></tr></thead><tbody>
  ${rows.map(r=>`<tr><td><span class="dot" style="--c:${r.t.color}"></span> ${esc(r.t.name)}</td><td class="num"><b>${r.n}</b></td><td class="num">${r.cv}</td><td class="num hide-s">${r.given}</td><td class="hide-s"><div class="bar" style="--c:${r.t.color};width:${r.n/mx*100}%"></div></td></tr>`).join('')}
  <tr><td><b>Total</b></td><td class="num"><b>${wk.length}</b></td><td></td><td class="hide-s"></td><td class="hide-s"></td></tr></tbody></table></div></div>`;
}

function hours(){
  const t=T(me());const hsel=(v,id)=>`<select id="${id}">${Array.from({length:CLOSE-OPEN+1},(_,i)=>OPEN+i).map(h=>`<option value="${h}" ${h===v?'selected':''}>${hh(h)}</option>`).join('')}</select>`;
  return`<div class="panel"><div class="ph"><div><h2>My working hours</h2><p>Set the hours you train each week. These shade your open slots on the day view.</p></div></div>
  <div class="scroll"><table class="hours"><tbody>${[6,0,1,2,3,4,5].map(d=>{const h=t.hours[d];return`<tr><td style="width:8em"><label><input type="checkbox" id="hd${d}" ${h?'checked':''}> ${DOW[d]}</label></td><td>${hsel(h?h[0]:6,'hs'+d)} <span class="muted">to</span> ${hsel(h?h[1]:12,'he'+d)}</td></tr>`}).join('')}</tbody></table></div>
  <div class="form"><button class="btn pri" data-act="savehours">Save my hours</button></div></div>`;
}

const splitName=n=>{const p=n.trim().split(/\s+/);return{first_name:p.shift()||'',last_name:p.join(' ')}};
const parseBday=v=>{const m=String(v||'').match(/(\d{1,2})\D+(\d{1,2})/);return m?pad(+m[1])+'-'+pad(+m[2]):null};
// Pet fields shared by the add-client, edit-client and trainer pet forms.
const petFields=c=>`<div class="two"><div class="fld"><label for="epn">Pet’s name</label><input id="epn" value="${esc(c.pet?.name||'')}" placeholder="e.g. Finn"></div>
  <div class="fld"><label for="ept">Kind of pet</label><input id="ept" value="${esc(c.pet?.type||'')}" placeholder="e.g. Labradoodle"></div></div>
  <div class="fld"><label for="epp">Pet photo for the TV (a close-up of their face works best)</label><div class="petrow">${petOK(c.pet)?`<img src="${esc(c.pet.photo)}" alt="">`:''}<input type="file" id="epp" accept="image/*">${c.pet?'<label class="muted"><input type="checkbox" id="epx"> Remove pet</label>':''}</div><span id="epm" class="muted"></span></div>`;
// Returns the pet columns to save ({} = leave as is), or null after showing an error.
async function readPet($,c){let ph=null;try{ph=await petPhoto($('epp').files[0])}catch(err){$('epm').textContent=err.message;return null}
  const pn=$('epn').value.trim(),pt=$('ept').value.trim(),photo=ph||(c.pet&&c.pet.photo);
  if($('epx')&&$('epx').checked)return{pet_name:null,pet_type:null,pet_photo:null};
  if(pn&&photo)return{pet_name:pn,pet_type:pt||null,pet_photo:photo};
  if(pn||ph){$('epm').textContent='Add both the pet’s name and a photo.';return null}return{}}
function newClientModal(){
  const ov=document.createElement('div');ov.className='ov';
  ov.innerHTML=`<form class="modal" id="cf"><h2>Add client</h2>
  <div class="fld"><label for="cn">Full name</label><input id="cn" required></div>
  <div class="two"><div class="fld"><label for="ct">Regular trainer</label><select id="ct"><option value="">Unassigned</option>${S.trainers.filter(t=>t.active).map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
  <div class="fld"><label for="cb">Birthday (MM/DD)</label><input id="cb" placeholder="optional"></div></div>
  ${petFields({})}
  <div class="mf"><span class="sp"></span><button type="button" class="btn" data-m="x">Cancel</button><button class="btn pri" id="cfs">Add client</button></div></form>`;
  document.body.appendChild(ov);const $=id=>ov.querySelector('#'+id);$('cn').focus();
  ov.addEventListener('click',e=>{if(e.target===ov||e.target.dataset.m==='x')ov.remove()});
  $('cf').onsubmit=async e=>{e.preventDefault();e.stopPropagation();const n=$('cn').value.trim();if(!n)return;const petp=await readPet($,{});if(!petp)return;
    ov.remove();act(()=>q(sb.from('clients').insert({...splitName(n),trainer_id:$('ct').value||null,birthday:parseBday($('cb').value),member_since:iso(new Date()),...petp})),'Client added')};
}
// Trainers can add or change the pet on their own clients (saved through set_client_pet).
function petModal(c){
  const ov=document.createElement('div');ov.className='ov';
  ov.innerHTML=`<form class="modal" id="pf"><h2>${esc(c.first||c.name)}’s pet</h2><p class="muted" style="padding:0 20px;margin:0 0 4px">Shows on the gym TV in the Method Mascots box while ${esc(c.first||c.name)} is training.</p>
  ${petFields(c)}
  <div class="mf"><span class="sp"></span><button type="button" class="btn" data-m="x">Cancel</button><button class="btn pri">Save pet</button></div></form>`;
  document.body.appendChild(ov);const $=id=>ov.querySelector('#'+id);
  ov.addEventListener('click',e=>{if(e.target===ov||e.target.dataset.m==='x')ov.remove()});
  $('pf').onsubmit=async e=>{e.preventDefault();e.stopPropagation();const p=await readPet($,c);if(!p)return;if(!('pet_name' in p)){ov.remove();return}
    ov.remove();act(()=>q(sb.rpc('set_client_pet',{cid:c.id,pname:p.pet_name,ptype:p.pet_type,pphoto:p.pet_photo})),p.pet_name?'Pet saved':'Pet removed')};
}
function clientModal(c){
  const ov=document.createElement('div');ov.className='ov';const past=lifeTotal(c)-(c.prior||0);
  const bd=c.bday?(+c.bday.slice(0,2))+'/'+(+c.bday.slice(3)):'';
  ov.innerHTML=`<form class="modal" id="ef"><h2>Edit client</h2>
  <div class="fld"><label for="en">Full name</label><input id="en" value="${esc(c.name)}" required></div>
  <div class="two"><div class="fld"><label for="et">Regular trainer</label><select id="et"><option value="">Unassigned</option>${S.trainers.filter(t=>t.active).map(t=>`<option value="${t.id}" ${c.trainer===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div>
  <div class="fld"><label for="eb">Birthday (MM/DD)</label><input id="eb" value="${bd}" placeholder="e.g. 3/14"></div></div>
  <div class="two"><div class="fld"><label for="el">Lifetime sessions</label><input id="el" type="number" min="0" value="${lifeTotal(c)}"></div>
  <div class="fld"><label for="es">Status</label><select id="es"><option value="1" ${c.active?'selected':''}>Active</option><option value="0" ${c.active?'':'selected'}>Inactive</option></select></div></div>
  <div class="fld"><label for="ek">Sessions left on package</label><input id="ek" value="${esc(c.left??'')}"></div>
  ${petFields(c)}
  <p class="muted" style="padding:0 20px;font-size:13px;margin:6px 0 0">Lifetime sessions sets the 100/200/300 Club color on the TV. Inactive clients drop off the trainers’ booking list.</p>
  <div class="mf"><span class="sp"></span><button type="button" class="btn" data-m="x">Cancel</button><button class="btn pri">Save</button></div></form>`;
  document.body.appendChild(ov);const $=id=>ov.querySelector('#'+id);
  ov.addEventListener('click',e=>{if(e.target===ov||e.target.dataset.m==='x')ov.remove()});
  $('ef').onsubmit=async e=>{e.preventDefault();const n=$('en').value.trim();if(!n)return;
    const petp=await readPet($,c);if(!petp)return;
    const L=Math.max(0,+$('el').value||0);
    const patch={...splitName(n),trainer_id:$('et').value||null,active:$('es').value==='1',birthday:parseBday($('eb').value),prior_sessions:Math.max(0,L-past),sessions_left:$('ek').value.trim()||null,...petp};
    ov.remove();act(()=>q(sb.from('clients').update(patch).eq('id',c.id)),'Client saved')};
}

function modal(s,pre){
  const admin=isAdmin();const tid=s?s.trainer:pre.trainer||me()||(V.filter!=='all'?V.filter:(S.trainers.find(t=>t.active)||{}).id);
  if(!tid){toast('Add a trainer first.',true);return}
  const ov=document.createElement('div');ov.className='ov';
  let pickC=s?s.client:pre.client||'';let remote=[];let seq=0;
  const nameOf=id=>C(id)?.name||remote.find(r=>r.id===id)?.name||'';
  const build=(tid,qs)=>{qs=(qs||'').toLowerCase().trim();const f=c=>c.active&&(!qs||c.name.toLowerCase().includes(qs));const by=(a,b)=>a.name.localeCompare(b.name);
    const own=S.clients.filter(c=>f(c)&&c.trainer===tid).sort(by),un=admin?S.clients.filter(c=>f(c)&&!c.trainer).sort(by):[];
    const other=admin?S.clients.filter(c=>f(c)&&c.trainer&&c.trainer!==tid).sort(by).map(c=>({id:c.id,name:c.name,trainer:T(c.trainer).name})):remote.filter(r=>!own.some(o=>o.id===r.id));
    const o=(c,lab)=>`<button type="button" data-pc="${c.id}" class="${pickC===c.id?'on':''}">${esc(c.name)}${lab?` <span class="muted" style="font-size:13px">· ${esc(lab)}’s client</span>`:''}</button>`;
    const g=(t,l)=>l?`<div class="g">${t}</div>${l}`:'';
    const out=g(me()?'My clients':esc(T(tid).name)+'’s clients',own.map(c=>o(c)).join(''))+(qs?g('Cover another trainer’s client',other.map(c=>o(c,c.trainer||'Unassigned')).join('')):`<div class="g">Covering for someone? Type their client’s name.</div>`)+g('Unassigned',un.map(c=>o(c)).join(''));
    return out||'<div class="none">No client by that name.</div>'};
  const hsel=Array.from({length:CLOSE-OPEN},(_,i)=>OPEN+i).map(h=>`<option value="${h}" ${(s?s.hour:pre.hour||9)===h?'selected':''}>${hh(h)}</option>`).join('');
  ov.innerHTML=`<form class="modal" id="mf"><h2>${s?'Change appointment':'New appointment'}</h2><p class="muted" style="padding:0 20px;margin:0;font-size:13px">Appointments are one hour.</p>
  <div class="fld"><label for="mt">Trainer</label>${admin?`<select id="mt">${S.trainers.filter(t=>t.active).map(t=>`<option value="${t.id}" ${t.id===tid?'selected':''}>${esc(t.name)}</option>`).join('')}</select>`:`<input id="mt" value="${esc(T(tid).name)}" disabled>`}</div>
  <div class="fld"><label for="mcq">Client</label><input id="mcq" placeholder="Type a name to search" autocomplete="off" value="${esc(nameOf(pickC))}"><input type="hidden" id="mc" value="${pickC}"><div class="cl" id="cl">${build(tid,'')}</div></div>
  <div class="two"><div class="fld"><label for="md">Date</label><input id="md" type="date" value="${s?s.date:pre.date||iso(new Date())}" required></div><div class="fld"><label for="mh">Time</label><select id="mh">${hsel}</select></div></div>
  <div class="two"><div class="fld"><label for="my">Type</label><select id="my">${TYPES.map(x=>`<option ${s&&s.type===x?'selected':''}>${x}</option>`).join('')}</select></div>
  ${s?'':`<div class="fld"><label for="mr">Repeat</label><select id="mr"><option value="1">Just once</option><option value="4">Weekly, 4 weeks</option><option value="8">Weekly, 8 weeks</option><option value="12">Weekly, 12 weeks</option></select></div>`}</div>
  <div id="mw"></div>
  <div class="mf">${s?`<button type="button" class="btn danger" data-m="del">Remove</button>`:''}<span class="sp"></span><button type="button" class="btn" data-m="x">Cancel</button><button class="btn pri">${s?'Save changes':'Book it'}</button></div></form>`;
  document.body.appendChild(ov);
  const $=id=>ov.querySelector('#'+id);const trn=()=>admin?$('mt').value:tid;
  const check=()=>{const t=T(trn()),d=$('md').value,h=+$('mh').value,c=C($('mc').value)||remote.find(r=>r.id===$('mc').value);const w=[];
    if(d){const clash=S.sessions.find(x=>x!==s&&x.trainer===t.id&&x.date===d&&x.hour===h);if(clash)w.push(`${esc(t.name)} already has ${esc(C(clash.client)?.name||'a client')} at ${hh(h)}.`);
      const hr=t.hours[parse(d).getDay()];if(!hr||h<hr[0]||h>=hr[1])w.push(`This is outside ${esc(t.name)}’s working hours.`)}
    const ct=c&&(c.trainer_id||c.trainer);
    if(c&&((c.trainer&&c.trainer!==t.id&&S.trainers.some(x=>x.id===c.trainer))||(c.trainer&&!S.trainers.some(x=>x.id===c.trainer))))w.push(`Coverage: counts for ${esc(t.name)}’s payroll. ${esc(c.name)} stays on their regular trainer’s roster.`);
    $('mw').innerHTML=w.map(x=>`<div class="warn">${x}</div>`).join('')};
  const relist=()=>{const qs=$('mcq').value;$('cl').innerHTML=build(trn(),nameOf(pickC)===qs&&pickC?'':qs)};
  const searchRemote=async()=>{const qs=$('mcq').value.trim();if(admin||qs.length<2){remote=[];return relist()}
    const my=++seq;try{const r=await q(sb.rpc('search_cover_clients',{q:qs}));if(my!==seq)return;remote=r.map(x=>({id:x.id,name:x.name,trainer:x.trainer}));}catch(e){remote=[]}relist()};
  if(admin)$('mt').onchange=()=>{relist();check()};
  $('mcq').addEventListener('input',()=>{pickC='';$('mc').value='';relist();check();searchRemote()});
  $('cl').addEventListener('click',e=>{const b=e.target.closest('[data-pc]');if(!b)return;pickC=b.dataset.pc;$('mc').value=pickC;$('mcq').value=nameOf(pickC);relist();check()});
  ['md','mh'].forEach(i=>$(i).addEventListener('change',check));check();
  const close=()=>ov.remove();
  ov.addEventListener('click',e=>{if(e.target===ov)close();const m=e.target.dataset.m;if(m==='x')close();
    if(m==='del'){if(!e.target.dataset.sure){e.target.dataset.sure=1;e.target.textContent='Tap again to remove';return}close();act(()=>q(sb.from('sessions').delete().eq('id',s.id)),'Session removed')}});
  $('mf').onsubmit=e=>{e.preventDefault();const v={trainer_id:trn(),client_id:$('mc').value,date:$('md').value,hour:+$('mh').value,type:$('my').value};
    if(!v.client_id){$('mw').innerHTML='<div class="warn">Pick a client from the list first.</div>';return}if(!v.date)return;
    close();
    if(s)act(()=>q(sb.from('sessions').update(v).eq('id',s.id)),'Session saved');
    else{const n=+$('mr').value;const rows=Array.from({length:n},(_,i)=>({...v,date:iso(addDays(parse(v.date),i*7))}));act(()=>q(sb.from('sessions').insert(rows)),n>1?`Booked ${n} weekly sessions`:'Session booked')}};
}

// ---------- TV ----------
const ICON={paw:'<path d="M12 13c-3.2 0-6.2 3-6.2 5.6 0 1.7 1.3 2.6 3 2.6 1.3 0 2.1-.7 3.2-.7s1.9.7 3.2.7c1.7 0 3-.9 3-2.6C18.2 16 15.2 13 12 13zM6.2 12.2c1.3-.4 1.9-2.1 1.3-3.8S5.6 5.7 4.3 6.1 2.4 8.2 3 9.9s1.9 2.7 3.2 2.3zM10 8.6c1.4-.2 2.2-1.9 1.9-3.7S10.3 2 8.9 2.2 6.7 4.1 7 5.9s1.6 2.9 3 2.7zM17.8 12.2c1.3.4 2.6-.6 3.2-2.3s-.1-3.4-1.3-3.8-2.6.6-3.2 2.3-.1 3.4 1.3 3.8zM14 8.6c1.4.2 2.7-1 3-2.7s-.5-3.5-1.9-3.7-2.7 1-3 2.7.5 3.5 1.9 3.7z"/>',bell:'<path d="M1 9.5h2v-2h2.2v-2H8v13H5.2v-2H3v-2H1zM16 5.5h2.8v2H21v2h2v5h-2v2h-2.2v2H16zM9 10.6h6v2.8H9z"/>',kb:'<path fill-rule="evenodd" d="M7.5 2h9A2.5 2.5 0 0 1 19 4.5v3.2l-1.3 1.6A7.8 7.8 0 1 1 6.3 9.3L5 7.7V4.5A2.5 2.5 0 0 1 7.5 2zm.3 2.4a.6.6 0 0 0-.6.6v1.8l1 1.2A7.7 7.7 0 0 1 12 7a7.7 7.7 0 0 1 3.8 1l1-1.2V5a.6.6 0 0 0-.6-.6z"/>',plate:'<path fill-rule="evenodd" d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22zm0 8.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zM12 3.6A8.4 8.4 0 0 0 3.6 12h1.8A6.6 6.6 0 0 1 12 5.4z"/>',heart:'<path d="M12 21s-8.5-5.2-8.5-11.3A4.7 4.7 0 0 1 12 6.9a4.7 4.7 0 0 1 8.5 2.8C20.5 15.8 12 21 12 21z"/>',star:'<path d="M12 2l3 6.5 7 .8-5.2 4.8 1.4 7L12 17.6 5.8 21l1.4-7L2 9.3l7-.8z"/>',flame:'<path d="M12 2c1 4 6 6.5 6 12a6 6 0 0 1-12 0c0-3.2 1.8-4.8 2.6-7.3 1.2 1.3 1.9 2.6 1.9 4.6 1.6-2.4 1.9-5.6 1.5-9.3z"/>',cake:'<path d="M11 2.5c-1 1.4-1.2 2.6 0 3.3h2c1.2-.7 1-1.9 0-3.3l-1-1.2zM11 7h2v3h-2zM4 11h16a1 1 0 0 1 1 1v3c-1.4 0-1.4 1.3-3 1.3S16.4 15 15 15s-1.4 1.3-3 1.3S10.4 15 9 15s-1.4 1.3-3 1.3S4.4 15 3 15v-3a1 1 0 0 1 1-1zM3 17c1.6.6 2.6-.6 3-.6s1.4 1.3 3 1.3 1.6-1.3 3-1.3 1.4 1.3 3 1.3 1.6-1.3 3-1.3 1.4 1.2 3 .6v4H3z"/>',spark:'<path d="M12 1.5l2.3 7.2 7.2 2.3-7.2 2.3L12 20.5l-2.3-7.2L2.5 11l7.2-2.3zM19 16l.9 2.4 2.4.9-2.4.9L19 22.6l-.9-2.4-2.4-.9 2.4-.9z"/>'};
const MS=[10,25,50,75,100,150,200,250,300,400,500];
const tierOf=n=>n>=300?3:n>=200?2:n>=100?1:0;
function streakN(s){const wks=new Set(s.weeks||[]);let w=satOf(parse(s.date)),n=0;while(wks.has(iso(w))){n++;w=addDays(w,-7)}return n}
const isNewOn=s=>{const d=parse(s.date);return!!(s.since&&d>=parse(s.since)&&(d-parse(s.since))/864e5<=14)};
// Spotlight: automatic facts about the clients on the Now and Next columns. Nobody picks anything.
// items: [{name, tr (trainer name), n (lifetime sessions incl. this one), st (week streak), isNew, bday}]
function spotFacts(items){const seen=new Set(),out=[];
  items.forEach(x=>{if(!x.name||seen.has(x.name+x.tr))return;seen.add(x.name+x.tr);const f=[];const tr=tierOf(x.n);
    if(x.bday)f.push({s:100,ic:'cake',col:'#ff8fbf',lab:'Happy birthday',line:`Celebrating with ${x.tr} today`});
    if(MS.includes(x.n))f.push({s:90+x.n/100,ic:'star',col:'#f5c84c',lab:'Milestone today',line:`Session #${x.n}. Way to go!`});
    if(x.isNew)f.push({s:80,ic:'kb',col:'#6fd8a6',lab:'Welcome to The Method',line:`New member, training with ${x.tr}`});
    const club=[100,200,300].find(c=>c>x.n);if(club&&club-x.n<=10){const d=club-x.n;f.push({s:70+(10-d),ic:'star',col:club===100?'#5fe0a8':club===200?'#8fb0ff':'#f3cf6a',lab:`Almost ${club} Club`,line:d===1?`One more session and they’re in the ${club} Club!`:`Just ${d} sessions away from the ${club} Club`})}
    else{const ms=MS.find(m=>m>x.n);if(ms&&ms>=25&&ms-x.n<=3)f.push({s:45,ic:'star',col:'#f5c84c',lab:'Coming up',line:`${ms-x.n===1?'One session':(ms-x.n)+' sessions'} away from session #${ms}`})}
    if(x.st>=3&&tr===0)f.push({s:55+x.st,ic:'flame',col:'#ff8a4c',lab:'On a streak',line:`${x.st} weeks in a row and counting`});
    if(tr&&!f.length)f.push({s:20+x.n/100,ic:'star',col:['','#5fe0a8','#8fb0ff','#f3cf6a'][tr],lab:`${tr}00 Club member`,line:`${x.n} sessions with The Method`});
    if(f.length){f.sort((a,b)=>b.s-a.s);out.push({...f[0],name:x.name})}});
  out.sort((a,b)=>b.s-a.s);const pick=[],labs=new Set();out.forEach(f=>{const t=f.lab.split(' ')[0];if(pick.length<4&&!labs.has(t)){pick.push(f);labs.add(t)}});
  out.forEach(f=>{if(pick.length<4&&!pick.includes(f))pick.push(f)});return pick.sort((a,b)=>b.s-a.s)}
let spotI=0,spotTimer=null;
const petOK=p=>p&&p.name&&typeof p.photo==='string'&&/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(p.photo);
// Method Mascots: the top box rotates through pets of clients in the Now and Next columns.
// Decorative paw-in-heart mark on the right of the Method Mascots box (gentle heartbeat).
const MASCOT_DECO=(()=>{const C=(x,y,rx,ry)=>`M${x-rx} ${y}a${rx} ${ry} 0 1 0 ${2*rx} 0a${rx} ${ry} 0 1 0 ${-2*rx} 0Z`;
  const heart='M50 88C21 67 5 51 5 30C5 15 16 5 29 5C38 5 46 10 50 18C54 10 62 5 71 5C84 5 95 15 95 30C95 51 79 67 50 88Z';
  const pad='M50 45C58 45 66 54 66 61C66 67 61 68 57 67C54 66 52 65 50 65C48 65 46 66 43 67C39 68 34 67 34 61C34 54 42 45 50 45Z';
  const toes=C(33.5,41,5.2,6.4)+C(43.5,31.5,5.4,6.8)+C(56.5,31.5,5.4,6.8)+C(66.5,41,5.2,6.4);
  return`<svg class="deco" viewBox="0 0 100 92" aria-hidden="true"><path fill-rule="evenodd" d="${heart}${pad}${toes}"/></svg>`})();
// Warm ways to tie a pet to its person; mixed so neighbours on screen differ.
const PET_LINES=[n=>n+'’s biggest fan',n=>'Cheering on '+n,n=>n+'’s training buddy',n=>n+'’s best friend',n=>n+'’s sidekick'];
const petLine=(n,i)=>PET_LINES[(i+new Date().getHours())%PET_LINES.length](n);
function mascotHTML(pets){
  if(!pets.length)return`<div class="spot auto"><small class="sph">METHOD MASCOTS</small><div class="spf on"><svg viewBox="0 0 24 24" style="fill:#ffd36b">${ICON.paw}</svg><div><small>MEET THE PACK</small><b>Method Mascots</b><p>Send us a photo of your pet’s face to see them up here!</p></div></div></div>`;
  spotI%=pets.length;
  return`<div class="spot auto"><small class="sph">METHOD MASCOTS</small>${MASCOT_DECO}${pets.map((p,i)=>`<div class="spf ${i===spotI?'on':''}"><img class="petimg" src="${esc(p.photo)}" alt=""><div><b>${esc(p.name)}</b><p>${esc(petLine(p.owner,i))}</p></div></div>`).join('')}${pets.length>1?`<div class="spd">${pets.map((p,i)=>`<i class="${i===spotI?'on':''}"></i>`).join('')}</div>`:''}</div>`}
function spotRotate(){clearInterval(spotTimer);spotTimer=setInterval(()=>{const f=[...document.querySelectorAll('.spot .spf')],d=[...document.querySelectorAll('.spot .spd i')];if(f.length<2)return;
  spotI=(spotI+1)%f.length;f.forEach((x,i)=>x.classList.toggle('on',i===spotI));d.forEach((x,i)=>x.classList.toggle('on',i===spotI))},8000)}
function tvBadges(s){const out=[];const d=parse(s.date);
  if(s.bday&&s.bday===s.date.slice(5))out.push(['cake','Happy birthday!','#ff8fbf']);
  if(MS.includes(s.n))out.push(['star',s.n+'th session','#f5c84c']);
  if(s.since&&d>=parse(s.since)&&(d-parse(s.since))/864e5<=14)out.push(['kb','New member','#6fd8a6']);
  const n=streakN(s);
  if(n>=3&&tierOf(s.n||0)===0)out.push(['flame',n+'-week streak','#ff8a4c']);
  return out}
let tvTimer=null;
let tvPets=null;
async function tvLoad(){
  if(!tvData)app.innerHTML='<div class="tv"><h1 style="color:#f4eee7">Loading today’s schedule…</h1></div>';
  try{tvData=await q(sb.rpc('tv_board',{day:iso(new Date())}));
    const dk=iso(new Date());if(!tvPets||tvPets.day!==dk||Date.now()-tvPets.at>600000){try{tvPets={day:dk,at:Date.now(),list:await q(sb.rpc('tv_pets',{day:dk}))||[]}}catch(e){console.error(e);tvPets=tvPets||{day:dk,at:Date.now(),list:[]}}}
    tv()}
  catch(e){console.error(e);if(!tvData)app.innerHTML='<div class="tv"><h1 style="color:#f4eee7">Can’t reach the schedule right now. Retrying…</h1></div>'}
  clearTimeout(tvTimer);tvTimer=setTimeout(()=>{if(location.hash==='#tv')tvLoad()},60000);
}
// Little animated workout figures for the TV cards (original line drawings).
const FIGS=(()=>{const A=(attr,a,b,d)=>`<animate attributeName="${attr}" values="${a};${b};${a}" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="1.8s" begin="${d}" repeatCount="indefinite"/>`;
  const T=(a,b,d)=>`<animateTransform attributeName="transform" type="translate" values="${a};${b};${a}" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="1.8s" begin="${d}" repeatCount="indefinite"/>`;
  const P=(a,b,d)=>`<path d="${a}">${A('d',a,b,d)}</path>`;
  const H=(x1,y1,x2,y2,d)=>`<circle r="4" cx="${x1}" cy="${y1}" class="hd">${A('cx',x1,x2,d)}${A('cy',y1,y2,d)}</circle>`;
  return{
  squat:d=>`<g>${T('0 0','0 9',d)}<path d="M7 14H41"/><rect x="7" y="9" width="3.5" height="10" rx="1" class="pl"/><rect x="37.5" y="9" width="3.5" height="10" rx="1" class="pl"/></g>${H(24,8,24,17,d)}${P('M15 14L18 19L24 15L30 19L33 14M24 15L24 29M24 29L19 37L18 46M24 29L29 37L30 46','M15 23L18 28L24 24L30 28L33 23M24 24L24 36M24 36L14 37L17 46M24 36L34 37L31 46',d)}`,
  press:d=>`<g>${T('0 0','0 -12',d)}<path d="M7 15H41"/><rect x="7" y="10" width="3.5" height="10" rx="1" class="pl"/><rect x="37.5" y="10" width="3.5" height="10" rx="1" class="pl"/></g>${H(24,12,24,12,d)}${P('M14 15L15 23L24 18L33 23L34 15M24 18L24 33M24 33L20 46M24 33L28 46','M14 3L15 11L24 18L33 11L34 3M24 18L24 33M24 33L20 46M24 33L28 46',d)}`,
  pullup:d=>`<path d="M6 10H42"/>${H(24,19,24,4,d)}${P('M16 10L19 17L24 24L29 17L32 10M24 24L24 35M24 35L22 46M24 35L26 46','M16 10L12 15L24 13L36 15L32 10M24 13L24 25M24 25L22 36M24 25L26 36',d)}`,
  pushup:d=>`<path d="M3 44H45" class="fl"/>${H(9,26,8,35,d)}${P('M13 43L13 36L13 29M13 29L27 36L42 43','M13 43L19 40L13 37M13 37L27 40L42 43',d)}`,
  swing:d=>`<g>${T('23 37','37 13',d)}<circle cx="0" cy="3" r="3.6" class="pl"/></g>${H(34,18,22,6,d)}${P('M30 22L24 36M30 22L16 30M16 30L20 38L21 46M16 30L24 38L25 46','M22 11L37 12M22 11L22 27M22 27L22 37L21 46M22 27L25 37L25 46',d)}`,
  lunge:d=>`${H(24,7,24,15,d)}${P('M24 13L25 25M24 12L24 27M24 27L29 36L33 46M24 27L18 36L12 46','M24 21L25 33M24 20L24 35M24 35L33 35L33 46M24 35L18 44L12 46',d)}<path d="M6 46.5H42" class="fl"/>`,
  curl:d=>`${H(24,8,24,8,d)}<path d="M24 13L24 30M24 30L20 46M24 30L28 46"/>${P('M24 14L16 22L14 31M24 14L32 22L34 31','M24 14L16 22L15 13M24 14L32 22L33 13',d)}<g>${T('14 32','15 12',d)}<path d=\"M-3 0H3\"/><rect x=\"-5\" y=\"-2.8\" width=\"2.4\" height=\"5.6\" rx=\".8\" class=\"pl\"/><rect x=\"2.6\" y=\"-2.8\" width=\"2.4\" height=\"5.6\" rx=\".8\" class=\"pl\"/></g><g>${T('34 32','33 12',d)}<path d=\"M-3 0H3\"/><rect x=\"-5\" y=\"-2.8\" width=\"2.4\" height=\"5.6\" rx=\".8\" class=\"pl\"/><rect x=\"2.6\" y=\"-2.8\" width=\"2.4\" height=\"5.6\" rx=\".8\" class=\"pl\"/></g>`}})();
const FIGK=['squat','press','pullup','pushup','swing','lunge','curl'];
// Cards on screen use all 7 moves before any repeats (order shifts each hour for variety).
let FIGN=0;
function figFor(key){let h=0;for(const ch of String(key))h=(h*31+ch.charCodeAt(0))>>>0;const k=FIGK[FIGN++%FIGK.length];
  return`<svg class="fig" viewBox="0 0 48 48" aria-hidden="true">${FIGS[k]('-'+((h>>4)%18)/10+'s')}</svg>`}
function petPhoto(file){return new Promise((ok,no)=>{if(!file)return ok(null);if(!/^image\//.test(file.type))return no(new Error('Please pick a photo'));const r=new FileReader();r.onerror=()=>no(r.error);r.onload=()=>{const im=new Image();im.onerror=()=>no(new Error('Could not read that photo'));im.onload=()=>{const m=360,s=Math.min(1,m/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext('2d').drawImage(im,0,0,c.width,c.height);ok(c.toDataURL('image/jpeg',.84))};im.src=r.result};r.readAsDataURL(file)})}
function tv(){
  FIGN=new Date().getHours();
  const D=tvData;const TR=id=>D.trainers.find(t=>t.id===id)||{name:'',color:'#888'};
  const now=new Date(),k=iso(now),hNow=now.getHours(),tm=iso(addDays(now,1));
  const ss=D.sessions.map((s,i)=>({...s,i}));
  const today=ss.filter(s=>s.date===k);
  const up=ss.filter(s=>(s.date===k&&s.hour>=hNow)||s.date===tm).sort((a,b)=>a.date.localeCompare(b.date)||a.hour-b.hour||TR(a.trainer).name.localeCompare(TR(b.trainer).name));
  const groups=[];up.forEach(s=>{const g=groups.find(g=>g.date===s.date&&g.hour===s.hour);g?g.list.push(s):groups.push({date:s.date,hour:s.hour,list:[s]})});
  const lab=(g,i)=>g.date===tm?(i===0||groups[i-1].date!==tm?'Tomorrow · ':'')+hh(g.hour).replace(':00 ',' '):hh(g.hour).replace(':00 ',' ');
  const card=s=>{const t=TR(s.trainer),n=s.name,b=n?tvBadges(s):[];const tr=n?tierOf(s.n):0;const label=n||t.name;
    return`<div class="cc ${tr?'t'+tr:''}" style="--c:${t.color}">${tr?`<em class="club">${tr}00 Club</em>`:''}<b class="${label.length>12?'xl':label.length>8?'lg':''}">${esc(label)}</b>${n?`<span class="wt">w/ ${esc(t.name)}${figFor(n+'|'+t.name)}</span>`:''}${b.length?`<div class="bdg">${b.map(([ic,tx,col],j)=>`<span class="bd" style="--b:${col};--d:${((s.hour*7+j*5+s.i)%9)*.3}s"><svg viewBox="0 0 24 24">${ICON[ic]}</svg>${tx}</span>`).join('')}</div>`:''}</div>`};
  const col=(g,i)=>{if(!g)return'<div class="col"></div>';const live=g.date===k&&g.hour===hNow;
    return`<div class="col ${g.list.length>6?'many':g.list.length<=3?'one':''}"><div class="colh ${live?'live':''}">${live?'<span class="pulse"></span>Training now · ':i===0?'Training next · ':groups[0]&&groups[0].date===k&&groups[0].hour===hNow?'Training next · ':'Coming up · '}${lab(g,i)}</div><div class="cards">${g.list.map(card).join('')}</div></div>`};
  const rest=groups.slice(2,8);
  const later=`<div class="col"><div class="colh">Later</div><div class="legend"><span><i style="background:#1d7a58"></i>100 Club</span><span><i style="background:#3561d8"></i>200 Club</span><span><i style="background:#c9952a"></i>300 Club</span></div><div class="later">${rest.length?rest.map((g,j)=>`${g.date===tm&&(j===0?groups[1].date!==tm:rest[j-1].date!==tm)?'<div class="lrd">Tomorrow</div>':''}<div class="lr"><div class="h">${hh(g.hour).replace(':00 ',' ')}</div><div class="ns">${g.list.map(s=>`<span class="${s.name?'k'+tierOf(s.n):''}" style="--c:${TR(s.trainer).color}"><i></i>${esc(s.name||TR(s.trainer).name)}${s.name?tvBadges(s).map(([ic,,c])=>`<svg viewBox="0 0 24 24" style="--b:${c}">${ICON[ic]}</svg>`).join(''):''}</span>`).join('')}</div></div>`).join(''):'<div class="muted" style="font-size:22px">Nothing else booked yet.</div>'}</div></div>`;
  const cnt={};today.forEach(s=>cnt[s.trainer]=(cnt[s.trainer]||0)+1);
  const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1]||TR(a[0]).name.localeCompare(TR(b[0]).name)).slice(0,3);
  const lead=`<div class="tvtop"><h2>Top trainers today<small>Most sessions on the schedule</small></h2>${top.length?'':'<p class="ldr0">The leaderboard fills in as soon as today’s first session is booked.</p>'}${top.map(([id,n],i)=>`<div class="ldr ${i?'':'gold'}" style="--m:${['#f0c04a','#cfd3d8','#d98b4e'][i]}"><div class="medal">${i?'':'<svg class="crown" viewBox="0 0 24 16"><path d="M2 14 0 3l6 4 6-7 6 7 6-4-2 11z"/></svg>'}${i+1}</div><b>${i?'':'<small>TOP TRAINER</small>'}${esc(TR(id).name)}</b><div class="n">${n}</div></div>`).join('')}</div>`;
  const pets=[];{const seen=new Set();groups.slice(0,2).flatMap(g=>g.list).forEach(x=>{const p=(tvPets&&tvPets.list||[]).find(p=>p.date===x.date&&p.hour===x.hour&&p.trainer===x.trainer);
    if(!p||!x.name)return;const k=p.pet+'|'+p.owner;if(seen.has(k))return;seen.add(k);const o={name:p.pet,type:p.type,photo:p.photo,owner:p.owner};if(petOK(o))pets.push(o)})}
  const spot=mascotHTML(pets);
  app.innerHTML=`<div class="tv"><div class="tvh"><div class="logo" style="color:#f4eee7"><i>M</i><div>THE METHOD<small style="color:#b9aea2">Durham</small></div></div><h1>Today at The Method</h1>
  <div class="tot"><div><b>${D.month_total}</b>sessions this month</div><div><b>${today.length}</b>sessions today</div></div>
  <div class="clock"><b>${now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</b><span>${now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</span></div></div>
  <div class="tvmid">${lead}${spot}</div>
  <div class="tvcols">${groups.length?col(groups[0],0)+col(groups[1],1):'<div class="wrapup">That’s a wrap. No more sessions booked for today or tomorrow.</div>'}</div></div>
  <button class="btn sm tvx" data-act="exittv">Exit TV</button>`;
  spotRotate();
}

// ---------- events ----------
app.addEventListener('click',e=>{
  const b=e.target.closest('button,[data-day],[data-slot]');if(!b)return;const d=b.dataset;
  if(d.go){location.hash=d.go;return}
  if(d.auth){authMode=d.auth;authErr='';authMsg='';return render()}
  if(d.tab){V.tab=d.tab;return render()}
  if(d.f){V.filter=d.f;return render()}
  if(d.day){V.day=d.day;V.tab='day';return render()}
  if(d.slot){const[t,h]=d.slot.split('|');return modal(null,{trainer:t,hour:+h,date:V.day})}
  if(d.new)return modal(null,{date:d.new});
  if(d.editc)return clientModal(C(d.editc));
  if(d.pet)return petModal(C(d.pet));
  if(d.book)return modal(null,{client:d.book,date:iso(new Date())});
  if(d.ci){const[id,v]=d.ci.split('|');return act(async()=>{await q(sb.from('checkins').upsert({week_start:wkKey(),client_id:id,status:v}));if(v==='inactive')await q(sb.rpc('checkin_inactive',{cid:id}))},v==='away'?'Marked out of town this week':'Marked inactive')}
  if(d.saveprof){const id=d.saveprof;const role=document.getElementById('pr-'+id).value,tr=document.getElementById('pt-'+id).value||null;
    if(role==='trainer'&&!tr){toast('Pick which trainer this login belongs to.',true);return}
    if(id===U.uid&&role!=='admin'){toast('You can’t remove your own admin access.',true);return}
    return act(()=>q(sb.from('profiles').update({role,trainer_id:tr}).eq('id',id)),'Login saved')}
  if(d.id)return modal(S.sessions.find(s=>s.id===d.id));
  const a=d.act;if(!a)return;
  if(a==='logout'){viewAs=null;return sb.auth.signOut().then(()=>{U=null;V.tab='week';V.filter='all';render()})}
  if(a==='refresh')return act(async()=>{await whoAmI()});
  if(a==='back'){viewAs=null;V.tab='trainers';return render()}
  if(a==='viewas'){viewAs=d.t;V.tab='week';return render()}
  if(a==='new')return modal(null,{date:V.tab==='day'?V.day:iso(new Date())});
  if(a==='addclient')return newClientModal();
  if(a==='wk-1'||a==='wk1'){V.week=addDays(V.week,a==='wk1'?7:-7);return ensureRange(V.week).then(render)}
  if(a==='wk0'){V.week=satOf(new Date());return render()}
  if(a==='d-1'||a==='d1'){V.day=iso(addDays(parse(V.day),a==='d1'?1:-1));return ensureRange(parse(V.day)).then(render)}
  if(a==='d0'){V.day=iso(new Date());return render()}
  if(a==='toggle'){const c=C(d.c);return act(()=>q(sb.from('clients').update({active:!c.active}).eq('id',c.id)))}
  if(a==='remove'){const t=T(d.t);if(!b.dataset.sure){b.dataset.sure=1;b.textContent='Tap again: clients go to Unassigned';return}
    return act(async()=>{await q(sb.from('clients').update({trainer_id:null}).eq('trainer_id',t.id));await q(sb.from('trainers').update({active:false}).eq('id',t.id))},'Trainer removed')}
  if(a==='savehours'){const t=T(me());const hrs={};[0,1,2,3,4,5,6].forEach(x=>{const on=document.getElementById('hd'+x).checked,s=+document.getElementById('hs'+x).value,en=+document.getElementById('he'+x).value;hrs[x]=on&&en>s?[s,en]:null});
    return act(()=>q(sb.from('trainers').update({hours:hrs}).eq('id',t.id)),'Hours saved')}
  if(a==='exittv'){location.hash='';return}
});
app.addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const val=id=>(document.getElementById(id)?.value||'').trim();
  if(f.id==='af'){
    authErr='';authMsg='';f.classList.add('busy');
    try{
      if(authMode==='in'){const {error}=await sb.auth.signInWithPassword({email:val('ae'),password:document.getElementById('ap').value});if(error)throw error;await whoAmI();await load()}
      else if(authMode==='up'){const {data,error}=await sb.auth.signUp({email:val('ae'),password:document.getElementById('ap').value,options:{data:{display_name:val('an')},emailRedirectTo:location.origin+location.pathname}});if(error)throw error;
        if(data.session){await whoAmI();await load()}else{authMode='in';authMsg='Check your email for a link to confirm your account, then sign in here.'}}
      else if(authMode==='forgot'){const {error}=await sb.auth.resetPasswordForEmail(val('ae'),{redirectTo:location.origin+location.pathname});if(error)throw error;authMode='in';authMsg='If that email has an account, a reset link is on its way.'}
      else if(authMode==='recovery'){const {error}=await sb.auth.updateUser({password:document.getElementById('ap').value});if(error)throw error;authMode='in';authMsg='Password saved.';await whoAmI();await load()}
    }catch(err){authErr=err.message==='Invalid login credentials'?'That email and password don’t match.':(err.message||String(err))}
    return render()}
  if(f.id==='tf'){const n=val('tn');if(!n)return;return act(()=>q(sb.from('trainers').insert({name:n,color:COLORS[S.trainers.length%COLORS.length]})),'Trainer added')}
});
app.addEventListener('change',e=>{const t=e.target;
  if(t.dataset.move)return act(()=>q(sb.from('clients').update({trainer_id:t.value||null}).eq('id',t.dataset.move)),'Client moved');
  if(t.id==='tvn')return act(()=>q(sb.from('settings').upsert({key:'tv_names',value:t.value})),'TV setting saved');
});
app.addEventListener('input',e=>{if(e.target.id==='q'){V.q=e.target.value;render();const x=document.getElementById('q');x.focus();x.setSelectionRange(x.value.length,x.value.length)}});
window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#access_token')||location.hash.includes('type=recovery'))return;render()});

async function start(){
  if(!configured)return render();
  sb.auth.onAuthStateChange((ev)=>{if(ev==='PASSWORD_RECOVERY'){authMode='recovery';render()}});
  if(location.hash==='#tv')return render();
  app.innerHTML='<div class="wait"><div class="box"><div class="logo"><i>M</i><div>THE METHOD<small>Trainer schedule</small></div></div><p class="muted">Loading…</p></div></div>';
  try{await whoAmI();if(U&&U.role!=='pending')await load()}catch(e){console.error(e);toast('Couldn’t load the schedule: '+(e.message||e),true)}
  render();
  setInterval(async()=>{if(U&&U.role!=='pending'&&location.hash!=='#tv'&&!document.querySelector('.ov')&&!document.hidden){try{await load();if(!document.querySelector('.ov')&&document.activeElement?.id!=='q')render()}catch(e){}}},120000);
}
start();
}
