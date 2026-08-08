const JOBS = [
  'Novice','Swordsman','Archer','Mage','Acolyte','Merchant','Thief','Gunslinger','Druid',
  'Knight','Crusader','Hunter','Wizard','Priest','Monk','Blacksmith','Assassin','Sentry',
  'Lord Knight','Paladin','Sniper','High Wizard','High Priest','Champion','Assassin Cross','Rebellion'
];

const FILE = {};
JOBS.forEach(j => FILE[j] = j.toLowerCase().replaceAll(' ', '') + '.png');

const PH_TZ = 'Asia/Manila';
const PARTY_NAMES = ['Elite Party','Sub Party 1','Sub Party 2','Sub Party 3'];
const INTERNAL_EMAIL_DOMAIN = 'gm-rotw.app';

const SB_CONFIG = window.GM_SUPABASE || {};
const SUPABASE_READY = Boolean(
  window.supabase &&
  SB_CONFIG.url &&
  SB_CONFIG.publishableKey &&
  !String(SB_CONFIG.url).includes('YOUR_SUPABASE') &&
  !String(SB_CONFIG.publishableKey).includes('YOUR_SUPABASE')
);
const sb = SUPABASE_READY ? window.supabase.createClient(SB_CONFIG.url, SB_CONFIG.publishableKey) : null;

const ATT_EVENTS = [
  { id:'banquet_tue', name:'Guild Banquet', shortDay:'Tuesday', dayOffset:1, start:'22:00', end:'22:20' },
  { id:'league_tue', name:'Guild League', shortDay:'Tuesday', dayOffset:1, start:'22:30', end:'22:55' },
  { id:'mirror_thu', name:'Mirror World', shortDay:'Thursday', dayOffset:3, start:'22:00', end:'22:15' },
  { id:'hazy_thu', name:'Hazy Forest', shortDay:'Thursday', dayOffset:3, start:'22:30', end:'22:45' },
  { id:'league_thu', name:'Guild League', shortDay:'Thursday', dayOffset:3, start:'23:00', end:'23:25' },
  { id:'polarity_sun', name:'Polarity Zone', shortDay:'Sunday', dayOffset:6, start:null, end:null, dynamic:true }
];

const ATT_SUMMARY_GROUPS = [
  { label:'Tuesday', name:'Guild Banquet', ids:['banquet_tue'] },
  { label:'Tue + Thu', name:'Guild League', ids:['league_tue','league_thu'] },
  { label:'Thursday', name:'Mirror World', ids:['mirror_thu'] },
  { label:'Thursday', name:'Hazy Forest', ids:['hazy_thu'] },
  { label:'Sunday', name:'Polarity Zone', ids:['polarity_sun'] }
];

let state = {
  user:null,
  authUserId:null,
  page:'rankings',
  party:'Elite Party',
  attSession:'banquet_tue',
  attSearch:'',
  rankingSort:{key:'gear',dir:'desc'},
  charUserId:null,
  partyPickerSlot:null
};

let db = { guilds:[], users:[], parties:{}, attendance:{} };

function usernameToEmail(username=''){
  return `${String(username).trim().toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`;
}

function profileToUser(p){
  return {
    id:p.id,
    guildId:p.guild_id,
    username:p.username||'',
    ign:p.ign,
    job:p.job,
    level:Number(p.level||1),
    gear:Number(p.gear_rating||0),
    main:p.main_build||'',
    sub:p.sub_build||'',
    position:p.position,
    active:p.status!=='inactive',
    systemRole:p.system_role
  };
}

function guildRowToLocal(g){
  return { id:g.id, name:g.name, code:g.invite_code, status:g.status };
}

async function loadAppData(authUserId){
  if(!sb) throw new Error('Supabase is not configured.');
  const {data:me,error:meError}=await sb.from('profiles').select('id,guild_id,ign,job,level,gear_rating,main_build,sub_build,position,system_role,status,created_at,updated_at').eq('id',authUserId).single();
  if(meError||!me) throw new Error(meError?.message||'Your account profile was not found.');

  const [guildRes,profileRes,stateRes]=await Promise.all([
    sb.from('guilds').select('id,name,status,created_at,updated_at').order('created_at',{ascending:true}),
    sb.from('profiles').select('id,guild_id,ign,job,level,gear_rating,main_build,sub_build,position,system_role,status,created_at,updated_at').order('created_at',{ascending:true}),
    sb.from('guild_state').select('*')
  ]);
  if(guildRes.error) throw guildRes.error;
  if(profileRes.error) throw profileRes.error;
  if(stateRes.error) throw stateRes.error;

  db={guilds:(guildRes.data||[]).map(guildRowToLocal),users:[],parties:{},attendance:{}};
  db.users=(profileRes.data||[]).filter(p=>p.system_role!=='Developer').map(profileToUser);
  for(const row of stateRes.data||[]){
    Object.assign(db.parties,row.parties||{});
    Object.assign(db.attendance,row.attendance||{});
  }

  state.authUserId=authUserId;
  if(me.system_role==='Developer'){
    const [{data:codes,error:codesError},{data:names,error:namesError}]=await Promise.all([
      sb.rpc('developer_invite_codes'),sb.rpc('developer_account_names')
    ]);
    if(codesError) throw codesError;
    if(namesError) throw namesError;
    const codeMap=new Map((codes||[]).map(x=>[x.guild_id,x.invite_code]));
    const nameMap=new Map((names||[]).map(x=>[x.profile_id,x.username]));
    db.guilds.forEach(g=>g.code=codeMap.get(g.id)||'');
    db.users.forEach(u=>u.username=nameMap.get(u.id)||'');
    state.user={id:me.id,role:'Developer',position:'Developer',systemRole:'Developer',username:'Developer',ign:me.ign||'Developer',active:true};
  }else{
    const current=profileToUser(me);
    if(!current.active) throw new Error('This account has been deactivated. Please contact your Guild Master.');
    state.user=current;
    state.charUserId=current.id;
    if(current.position==='Guild Master'){
      const {data:inviteCode,error:inviteError}=await sb.rpc('get_guild_invite_code',{p_guild_id:current.guildId});
      if(inviteError) throw inviteError;
      const g=db.guilds.find(x=>x.id===current.guildId); if(g) g.code=inviteCode||'';
    }
  }
}

async function reloadAppData(){
  if(!state.authUserId) return;
  const keepChar=state.charUserId;
  await loadAppData(state.authUserId);
  if(keepChar && db.users.some(u=>u.id===keepChar)) state.charUserId=keepChar;
}

async function persistGuildState(){
  if(!sb||!canManage()) return;
  const {error}=await sb.rpc('save_guild_state',{p_parties:db.parties,p_attendance:db.attendance});
  if(error) throw error;
}

async function invokeAdmin(body){
  const {data,error}=await sb.functions.invoke('account-admin',{body});
  if(error) throw error;
  if(data?.error) throw new Error(data.error);
  return data;
}

const el = () => document.getElementById('app');
function esc(s=''){
  return String(s).replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));
}
function gid(){ return state.user?.guildId; }
function guild(){ return db.guilds.find(g=>g.id===gid()); }
function members(includeInactive=false){ return db.users.filter(u=>u.guildId===gid()&&(includeInactive||u.active!==false)).sort((a,b)=>(b.gear||0)-(a.gear||0)); }
function jobIcon(j){ return `img/jobs/${FILE[j]||'novice.png'}`; }
function canManage(){ return ['Guild Master','Officer'].includes(state.user?.position); }

function phDateParts(date=new Date()){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:PH_TZ, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(date).reduce((o,p)=>(o[p.type]=p.value,o),{});
  return { y:+parts.year, m:+parts.month, d:+parts.day, h:+parts.hour, min:+parts.minute };
}

