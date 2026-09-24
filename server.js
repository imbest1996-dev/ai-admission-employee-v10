const express=require('express');
const path=require('path');
const crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const app=express(); app.use(express.json({limit:'1mb'}));
const PORT=process.env.PORT||3000, TRIAL_DAYS=Number(process.env.DEMO_TRIAL_DAYS||14);
const VERSION='V10.1', STARTED_AT=Date.now();
const DATA_DIR=path.resolve(process.env.DATA_DIR||__dirname), DB_PATH=path.join(DATA_DIR,'admission.db');
require('fs').mkdirSync(DATA_DIR,{recursive:true});
const BILLING_SECRET=process.env.BILLING_WEBHOOK_SECRET||'';
const db=new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
db.exec(`CREATE TABLE IF NOT EXISTS institutes(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE,password_hash TEXT,password_salt TEXT,location TEXT DEFAULT 'India',courses TEXT DEFAULT '',demo TEXT DEFAULT '',plan TEXT DEFAULT 'trial',subscription_status TEXT DEFAULT 'trialing',trial_ends_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,institute_id INTEGER,expires_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,institute_id INTEGER,student_message TEXT,course TEXT,intent TEXT,temperature TEXT,next_action TEXT,summary TEXT,status TEXT DEFAULT 'New',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS funnel_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT,institute_id INTEGER,meta TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY AUTOINCREMENT,institute_id INTEGER,session_id TEXT,current_course TEXT DEFAULT 'Unknown',phone TEXT,last_intent TEXT,last_action TEXT,history TEXT DEFAULT '[]',updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(institute_id,session_id));
CREATE TABLE IF NOT EXISTS billing_events(id INTEGER PRIMARY KEY AUTOINCREMENT,institute_id INTEGER,event_type TEXT,payload TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// V10.1 lightweight migrations
for(const sql of ["ALTER TABLE institutes ADD COLUMN public_slug TEXT","ALTER TABLE leads ADD COLUMN phone TEXT"]){try{db.exec(sql)}catch{}}
function slugify(x){return String(x||'institute').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'institute'}
function ensureSlug(id,name){let row=db.prepare('SELECT public_slug FROM institutes WHERE id=?').get(id);if(row?.public_slug)return row.public_slug;let base=slugify(name),slug=base,n=1;while(db.prepare('SELECT id FROM institutes WHERE public_slug=? AND id<>?').get(slug,id))slug=base+'-'+(++n);db.prepare('UPDATE institutes SET public_slug=? WHERE id=?').run(slug,id);return slug}
for(const x of db.prepare('SELECT id,name FROM institutes WHERE public_slug IS NULL OR public_slug=\'\'').all())ensureSlug(x.id,x.name);
const publicHits=new Map(); function publicRate(req,res,next){const k=req.ip||'unknown',now=Date.now(),x=publicHits.get(k)||{n:0,t:now};if(now-x.t>60000){x.n=0;x.t=now}x.n++;publicHits.set(k,x);if(x.n>60)return res.status(429).json({error:'too many requests'});next()}
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
function cookie(req,name){const m=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return m?decodeURIComponent(m.slice(name.length+1)):''}
function auth(req,res,next){const token=cookie(req,'aae_session'); if(!token)return res.status(401).json({error:'login required'}); const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token,new Date().toISOString()); if(!s)return res.status(401).json({error:'session expired'}); req.instituteId=s.institute_id; next()}
function event(type,id=null,meta={}){db.prepare('INSERT INTO funnel_events(event_type,institute_id,meta) VALUES(?,?,?)').run(type,id,JSON.stringify(meta))}
function entitlement(id){const x=db.prepare('SELECT subscription_status,trial_ends_at FROM institutes WHERE id=?').get(id); if(!x)return false; return x.subscription_status==='active'||(x.subscription_status==='trialing'&&x.trial_ends_at>new Date().toISOString())}
function fallback(message,setup){
 const raw=String(message||''), low=raw.toLowerCase(),
 risky=/(discount|scholarship|refund|guarantee|guaranteed|selection rate|success rate|air\s*\d+|hostel|transport|bus facility|loan|emi|coupon|faculty|teacher|exam date|last date|deadline|personal number|owner.*number|system prompt|developer mode|rules bhool|ignore.*rules|weather|chest pain|job guarantee|seat guaranteed|kal fee|yesterday.*fee|allen|aakash|motion|resonance)/i.test(raw);
 if(risky){
   return {reply:'Is baat ki verified information saved institute data mein available nahi hai. Main ise institute team se confirm karne ke liye escalate kar raha hoon.',lead:{course:(low.includes('neet')||low.includes('नीट'))?'NEET':(low.includes('jee')||low.includes('जेईई')||low.includes('जेई'))?'JEE':'Unknown',intent:'NeedsConfirmation',temperature:'Warm',next_action:'HUMAN_ESCALATION',summary:raw.slice(0,140),phone:null},mode:'offline-v9.3-safety'};
 }
 const lines=String(setup.courses||'').split('\n').map(x=>x.trim()).filter(Boolean);
 const course=(low.includes('neet')||low.includes('नीट'))?'NEET':(low.includes('jee')||low.includes('जेईई')||low.includes('जेई'))?'JEE':(lines.find(x=>low.includes(x.split(/[—:-]/)[0].trim().toLowerCase()))||'').split(/[—:-]/)[0].trim()||'Unknown';
 const fee=/(fee|fees|price|cost|kitna|कितना|फीस|₹)/i.test(raw), demo=/(demo|counselling|counseling|visit|book|डेमो|काउंस)/i.test(raw);
 const batch=/(batch|timing|time|start|class|बैच|टाइम)/i.test(raw), admission=/(admission|join|enroll|seat|एडमिशन|जॉइन)/i.test(raw);
 const phone=(raw.match(/(?:\+?91[-\s]?)?[6-9]\d{9}/)||[])[0]||null;
 const intent=demo?'Demo':fee?'Fees':batch?'Batch':admission?'Admission':'General';
 const line=course==='Unknown'?null:lines.find(x=>x.toLowerCase().includes(course.toLowerCase()));
 let reply,next_action='ASK_COURSE',temp='Warm';
 if(course==='Unknown') reply='Aap NEET/JEE ya kaunsa course dekh rahe hain? Course batayenge to main available institute information se exact help karunga.';
 else if(fee){reply=line?`${line}\nAgar aap chahein to counselling/demo ka preferred day bata dijiye.`:'Is course ki exact fee saved institute information mein nahi hai. Institute team se confirmation chahiye.';next_action=line?'ASK_TIMELINE':'HUMAN_ESCALATION';temp=line?'Hot':'Warm';}
 else if(demo){reply=(setup.demo||'Counselling/demo details institute se confirm karni hongi.')+' — preferred day/time batayein.';next_action=setup.demo?'BOOK_DEMO':'HUMAN_ESCALATION';temp='Hot';}
 else if(batch){reply=line?`${line}\nAgar batch timing is line mein mention nahi hai to institute confirmation chahiye.`:'Batch/timing ki exact information saved data mein nahi hai; institute confirmation chahiye.';next_action='HUMAN_ESCALATION';}
 else if(admission){reply=`${course} admission mein interest note kar liya hai. ${phone?'Aapka contact bhi capture ho gaya.':'Contact number share karna optional hai; counselling preferred day bhi bata sakte hain.'}`;next_action=phone?'OWNER_CALLBACK':'ASK_CONTACT';temp='Hot';}
 else {reply=`Aap ${course} ke baare mein pooch rahe hain. Fees, batch ya counselling mein se kis cheez ki information chahiye?`;next_action='ASK_INTENT';}
 return {reply,lead:{course,intent,temperature:temp,next_action,summary:raw.slice(0,140),phone},mode:'offline-v9'};
}
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'';
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-5.6-luna';
async function aiAdmission(message,setup){
  if(!OPENAI_API_KEY)return fallback(message,setup);
  const facts=`Institute: ${setup.name||''}\nLocation: ${setup.location||''}\nCourses/fees/batches:\n${setup.courses||''}\nDemo/counselling:\n${setup.demo||''}`;
  const instructions=`You are an admission assistant. Reply in the student's language (Hindi, Hinglish or English). Use ONLY the institute facts supplied. Never invent fees, dates, discounts, seats, results or policies. If facts are insufficient, say you need institute confirmation and set next_action to HUMAN_ESCALATION. Return ONLY valid JSON with keys reply and lead; lead must contain course,intent,temperature,next_action,summary. temperature must be Hot, Warm, or Cold.`;
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,instructions,input:`INSTITUTE FACTS:\n${facts}\n\nSTUDENT MESSAGE:\n${message}`})});
    if(!r.ok)throw new Error(`OpenAI HTTP ${r.status}`);
    const data=await r.json();
    let text=data.output_text;
    if(!text&&Array.isArray(data.output))text=data.output.flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
    const out=JSON.parse(String(text||'').replace(/^```json\s*|\s*```$/g,''));
    if(!out?.reply||!out?.lead)throw new Error('invalid AI structure');
    out.mode='openai'; return out;
  }catch(e){
    const out=fallback(message,setup);out.mode='fallback';out.ai_error=e.message;return out;
  }
}


