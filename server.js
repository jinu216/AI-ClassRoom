const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '12mb' }));

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }
    })
  : null;

const CLOUD_KEY_PATTERN = /^pius_[A-Za-z0-9_.:+-]{1,180}$/;
const LOCAL_ONLY_KEY_PATTERN = /(password|login_grant|preview_|health_probe|_read_|_seen_|_undo|review_drafts|active_step)/i;
function validCloudKey(key) {
  return CLOUD_KEY_PATTERN.test(String(key || '')) && !LOCAL_ONLY_KEY_PATTERN.test(String(key || ''));
}
function requestActor(req) {
  return String(req.get('x-portal-actor') || 'portal-user').slice(0,120);
}
function cloudUnavailable(res) {
  return res.status(503).json({ ok:false, error:'Supabase cloud storage is not configured on the server.' });
}

// Serve the public folder through both URL styles used by the project.
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname,'uploads');
if(!fs.existsSync(uploadsDir))fs.mkdirSync(uploadsDir,{recursive:true});
const upload = multer({
  dest: uploadsDir,
  limits:{fileSize:5*1024*1024},
  fileFilter:(req,file,cb)=>{
    const ok=/^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.|vnd\.ms-excel|vnd\.ms-powerpoint)|image\/|text\/)/i.test(file.mimetype||'');
    cb(ok?null:new Error('Unsupported document type'),ok);
  }
});

app.use('/public', express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));
app.get('/', (req, res) => res.redirect('/public/principal.html'));

// Central portal state. Supabase is authoritative; browsers only keep a cache.
app.get('/api/cloud-state', async (req, res) => {
  if (!supabase) return cloudUnavailable(res);
  res.set('Cache-Control', 'no-store');
  const { data, error } = await supabase
    .from('portal_state')
    .select('state_key,state_value,version,updated_at')
    .order('state_key');
  if (error) return res.status(502).json({ ok:false, error:'Cloud data could not be loaded.', detail:error.message });
  const records = {};
  for (const row of data || []) {
    if (validCloudKey(row.state_key)) records[row.state_key] = {
      value:row.state_value,
      version:Number(row.version || 1),
      updatedAt:row.updated_at
    };
  }
  res.json({ ok:true, records, checkedAt:new Date().toISOString() });
});

app.put('/api/cloud-state/:key', async (req, res) => {
  if (!supabase) return cloudUnavailable(res);
  const key = decodeURIComponent(req.params.key || '');
  if (!validCloudKey(key)) return res.status(400).json({ ok:false, error:'This browser-only key cannot be stored in the cloud.' });
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) return res.status(400).json({ ok:false, error:'A value is required.' });
  const actor = requestActor(req);
  const { data:existing, error:readError } = await supabase
    .from('portal_state').select('version').eq('state_key',key).maybeSingle();
  if (readError) return res.status(502).json({ ok:false, error:'Cloud version could not be checked.', detail:readError.message });
  const requestedVersion = Number(req.body.baseVersion || 0);
  const currentVersion = Number(existing?.version || 0);
  if (requestedVersion && currentVersion && requestedVersion !== currentVersion) {
    return res.status(409).json({ ok:false, conflict:true, currentVersion, error:'A newer cloud copy already exists.' });
  }
  const nextVersion = currentVersion + 1;
  const row = { state_key:key, state_value:req.body.value, version:nextVersion, updated_by:actor, updated_at:new Date().toISOString() };
  const { data, error } = await supabase.from('portal_state').upsert(row,{onConflict:'state_key'}).select('version,updated_at').single();
  if (error) return res.status(502).json({ ok:false, error:'Cloud data could not be saved.', detail:error.message });
  await supabase.from('portal_audit_log').insert({ action:'state.upsert', entity_type:'portal_state', entity_id:key, actor, metadata:{version:data.version} });
  broadcast({ type:'CLOUD_STATE_UPDATED', payload:{ key, value:req.body.value, version:data.version, updatedAt:data.updated_at, source:req.get('x-portal-client') || '' } });
  res.json({ ok:true, key, version:data.version, updatedAt:data.updated_at });
});

app.delete('/api/cloud-state/:key', async (req, res) => {
  if (!supabase) return cloudUnavailable(res);
  const key = decodeURIComponent(req.params.key || '');
  if (!validCloudKey(key)) return res.status(400).json({ ok:false, error:'Invalid cloud key.' });
  const actor = requestActor(req);
  const { error } = await supabase.from('portal_state').delete().eq('state_key',key);
  if (error) return res.status(502).json({ ok:false, error:'Cloud data could not be removed.', detail:error.message });
  await supabase.from('portal_audit_log').insert({ action:'state.delete', entity_type:'portal_state', entity_id:key, actor });
  broadcast({ type:'CLOUD_STATE_DELETED', payload:{key,source:req.get('x-portal-client') || ''} });
  res.json({ok:true,key});
});