function ymdFromUtcDate(d){
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function parseYmd(s){
  const [y,m,d] = s.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d));
}

function addDaysYmd(ymd,days){
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate()+days);
  return ymdFromUtcDate(d);
}

function currentWeekKey(){
  const p = phDateParts();
  const d = new Date(Date.UTC(p.y,p.m-1,p.d));
  const mondayOffset = (d.getUTCDay()+6)%7;
  d.setUTCDate(d.getUTCDate()-mondayOffset);
  return ymdFromUtcDate(d);
}

function prettyDate(ymd, opts={month:'short',day:'numeric'}){
  const d = parseYmd(ymd);
  return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',...opts}).format(d);
}

function weekLabel(){
  const mon = currentWeekKey();
  const sun = addDaysYmd(mon,6);
  return `${prettyDate(mon)} – ${prettyDate(sun,{month:'short',day:'numeric',year:'numeric'})}`;
}

function attendanceWeek(create=true){
  const g = gid();
  const wk = currentWeekKey();
  if(!g) return null;
  if(create){
    db.attendance[g] ??= {};
    db.attendance[g][wk] ??= { sessions:{}, polarityStart:'', polarityEnd:'' };
    db.attendance[g][wk].sessions ??= {};
    db.attendance[g][wk].polarityStart ??= '';
    db.attendance[g][wk].polarityEnd ??= '';
  }
  return db.attendance?.[g]?.[wk] || null;
}

function sessionRec(id, create=true){
  const w = attendanceWeek(create);
  if(!w) return {finalized:false,absent:[]};
  if(create){
    w.sessions[id] ??= { finalized:false, absent:[] };
    w.sessions[id].absent ??= [];
  }
  return w.sessions[id] || {finalized:false,absent:[]};
}

function effectiveTimes(ev){
  if(!ev.dynamic) return {start:ev.start,end:ev.end};
  const w = attendanceWeek(false);
  return {start:w?.polarityStart||'',end:w?.polarityEnd||''};
}

function sessionDate(ev){ return addDaysYmd(currentWeekKey(),ev.dayOffset); }

function scheduleText(ev){
  const {start,end} = effectiveTimes(ev);
  const date = prettyDate(sessionDate(ev),{weekday:'short',month:'short',day:'numeric'});
  if(!start || !end) return `${date} · Time TBD (PH)`;
  return `${date} · ${start}–${end} PH`;
}

function phLocalInstant(ymd,time){
  const [y,m,d] = ymd.split('-').map(Number);
  const [h,min] = time.split(':').map(Number);
  return new Date(Date.UTC(y,m-1,d,h-8,min,0));
}

function sessionState(ev){
  const rec = sessionRec(ev.id,false);
  if(rec.finalized) return {label:'Finalized',className:'att-finalized'};
  const {end} = effectiveTimes(ev);
  if(!end) return {label:'Schedule TBD',className:'att-tbd'};
  return new Date() < phLocalInstant(sessionDate(ev),end)
    ? {label:'Upcoming',className:'att-upcoming'}
    : {label:'Pending Review',className:'att-pending'};
}

function memberSessionStatus(userId,ev){
  const rec = sessionRec(ev.id,false);
  if(!rec.finalized) return sessionState(ev).label;
  return rec.absent?.includes(userId) ? 'Absent' : 'Attend';
}

function auth(tab='login',msg=''){
  state.user=null;
  el().innerHTML=`<main class='screen auth'>
    <div class='auth-layout'>
      <section class='auth-card'>
        <div class='brand'><img src='img/ui/guild-crest.png'><div><h1>Guild Manager - ROTW</h1><p>Guild coordination portal</p></div></div>
        <div class='tabs'><button class='${tab==='login'?'active':''}' onclick="auth('login')">Login</button><button class='${tab==='register'?'active':''}' onclick="auth('register')">Register</button></div>
        ${tab==='login'?loginForm():registerForm()}
        ${msg?`<div class='error'>${esc(msg)}</div>`:''}
      </section>
      <aside class='auth-service-info'>
        <span class='auth-service-kicker'>Guild Management Service</span>
        <h2>Ragnarok Online<br>The New World</h2>
        <p>This is a Guild Management System for <b>Ragnarok Online: The New World</b>.</p>
        <p>Guild Leaders who want to register and avail of the <b>lifetime service</b> can get access for only:</p>
        <div class='service-price'><strong>₱300</strong><span>or</span><strong>$5</strong></div>
        <div class='service-contact'>
          <span>Contact me:</span>
          <a href='mailto:kifu.gaming@gmail.com'>kifu.gaming@gmail.com</a>
        </div>
      </aside>
    </div>
  </main>`;
}

function loginForm(){
  return `<form onsubmit='login(event)'>
    <div class='field'><label>Username</label><input id='loginUser' required autocomplete='username'></div>
    <div class='field'><label>Password</label><input id='loginPass' type='password' required autocomplete='current-password'></div>
    <button class='btn primary' style='width:100%'>Login</button>
  </form>`;
}

function registerForm(){
  return `<div class='notice'>Please don't use your in-game username/password credentials. Create different credentials for Guild Manager - ROTW.</div>
  <form onsubmit='register(event)'>
    <div class='field'><label>Username</label><input id='rUser' required minlength='3' maxlength='32' pattern='[A-Za-z0-9._-]+' autocomplete='username'><div class='muted'>3–32 characters: letters, numbers, dot, underscore, or hyphen.</div></div>
    <div class='field'><label>Password</label><input id='rPass' type='password' minlength='6' required></div>
    <div class='field'><label>IGN</label><input id='rIgn' required></div>
    <div class='field'><label>Job</label><select id='rJob'>${JOBS.map(j=>`<option>${j}</option>`).join('')}</select></div>
    <div class='field'><label>Guild Reference Code</label><input id='rCode' required maxlength='12' style='text-transform:uppercase'></div>
    <button class='btn primary' style='width:100%'>Create Account</button>
  </form>`;
}

async function login(e){
  e.preventDefault();
  if(!SUPABASE_READY) return setupRequired();
  const username=document.getElementById('loginUser').value.trim();
  const password=document.getElementById('loginPass').value;
  try{
    const {data,error}=await sb.auth.signInWithPassword({email:usernameToEmail(username),password});
    if(error||!data.user) throw new Error('Invalid username or password.');
    await loadAppData(data.user.id);
    if(state.user?.role==='Developer') dev(); else dashboard();
  }catch(err){
    await sb.auth.signOut().catch(()=>{});
    state.user=null; state.authUserId=null;
    auth('login',err?.message||'Unable to login.');
  }
}