function applyConversationContext(message,out,ctx){
  if(!ctx)return out;
  const raw=String(message||''), explicit=out.lead.course!=='Unknown';
  if(!explicit && ctx.current_course && ctx.current_course!=='Unknown'){
    out.lead.course=ctx.current_course;
    // Re-run deterministic answer with inherited course made explicit.
    const inherited=fallback(`${ctx.current_course} ${raw}`,ctx.setup);
    out.reply=inherited.reply; out.lead.intent=inherited.lead.intent;
    out.lead.temperature=inherited.lead.temperature; out.lead.next_action=inherited.lead.next_action;
    out.lead.phone=inherited.lead.phone||ctx.phone||null;
    out.lead.summary=raw.slice(0,140); out.mode=(out.mode||'offline-v9')+'+memory';
  }
  // A phone-only follow-up after admission interest means callback.
  if(!explicit && out.lead.phone && ctx.current_course && ctx.current_course!=='Unknown'){
    out.lead.course=ctx.current_course; out.lead.temperature='Hot'; out.lead.next_action='OWNER_CALLBACK';
    if(out.lead.intent==='General')out.lead.intent=ctx.last_intent==='Admission'?'Admission':'General';
    out.reply=`${ctx.current_course} enquiry ke liye contact number note kar liya hai. Institute team callback kar sakti hai.`;
  }
  return out;
}
function loadConversation(instituteId,sessionId,setup){
  if(!sessionId)return null;
  const x=db.prepare('SELECT * FROM conversations WHERE institute_id=? AND session_id=?').get(instituteId,sessionId);
  return x?{...x,setup}: {current_course:'Unknown',phone:null,last_intent:null,last_action:null,history:'[]',setup};
}
function saveConversation(instituteId,sessionId,out,message){
  if(!sessionId)return;
  const old=db.prepare('SELECT * FROM conversations WHERE institute_id=? AND session_id=?').get(instituteId,sessionId);
  let h=[];try{h=JSON.parse(old?.history||'[]')}catch{};h.push({student:String(message).slice(0,500),assistant:String(out.reply).slice(0,700)});
  h=h.slice(-12);
  const course=out.lead.course!=='Unknown'?out.lead.course:(old?.current_course||'Unknown'), phone=out.lead.phone||old?.phone||null;
  db.prepare(`INSERT INTO conversations(institute_id,session_id,current_course,phone,last_intent,last_action,history,updated_at)
  VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(institute_id,session_id) DO UPDATE SET current_course=excluded.current_course,phone=excluded.phone,last_intent=excluded.last_intent,last_action=excluded.last_action,history=excluded.history,updated_at=CURRENT_TIMESTAMP`)
  .run(instituteId,sessionId,course,phone,out.lead.intent,out.lead.next_action,JSON.stringify(h));
}