// Read-only cloud diagnostics used by the Principal System Health page.
// Secrets are used only on the server and are never included in the response.
const SYSTEM_VERSION = process.env.APP_VERSION || 'principal-cloud-health-v1';
function timedFetch(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  return fetch(url, { ...options, signal: controller.signal })
    .then(response => ({ response, latencyMs: Date.now() - started }))
    .finally(() => clearTimeout(timer));
}
function safeServiceError(error) {
  if (error && error.name === 'AbortError') return 'Request timed out.';
  return 'Cloud service could not be reached.';
}
app.get('/api/health', (req, res) => res.json({ status:'online', version:SYSTEM_VERSION, time:new Date().toISOString() }));
app.get('/api/system-health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const checks = {
    render: { status:'ok', message:'Node.js server responded successfully.' },
    websocket: { status:'ok', message:`WebSocket server active with ${wss.clients.size} connected portal client(s).` },
    github: process.env.RENDER_GIT_COMMIT
      ? { status:'ok', message:'Render is running a traceable GitHub commit.' }
      : { status:'warning', message:'Server is active, but Render did not provide Git commit metadata.', recommendation:'Confirm this Render service is connected to the intended GitHub repository and branch, and enable Auto-Deploy.' },
    supabaseDatabase: { status:'error', message:'Supabase environment variables are not configured.', recommendation:'Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render Environment, then redeploy.' },
    supabaseStorage: { status:'error', message:'Supabase environment variables are not configured.', recommendation:'Add the Supabase credentials in Render and create a private bucket named portal-private.' }
  };
  if (supabaseUrl && supabaseKey) {
    // New sb_secret_* keys authenticate through the apikey header. Legacy
    // service_role JWT keys additionally use Authorization: Bearer.
    const headers = { apikey:supabaseKey, Accept:'application/json' };
    if (!supabaseKey.startsWith('sb_secret_')) headers.Authorization=`Bearer ${supabaseKey}`;
    const databaseStarted=Date.now();
    const [dbResult, storageResult] = await Promise.allSettled([
      supabase.from('portal_health_check').select('id,service_name').limit(1),
      timedFetch(`${supabaseUrl}/storage/v1/bucket`, { headers })
    ]);
    if (dbResult.status === 'fulfilled') {
      const { error, status } = dbResult.value;
      const latencyMs=Date.now()-databaseStarted;
      if (!error) checks.supabaseDatabase={status:'ok',message:'Database connection and health table are available.',latencyMs};
      else if (status===404||error.code==='PGRST205') checks.supabaseDatabase={status:'warning',message:'Supabase responded, but portal_health_check is missing.',latencyMs,recommendation:'Run supabase-portal-schema.sql in the Supabase SQL Editor, then test again.'};
      else checks.supabaseDatabase={status:'error',message:`Supabase database check failed${status?' (HTTP '+status+')':''}.`,latencyMs,recommendation:'Verify the Supabase server key and portal_health_check permissions in Render and Supabase.'};
    } else checks.supabaseDatabase={status:'error',message:safeServiceError(dbResult.reason),recommendation:'Verify SUPABASE_URL, Render outbound connectivity and the Supabase project status.'};
    if (storageResult.status === 'fulfilled') {
      const { response, latencyMs } = storageResult.value;
      if (response.ok) {
        const buckets=await response.json().catch(()=>[]),hasPrivate=Array.isArray(buckets)&&buckets.some(b=>b.name==='portal-private'&&b.public===false);
        checks.supabaseStorage=hasPrivate?{status:'ok',message:'Supabase Storage is active and portal-private is private.',latencyMs}:{status:'warning',message:'Storage responded, but the private portal-private bucket was not found.',latencyMs,recommendation:'Run supabase-health-setup.sql or create a private bucket named portal-private.'};
      } else checks.supabaseStorage={status:'error',message:`Supabase Storage returned HTTP ${response.status}.`,latencyMs,recommendation:'Use the service-role key on Render and verify Storage is enabled for this project.'};
    } else checks.supabaseStorage={status:'error',message:safeServiceError(storageResult.reason),recommendation:'Verify the Supabase project status and Render environment variables.'};
  }
  res.json({requestId:`health-${Date.now()}`,checkedAt:new Date().toISOString(),checks,deployment:{environment:process.env.RENDER?'Render':'Local / other host',serviceName:process.env.RENDER_SERVICE_NAME||'Not reported',externalUrl:process.env.RENDER_EXTERNAL_URL||'',gitCommit:process.env.RENDER_GIT_COMMIT?process.env.RENDER_GIT_COMMIT.slice(0,12):'Not reported',gitBranch:process.env.RENDER_GIT_BRANCH||'Not reported',serverVersion:SYSTEM_VERSION,nodeVersion:process.version,uptimeSeconds:Math.round(process.uptime()),websocketClients:wss.clients.size}});
});

// ====================================================================
// 1. IN-MEMORY STATE STORE
// ====================================================================
let page1Data = {
  heading1: "Our History & Legacy",
  text1: "Founded with a vision of excellence, Pope Pius institution has been nurturing young minds for decades.",
  heading2: "Campus Facilities",
  text2: "Equipped with modern laboratories, digital classrooms, and extensive sports facilities."
};

let facultyData = [
  {
    id: 101,
    name: "Dr. Sarah Jenkins",
    qualification: "Ph.D. in Applied Physics",
    specialization: "Quantum Physics & Thermodynamics",
    experience: "12",
    yearJoined: "2018",
    photo: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=300&q=80",
    bio: "Senior Lecturer with over a decade of research experience in quantum systems and curriculum development."
  },
  {
    id: 102,
    name: "Prof. Alan Vance",
    qualification: "M.Sc. Computer Science",
    specialization: "Artificial Intelligence & Embedded Systems",
    experience: "8",
    yearJoined: "2021",
    photo: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=300&q=80",
    bio: "Dedicated instructor focusing on hands-on practical robotics, IoT, and software development."
  }
];

let noticesData = [
  { id: 'N1', title: 'Mid-Term Examinations Schedule Released', priority: 'High', date: '2026-08-01' }
];

let feeData = {
  term: 'Term 2 - 2026',
  amount: '$1,550',
  dueDate: '2026-09-15'
};

// Shared Principal / Faculty Portal state.
// Prototype note: this state resets when the Node process restarts.
let portalStaff = [];
let profileVerificationRequests = [];
let portalStudents = [];
let studentProfileRequests = [];
let studentLeaveRecords = [];
let studentMailbox = [];
let classTeacherAssignments = {};
let timetableFolders = [];
let timetableReview = null;
let communicationMessages = [];
let chatMessages = [];
let communicationAuditLog = [];
let pushSubscriptions = [];
const VAPID_PUBLIC_KEY=process.env.VAPID_PUBLIC_KEY||'';
const VAPID_PRIVATE_KEY=process.env.VAPID_PRIVATE_KEY||'';
const VAPID_SUBJECT=process.env.VAPID_SUBJECT||'mailto:admin@example.com';
if(VAPID_PUBLIC_KEY&&VAPID_PRIVATE_KEY)webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';