async function register(e){
  e.preventDefault();
  if(!SUPABASE_READY) return setupRequired();
  const inviteCode=document.getElementById('rCode').value.trim().toUpperCase();
  const username=document.getElementById('rUser').value.trim();
  const password=document.getElementById('rPass').value;
  const ign=document.getElementById('rIgn').value.trim();
  const job=document.getElementById('rJob').value;
  if(!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return auth('register','Username must be 3–32 characters using letters, numbers, dot, underscore, or hyphen.');
  try{
    const {data:valid,error:validError}=await sb.rpc('validate_invite_code',{p_code:inviteCode});
    if(validError) throw validError;
    if(!valid) throw new Error('Invalid or inactive guild reference code.');

    const {data:signup,error:signupError}=await sb.auth.signUp({
      email:usernameToEmail(username),
      password,
      options:{data:{username}}
    });
    if(signupError) throw signupError;
    if(!signup.session||!signup.user) throw new Error('Supabase Confirm Email must be OFF for this username-based login system.');

    const {error:profileError}=await sb.rpc('complete_registration',{
      p_username:username,p_ign:ign,p_job:job,p_invite_code:inviteCode
    });
    if(profileError) throw profileError;

    await loadAppData(signup.user.id);
    dashboard();
  }catch(err){
    await sb.auth.signOut().catch(()=>{});
    state.user=null; state.authUserId=null;
    auth('register',err?.message||'Unable to create account.');
  }
}

async function logout(){
  if(sb) await sb.auth.signOut().catch(()=>{});
  state.user=null; state.authUserId=null; state.charUserId=null;
  db={guilds:[],users:[],parties:{},attendance:{}};
  auth('login');
}

function setupRequired(){
  el().innerHTML=`<main class='screen auth'><section class='auth-card' style='position:relative;z-index:1'><div class='brand'><img src='img/ui/guild-crest.png'><div><h1>Supabase Setup Required</h1><p>Guild Manager - ROTW</p></div></div><div class='notice' style='margin-top:20px'>Open <b>supabase-config.js</b> and enter your Supabase Project URL and Publishable key. Then follow <b>SUPABASE-SETUP.md</b>.</div></section></main>`;
}

function shell(content){
  const g=guild();
  el().innerHTML=`<main class='screen app'><div class='shell'>
    <header class='topbar'>
      <div class='brand'><img src='img/ui/guild-crest.png' style='width:44px;height:44px'><div><b>Guild Manager - ROTW</b><div class='guild-title'>${esc(g?.name||'Guild')}</div></div></div>
      <div class='top-actions'><span class='hide-sm'>${esc(state.user.ign)}</span><button class='btn' onclick='logout()'>Logout</button></div>
    </header>
    <aside class='sidebar'>${nav()}<div class='guild-card'><div><b>${esc(g.name)}</b><div class='muted'>${members().length} active member${members().length===1?'':'s'}</div></div></div></aside>
    <section class='content'>${content}</section>
  </div>
  <nav class='bottomnav'>
    <button class='${state.page==='rankings'?'active':''}' onclick="go('rankings')">Rankings</button>
    <button class='${state.page==='guild'?'active':''}' onclick="go('guild')">Guild</button>
    <button class='${state.page==='char'?'active':''}' onclick="state.charUserId=state.user.id;go('char')">Char Info</button>
    <button class='${state.page==='attendance'?'active':''}' onclick="go('attendance')">Attendance</button>
    <button class='${state.page==='party'?'active':''}' onclick="go('party')">Party</button>
  </nav></main>`;
}

function nav(){
  return `<button class='navbtn ${state.page==='rankings'?'active':''}' onclick="go('rankings')">🏆 Rankings</button>
  <button class='navbtn ${state.page==='guild'?'active':''}' onclick="go('guild')">🏰 Guild Info</button>
  <button class='navbtn ${state.page==='char'?'active':''}' onclick="state.charUserId=state.user.id;go('char')">👤 Char Info</button>
  <button class='navbtn ${state.page==='attendance'?'active':''}' onclick="go('attendance')">📅 Attendance</button>
  <button class='navbtn ${state.page==='party'?'active':''}' onclick="go('party')">👥 Party</button>
  <div class='subnav'>${['Elite Party','Sub Party 1','Sub Party 2','Sub Party 3'].map(p=>`<button class='navbtn' onclick="state.party='${p}';go('party')">• ${p}</button>`).join('')}</div>`;
}

function dashboard(){ go('rankings'); }
function go(p){
  state.page=p;
  if(p==='rankings') rankings();
  if(p==='guild') guildInfo();
  if(p==='char') charInfo();
  if(p==='attendance') attendance();
  if(p==='party') party();
}

function rankingValue(u,key){
  if(key==='level') return Number(u.level||0);
  if(key==='gear'||key==='rank') return Number(u.gear||0);
  if(key==='position') return ({'Guild Master':1,'Officer':2,'Elite Member':3,'Member':4})[u.position]||99;
  if(key==='ign') return String(u.ign||'').toLowerCase();
  if(key==='job') return String(u.job||'').toLowerCase();
  if(key==='main') return String(u.main||'').toLowerCase();
  if(key==='sub') return String(u.sub||'').toLowerCase();
  return '';
}

function rankingMembers(){
  const m=db.users.filter(u=>u.guildId===gid()&&u.active!==false);
  const {key,dir}=state.rankingSort;
  const mult=dir==='asc'?1:-1;
  return m.sort((a,b)=>{
    const av=rankingValue(a,key),bv=rankingValue(b,key);
    let c=0;
    if(typeof av==='number'&&typeof bv==='number') c=av-bv;
    else c=String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'});
    if(c===0) c=String(a.ign||'').localeCompare(String(b.ign||''),undefined,{sensitivity:'base'});
    return c*mult;
  });
}

function sortRankings(key){
  if(state.rankingSort.key===key) state.rankingSort.dir=state.rankingSort.dir==='asc'?'desc':'asc';
  else {
    state.rankingSort.key=key;
    state.rankingSort.dir=['level','gear','rank'].includes(key)?'desc':'asc';
  }
  rankings();
}

function setRankingSort(key){
  state.rankingSort.key=key;
  state.rankingSort.dir=['level','gear','rank'].includes(key)?'desc':'asc';
  rankings();
}

function toggleRankingDirection(){
  state.rankingSort.dir=state.rankingSort.dir==='asc'?'desc':'asc';
  rankings();
}

function sortHeader(label,key){
  const active=state.rankingSort.key===key;
  const arrow=active?(state.rankingSort.dir==='asc'?'▲':'▼'):'↕';
  return `<button class='sort-head ${active?'active':''}' onclick="sortRankings('${key}')" title='Sort by ${esc(label)}'>${esc(label)} <span>${arrow}</span></button>`;
}

function viewMemberChar(id){
  if(!canManage()&&id!==state.user?.id) return;
  const target=db.users.find(u=>u.id===id&&u.guildId===gid());
  if(!target) return;
  state.charUserId=target.id;
  state.page='char';
  charInfo();
}

function canEditGuildPosition(target){
  if(!target || target.guildId!==gid()) return false;
  const actor=state.user?.position;
  if(actor==='Guild Master') return target.position!=='Guild Master';
  if(actor==='Officer') return !['Guild Master','Officer'].includes(target.position);
  return false;
}

function guildPositionControlHtml(u, mobile=false){
  if(!canEditGuildPosition(u)){
    const locked = canManage() && ['Guild Master','Officer'].includes(u.position) ? ' 🔒' : '';
    return `<span class='position-static ${mobile?'position-static-mobile':''}'>${esc(u.position)}${locked}</span>`;
  }
  const positions=['Officer','Elite Member','Member'];
  return `<select class='ranking-position-select ${mobile?'ranking-position-select-mobile':''}' aria-label='Change ${esc(u.ign)} guild position' onchange="updateRankingGuildPosition('${u.id}',this.value)">${positions.map(p=>`<option value='${p}' ${u.position===p?'selected':''}>${p}</option>`).join('')}</select>`;
}

async function updateRankingGuildPosition(userId,next){
  const target=db.users.find(u=>u.id===userId&&u.guildId===gid());
  if(!target) return alert('Guild member not found.');
  if(!canEditGuildPosition(target)){
    alert(state.user?.position==='Officer' ? 'Officers cannot change the Guild Master or another Officer.' : 'You cannot change this guild position.');
    return rankings();
  }
  if(!['Officer','Elite Member','Member'].includes(next)) return rankings();
  const previous=target.position;
  if(previous===next) return;
  const actor=state.user?.position;
  const warning = actor==='Officer' && next==='Officer' ? `

Once promoted, you will not be able to change ${target.ign}'s Officer position. Only the Guild Master can change an Officer.` : '';
  if(!confirm(`Change ${target.ign} from ${previous} to ${next}?${warning}`)) return rankings();
  try{
    const {error}=await sb.rpc('set_member_position',{p_target:userId,p_position:next});
    if(error) throw error;
    await reloadAppData();
    rankings();
  }catch(err){
    alert(err?.message||'Unable to change guild position.');
    await reloadAppData().catch(()=>{});
    rankings();
  }
}

function rankings(){
  const m=rankingMembers();
  const canView=canManage();
  const rows=m.map((u,i)=>`<tr><td class='rank'>#${i+1}</td><td>${canView?`<button class='member-link' onclick="viewMemberChar('${u.id}')">${esc(u.ign)}</button>`:esc(u.ign)}</td><td>${u.level||1}</td><td><div class='jobcell'><img src='${jobIcon(u.job)}'>${esc(u.job)}</div></td><td>${guildPositionControlHtml(u)}</td><td class='rating'>${Number(u.gear||0).toLocaleString()}</td><td>${esc(u.main||'-')}</td><td>${esc(u.sub||'-')}</td></tr>`).join('');
  const cards=m.map((u,i)=>`<article class='member-card'><div class='top'><img src='${jobIcon(u.job)}'><div><b>#${i+1} ${esc(u.ign)}</b><div class='muted'>Lv.${u.level||1} · ${esc(u.job)}</div></div>${canView?`<button class='btn member-card-view' onclick="viewMemberChar('${u.id}')">View Info</button>`:''}</div><div class='meta'><span>Position</span><div>${guildPositionControlHtml(u,true)}</div><span>Gear Rating</span><b class='rating'>${Number(u.gear||0).toLocaleString()}</b><span>Main Build</span><b>${esc(u.main||'-')}</b><span>Sub Build</span><b>${esc(u.sub||'-')}</b></div></article>`).join('');
  const sortOptions=[['rank','Rank'],['ign','IGN'],['level','Level'],['job','Job'],['position','Guild Position'],['gear','Gear Rating'],['main','Main Build'],['sub','Sub Build']].map(([k,l])=>`<option value='${k}' ${state.rankingSort.key===k?'selected':''}>${l}</option>`).join('');
  const positionHint=canManage()?`<div class='ranking-position-hint'>${state.user.position==='Guild Master'?'Guild Master can change Officer / Elite Member / Member positions directly below.':'Officer can change Member / Elite Member positions and may promote them to Officer. Guild Master and existing Officers are locked.'}</div>`:'';
  shell(`<div class='section-head'><h2>Character Member Rankings</h2><div class='chips'><span class='chip'>👑 Guild Master</span><span class='chip'>🛡 Officer</span><span class='chip'>💎 Elite Member</span><span class='chip'>🍃 Member</span></div></div>
  ${positionHint}
  <div class='mobile-sort'><label>Sort by <select onchange='setRankingSort(this.value)'>${sortOptions}</select></label><button class='btn' onclick='toggleRankingDirection()'>${state.rankingSort.dir==='asc'?'▲ Ascending':'▼ Descending'}</button></div>
  <div class='tablewrap'><table><thead><tr><th>${sortHeader('#','rank')}</th><th>${sortHeader('IGN','ign')}</th><th>${sortHeader('Level','level')}</th><th>${sortHeader('Job','job')}</th><th>${sortHeader('Guild Position','position')}</th><th>${sortHeader('Gear Rating','gear')}</th><th>${sortHeader('Main Build','main')}</th><th>${sortHeader('Sub Build','sub')}</th></tr></thead><tbody>${rows}</tbody></table></div><div class='mobile-cards'>${cards}</div>`);
}


function roleLevel(position){
  return ({'Guild Master':4,'Officer':3,'Elite Member':2,'Member':1})[position]||0;
}

function canEditCharacter(target){
  if(!target || target.guildId!==gid()) return false;
  if(target.id===state.user?.id) return true;
  return canManage() && roleLevel(state.user?.position)>roleLevel(target.position);
}

function guildInfo(){
  const g=guild();
  const activeMembers=members();
  const inactiveMembers=members(true).filter(u=>u.active===false);
  const jobCounts=JOBS.map(job=>({job,count:activeMembers.filter(u=>u.job===job).length})).filter(x=>x.count>0).sort((a,b)=>b.count-a.count||a.job.localeCompare(b.job));
  const jobsHtml=jobCounts.length?jobCounts.map(x=>`<div class='job-stat'><img src='${jobIcon(x.job)}' alt=''><div><b>${esc(x.job)}</b><span>${x.count}</span></div></div>`).join(''):`<div class='muted'>No active members yet.</div>`;
  const invite=state.user.position==='Guild Master'?`<section class='card invite-management'>
    <div><h3>Guild Invitation Code</h3><p class='muted'>Only the Guild Master can view or refresh this code. Refresh it if the old code may have been shared outside the guild.</p></div>
    <div class='invite-code-row'><code id='guildInviteCode'>${esc(g.code)}</code><button class='btn' onclick='copyGuildInviteCode()'>Copy</button><button class='btn danger-btn' onclick='refreshGuildInviteCode()'>Refresh Code</button></div>
  </section>`:`<section class='card invite-management'><div><h3>Guild Invitation Code</h3><p class='muted'>For security, the invitation code is managed only by the Guild Master.</p></div><span class='chip'>Protected</span></section>`;
  const inactive=inactiveMembers.length?`<section class='card inactive-summary'><div class='section-head compact-head'><div><h3>Deactivated Accounts</h3><p class='muted'>These accounts cannot log in and are excluded from active guild counts, rankings, attendance rosters, and party assignments.</p></div><span class='chip'>${inactiveMembers.length}</span></div></section>`:'';
  shell(`<div class='section-head'><div><h2>Guild Info</h2><p class='muted'>${esc(g.name)} overview</p></div><div class='chips'><span class='chip'>Total Active Members: ${activeMembers.length}</span></div></div>
    <div class='guild-info-grid'><section class='card guild-total-card'><span class='guild-total-number'>${activeMembers.length}</span><div><b>Total Members</b><p class='muted'>Active guild accounts</p></div></section><section class='card'><h3>Job Class Distribution</h3><div class='job-stats'>${jobsHtml}</div></section></div>
    ${invite}${inactive}`);
}

async function refreshGuildInviteCode(){
  if(state.user?.position!=='Guild Master') return alert('Only the Guild Master can refresh the guild invitation code.');
  const g=guild(); if(!g) return;
  if(!confirm(`Refresh ${g.name}'s invitation code? The current code will immediately stop working for new registrations.`)) return;
  try{
    const {data,error}=await sb.rpc('reset_invite_code',{p_guild_id:g.id});
    if(error) throw error;
    g.code=data;
    guildInfo();
  }catch(err){ alert(err?.message||'Unable to refresh the invitation code.'); }
}

function copyGuildInviteCode(){
  if(state.user?.position!=='Guild Master') return;
  const value=guild()?.code||'';
  if(navigator.clipboard?.writeText){ navigator.clipboard.writeText(value).then(()=>alert('Guild invitation code copied.')).catch(()=>prompt('Copy this guild invitation code:',value)); }
  else prompt('Copy this guild invitation code:',value);
}

function attendanceSummaryHtml(user){
  const items=ATT_SUMMARY_GROUPS.map(group=>{
    let finalized=0, attended=0;
    for(const id of group.ids){
      const r=sessionRec(id,false);
      if(r.finalized){
        finalized++;
        if(!r.absent?.includes(user.id)) attended++;
      }
    }
    const total=group.ids.length;
    let result;
    if(finalized===total) result=`${attended}/${total}`;
    else if(finalized===0) result='Pending';
    else result=`${attended}/${finalized} finalized · ${total-finalized} pending`;
    return `<div class='attendance-summary-row'><div><span class='att-day'>${esc(group.label)}</span><b>${esc(group.name)}</b></div><strong>${esc(result)}</strong></div>`;
  }).join('');

  let totalFinalized=0,totalAttend=0;
  ATT_EVENTS.forEach(ev=>{
    const r=sessionRec(ev.id,false);
    if(r.finalized){ totalFinalized++; if(!r.absent?.includes(user.id)) totalAttend++; }
  });
  const totalText=totalFinalized===ATT_EVENTS.length ? `${totalAttend}/${ATT_EVENTS.length}` : `${totalAttend}/${totalFinalized} finalized · ${ATT_EVENTS.length-totalFinalized} pending`;

  return `<section class='card attendance-summary-card'>
    <div class='section-head compact-head'><div><h3>Weekly Attendance</h3><p class='muted'>${esc(weekLabel())} · Philippine Time · resets every Monday</p></div><span class='attendance-total'>${esc(totalText)}</span></div>
    <div class='attendance-summary-list'>${items}</div>
  </section>`;
}

function charInfo(){
  const manager=canManage();
  let u=state.user;
  if(manager&&state.charUserId){
    const selected=db.users.find(x=>x.id===state.charUserId&&x.guildId===gid());
    if(selected) u=selected;
  }
  if(!manager) u=state.user;
  state.charUserId=u.id;
  const own=u.id===state.user.id;
  const editable=canEditCharacter(u);
  const disabled=editable?'':'disabled';
  const memberPicker=manager?`<section class='card member-browser'>
    <div><b>Guild Member</b><div class='muted'>You can edit only members below your own guild role. Same-role and higher-role accounts are protected.</div></div>
    <select onchange='viewMemberChar(this.value)'>${members(true).map(m=>`<option value='${m.id}' ${m.id===u.id?'selected':''}>${esc(m.ign)} · ${esc(m.job)} · ${esc(m.position)}${m.active===false?' · DEACTIVATED':''}</option>`).join('')}</select>
  </section>`:'';
  const passwordControl=!own&&editable&&state.user.position==='Guild Master'?`<div class='password-reset-block'>
      <div class='field password-reset-field'><label>Change Password</label><input id='memberNewPassword' type='password' minlength='6' placeholder='Enter a new password'></div>
      <button type='button' class='btn primary' onclick="changeMemberPassword('${u.id}')">Change Password</button>
      <div class='muted password-reset-note'>No old password is required. The member must use the new password on their next login.</div>
    </div>`:'';
  const accountControls=!own&&editable?`<section class='card account-management'>
    <div><h3>Member Account</h3><p class='muted'>${u.active===false?'This account is currently deactivated and cannot log in.':'Manage this member account. Password reset is available only to the Guild Master.'}</p></div>
    ${passwordControl}
    <div class='account-actions'>${u.active===false?`<button type='button' class='btn' onclick="setMemberActive('${u.id}',true)">Reactivate Account</button>`:`<button type='button' class='btn' onclick="setMemberActive('${u.id}',false)">Deactivate Account</button>`}<button type='button' class='btn danger-btn' onclick="deleteMemberAccount('${u.id}')">Delete Account</button></div>
  </section>`:'';
  const modeChip=own?`<span class='chip edit-chip'>My Character · Editable</span>`:editable?`<span class='chip edit-chip'>Edit Mode</span>`:`<span class='chip view-chip'>View Only</span>`;
  shell(`<div class='section-head'><div><h2>Character Info</h2><p class='muted char-viewing'>Viewing: <b>${esc(u.ign)}</b> · ${esc(u.job)}${u.active===false?' · DEACTIVATED':''}</p></div><div class='chips'><span class='chip'>${esc(u.position)}</span>${modeChip}</div></div>
  ${memberPicker}
  <form class='card char-form' onsubmit='saveChar(event)'>
    <div class='formgrid'>
      <div class='field'><label>IGN</label><input id='cIgn' value='${esc(u.ign)}' required ${disabled}></div>
      <div class='field'><label>Level</label><input id='cLevel' type='number' min='1' max='999' value='${u.level||1}' required ${disabled}></div>
      <div class='field'><label>Job</label><select id='cJob' ${disabled}>${JOBS.map(j=>`<option ${u.job===j?'selected':''}>${j}</option>`).join('')}</select></div>
      <div class='field'><label>Gear Rating</label><input id='cGear' type='number' min='0' value='${u.gear||0}' ${disabled}></div>
      <div class='field'><label>Main Build</label><input id='cMain' value='${esc(u.main||'')}' ${disabled}></div>
      <div class='field'><label>Sub Build</label><input id='cSub' value='${esc(u.sub||'')}' ${disabled}></div>
    </div>
    <div class='field'><label>Guild Position</label><input value='${esc(u.position)}' disabled></div>
    ${editable?`<button class='btn primary'>Save Changes</button>`:`<div class='notice'>This member has the same or a higher guild role than your account, so their character information is protected.</div>`}
  </form>
  ${accountControls}
  ${attendanceSummaryHtml(u)}`);
}

async function saveChar(e){
  e.preventDefault();
  const target=db.users.find(x=>x.id===state.charUserId&&x.guildId===gid());
  if(!target || !canEditCharacter(target)) return alert('You do not have permission to edit this character.');
  const payload={
    p_target:target.id,
    p_ign:document.getElementById('cIgn').value.trim(),
    p_level:+document.getElementById('cLevel').value,
    p_job:document.getElementById('cJob').value,
    p_gear_rating:+document.getElementById('cGear').value,
    p_main_build:document.getElementById('cMain').value.trim(),
    p_sub_build:document.getElementById('cSub').value.trim()
  };
  try{
    const {error}=await sb.rpc('update_character',payload);
    if(error) throw error;
    await reloadAppData();
    charInfo();
  }catch(err){ alert(err?.message||'Unable to save character information.'); }
}

async function changeMemberPassword(id){
  if(state.user?.position!=='Guild Master') return alert('Only the Guild Master can change member passwords.');
  const target=db.users.find(x=>x.id===id&&x.guildId===gid());
  if(!target || target.id===state.user.id || roleLevel(target.position)>=roleLevel('Guild Master')) return alert('You cannot change this account password.');
  const input=document.getElementById('memberNewPassword');
  const next=input?.value||'';
  if(next.length<6) return alert('New password must be at least 6 characters.');
  if(!confirm(`Change ${target.ign}'s Guild Manager password? Their old password will stop working immediately.`)) return;
  try{
    await invokeAdmin({action:'reset_password',target_id:target.id,password:next});
    if(input) input.value='';
    alert(`Password changed for ${target.ign}.`);
  }catch(err){ alert(err?.message||'Unable to change password.'); }
}

function removeUserFromParties(userId){
  Object.keys(db.parties).forEach(k=>{
    if(!k.startsWith(gid()+'|')) return;
    db.parties[k]=db.parties[k].map(id=>id===userId?null:id);
  });
}

async function setMemberActive(id,active){
  const target=db.users.find(x=>x.id===id&&x.guildId===gid());
  if(!target || target.id===state.user.id || !canEditCharacter(target)) return alert('You cannot change this account.');
  const message=active
    ? `Reactivate ${target.ign}'s account? They will be able to log in again.`
    : `Deactivate ${target.ign}'s account? They will no longer be able to use Guild Manager and will be removed from current party assignments.`;
  if(!confirm(message)) return;
  try{
    await invokeAdmin({action:'set_active',target_id:target.id,active});
    if(!active){ removeUserFromParties(target.id); await persistGuildState(); }
    await reloadAppData();
    charInfo();
  }catch(err){ alert(err?.message||'Unable to update this account.'); }
}

async function deleteMemberAccount(id){
  const target=db.users.find(x=>x.id===id&&x.guildId===gid());
  if(!target || target.id===state.user.id || !canEditCharacter(target)) return alert('You cannot delete this account.');
  if(!confirm(`Permanently delete ${target.ign}'s Guild Manager account? This cannot be undone.`)) return;
  try{
    await invokeAdmin({action:'delete_user',target_id:target.id});
    state.charUserId=state.user.id;
    await reloadAppData();
    charInfo();
  }catch(err){ alert(err?.message||'Unable to delete this account.'); }
}


function attendance(){
  const editable=canManage();
  attendanceWeek(true);
  if(!ATT_EVENTS.some(e=>e.id===state.attSession)) state.attSession=ATT_EVENTS[0].id;

  const rows=ATT_EVENTS.map(ev=>{
    const rec=sessionRec(ev.id,false);
    const st=sessionState(ev);
    const absentCount=rec.finalized ? (rec.absent?.length||0) : '—';
    const myStatus=memberSessionStatus(state.user.id,ev);
    return `<tr class='${state.attSession===ev.id?'selected-att-row':''}'>
      <td><b>${esc(ev.name)}</b><div class='muted'>${esc(ev.shortDay)}</div></td>
      <td>${esc(scheduleText(ev))}</td>
      <td><span class='att-status ${st.className}'>${esc(st.label)}</span></td>
      ${editable?`<td>${absentCount}</td><td><button class='btn ${state.attSession===ev.id?'primary':''}' onclick="state.attSession='${ev.id}';attendance()">Manage</button></td>`:`<td><span class='member-att-status ${myStatus==='Attend'?'is-attend':myStatus==='Absent'?'is-absent':''}'>${esc(myStatus)}</span></td>`}
    </tr>`;
  }).join('');

  const mobile=ATT_EVENTS.map(ev=>{
    const st=sessionState(ev);
    const myStatus=memberSessionStatus(state.user.id,ev);
    return `<article class='attendance-event-card ${state.attSession===ev.id?'selected':''}'>
      <div><b>${esc(ev.name)}</b><div class='muted'>${esc(scheduleText(ev))}</div></div>
      <div class='attendance-card-actions'><span class='att-status ${st.className}'>${esc(st.label)}</span>${editable?`<button class='btn' onclick="state.attSession='${ev.id}';attendance()">Manage</button>`:`<span class='member-att-status ${myStatus==='Attend'?'is-attend':myStatus==='Absent'?'is-absent':''}'>${esc(myStatus)}</span>`}</div>
    </article>`;
  }).join('');

  shell(`<div class='section-head'><div><h2>Weekly Attendance</h2><p class='muted'>${esc(weekLabel())} · Philippine Time (UTC+8) · new attendance week starts every Monday</p></div>${editable?`<span class='chip'>Guild Master / Officer Control</span>`:`<span class='chip'>View Only</span>`}</div>
  ${editable?`<div class='notice attendance-notice'>Mark only the players who <b>did not attend</b>. When you finalize an event, every unmarked player is automatically recorded as <b>Attend</b>.</div>`:''}
  <div class='tablewrap attendance-table'><table><thead><tr><th>Event</th><th>Schedule</th><th>Record Status</th>${editable?'<th>Absent</th><th></th>':'<th>My Attendance</th>'}</tr></thead><tbody>${rows}</tbody></table></div>
  <div class='attendance-mobile-list'>${mobile}</div>
  ${editable?attendanceEditorHtml():attendanceSummaryHtml(state.user)}`);
  if(editable) filterAttendanceMembers(state.attSearch||'');
}

function attendanceEditorHtml(){
  const ev=ATT_EVENTS.find(e=>e.id===state.attSession)||ATT_EVENTS[0];
  const rec=sessionRec(ev.id,true);
  const w=attendanceWeek(true);
  const mem=members();
  const roster=mem.map(u=>`<label class='absent-member ${rec.absent?.includes(u.id)?'checked':''}' data-att-member data-search='${esc((u.ign+' '+u.job+' '+u.position).toLowerCase())}'>
    <input type='checkbox' data-att-absent value='${u.id}' ${rec.absent?.includes(u.id)?'checked':''} onchange='syncAbsentStyle(this)'>
    <img src='${jobIcon(u.job)}'><span><b>${esc(u.ign)}</b><small>${esc(u.job)} · ${esc(u.position)}</small></span><em>Absent</em>
  </label>`).join('');

  const dynamic=ev.dynamic?`<div class='polarity-schedule'>
    <div><b>Polarity Zone Schedule</b><div class='muted'>Set this Sunday's event time in Philippine Time.</div></div>
    <div class='polarity-times'><div class='field'><label>Start</label><input id='polarityStart' type='time' value='${esc(w.polarityStart||'')}'></div><div class='field'><label>End</label><input id='polarityEnd' type='time' value='${esc(w.polarityEnd||'')}'></div><button class='btn' onclick='savePolaritySchedule()'>Save Time</button></div>
  </div>`:'';

  return `<section class='card attendance-editor'>
    <div class='section-head compact-head'><div><h3>Manage: ${esc(ev.name)}</h3><p class='muted'>${esc(scheduleText(ev))}</p></div><span class='att-status ${sessionState(ev).className}'>${esc(sessionState(ev).label)}</span></div>
    ${dynamic}
    <div class='attendance-editor-toolbar'><div><b>Absent Players</b><div class='muted'>Leave everyone who attended unchecked.</div></div><button class='btn' onclick='clearAbsentSelection()'>Clear Selection</button></div>
    <div class='attendance-search-row'>
      <div class='field attendance-search-field'>
        <label>Search Members</label>
        <input id='attendanceSearch' type='search' placeholder='Search IGN, Job, or Guild Position...' value='${esc(state.attSearch||'')}' oninput='filterAttendanceMembers(this.value)'>
      </div>
      <div class='attendance-search-count muted' id='attendanceSearchCount'></div>
    </div>
    <div class='absent-grid' id='attendanceRoster'>${roster||'<div class="muted">No members in this guild yet.</div>'}</div>
    <div class='attendance-editor-footer'><button class='btn primary' onclick="finalizeAttendance('${ev.id}')">${rec.finalized?'Update Finalized Attendance':'Finalize Attendance'}</button>${rec.finalized?`<button class='btn' onclick="reopenAttendance('${ev.id}')">Reopen Record</button>`:''}<span class='muted'>${rec.finalized&&rec.updatedAt?`Last saved ${esc(new Date(rec.updatedAt).toLocaleString())}`:'Not finalized yet'}</span></div>
  </section>`;
}

function syncAbsentStyle(input){ input.closest('.absent-member')?.classList.toggle('checked',input.checked); }
function clearAbsentSelection(){ document.querySelectorAll('[data-att-absent]').forEach(x=>{x.checked=false;syncAbsentStyle(x);}); }
function filterAttendanceMembers(v=''){
  state.attSearch = v || '';
  const q = (v || '').trim().toLowerCase();
  const cards = [...document.querySelectorAll('[data-att-member]')];
  let visible = 0;
  cards.forEach(card => {
    const hay = (card.dataset.search || '').toLowerCase();
    const show = !q || hay.includes(q);
    card.style.display = show ? '' : 'none';
    if(show) visible += 1;
  });
  const count = document.getElementById('attendanceSearchCount');
  if(count) count.textContent = q ? `${visible} result${visible===1?'':'s'} shown` : `${cards.length} member${cards.length===1?'':'s'}`;
}

async function savePolaritySchedule(){
  if(!canManage()) return;
  const start=document.getElementById('polarityStart')?.value||'';
  const end=document.getElementById('polarityEnd')?.value||'';
  if(!start||!end) return alert('Please set both the start and end time for Polarity Zone.');
  if(end<=start) return alert('Polarity Zone end time must be later than the start time.');
  const w=attendanceWeek(true); w.polarityStart=start; w.polarityEnd=end;
  try{ await persistGuildState(); attendance(); }catch(err){ alert(err?.message||'Unable to save the Polarity Zone schedule.'); }
}

async function finalizeAttendance(id){
  if(!canManage()) return;
  const ev=ATT_EVENTS.find(e=>e.id===id); if(!ev) return;
  if(ev.dynamic){
    const t=effectiveTimes(ev);
    if(!t.start||!t.end) return alert('Please set the Polarity Zone schedule before finalizing attendance.');
  }
  const absent=[...document.querySelectorAll('[data-att-absent]:checked')].map(x=>x.value);
  const rec=sessionRec(id,true);
  rec.finalized=true;
  rec.absent=absent;
  rec.updatedAt=new Date().toISOString();
  rec.updatedBy=state.user.id;
  try{ await persistGuildState(); attendance(); }catch(err){ alert(err?.message||'Unable to save attendance.'); }
}

async function reopenAttendance(id){
  if(!canManage()) return;
  if(!confirm('Reopen this attendance record? Member attendance will return to Pending until it is finalized again.')) return;
  const rec=sessionRec(id,true); rec.finalized=false; rec.updatedAt=new Date().toISOString(); rec.updatedBy=state.user.id;
  try{ await persistGuildState(); attendance(); }catch(err){ alert(err?.message||'Unable to reopen attendance.'); }
}

function partyKey(){ return gid()+'|'+state.party; }

function partySlotButton(ix,u){
  if(!u){
    return `<button class='party-slot-picker empty' onclick="openPartyPicker(${ix})" type='button'><span class='party-slot-empty'><b>Empty slot</b><small>Search or browse by Job</small></span><span class='party-slot-caret'>⌄</span></button>`;
  }
  return `<button class='party-slot-picker' onclick="openPartyPicker(${ix})" type='button'><img src='${jobIcon(u.job)}' alt=''><span class='party-slot-copy'><b>${esc(u.ign)}</b><small>${esc(u.job)}</small></span><span class='party-slot-caret'>⌄</span></button>`;
}

function party(){
  closePartyPicker();
  const key=partyKey(),editable=canManage();
  db.parties[key]??=Array(40).fill(null);
  const arr=db.parties[key],mem=members();
  let groups='';
  for(let g=0;g<8;g++){
    let slots='';
    for(let s=0;s<5;s++){
      const ix=g*5+s,id=arr[ix],u=mem.find(x=>x.id===id);
      slots+=`<div class='slot'>${editable?partySlotButton(ix,u):u?`<img src='${jobIcon(u.job)}'><div><b>${esc(u.ign)}</b><div class='muted'>${esc(u.job)}</div></div>`:`<span class='muted'>Empty slot</span>`}</div>`;
    }
    groups+=`<div class='group'><h3>Group ${g+1}</h3>${slots}</div>`;
  }
  shell(`<div class='section-head'><h2>${esc(state.party)}</h2><div class='chips'>${['Elite Party','Sub Party 1','Sub Party 2','Sub Party 3'].map(p=>`<button class='btn ${p===state.party?'primary':''}' onclick="state.party='${p}';party()">${p}</button>`).join('')}</div></div><p class='muted'>8 groups × 5 members = 40 players maximum. ${editable?'Click a slot to search by IGN or browse members grouped by Job. Selecting an already-assigned member will move them to the new slot.':'View only; only Guild Master and Officers can edit.'}</p><div class='party-grid'>${groups}</div>`);
}

function findPartyAssignment(userId,ignoreParty=null,ignoreIx=-1){
  for(const partyName of PARTY_NAMES){
    const key=gid()+'|'+partyName;
    const arr=db.parties[key]||[];
    const ix=arr.findIndex((x,i)=>x===userId && !(partyName===ignoreParty && i===ignoreIx));
    if(ix>=0) return {party:partyName,key,ix,group:Math.floor(ix/5)+1,slot:(ix%5)+1};
  }
  return null;
}

function partyAssignmentText(userId,currentIx){
  const found=findPartyAssignment(userId,state.party,currentIx);
  if(!found) return '';
  return `${found.party} · Group ${found.group}`;
}

function partyPickerHtml(ix){
  const arr=db.parties[partyKey()]||[];
  const currentId=arr[ix]||'';
  const mem=members().slice().sort((a,b)=>{
    const ai=JOBS.indexOf(a.job), bi=JOBS.indexOf(b.job);
    const aj=ai<0?999:ai, bj=bi<0?999:bi;
    return aj-bj || String(a.ign||'').localeCompare(String(b.ign||''),undefined,{sensitivity:'base'});
  });
  const jobs=[...new Set(mem.map(x=>x.job))].sort((a,b)=>{
    const ai=JOBS.indexOf(a),bi=JOBS.indexOf(b);
    return (ai<0?999:ai)-(bi<0?999:bi) || a.localeCompare(b);
  });
  const jobGroups=jobs.map(job=>{
    const list=mem.filter(x=>x.job===job);
    const rows=list.map(x=>{
      const assigned=partyAssignmentText(x.id,ix);
      const current=x.id===currentId;
      const search=esc(`${x.ign} ${x.job} ${x.position}`.toLowerCase());
      return `<button type='button' class='party-member-option ${current?'current':''}' data-party-search="${search}" onclick="choosePartyMember(${ix},'${x.id}')"><img src='${jobIcon(x.job)}' alt=''><span class='party-member-copy'><b>${esc(x.ign)}</b><small>${esc(x.position||'Member')}</small></span><span class='party-member-status'>${current?'<b>Current</b>':assigned?`<span>${esc(assigned)}</span>`:''}</span></button>`;
    }).join('');
    return `<section class='party-job-group' data-party-job><div class='party-job-title'><span><img src='${jobIcon(job)}' alt=''>${esc(job)}</span><small>${list.length} member${list.length===1?'':'s'}</small></div>${rows}</section>`;
  }).join('');
  const slotLabel=`Group ${Math.floor(ix/5)+1} · Slot ${(ix%5)+1}`;
  return `<div id='partyPickerOverlay' class='party-picker-overlay' onclick='closePartyPicker()'><div class='party-picker-panel' onclick='event.stopPropagation()'>
    <div class='party-picker-head'><div><div class='muted'>${esc(state.party)}</div><h3>Select Member</h3><p>${slotLabel}</p></div><button type='button' class='party-picker-close' onclick='closePartyPicker()' aria-label='Close'>×</button></div>
    <div class='party-picker-search'><span>⌕</span><input id='partyPickerSearch' type='search' autocomplete='off' placeholder='Search IGN or Job…' oninput='filterPartyPicker(this.value)'></div>
    <button type='button' class='party-empty-option' onclick='choosePartyMember(${ix},"")'><span>＋</span><div><b>Empty slot</b><small>Remove the current member from this slot</small></div></button>
    <div class='party-picker-list'>${jobGroups}<div id='partyPickerEmpty' class='party-picker-no-results' hidden>No matching guild member found.</div></div>
  </div></div>`;
}

function openPartyPicker(ix){
  if(!canManage()) return;
  closePartyPicker();
  state.partyPickerSlot=ix;
  document.body.insertAdjacentHTML('beforeend',partyPickerHtml(ix));
  setTimeout(()=>document.getElementById('partyPickerSearch')?.focus(),0);
}

function closePartyPicker(){
  document.getElementById('partyPickerOverlay')?.remove();
  state.partyPickerSlot=null;
}

function filterPartyPicker(value){
  const q=String(value||'').trim().toLowerCase();
  let visible=0;
  document.querySelectorAll('.party-member-option').forEach(row=>{
    const show=!q || (row.dataset.partySearch||'').includes(q);
    row.hidden=!show;
    if(show) visible++;
  });
  document.querySelectorAll('[data-party-job]').forEach(group=>{
    group.hidden=![...group.querySelectorAll('.party-member-option')].some(row=>!row.hidden);
  });
  const empty=document.getElementById('partyPickerEmpty');
  if(empty) empty.hidden=visible!==0;
}

function choosePartyMember(ix,id){
  closePartyPicker();
  assign(ix,id);
}

async function assign(ix,id){
  if(!canManage()) return;
  const key=partyKey();
  db.parties[key]??=Array(40).fill(null);
  if(id){
    const target=db.users.find(u=>u.id===id);
    const existing=findPartyAssignment(id,state.party,ix);
    if(existing){
      const newGroup=Math.floor(ix/5)+1;
      const player=target?.ign||'This member';
      if(!confirm(`${player} is already assigned to ${existing.party} - Group ${existing.group}.

Are you sure you want to move ${player} to ${state.party} - Group ${newGroup}?`)) return party();
    }
    // Enforce exactly one assignment across Elite Party and every Sub Party.
    for(const partyName of PARTY_NAMES){
      const partyKeyValue=gid()+'|'+partyName;
      db.parties[partyKeyValue]??=Array(40).fill(null);
      db.parties[partyKeyValue]=db.parties[partyKeyValue].map(memberId=>memberId===id?null:memberId);
    }
    db.parties[key][ix]=id;
  }else{
    db.parties[key][ix]=null;
  }
  try{ await persistGuildState(); party(); }catch(err){ alert(err?.message||'Unable to save party assignment.'); }
}

function dev(){
  el().innerHTML=`<main class='screen auth' style="background-image:url('img/backgrounds/character-desktop.png')"><section class='auth-card dev-portal'>
    <div class='brand'><img src='img/ui/guild-crest.png'><div><h1>Developer Portal</h1><p>Create and manage guilds and reference codes</p></div></div>
    <form class='card' style='margin-top:18px' onsubmit='createGuild(event)'><div class='field'><label>Guild Name</label><input id='gName' required></div><button class='btn primary'>Create Guild + Invite Code</button></form>
    <div class='dev-list'>${db.guilds.length?db.guilds.map(g=>{
      const guildUsers=db.users.filter(u=>u.guildId===g.id);
      const count=guildUsers.length;
      const gm=guildUsers.find(u=>u.position==='Guild Master');
      const gmText=gm?`<div class='dev-gm'><span>Guild Master</span><b>${esc(gm.ign)}</b><small>Username: ${esc(gm.username)}${gm.active===false?' · DEACTIVATED':''}</small></div>`:`<div class='dev-gm empty'><span>Guild Master</span><b>Not registered yet</b></div>`;
      return `<div class='dev-row'><div class='dev-info'><b class='dev-guild-name'>${esc(g.name)}</b><div class='muted'>Reference Code: <b>${esc(g.code)}</b> · <span class='status ${g.status==='active'?'status-active':'status-inactive'}'>${esc(g.status)}</span> · ${count} member${count===1?'':'s'}</div>${gmText}</div><div class='dev-actions'>${gm?`<button class='btn primary' onclick="developerResetGuildMasterPassword('${g.id}')">Change GM Password</button>`:''}<button class='btn' onclick="editGuild('${g.id}')">Edit Name</button><button class='btn' onclick="regen('${g.id}')">Reset Code</button><button class='btn' onclick="toggleGuild('${g.id}')">${g.status==='active'?'Disable':'Enable'}</button><button class='btn danger-btn' onclick="deleteGuild('${g.id}')">Delete</button></div></div>`
    }).join(''):`<div class='card muted' style='margin-top:18px'>No guilds created yet.</div>`}</div>
    <button class='btn' style='margin-top:18px' onclick='logout()'>Logout</button>
  </section></main>`;
}

async function developerResetGuildMasterPassword(guildId){
  const g=db.guilds.find(x=>x.id===guildId);
  const gm=db.users.find(u=>u.guildId===guildId&&u.position==='Guild Master');
  if(!g || !gm) return alert('This guild does not have a registered Guild Master yet.');
  const next=prompt(`Enter a new password for ${gm.ign} (${g.name}).

Minimum 6 characters:`,'');
  if(next===null) return;
  if(next.length<6) return alert('New password must be at least 6 characters.');
  if(!confirm(`Reset the Guild Master password for ${gm.ign}? Their old password will stop working immediately.`)) return;
  try{
    await invokeAdmin({action:'reset_password',target_id:gm.id,password:next});
    alert(`Guild Master password changed for ${gm.ign}.`);
  }catch(err){ alert(err?.message||'Unable to reset Guild Master password.'); }
}

async function createGuild(e){
  e.preventDefault();
  const name=document.getElementById('gName').value.trim(); if(!name)return;
  try{
    const {error}=await sb.rpc('developer_create_guild',{p_name:name});
    if(error) throw error;
    await reloadAppData(); dev();
  }catch(err){ alert(err?.message||'Unable to create guild.'); }
}

async function regen(id){
  const g=db.guilds.find(x=>x.id===id); if(!g)return;
  if(!confirm(`Generate a new invite code for ${g.name}? The old code will stop working for new registrations.`))return;
  try{
    const {data,error}=await sb.rpc('reset_invite_code',{p_guild_id:id});
    if(error) throw error;
    g.code=data; dev();
  }catch(err){ alert(err?.message||'Unable to reset invite code.'); }
}

async function editGuild(id){
  const g=db.guilds.find(x=>x.id===id); if(!g)return;
  let name=prompt('Enter the new guild name:',g.name); if(name===null)return;
  name=name.trim(); if(!name)return alert('Guild name cannot be empty.');
  try{
    const {error}=await sb.rpc('developer_update_guild',{p_guild_id:id,p_name:name,p_status:null});
    if(error) throw error;
    await reloadAppData(); dev();
  }catch(err){ alert(err?.message||'Unable to edit guild.'); }
}

async function toggleGuild(id){
  const g=db.guilds.find(x=>x.id===id); if(!g)return;
  const next=g.status==='active'?'inactive':'active';
  const verb=next==='active'?'enable':'disable';
  if(!confirm(`${verb[0].toUpperCase()+verb.slice(1)} ${g.name}?${next==='inactive'?' New registrations using its reference code will be blocked.':''}`))return;
  try{
    const {error}=await sb.rpc('developer_update_guild',{p_guild_id:id,p_name:null,p_status:next});
    if(error) throw error;
    await reloadAppData(); dev();
  }catch(err){ alert(err?.message||'Unable to update guild status.'); }
}

async function deleteGuild(id){
  const g=db.guilds.find(x=>x.id===id); if(!g)return;
  const count=db.users.filter(u=>u.guildId===id).length;
  if(!confirm(`Permanently delete ${g.name}? This will also delete ${count} member Auth account${count===1?'':'s'}, attendance data, and party assignments. This cannot be undone.`))return;
  try{
    await invokeAdmin({action:'delete_guild',guild_id:id});
    await reloadAppData(); dev();
  }catch(err){ alert(err?.message||'Unable to delete guild.'); }
}

async function bootstrap(){
  if(!SUPABASE_READY) return setupRequired();
  try{
    const {data,error}=await sb.auth.getSession();
    if(error) throw error;
    const session=data.session;
    if(!session?.user) return auth('login');
    await loadAppData(session.user.id);
    if(state.user?.role==='Developer') dev(); else dashboard();
  }catch(err){
    await sb.auth.signOut().catch(()=>{});
    state.user=null; state.authUserId=null;
    auth('login',err?.message||'Please login again.');
  }
}

bootstrap();