function logEvent(level,type,meta={}){
  const line=JSON.stringify({ts:new Date().toISOString(),level,type,...meta});
  (level==='error'?console.error:console.log)(line);
}
function dbCounts(){return {institutes:Number(db.prepare('SELECT COUNT(*) n FROM institutes').get().n),leads:Number(db.prepare('SELECT COUNT(*) n FROM leads').get().n),conversations:Number(db.prepare('SELECT COUNT(*) n FROM conversations').get().n)};}
function readiness(){
  const warnings=[];
  if(process.env.NODE_ENV==='production'&&!BILLING_SECRET)warnings.push('BILLING_WEBHOOK_SECRET missing: real billing webhook disabled');
  if(!OPENAI_API_KEY)warnings.push('OPENAI_API_KEY missing: deterministic offline engine active');
  return {ready:true,version:VERSION,node:process.version,db_path:DB_PATH,offline_ai:!OPENAI_API_KEY,warnings};
}

app.use(express.static(path.join(__dirname,'public')));
app.get('/i/:slug',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.post('/api/public/event',publicRate,(req,res)=>{const allowed=new Set(['page_view','cta_demo','demo_message','student_chat_open']);const t=String(req.body?.event_type||'page_view');if(!allowed.has(t))return res.status(400).json({error:'invalid event'});event(t,null,{});res.json({ok:true})});
app.post('/api/public/demo',(req,res)=>{const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'message required'});event('demo_message');res.json(fallback(message,{courses:'NEET Dropper — sample fee ₹45,000\nJEE Dropper — sample fee ₹40,000',demo:'Free counselling available Mon–Sat'}))});
app.post('/api/auth/signup',(req,res)=>{const {name,email,password,location='India',courses='',demo=''}=req.body||{};if(!name||!email||!password||password.length<8)return res.status(400).json({error:'name, valid email and password (8+ chars) required'});const salt=crypto.randomBytes(16).toString('hex'),ph=hash(password,salt),end=new Date(Date.now()+TRIAL_DAYS*86400000).toISOString();try{const r=db.prepare('INSERT INTO institutes(name,email,password_hash,password_salt,location,courses,demo,trial_ends_at) VALUES(?,?,?,?,?,?,?,?)').run(name,email.toLowerCase(),ph,salt,location,courses,demo,end);const id=Number(r.lastInsertRowid);const public_slug=ensureSlug(id,name);event('trial_signup',id);res.json({ok:true,trial_ends_at:end,public_slug})}catch(e){res.status(409).json({error:'email already registered'})}});
app.post('/api/auth/login',(req,res)=>{const {email,password}=req.body||{};const u=db.prepare('SELECT * FROM institutes WHERE email=?').get(String(email||'').toLowerCase());if(!u||hash(String(password||''),u.password_salt)!==u.password_hash)return res.status(401).json({error:'invalid credentials'});const token=crypto.randomBytes(32).toString('hex'),exp=new Date(Date.now()+7*86400000).toISOString();db.prepare('INSERT INTO sessions(token,institute_id,expires_at) VALUES(?,?,?)').run(token,u.id,exp);res.setHeader('Set-Cookie',`aae_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`);event('login',u.id);res.json({ok:true})});
app.post('/api/auth/logout',auth,(req,res)=>{const t=cookie(req,'aae_session');db.prepare('DELETE FROM sessions WHERE token=?').run(t);res.setHeader('Set-Cookie','aae_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>{const x=db.prepare('SELECT id,name,email,location,courses,demo,public_slug,plan,subscription_status,trial_ends_at FROM institutes WHERE id=?').get(req.instituteId);res.json({...x,entitled:entitlement(req.instituteId)})});
app.patch('/api/me',auth,(req,res)=>{const old=db.prepare('SELECT * FROM institutes WHERE id=?').get(req.instituteId);const {name=old.name,location=old.location,courses=old.courses,demo=old.demo}=req.body||{};db.prepare('UPDATE institutes SET name=?,location=?,courses=?,demo=? WHERE id=?').run(name,location,courses,demo,req.instituteId);res.json({ok:true,public_slug:ensureSlug(req.instituteId,name)})});
app.post('/api/chat',auth,async(req,res)=>{if(!entitlement(req.instituteId))return res.status(402).json({error:'trial/subscription inactive'});const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'message required'});const setup=db.prepare('SELECT name,location,courses,demo FROM institutes WHERE id=?').get(req.instituteId);let out=await aiAdmission(message,setup);
const sessionId=String(req.body?.session_id||'').trim().slice(0,100);
const ctx=loadConversation(req.instituteId,sessionId,setup);
out=applyConversationContext(message,out,ctx);
saveConversation(req.instituteId,sessionId,out,message);
const l=out.lead;const r=db.prepare('INSERT INTO leads(institute_id,student_message,course,intent,temperature,next_action,summary,phone) VALUES(?,?,?,?,?,?,?,?)').run(req.instituteId,message,l.course,l.intent,l.temperature,l.next_action,l.summary,l.phone||null);out.lead.id=Number(r.lastInsertRowid);res.json(out)});
app.get('/api/public/institute/:slug',publicRate,(req,res)=>{const x=db.prepare('SELECT id,name,location,public_slug,subscription_status,trial_ends_at FROM institutes WHERE public_slug=?').get(String(req.params.slug||''));if(!x||!entitlement(x.id))return res.status(404).json({error:'institute unavailable'});res.json({name:x.name,location:x.location,slug:x.public_slug});});
app.post('/api/public/institute/:slug/chat',publicRate,async(req,res)=>{const inst=db.prepare('SELECT id,name,location,courses,demo,public_slug FROM institutes WHERE public_slug=?').get(String(req.params.slug||''));if(!inst||!entitlement(inst.id))return res.status(404).json({error:'institute unavailable'});const message=String(req.body?.message||'').trim().slice(0,500);if(!message)return res.status(400).json({error:'message required'});const sessionId=String(req.body?.session_id||'').trim().slice(0,100);if(!sessionId)return res.status(400).json({error:'session_id required'});let out=await aiAdmission(message,inst);out=applyConversationContext(message,out,loadConversation(inst.id,sessionId,inst));saveConversation(inst.id,sessionId,out,message);const l=out.lead;const r=db.prepare('INSERT INTO leads(institute_id,student_message,course,intent,temperature,next_action,summary,phone) VALUES(?,?,?,?,?,?,?,?)').run(inst.id,message,l.course,l.intent,l.temperature,l.next_action,l.summary,l.phone||null);event('student_chat',inst.id,{course:l.course,intent:l.intent});res.json({reply:out.reply,lead_id:Number(r.lastInsertRowid)});});
app.patch('/api/leads/:id/status',auth,(req,res)=>{const allowed=new Set(['New','Contacted','Demo Booked','Admitted','Lost']);const status=String(req.body?.status||'');if(!allowed.has(status))return res.status(400).json({error:'invalid status'});const r=db.prepare('UPDATE leads SET status=? WHERE id=? AND institute_id=?').run(status,Number(req.params.id),req.instituteId);if(!r.changes)return res.status(404).json({error:'lead not found'});res.json({ok:true,status});});
app.get('/api/leads',auth,(req,res)=>res.json(db.prepare('SELECT * FROM leads WHERE institute_id=? ORDER BY id DESC LIMIT 200').all(req.instituteId)));
app.get('/api/followups',auth,(req,res)=>res.json(db.prepare("SELECT * FROM leads WHERE institute_id=? AND (temperature='Hot' OR next_action IN ('BOOK_DEMO','OWNER_CALLBACK','HUMAN_ESCALATION')) ORDER BY id DESC LIMIT 100").all(req.instituteId)));
app.get('/api/stats',auth,(req,res)=>{const id=req.instituteId;const n=q=>Number(db.prepare(q).get(id).n);res.json({enquiries:n('SELECT COUNT(*) n FROM leads WHERE institute_id=?'),hot:n("SELECT COUNT(*) n FROM leads WHERE institute_id=? AND temperature='Hot'"),demo:n("SELECT COUNT(*) n FROM leads WHERE institute_id=? AND intent='Demo'")})});

app.get('/api/ops/status',auth,(req,res)=>res.json({ok:true,...readiness(),uptime_seconds:Math.floor((Date.now()-STARTED_AT)/1000),counts:dbCounts()}));
app.get('/api/export',auth,(req,res)=>{
 const id=req.instituteId, institute=db.prepare('SELECT id,name,email,location,courses,demo,plan,subscription_status,trial_ends_at,created_at FROM institutes WHERE id=?').get(id);
 const leads=db.prepare('SELECT * FROM leads WHERE institute_id=? ORDER BY id').all(id);
 const conversations=db.prepare('SELECT session_id,current_course,phone,last_intent,last_action,history,updated_at FROM conversations WHERE institute_id=? ORDER BY id').all(id);
 event('data_exported',id,{leads:leads.length,conversations:conversations.length});
 res.setHeader('Content-Disposition',`attachment; filename="ai-admission-export-${id}.json"`);
 res.json({exported_at:new Date().toISOString(),version:VERSION,institute,leads,conversations});
});

app.get('/api/funnel',auth,(req,res)=>res.json(db.prepare('SELECT event_type,COUNT(*) n FROM funnel_events WHERE institute_id=? GROUP BY event_type ORDER BY n DESC').all(req.instituteId)));
app.post('/api/billing/demo-checkout',auth,(req,res)=>{event('checkout_started',req.instituteId,{plan:req.body?.plan||'starter'});res.json({ok:true,mode:'sandbox',message:'No real charge made. Use signed webhook to simulate activation.'})});
app.post('/webhooks/billing',(req,res)=>{if(!BILLING_SECRET||req.headers['x-billing-secret']!==BILLING_SECRET)return res.sendStatus(401);const {institute_id,event_type}=req.body||{};const map={subscription_activated:'active',payment_failed:'past_due',subscription_cancelled:'cancelled'};if(!institute_id||!map[event_type])return res.status(400).json({error:'invalid event'});db.prepare('UPDATE institutes SET subscription_status=?,plan=CASE WHEN ?="active" THEN "starter" ELSE plan END WHERE id=?').run(map[event_type],map[event_type],institute_id);db.prepare('INSERT INTO billing_events(institute_id,event_type,payload) VALUES(?,?,?)').run(institute_id,event_type,JSON.stringify(req.body));event(event_type,institute_id);res.json({ok:true,status:map[event_type]})});

// ---- V7 sandbox adapters + pilot regression runner ----
function sandboxWhatsAppSend(to,text){
  const id='wamock_'+crypto.randomBytes(6).toString('hex');
  return {ok:true,provider:'sandbox-whatsapp',message_id:id,to:String(to||'test-student'),text:String(text||'')};
}
function sandboxPaymentEvent(instituteId,eventType){
  const map={subscription_activated:'active',payment_failed:'past_due',subscription_cancelled:'cancelled'};
  if(!map[eventType]) throw new Error('unsupported sandbox billing event');
  db.prepare('UPDATE institutes SET subscription_status=?,plan=CASE WHEN ?="active" THEN "starter" ELSE plan END WHERE id=?')
    .run(map[eventType],map[eventType],instituteId);
  db.prepare('INSERT INTO billing_events(institute_id,event_type,payload) VALUES(?,?,?)')
    .run(instituteId,eventType,JSON.stringify({sandbox:true,institute_id:instituteId,event_type:eventType}));
  event(eventType,instituteId,{sandbox:true});
  return map[eventType];
}
app.post('/api/sandbox/whatsapp/send',auth,(req,res)=>{
  if(!entitlement(req.instituteId)) return res.status(402).json({error:'trial/subscription inactive'});
  const out=sandboxWhatsAppSend(req.body?.to,req.body?.text);
  event('sandbox_whatsapp_sent',req.instituteId,{message_id:out.message_id});
  res.json(out);
});
app.post('/api/sandbox/billing/:event',auth,(req,res)=>{
  try{res.json({ok:true,status:sandboxPaymentEvent(req.instituteId,req.params.event)})}
  catch(e){res.status(400).json({error:e.message})}
});
app.post('/api/pilot/run',(req,res)=>{
  // Local/sandbox regression test. It creates an isolated synthetic tenant.
  const stamp=Date.now()+'_'+crypto.randomBytes(3).toString('hex');
  const checks=[]; let instituteId=null;
  const check=(name,fn)=>{try{const detail=fn();checks.push({name,pass:true,detail});return detail}catch(e){checks.push({name,pass:false,error:e.message});return null}};
  check('database_write',()=>{
    const salt=crypto.randomBytes(16).toString('hex'), end=new Date(Date.now()+TRIAL_DAYS*86400000).toISOString();
    const r=db.prepare('INSERT INTO institutes(name,email,password_hash,password_salt,location,courses,demo,trial_ends_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('V7 Pilot Institute','pilot_'+stamp+'@example.invalid',hash('PilotPass123!',salt),salt,'Test City','NEET Dropper — ₹45,000\nJEE Dropper — ₹40,000','Counselling Mon–Sat',end);
    instituteId=Number(r.lastInsertRowid); return {institute_id:instituteId};
  });
  check('trial_entitlement',()=>{if(!entitlement(instituteId))throw new Error('trial not entitled');return 'active'});
  const chat=check('admission_engine',()=>{
    const setup=db.prepare('SELECT courses,demo FROM institutes WHERE id=?').get(instituteId);
    const out=fallback('NEET dropper fees and demo?',setup);
    if(out.lead.course!=='NEET'||out.lead.temperature!=='Hot')throw new Error('lead classification unexpected');
    const l=out.lead;
    const r=db.prepare('INSERT INTO leads(institute_id,student_message,course,intent,temperature,next_action,summary) VALUES(?,?,?,?,?,?,?)')
      .run(instituteId,'NEET dropper fees and demo?',l.course,l.intent,l.temperature,l.next_action,l.summary);
    return {lead_id:Number(r.lastInsertRowid),course:l.course,intent:l.intent,temperature:l.temperature};
  });
  check('lead_persistence',()=>{const n=Number(db.prepare('SELECT COUNT(*) n FROM leads WHERE institute_id=?').get(instituteId).n);if(n<1)throw new Error('lead missing');return {count:n}});
  check('sandbox_whatsapp',()=>sandboxWhatsAppSend('919999999999','Pilot reply'));
  check('sandbox_payment_activation',()=>{const s=sandboxPaymentEvent(instituteId,'subscription_activated');if(s!=='active'||!entitlement(instituteId))throw new Error('activation failed');return s});
  check('analytics_event',()=>{event('pilot_completed',instituteId,{checks:checks.length});const n=Number(db.prepare("SELECT COUNT(*) n FROM funnel_events WHERE institute_id=?").get(instituteId).n);if(n<1)throw new Error('analytics missing');return {events:n}});
  const passed=checks.every(x=>x.pass);
  res.status(passed?200:500).json({ok:passed,version:VERSION,mode:'sandbox',summary:{passed:checks.filter(x=>x.pass).length,total:checks.length},checks});
});

app.get('/api/health',(req,res)=>{try{db.prepare('SELECT 1').get();res.json({ok:true,version:VERSION,uptime_seconds:Math.floor((Date.now()-STARTED_AT)/1000),database:'ok',auth:true,multiTenant:true,billing:'sandbox',whatsapp:'sandbox',pilot:true})}catch(e){res.status(503).json({ok:false,version:VERSION,database:'error'})}});
app.use((err,req,res,next)=>{logEvent('error','unhandled_request',{method:req.method,path:req.path,error:String(err?.message||err)});if(res.headersSent)return next(err);res.status(500).json({error:'internal server error',request_failed:true})});
process.on('uncaughtException',e=>logEvent('error','uncaught_exception',{error:e.message}));
process.on('unhandledRejection',e=>logEvent('error','unhandled_rejection',{error:String(e?.message||e)}));
app.listen(PORT,()=>logEvent('info','server_started',{version:VERSION,port:Number(PORT),node:process.version,data_dir:DATA_DIR}));