let portionProgress = [];
let additionalDutyAssignments = [];
let libraryResources = [];
let attendanceSettings = { schoolName:'Pope Pius Academy', latitude:'', longitude:'', radiusMeters:150, gpsAccuracyMeters:100, checkInTime:'08:00', checkOutTime:'16:00', graceMinutes:10, minimumFullDayMinutes:420, halfDayMinutes:240, locationRequired:true };
let attendanceRecords = [];
let leaveRecords = [];

async function hydrateSharedStateFromCloud() {
  if (!supabase) return;
  const keys = [
    'pius_staff_data','pius_students_data','pius_profile_verification_requests',
    'pius_student_profile_requests','pius_student_leave_records',
    'pius_class_teacher_assignments','pius_timetable_folders','pius_portion_progress',
    'pius_additional_duty_assignments','pius_digital_library_resources',
    'pius_attendance_settings','pius_attendance_records','pius_leave_records',
    'pius_communication_messages','pius_chat_messages','pius_communication_audit_log'
  ];
  const { data, error } = await supabase.from('portal_state').select('state_key,state_value').in('state_key',keys);
  if (error) { console.error('Supabase shared-state hydration failed:', error.message); return; }
  const value = key => (data || []).find(row => row.state_key === key)?.state_value;
  if (Array.isArray(value('pius_staff_data'))) portalStaff=value('pius_staff_data');
  if (Array.isArray(value('pius_students_data'))) portalStudents=value('pius_students_data');
  if (Array.isArray(value('pius_profile_verification_requests'))) profileVerificationRequests=value('pius_profile_verification_requests');
  if (Array.isArray(value('pius_student_profile_requests'))) studentProfileRequests=value('pius_student_profile_requests');
  if (Array.isArray(value('pius_student_leave_records'))) studentLeaveRecords=value('pius_student_leave_records');
  if (value('pius_class_teacher_assignments') && typeof value('pius_class_teacher_assignments') === 'object') classTeacherAssignments=value('pius_class_teacher_assignments');
  if (Array.isArray(value('pius_timetable_folders'))) timetableFolders=value('pius_timetable_folders');
  if (Array.isArray(value('pius_portion_progress'))) portionProgress=value('pius_portion_progress');
  if (Array.isArray(value('pius_additional_duty_assignments'))) additionalDutyAssignments=value('pius_additional_duty_assignments');
  if (Array.isArray(value('pius_digital_library_resources'))) libraryResources=value('pius_digital_library_resources');
  if (value('pius_attendance_settings') && typeof value('pius_attendance_settings') === 'object') attendanceSettings=value('pius_attendance_settings');
  if (Array.isArray(value('pius_attendance_records'))) attendanceRecords=value('pius_attendance_records');
  if (Array.isArray(value('pius_leave_records'))) leaveRecords=value('pius_leave_records');
  if (Array.isArray(value('pius_communication_messages'))) communicationMessages=value('pius_communication_messages');
  if (Array.isArray(value('pius_chat_messages'))) chatMessages=value('pius_chat_messages');
  if (Array.isArray(value('pius_communication_audit_log'))) communicationAuditLog=value('pius_communication_audit_log');
}

function upsertById(list, item) {
  if (!item || !item.id) return;
  const index = list.findIndex(x => x.id === item.id);
  if (index >= 0) list[index] = { ...list[index], ...item };
  else list.unshift(item);
}

function upsertVerification(request) {
  if (!request || !request.id) return;
  const index = profileVerificationRequests.findIndex(r => r.id === request.id);
  if (index >= 0) profileVerificationRequests[index] = { ...profileVerificationRequests[index], ...request };
  else profileVerificationRequests.unshift(request);
}

function applyProfileToRoster(profile) {
  if (!profile || !profile.empId) return;
  const index = portalStaff.findIndex(s => s.empId === profile.empId);
  if (index >= 0) portalStaff[index] = { ...portalStaff[index], ...profile };
  else portalStaff.push(profile);
}

function upsertStudentRequest(request) {
  if (!request || !request.id) return;
  const index = studentProfileRequests.findIndex(r => r.id === request.id);
  if (index >= 0) studentProfileRequests[index] = { ...studentProfileRequests[index], ...request };
  else studentProfileRequests.unshift(request);
}

function applyStudentToRoster(profile) {
  if (!profile) return;
  const id = profile.rollId || profile.admissionNo || profile.studentId;
  if (!id) return;
  const index = portalStudents.findIndex(s => (s.rollId || s.admissionNo || s.studentId) === id);
  if (index >= 0) portalStudents[index] = { ...portalStudents[index], ...profile };
  else portalStudents.push(profile);
}

// Mock student database for lookup tab
const studentDatabase = {
  "101": {
    name: "Alex Johnson",
    class: "Grade 10-A",
    attendance: { present: 88, total: 92, percentage: "95.6%" },
    academics: [
      { subject: "Mathematics", score: "92/100" },
      { subject: "Physics", score: "88/100" },
      { subject: "Computer Science", score: "96/100" }
    ]
  },
  "102": {
    name: "Maria Garcia",
    class: "Grade 10-B",
    attendance: { present: 82, total: 92, percentage: "89.1%" },
    academics: [
      { subject: "Mathematics", score: "78/100" },
      { subject: "Physics", score: "84/100" },
      { subject: "Computer Science", score: "90/100" }
    ]
  }
};

// Helper: Broadcast payload to all connected clients
function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

async function persistRuntimeState(key,value){
  if(!supabase)return;
  try{
    const {data:existing}=await supabase.from('portal_state').select('version').eq('state_key',key).maybeSingle();
    const version=Number(existing?.version||0)+1;
    await supabase.from('portal_state').upsert({state_key:key,state_value:value,version,updated_by:'server-runtime',updated_at:new Date().toISOString()},{onConflict:'state_key'});
  }catch(e){console.error('Runtime state persistence failed:',key,e.message)}
}
function commId(prefix='MSG'){return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`}
function requestNo(prefix='REQ'){const d=new Date(),stamp=d.toISOString().slice(0,10).replace(/-/g,'');return `${prefix}-${stamp}-${String(Date.now()).slice(-7)}-${Math.random().toString(36).slice(2,5).toUpperCase()}`}
function ensureRequestNo(obj,prefix='REQ'){if(!obj)return '';if(!obj.requestNo)obj.requestNo=obj.id||requestNo(prefix);return obj.requestNo}
function auditCommunication(action,item,actor={}){const row={id:commId('AUD'),requestNo:item?.requestNo||item?.id||'',messageId:item?.id||'',action,actorRole:actor.role||actor.actorRole||'',actorId:actor.id||actor.actorId||'',actorName:actor.name||actor.actorName||'',status:item?.status||'',at:new Date().toISOString()};communicationAuditLog.unshift(row);communicationAuditLog=communicationAuditLog.slice(0,10000);persistRuntimeState('pius_communication_audit_log',communicationAuditLog);broadcast({type:'COMMUNICATION_AUDIT_UPDATED',payload:row});return row}
function addCommunication(msg){
  const item={id:msg.id||commId('MAIL'),requestNo:msg.requestNo||requestNo(msg.type&&/REQUEST|PROFILE|LEAVE|TIMETABLE/.test(msg.type)?'REQ':'MSG'),kind:'official',status:msg.status||'New',createdAt:msg.createdAt||new Date().toISOString(),readBy:Array.isArray(msg.readBy)?msg.readBy:[],deletedFor:Array.isArray(msg.deletedFor)?msg.deletedFor:[],...msg};
  ensureRequestNo(item,msg.type&&/REQUEST|PROFILE|LEAVE|TIMETABLE/.test(msg.type)?'REQ':'MSG');
  communicationMessages.unshift(item);communicationMessages=communicationMessages.slice(0,5000);
  auditCommunication('CREATED',item,{role:msg.fromRole,id:msg.fromId,name:msg.fromName});
  persistRuntimeState('pius_communication_messages',communicationMessages);
  broadcast({type:'COMMUNICATION_UPDATED',payload:item});
  return item;
}
function addChat(msg){
  const item={id:msg.id||commId('CHAT'),kind:'chat',createdAt:msg.createdAt||new Date().toISOString(),...msg};
  chatMessages.push(item);chatMessages=chatMessages.slice(-10000);
  persistRuntimeState('pius_chat_messages',chatMessages);
  broadcast({type:'CHAT_MESSAGE_UPDATED',payload:item});
  return item;
}
function studentPortalId(s){return String(s.rollId||s.admissionNo||s.studentId||'')}
function classEqualsStudent(folder,s){
  const grade=String(s.grade||s.className||'').trim().toLowerCase();
  const div=String(s.section||s.division||'').replace(/^div\s*/i,'').trim().toLowerCase();
  const fg=String(folder.className||'').trim().toLowerCase();
  const fd=String(folder.division||'').replace(/^div\s*/i,'').trim().toLowerCase();
  return grade===fg && (!div||div===fd);
}
app.post('/api/communications/upload',upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({ok:false,error:'No file uploaded.'});
  const ext=path.extname(req.file.originalname||'').slice(0,12);
  const finalName=`${req.file.filename}${ext}`;
  const finalPath=path.join(uploadsDir,finalName);
  fs.renameSync(req.file.path,finalPath);
  res.json({ok:true,attachment:{name:req.file.originalname,size:req.file.size,mime:req.file.mimetype,url:`/uploads/${finalName}`}});
});

async function sendWebPushToEmpIds(empIds,title,body,url='/public/faculty.html'){
  if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY)return {sent:0,reason:'VAPID not configured'};
  const ids=new Set((empIds||[]).map(String));let sent=0;
  for(const item of pushSubscriptions.filter(x=>ids.has(String(x.empId)))){
    try{await webpush.sendNotification(item.subscription,JSON.stringify({title,body,url}));sent++}
    catch(e){if([404,410].includes(e.statusCode))pushSubscriptions=pushSubscriptions.filter(x=>x!==item)}
  }
  return {sent};
}
async function telegramSend(chatId,text){
  if(!TELEGRAM_BOT_TOKEN||!chatId)return false;
  try{
    const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text})});
    return r.ok;
  }catch(e){return false}
}
async function notifyFaculty(empIds,title,body){
  const ids=new Set((empIds||[]).map(String));
  const push=await sendWebPushToEmpIds([...ids],title,body);
  let telegram=0;
  for(const staff of portalStaff.filter(s=>ids.has(String(s.empId))&&s.telegramChatId)){
    if(await telegramSend(staff.telegramChatId,`${title}\n${body}`))telegram++;
  }
  return {push:push.sent||0,telegram};
}
function aiSystemPrompt(){
  return `You are the advisory intelligence layer for a school ERP. Use only supplied structured facts. Never invent teacher capabilities, workloads, ownership, rules or timetable feasibility. Deterministic school rules and CSP results are authoritative. Give concise management-friendly analysis: issue, reason, impact, best options, risks, and what requires Principal approval. Never claim a staffing reduction is safe unless supplied simulation data proves it.`;
}
app.get('/api/push/public-key',(req,res)=>res.json({publicKey:VAPID_PUBLIC_KEY||''}));
app.post('/api/push/subscribe',(req,res)=>{
  const {empId,mobile,subscription}=req.body||{};
  if(!empId||!subscription?.endpoint)return res.status(400).json({ok:false,error:'empId and push subscription are required.'});
  pushSubscriptions=pushSubscriptions.filter(x=>x.subscription?.endpoint!==subscription.endpoint);
  pushSubscriptions.push({empId:String(empId),mobile:String(mobile||''),subscription,createdAt:new Date().toISOString()});
  res.json({ok:true});
});
app.post('/api/notify/timetable-review',async(req,res)=>{
  if(!timetableReview)return res.status(400).json({ok:false,error:'No active timetable review.'});
  const result=await notifyFaculty(timetableReview.teacherIds||[],'Timetable waiting for review',`Timetable V${timetableReview.version} is ready. Open the Faculty Portal to Accept or Raise Issue.`);
  res.json({ok:true,...result});
});
app.post('/api/telegram/test',async(req,res)=>{
  const {chatId,message}=req.body||{};const ok=await telegramSend(chatId,message||'School ERP Telegram test notification.');
  res.status(ok?200:400).json({ok});
});
app.post('/api/ai/analyse',async(req,res)=>{
  const provider=String(req.body?.provider||'').toLowerCase();
  const question=String(req.body?.question||'').slice(0,4000);
  const context=req.body?.context||{};
  if(!question)return res.status(400).json({ok:false,error:'Question is required.'});
  const input=`${aiSystemPrompt()}\n\nQuestion:\n${question}\n\nStructured school facts:\n${JSON.stringify(context)}`;
  try{
    if(provider==='openai'){
      const key=process.env.OPENAI_API_KEY;if(!key)return res.status(503).json({ok:false,error:'OPENAI_API_KEY is not configured.'});
      const model=process.env.OPENAI_MODEL||'gpt-5.6';
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model,input})});
      const j=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:j.error?.message||'OpenAI request failed.'});
      const text=j.output_text||j.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'';
      return res.json({ok:true,provider:'openai',providerLabel:'OpenAI',text});
    }
    if(provider==='gemini'){
      const key=process.env.GEMINI_API_KEY;if(!key)return res.status(503).json({ok:false,error:'GEMINI_API_KEY is not configured.'});
      const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:input}]}]})});
      const j=await r.json();if(!r.ok)return res.status(r.status).json({ok:false,error:j.error?.message||'Gemini request failed.'});
      const text=(j.candidates||[]).flatMap(c=>c.content?.parts||[]).map(x=>x.text||'').join('');
      return res.json({ok:true,provider:'gemini',providerLabel:'Gemini',text});
    }
    return res.status(400).json({ok:false,error:'Choose openai or gemini.'});
  }catch(e){return res.status(502).json({ok:false,error:'AI provider could not be reached.'})}
});

// ====================================================================
// 2. WEBSOCKET REAL-TIME ENGINE
// ====================================================================
wss.on('connection', async (ws) => {
  console.log('Client connected.');

  await hydrateSharedStateFromCloud();
  if (ws.readyState !== WebSocket.OPEN) return;

  // Send current state instantly on new connection
  ws.send(JSON.stringify({
    type: 'INIT_DATA',
    payload: {
      page1: page1Data,
      faculty: facultyData,
      notices: noticesData,
      fees: feeData,
      portalStaff,
      profileVerificationRequests,
      attendanceSettings,
      attendanceRecords,
      leaveRecords
      ,portalStudents
      ,studentProfileRequests
      ,studentLeaveRecords
      ,studentMailbox
      ,classTeacherAssignments
      ,timetableFolders
      ,timetableReview
      ,communicationMessages
      ,chatMessages
      ,communicationAuditLog
      ,portionProgress
      ,additionalDutyAssignments
      ,libraryResources
    }
  }));

  // Handle incoming messages from Principal or Student portals
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received Event:', data.type);

      switch (data.type) {
        // Principal Portal publishes the complete staff roster.
        case 'SYNC_PORTAL_STAFF':
          if (!Array.isArray(data.payload)) break;
          // Prevent Principal/server feedback loops by ignoring an identical roster.
          if (JSON.stringify(data.payload) === JSON.stringify(portalStaff)) break;
          portalStaff = data.payload;
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

        // Principal publishes the complete student roster used for portal login.
        case 'SYNC_PORTAL_STUDENTS':
          if (!Array.isArray(data.payload)) break;
          if (JSON.stringify(data.payload) === JSON.stringify(portalStudents)) break;
          portalStudents = data.payload;
          broadcast({ type:'PORTAL_STUDENTS_UPDATED', payload:portalStudents });
          break;

        case 'SYNC_STUDENT_PORTAL_DATA':
          if (Array.isArray(data.payload?.studentRequests)) data.payload.studentRequests.forEach(upsertStudentRequest);
          if (Array.isArray(data.payload?.studentLeaves)) data.payload.studentLeaves.forEach(r => upsertById(studentLeaveRecords, r));
          broadcast({ type:'STUDENT_DATA_SYNCED', payload:{ studentProfileRequests, studentLeaveRecords, studentMailbox } });
          break;

        case 'SYNC_STUDENT_REQUESTS':
          if (Array.isArray(data.payload)) data.payload.forEach(upsertStudentRequest);
          broadcast({ type:'STUDENT_REQUESTS_SYNCED', payload:studentProfileRequests });
          break;

        case 'SYNC_CLASS_TEACHER_ASSIGNMENTS':
          classTeacherAssignments = (data.payload && typeof data.payload === 'object') ? data.payload : {};
          broadcast({ type:'CLASS_TEACHER_ASSIGNMENTS_UPDATED', payload:classTeacherAssignments });
          break;

        case 'SYNC_TIMETABLE_FOLDERS':
          if (!Array.isArray(data.payload)) break;
          timetableFolders = data.payload;
          broadcast({ type:'TIMETABLE_FOLDERS_UPDATED', payload:timetableFolders });
          break;

        case 'SUBMIT_TIMETABLE_REVIEW': {
          const r=data.payload||{};
          if(!Array.isArray(r.folders)||!Array.isArray(r.teacherIds))break;
          timetableFolders=r.folders;
          timetableReview={version:r.version,folders:r.folders,teacherIds:r.teacherIds,teacherReviews:{},sentAt:r.sentAt||new Date().toISOString()};
          broadcast({type:'TIMETABLE_FOLDERS_UPDATED',payload:timetableFolders});
          broadcast({type:'TIMETABLE_REVIEW_UPDATED',payload:timetableReview});
          notifyFaculty(r.teacherIds,'Timetable waiting for review',`Timetable V${r.version} is ready. Open the Faculty Portal to Accept or Raise Issue.`).catch(()=>{});
          (r.teacherIds||[]).forEach(tid=>{const t=portalStaff.find(x=>String(x.empId)===String(tid));addCommunication({fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Faculty',toId:String(tid),toName:t?.name||String(tid),type:'TIMETABLE_REVIEW_SENT',title:`Timetable V${r.version} awaiting review`,body:'Review your personal timetable and select Accept Timetable or Raise Issue.',actionRef:`TIMETABLE:${r.version}`})});
          break;
        }

        case 'FACULTY_TIMETABLE_DECISION': {
          const r=data.payload||{};
          if(!timetableReview||String(r.version)!==String(timetableReview.version))break;
          timetableReview.teacherReviews=timetableReview.teacherReviews||{};
          timetableReview.teacherReviews[String(r.teacherId)]=r;
          broadcast({type:'FACULTY_TIMETABLE_REVIEW_UPDATED',payload:r});
          addCommunication({fromRole:'Faculty',fromId:String(r.teacherId),fromName:r.teacherName||String(r.teacherId),toRole:'Principal',toId:'principal',toName:'Principal',type:r.status==='Accepted'?'TIMETABLE_ACCEPTED':'TIMETABLE_ISSUE',title:`${r.teacherName||r.teacherId} — timetable ${r.status}`,body:r.status==='Accepted'?`Timetable V${r.version} accepted.`:`Timetable V${r.version} issue: ${r.reason||'No reason supplied'}`,status:r.status,actionRef:`TIMETABLE:${r.version}`});
          addCommunication({fromRole:'System',fromId:'system',fromName:'School System',toRole:'Faculty',toId:String(r.teacherId),toName:r.teacherName||String(r.teacherId),type:'TIMETABLE_RESPONSE_RECORDED',title:`Timetable V${r.version} — ${r.status}`,body:r.status==='Accepted'?'Your timetable is confirmed and is now active in your Faculty Portal.':'Your issue has been sent to the Principal.',status:r.status,actionRef:`TIMETABLE:${r.version}`});
          persistRuntimeState('pius_communication_messages',communicationMessages);
          break;
        }

        case 'COMMUNICATION_MESSAGE_ACTION': {
          const r=data.payload||{},item=communicationMessages.find(x=>String(x.id)===String(r.messageId));
          if(!item)break;
          ensureRequestNo(item);
          if(r.action==='READ'){
            item.readBy=Array.isArray(item.readBy)?item.readBy:[];
            const key=`${r.actorRole||''}|${r.actorId||''}`;
            if(key&&!item.readBy.includes(key))item.readBy.push(key);
          }else if(r.action==='DELETE'){
            item.deletedFor=Array.isArray(item.deletedFor)?item.deletedFor:[];
            const key=`${r.actorRole||''}|${r.actorId||''}`;
            if(key&&!item.deletedFor.includes(key))item.deletedFor.push(key);
          }
          persistRuntimeState('pius_communication_messages',communicationMessages);
          auditCommunication(r.action,item,{role:r.actorRole,id:r.actorId,name:r.actorName});
          broadcast({type:'COMMUNICATION_MESSAGE_UPDATED',payload:item});
          break;
        }

        case 'COMMUNICATION_MESSAGE_CREATE': {
          const r=data.payload||{};
          if(!r.toRole||!r.title)break;
          addCommunication(r);
          break;
        }

        case 'CHAT_MESSAGE_CREATE': {
          const r=data.payload||{};
          if(!r.fromRole||!r.toRole||!String(r.body||'').trim()&&!r.attachment)break;
          addChat(r);
          break;
        }

        case 'FACULTY_PUBLISH_CLASS':
        case 'PUBLISH_CLASS_TIMETABLE': {
          const r=data.payload||{};
          const folder=timetableFolders.find(x=>String(x.id)===String(r.folderId)||String(x.academicDivisionId)===String(r.divisionId));
          if(!folder)break;
          if(data.type==='FACULTY_PUBLISH_CLASS' && String(folder.classTeacherEmpId||'')!==String(r.teacherId||''))break;
          const reviewers=folder.recipientTeacherEmpIds||[];
          const allAccepted=reviewers.length&&reviewers.every(id=>timetableReview?.teacherReviews?.[String(id)]?.status==='Accepted');
          if(!allAccepted && !r.principalOverride)break;
          folder.published=true;folder.reviewOnly=false;folder.status='Published to Students';folder.publishedAt=new Date().toISOString();folder.publishedBy=r.teacherName||r.teacherId||'Principal';
          broadcast({type:'TIMETABLE_FOLDERS_UPDATED',payload:timetableFolders});
          broadcast({type:'CLASS_TIMETABLE_PUBLISHED',payload:folder});
          persistRuntimeState('pius_timetable_folders',timetableFolders);
          addCommunication({fromRole:data.type==='FACULTY_PUBLISH_CLASS'?'Faculty':'Principal',fromId:String(r.teacherId||'principal'),fromName:r.teacherName||'Principal',toRole:'Principal',toId:'principal',toName:'Principal',type:'CLASS_TIMETABLE_PUBLISHED',title:`${folder.className} — ${folder.division} timetable published`,body:`The confirmed timetable was published to the Student Portal by ${r.teacherName||'Principal'}.`,status:'Published',actionRef:folder.id});
          portalStudents.filter(x=>classEqualsStudent(folder,x)).forEach(stu=>addCommunication({fromRole:'School',fromId:'school',fromName:'School',toRole:'Student',toId:studentPortalId(stu),toName:stu.name||studentPortalId(stu),type:'TIMETABLE_PUBLISHED',title:'Class timetable published',body:`Your ${folder.className} — ${folder.division} timetable is now active in the Student Portal.`,status:'Published',actionRef:folder.id}));
          break;
        }

        case 'FACULTY_TELEGRAM_LINK': {
          const r=data.payload||{};
          const staff=portalStaff.find(x=>String(x.empId)===String(r.empId));
          if(staff){staff.telegramChatId=String(r.chatId||'').trim();broadcast({type:'PORTAL_STAFF_UPDATED',payload:portalStaff})}
          break;
        }

        case 'SYNC_PORTION_PROGRESS':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(portionProgress,item));
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
          break;

        case 'PORTION_PROGRESS_UPDATE':
          upsertById(portionProgress,data.payload);
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
          break;

        case 'SYNC_LIBRARY_RESOURCES':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(libraryResources,item));
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'LIBRARY_RESOURCE_CREATE':
        case 'LIBRARY_RESOURCE_UPDATE':
          upsertById(libraryResources,data.payload);
          broadcast({type:'LIBRARY_RESOURCE_UPDATED',payload:data.payload});
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'LIBRARY_RESOURCE_DELETE':
          libraryResources=libraryResources.filter(x=>x.id!==data.payload?.id);
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'SYNC_ADDITIONAL_DUTIES':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(additionalDutyAssignments, item));
          broadcast({ type:'ADDITIONAL_DUTIES_UPDATED', payload:additionalDutyAssignments });
          break;

        case 'ADDITIONAL_DUTY_CREATE':
          upsertById(additionalDutyAssignments, data.payload);
          broadcast({ type:'ADDITIONAL_DUTY_UPDATED', payload:data.payload });
          broadcast({ type:'ADDITIONAL_DUTIES_UPDATED', payload:additionalDutyAssignments });
          break;

        case 'ADDITIONAL_DUTY_DECISION':
          upsertById(additionalDutyAssignments, data.payload);
          broadcast({ type:'ADDITIONAL_DUTY_UPDATED', payload:data.payload });
          broadcast({ type:'ADDITIONAL_DUTIES_UPDATED', payload:additionalDutyAssignments });
          break;

        case 'STUDENT_LOGIN_LOOKUP': {
          const normalized = String(data.mobile || '').replace(/[\s()-]/g, '').trim();
          const record = portalStudents.find(s =>
            String(s.portalMobile || '').replace(/[\s()-]/g, '').trim() === normalized &&
            s.portalAccess !== false
          );
          ws.send(JSON.stringify({type:'STUDENT_LOGIN_RESULT',requestId:data.requestId||'',payload:record||null}));
          break;
        }

        case 'STUDENT_PROFILE_REQUEST_CREATE': {
          const request = { ...(data.payload || {}) };
          const assignmentKey = `${String(request.className||'').trim()}|||${String(request.division||'').trim()}`;
          request.classTeacherEmpId = request.classTeacherEmpId || classTeacherAssignments[assignmentKey] || '';
          request.status = request.classTeacherEmpId ? 'Pending Class Teacher Approval' : 'Pending Class Teacher Assignment';
          upsertStudentRequest(request);
          broadcast({ type:'STUDENT_PROFILE_REQUEST_CREATED', payload:request });
          break;
        }

        case 'STUDENT_PROFILE_REQUEST_DECISION':
          upsertStudentRequest(data.payload);
          if (data.payload?.appliedProfile) applyStudentToRoster(data.payload.appliedProfile);
          broadcast({ type:'STUDENT_PROFILE_REQUEST_UPDATED', payload:data.payload });
          broadcast({ type:'PORTAL_STUDENTS_UPDATED', payload:portalStudents });
          break;

        case 'STUDENT_LEAVE_REQUEST_CREATE': {
          const request = { ...(data.payload || {}) };
          const assignmentKey = `${String(request.className||'').trim()}|||${String(request.division||'').trim()}`;
          request.classTeacherEmpId = request.classTeacherEmpId || classTeacherAssignments[assignmentKey] || '';
          request.status = request.classTeacherEmpId ? 'Pending Class Teacher Approval' : 'Pending Class Teacher Assignment';
          upsertById(studentLeaveRecords, request);
          broadcast({ type:'STUDENT_LEAVE_UPDATED', payload:request });
          break;
        }

        case 'STUDENT_LEAVE_DECISION':
          upsertById(studentLeaveRecords, data.payload);
          broadcast({ type:'STUDENT_LEAVE_UPDATED', payload:data.payload });
          break;

        // Restore locally retained verification records after a server restart.
        case 'SYNC_PROFILE_VERIFICATIONS':
          if (Array.isArray(data.payload)) data.payload.forEach(upsertVerification);
          broadcast({ type: 'PROFILE_VERIFICATIONS_SYNCED', payload: profileVerificationRequests });
          break;

        case 'SYNC_ATTENDANCE_DATA':
          if (data.payload?.settings) attendanceSettings = { ...attendanceSettings, ...data.payload.settings };
          if (Array.isArray(data.payload?.records)) data.payload.records.forEach(r => upsertById(attendanceRecords, r));
          if (Array.isArray(data.payload?.leaves)) data.payload.leaves.forEach(r => upsertById(leaveRecords, r));
          broadcast({ type:'ATTENDANCE_DATA_SYNCED', payload:{ settings:attendanceSettings, records:attendanceRecords, leaves:leaveRecords } });
          break;

        case 'ATTENDANCE_SETTINGS_UPDATE':
          attendanceSettings = { ...attendanceSettings, ...(data.payload || {}) };
          broadcast({ type:'ATTENDANCE_SETTINGS_UPDATED', payload:attendanceSettings });
          break;

        case 'ATTENDANCE_MARK':
        case 'ATTENDANCE_MANUAL_UPDATE':
          upsertById(attendanceRecords, data.payload);
          broadcast({ type:'ATTENDANCE_RECORD_UPDATED', payload:data.payload });
          break;

        case 'LEAVE_REQUEST_CREATE':
          upsertById(leaveRecords, data.payload);
          broadcast({ type:'LEAVE_RECORD_UPDATED', payload:data.payload });
          break;

        case 'LEAVE_DECISION':
          upsertById(leaveRecords, data.payload);
          broadcast({ type:'LEAVE_RECORD_UPDATED', payload:data.payload });
          break;

        // Faculty login lookup using the mobile registered by the Principal.
        case 'FACULTY_LOGIN_LOOKUP': {
          const normalized = String(data.mobile || '').replace(/[\s()-]/g, '').trim();
          const member = portalStaff.find(s =>
            String(s.portalMobile || s.mobile || '').replace(/[\s()-]/g, '').trim() === normalized &&
            String(s.category || '').toLowerCase() === 'teaching' &&
            s.portalAccess !== false
          );
          ws.send(JSON.stringify({
            type: 'FACULTY_LOGIN_RESULT',
            requestId: data.requestId || '',
            payload: member || null
          }));
          break;
        }

        // A new request can originate from either portal.
        case 'PROFILE_VERIFICATION_CREATE': {
          const r=data.payload||{};ensureRequestNo(r,'PV');
          upsertVerification(r);
          broadcast({ type: 'PROFILE_VERIFICATION_CREATED', payload: r });
          const existing=communicationMessages.find(x=>x.type==='FACULTY_PROFILE_REQUEST'&&String(x.requestNo)===String(r.requestNo));
          if(!existing)addCommunication({requestNo:r.requestNo,fromRole:'Faculty',fromId:String(r.empId||''),fromName:r.teacherName||r.empId||'Faculty',toRole:'Principal',toId:'principal',toName:'Principal',type:'FACULTY_PROFILE_REQUEST',title:'Faculty profile update request',body:r.note||'Faculty requested a profile update.',status:'Pending Principal Approval',details:{previous:r.previousSnapshot||{},proposed:r.snapshot||r.proposedChanges||{},note:r.note||'',source:r.source||'Teacher Profile Edit'},actionRef:r.id});
          break;
        }

        // Principal approves or rejects a faculty-originated request.
        case 'PROFILE_VERIFICATION_DECISION': {
          const r=data.payload||{};ensureRequestNo(r,'PV');
          upsertVerification(r);
          if (r.appliedProfile) applyProfileToRoster(r.appliedProfile);
          broadcast({ type: 'PROFILE_VERIFICATION_DECIDED', payload: r });
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          const original=communicationMessages.find(x=>x.type==='FACULTY_PROFILE_REQUEST'&&(String(x.requestNo)===String(r.requestNo)||String(x.actionRef)===String(r.id)));
          if(original){original.status=r.status;original.decisionAt=r.decisionAt||new Date().toISOString();original.decisionBy=r.decisionBy||r.approvedBy||r.rejectedBy||'Principal';original.decisionReason=r.rejectionReason||'';persistRuntimeState('pius_communication_messages',communicationMessages);broadcast({type:'COMMUNICATION_MESSAGE_UPDATED',payload:original});auditCommunication(r.status==='Approved'?'APPROVED':'REJECTED',original,{role:'Principal',id:'principal',name:'Principal'})}
          addCommunication({requestNo:r.requestNo,fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Faculty',toId:String(r.empId||''),toName:r.teacherName||r.empId||'Faculty',type:'FACULTY_PROFILE_DECISION',title:`Profile update request ${r.status}`,body:r.status==='Approved'?'Your requested profile changes were approved and applied.':`Your requested profile changes were rejected.${r.rejectionReason?' Reason: '+r.rejectionReason:''}`,status:r.status,details:{decisionAt:r.decisionAt||'',decisionBy:r.decisionBy||'',reason:r.rejectionReason||''},actionRef:r.id});
          break;
        }

        // Faculty confirms a Principal edit or asks for a correction.
        case 'PRINCIPAL_PROFILE_CONFIRMED':
        case 'PROFILE_VERIFICATION_UPDATE':
          upsertVerification(data.payload);
          if (data.payload?.appliedProfile) applyProfileToRoster(data.payload.appliedProfile);
          broadcast({ type: 'PROFILE_VERIFICATION_UPDATED', payload: data.payload });
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

        // Page 1 Overview Update (Preserved)
        case 'UPDATE_PAGE_1':
          page1Data = data.payload;
          broadcast({ type: 'PAGE_1_UPDATED', payload: page1Data });
          break;

        // Faculty Updates: Add Single New Faculty Member
        case 'ADD_FACULTY':
          const newMember = {
            id: Date.now(), // Generate unique ID
            ...data.payload
          };
          facultyData.push(newMember);
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        // Faculty Updates: Replace entire roster or update existing array
        case 'UPDATE_FACULTY':
          facultyData = data.payload;
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        // Faculty Updates: Delete Faculty Member by ID
        case 'DELETE_FACULTY':
          facultyData = facultyData.filter(f => f.id !== data.payload.id);
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        // Notices Updates (Preserved)
        case 'ADD_NOTICE':
          noticesData.unshift(data.payload);
          broadcast({ type: 'NOTICE_ADDED', payload: noticesData });
          break;

        // Fees Structure Updates (Preserved)
        case 'UPDATE_FEES':
          feeData = data.payload;
          broadcast({ type: 'FEES_UPDATED', payload: feeData });
          break;

        // Student Search Request (Preserved)
        case 'LOOKUP_STUDENT':
          const roll = data.rollNumber;
          const record = studentDatabase[roll];
          ws.send(JSON.stringify({
            type: 'STUDENT_RECORD_RESULT',
            found: !!record,
            payload: record || null
          }));
          break;

        default:
          console.warn('Unknown event type:', data.type);
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected.');
  });
});

// ====================================================================
// 3. START SERVER
// ====================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
