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
const portalClientIdentity=new Map();
const portalDiagnosticRuns=new Map();

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
let studentAttendanceRecords = [];
let classTeacherAssignments = {};
let timetableFolders = [];
let timetableReview = null;
let communicationMessages = [];
let chatMessages = [];
let communicationAuditLog = [];
let portalPresence = {};
let dailyPortionProgress = [];
let facultyNotificationSettings = {};
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
    'pius_student_profile_requests','pius_student_leave_records','pius_student_attendance_records','pius_student_attendance_records',
    'pius_class_teacher_assignments','pius_timetable_folders','pius_timetable_review','pius_portion_progress',
    'pius_additional_duty_assignments','pius_digital_library_resources',
    'pius_attendance_settings','pius_attendance_records','pius_leave_records',
    'pius_communication_messages','pius_chat_messages','pius_communication_audit_log','pius_faculty_notification_settings'
  ];
  const { data, error } = await supabase.from('portal_state').select('state_key,state_value').in('state_key',keys);
  if (error) { console.error('Supabase shared-state hydration failed:', error.message); return; }
  const value = key => (data || []).find(row => row.state_key === key)?.state_value;
  if (Array.isArray(value('pius_staff_data'))) portalStaff=value('pius_staff_data');
  if (Array.isArray(value('pius_students_data'))) portalStudents=value('pius_students_data');
  if (Array.isArray(value('pius_profile_verification_requests'))) profileVerificationRequests=value('pius_profile_verification_requests');
  if (Array.isArray(value('pius_student_profile_requests'))) studentProfileRequests=value('pius_student_profile_requests');
  if (Array.isArray(value('pius_student_leave_records'))) studentLeaveRecords=value('pius_student_leave_records');
  if (Array.isArray(value('pius_student_attendance_records'))) studentAttendanceRecords=value('pius_student_attendance_records');
  if (value('pius_class_teacher_assignments') && typeof value('pius_class_teacher_assignments') === 'object') classTeacherAssignments=value('pius_class_teacher_assignments');
  if (Array.isArray(value('pius_timetable_folders'))) timetableFolders=value('pius_timetable_folders');
  if (value('pius_timetable_review') && typeof value('pius_timetable_review')==='object') timetableReview=value('pius_timetable_review');
  if (Array.isArray(value('pius_portion_progress'))) portionProgress=value('pius_portion_progress');
  if (Array.isArray(value('pius_additional_duty_assignments'))) additionalDutyAssignments=value('pius_additional_duty_assignments');
  if (Array.isArray(value('pius_digital_library_resources'))) libraryResources=value('pius_digital_library_resources');
  if (value('pius_attendance_settings') && typeof value('pius_attendance_settings') === 'object') attendanceSettings=value('pius_attendance_settings');
  if (Array.isArray(value('pius_attendance_records'))) attendanceRecords=value('pius_attendance_records');
  if (Array.isArray(value('pius_leave_records'))) leaveRecords=value('pius_leave_records');
  if (Array.isArray(value('pius_communication_messages'))) communicationMessages=value('pius_communication_messages');
  if (Array.isArray(value('pius_chat_messages'))) chatMessages=value('pius_chat_messages');
  if (Array.isArray(value('pius_communication_audit_log'))) communicationAuditLog=value('pius_communication_audit_log');
  if (value('pius_faculty_notification_settings') && typeof value('pius_faculty_notification_settings')==='object') facultyNotificationSettings=value('pius_faculty_notification_settings');
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

const RESETTABLE_STATE_KEYS=[
  'pius_staff_data','pius_students_data','pius_profile_verification_requests',
  'pius_student_profile_requests','pius_student_leave_records',
  'pius_class_teacher_assignments','pius_timetable_folders','pius_timetable_review','pius_portion_progress',
  'pius_attendance_settings','pius_attendance_records','pius_leave_records',
  'pius_communication_messages','pius_chat_messages','pius_communication_audit_log',
  'pius_faculty_notification_settings','pius_daily_portion_progress'
];
async function clearPersistentSchoolState(){
  if(supabase){
    try{
      for(const key of RESETTABLE_STATE_KEYS){
        await supabase.from('portal_state').delete().eq('state_key',key);
      }
    }catch(e){console.error('Cloud reset failed:',e.message)}
  }
}
function clearInMemorySchoolState(){
  portalStaff=[];profileVerificationRequests=[];portalStudents=[];studentProfileRequests=[];
  studentLeaveRecords=[];studentMailbox=[];studentAttendanceRecords=[];classTeacherAssignments={};timetableFolders=[];
  portionProgress=[];additionalDutyAssignments=[];libraryResources=[];attendanceRecords=[];
  leaveRecords=[];communicationMessages=[];chatMessages=[];communicationAuditLog=[];
  facultyNotificationSettings={};dailyPortionProgress=[];portalPresence={};
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
function presenceKey(role,id){return `${role||''}|${id||''}`}
function setPresence(role,id,name,online=true){if(!role||!id)return;const k=presenceKey(role,id);portalPresence[k]={role,id:String(id),name:name||String(id),online:!!online,lastSeen:new Date().toISOString()};broadcast({type:'PRESENCE_UPDATED',payload:portalPresence[k]})}
function presenceList(){return Object.values(portalPresence)}

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

function addSenderReceipt(source,overrides={}){
  if(!source||!source.fromRole||!source.fromId||source.fromRole==='System')return null;
  const receipt={
    requestNo:source.requestNo||source.id||requestNo('RCT'),
    fromRole:'System',fromId:'system',fromName:'School Communication Log',
    toRole:source.fromRole,toId:String(source.fromId),toName:source.fromName||String(source.fromId),
    type:'SENT_RECEIPT',
    title:overrides.title||`Receipt — ${source.title||source.type||'Portal action'}`,
    body:overrides.body||`Your ${source.type||'message'} was recorded and sent to ${source.toName||source.toRole||'the recipient'}.`,
    status:overrides.status||source.status||'Sent',
    actionRef:source.actionRef||source.id||'',
    details:{originalType:source.type||'',originalTitle:source.title||'',recipientRole:source.toRole||'',recipientId:source.toId||'',recipientName:source.toName||'',originalBody:source.body||'',originalDetails:source.details||{},originalCreatedAt:source.createdAt||new Date().toISOString(),...(overrides.details||{})}
  };
  return addCommunication(receipt);
}
function addCommunicationWithReceipt(msg,receiptOverrides={}){
  const item=addCommunication(msg);
  if(msg?.fromRole&&msg?.fromId&&msg?.fromRole!=='System'&&!msg?.noSenderReceipt)addSenderReceipt(item,receiptOverrides);
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

function normClassPart(v){return String(v||'').replace(/^grade\s*/i,'').replace(/^class\s*/i,'').replace(/^div(ision)?\s*/i,'').trim().toLowerCase()}
function studentClassKey(s){return `${normClassPart(s.grade||s.className)}|||${normClassPart(s.section||s.division)}`}
function classTeacherIdForStudent(s){
  const cg=normClassPart(s.grade||s.className),cd=normClassPart(s.section||s.division);
  let id='';
  Object.entries(classTeacherAssignments||{}).some(([key,val])=>{
    const parts=String(key).split('|||');
    if(parts.length>=2&&normClassPart(parts[0])===cg&&normClassPart(parts[1])===cd){id=String(val||'');return true}
    return false;
  });
  if(id)return id;
  const folder=timetableFolders.find(f=>normClassPart(f.className)===cg&&normClassPart(f.division)===cd&&f.classTeacherEmpId);
  return folder?.classTeacherEmpId?String(folder.classTeacherEmpId):'';
}
function classTeacherNameForStudent(s){
  const id=classTeacherIdForStudent(s),t=portalStaff.find(x=>String(x.empId)===id);return t?.name||id||'Class Teacher';
}
function teacherCanMessageStudent(teacherId,student){
  const id=String(teacherId||'');if(!id||!student)return false;
  if(classTeacherIdForStudent(student)===id)return true;
  return timetableFolders.some(f=>normClassPart(f.className)===normClassPart(student.grade||student.className)&&normClassPart(f.division)===normClassPart(student.section||student.division)&&(f.recipientTeacherEmpIds||[]).map(String).includes(id));
}
function teacherStudents(teacherId){
  const seen=new Set();return portalStudents.filter(stu=>{
    const sid=studentPortalId(stu);if(!sid||seen.has(sid)||!teacherCanMessageStudent(teacherId,stu))return false;seen.add(sid);return true;
  });
}
function classEqualsStudent(folder,s){
  return normClassPart(folder.className)===normClassPart(s.grade||s.className)
    && normClassPart(folder.division)===normClassPart(s.section||s.division);
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
async function notifyFaculty(empIds,title,body,category='general'){
  const requested=new Set((empIds||[]).map(String));
  const allowed=[...requested].filter(id=>{
    const p=facultyNotificationSettings[String(id)];
    if(!p)return true;
    if(category==='timetable')return p.timetable!==false;
    if(category==='notices')return p.notices!==false;
    if(category==='approvals')return p.approvals!==false;
    if(category==='leave')return p.leave!==false;
    if(category==='duties')return p.duties!==false;
    if(category==='academic')return p.academic!==false;
    return true;
  });
  const ids=new Set(allowed);
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
  const result=await notifyFaculty(timetableReview.teacherIds||[],'Timetable waiting for review',`Timetable V${timetableReview.version} is ready. Open the Faculty Portal to Accept or Raise Issue.`,'timetable');
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

function currentPortalSnapshot(){
  return {
    portalStaff,portalStudents,studentProfileRequests,classTeacherAssignments,timetableFolders,
    communicationMessages,studentAttendanceRecords:typeof studentAttendanceRecords!=='undefined'?studentAttendanceRecords:[],
    profileVerificationRequests,portionProgress,attendanceRecords,leaveRecords,
    generatedAt:new Date().toISOString()
  };
}
function sendWs(ws,obj){try{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}catch(e){}}
function connectedRoleSummary(){
  const roles={Principal:0,Faculty:0,Student:0};
  portalClientIdentity.forEach(v=>{if(v?.role in roles)roles[v.role]++});
  return roles;
}
function startPortalDiagnostic(ws,r){
  const probeId=`PROBE-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,start=Date.now();
  const run={requestId:r.requestId||probeId,requester:ws,probeId,start,acks:new Map()};
  portalDiagnosticRuns.set(probeId,run);
  portalClientIdentity.forEach((identity,client)=>sendWs(client,{type:'PORTAL_ROUTE_PROBE',payload:{probeId,requestedBy:r.role||'',serverAt:new Date().toISOString()}}));
  setTimeout(()=>{
    const active=portalDiagnosticRuns.get(probeId);if(!active)return;
    const roles=['Principal','Faculty','Student'];
    const routes=roles.map(role=>{
      const connected=[...portalClientIdentity.entries()].filter(([client,id])=>id?.role===role);
      const responded=connected.some(([client,id])=>active.acks.has(client));
      return {role,connectedClients:connected.length,responded};
    });
    sendWs(active.requester,{type:'PORTAL_DIAGNOSTIC_RESULT',payload:{requestId:active.requestId,serverOk:true,routes,roundTripMs:Date.now()-start,connected:connectedRoleSummary(),completedAt:new Date().toISOString()}});
    portalDiagnosticRuns.delete(probeId);
  },1400);
}

function socketPortalRole(ws){return portalClientIdentity.get(ws)?.role||''}
function principalMasterAllowed(ws){return socketPortalRole(ws)==='Principal'}

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
      ,studentAttendanceRecords
      ,classTeacherAssignments
      ,timetableFolders
      ,timetableReview
      ,communicationMessages
      ,chatMessages
      ,communicationAuditLog
      ,portalPresence: presenceList()
      ,dailyPortionProgress
      ,facultyNotificationSettings
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
          if(!principalMasterAllowed(ws)){console.warn('Rejected non-Principal staff master sync');break;}
          portalStaff = data.payload;
          persistRuntimeState('pius_staff_data',portalStaff);
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

        // Principal publishes the complete student roster used for portal login.
        case 'SYNC_PORTAL_STUDENTS':
          if (!Array.isArray(data.payload)) break;
          if (JSON.stringify(data.payload) === JSON.stringify(portalStudents)) break;
          if(!principalMasterAllowed(ws)){console.warn('Rejected non-Principal student master sync');break;}
          portalStudents = data.payload;
          persistRuntimeState('pius_students_data',portalStudents);
          broadcast({ type:'PORTAL_STUDENTS_UPDATED', payload:portalStudents });
          break;

        case 'SYNC_STUDENT_PORTAL_DATA':
          if (Array.isArray(data.payload?.studentRequests)) data.payload.studentRequests.forEach(r=>{if(r?.id&&!studentProfileRequests.some(x=>String(x.id)===String(r.id)))studentProfileRequests.unshift(r)});
          if (Array.isArray(data.payload?.studentLeaves)) data.payload.studentLeaves.forEach(r=>{if(r?.id&&!studentLeaveRecords.some(x=>String(x.id)===String(r.id)))studentLeaveRecords.unshift(r)});
          persistRuntimeState('pius_student_profile_requests',studentProfileRequests);
          persistRuntimeState('pius_student_leave_records',studentLeaveRecords);
          broadcast({ type:'STUDENT_DATA_SYNCED', payload:{ studentProfileRequests, studentLeaveRecords, studentMailbox } });
          break;

        case 'SYNC_STUDENT_REQUESTS':
          if (Array.isArray(data.payload)) data.payload.forEach(upsertStudentRequest);
          broadcast({ type:'STUDENT_REQUESTS_SYNCED', payload:studentProfileRequests });
          break;

        case 'SYNC_CLASS_TEACHER_ASSIGNMENTS':
          if(!principalMasterAllowed(ws)){console.warn('Rejected non-Principal Class Teacher master sync');break;}
          classTeacherAssignments = (data.payload && typeof data.payload === 'object') ? data.payload : {};
          persistRuntimeState('pius_class_teacher_assignments',classTeacherAssignments);
          broadcast({ type:'CLASS_TEACHER_ASSIGNMENTS_UPDATED', payload:classTeacherAssignments });
          break;

        case 'SYNC_TIMETABLE_FOLDERS':
          if (!Array.isArray(data.payload)) break;
          if(!principalMasterAllowed(ws)){console.warn('Rejected non-Principal timetable master sync');break;}
          timetableFolders = data.payload;
          persistRuntimeState('pius_timetable_folders',timetableFolders);
          broadcast({ type:'TIMETABLE_FOLDERS_UPDATED', payload:timetableFolders });
          break;

        case 'SUBMIT_TIMETABLE_REVIEW': {
          const r=data.payload||{};
          if(!Array.isArray(r.folders)||!Array.isArray(r.teacherIds))break;
          timetableFolders=r.folders.map(f=>({...f,published:true,reviewOnly:false,status:'Active',publishedAt:f.publishedAt||new Date().toISOString(),publishedBy:'Principal'}));
          timetableReview={version:r.version,folders:timetableFolders,teacherIds:r.teacherIds,teacherReviews:{},mode:'LIVE_NO_APPROVAL',sentAt:r.sentAt||new Date().toISOString()};
          persistRuntimeState('pius_timetable_folders',timetableFolders);
          persistRuntimeState('pius_timetable_review',timetableReview);
          broadcast({type:'TIMETABLE_FOLDERS_UPDATED',payload:timetableFolders});
          broadcast({type:'TIMETABLE_REVIEW_UPDATED',payload:timetableReview});
          notifyFaculty(r.teacherIds,'New timetable published',`Timetable V${r.version} is now active. Open your Faculty Portal to view it. Raise a concern only if a specific day/period needs adjustment.`,'timetable').catch(()=>{});
          (r.teacherIds||[]).forEach(tid=>{const t=portalStaff.find(x=>String(x.empId)===String(tid));addCommunicationWithReceipt({fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Faculty',toId:String(tid),toName:t?.name||String(tid),type:'TIMETABLE_PUBLISHED',title:`Timetable V${r.version} published`,body:'Your timetable is active. No approval is required. Raise a concern with the exact class/day/period if an adjustment is needed.',status:'Active',actionRef:`TIMETABLE:${r.version}`})});
          portalStudents.forEach(stu=>{const folder=timetableFolders.find(f=>classEqualsStudent(f,stu));if(folder){const sid=studentPortalId(stu);addCommunicationWithReceipt({fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Student',toId:sid,toName:stu.name||sid,type:'TIMETABLE_PUBLISHED',title:'Your class timetable is available',body:`The timetable for ${folder.className} — ${folder.division} has been published and is available in your Student Portal.`,status:'Published',actionRef:`TIMETABLE:${r.version}`})}});
          persistRuntimeState('pius_communication_messages',communicationMessages);
          break;
        }

        case 'FACULTY_TIMETABLE_DECISION': {
          const r=data.payload||{};
          if(r.status!=='Issue')break;
          if(!timetableReview)timetableReview={version:r.version,folders:timetableFolders,teacherIds:[],teacherReviews:{},mode:'LIVE_NO_APPROVAL'};
          timetableReview.teacherReviews=timetableReview.teacherReviews||{};
          timetableReview.teacherReviews[String(r.teacherId)]=r;
          persistRuntimeState('pius_timetable_review',timetableReview);
          broadcast({type:'FACULTY_TIMETABLE_REVIEW_UPDATED',payload:r});
          addCommunicationWithReceipt({fromRole:'Faculty',fromId:String(r.teacherId),fromName:r.teacherName||String(r.teacherId),toRole:'Principal',toId:'principal',toName:'Principal',type:'TIMETABLE_ISSUE',title:`Timetable concern — ${r.teacherName||r.teacherId}`,body:`${r.className||''} ${r.division||''} · ${r.day||''} P${r.period||''} · ${r.subject||''}\nReason: ${r.reason||'No reason supplied'}`,status:'Action Required',details:r,actionRef:`TIMETABLE:${r.version}`});
          addCommunication({fromRole:'System',fromId:'system',fromName:'School System',toRole:'Faculty',toId:String(r.teacherId),toName:r.teacherName||String(r.teacherId),type:'TIMETABLE_CONCERN_RECORDED',title:'Timetable concern sent to Principal',body:`${r.day||''} P${r.period||''} · ${r.subject||''}\n${r.reason||''}`,status:'Submitted',details:r,actionRef:`TIMETABLE:${r.version}`});
          persistRuntimeState('pius_communication_messages',communicationMessages);
          break;
        }

        case 'PRINCIPAL_TIMETABLE_SWAP': {
          const r=data.payload||{};
          if(!principalMasterAllowed(ws)||!Array.isArray(r.folders))break;
          timetableFolders=r.folders.map(f=>({...f,published:true,reviewOnly:false,status:'Active'}));
          timetableReview={version:r.version,folders:timetableFolders,teacherIds:[...new Set(timetableFolders.flatMap(f=>f.recipientTeacherEmpIds||[]).map(String))],teacherReviews:{},mode:'LIVE_NO_APPROVAL',sentAt:new Date().toISOString()};
          persistRuntimeState('pius_timetable_folders',timetableFolders);persistRuntimeState('pius_timetable_review',timetableReview);
          broadcast({type:'TIMETABLE_FOLDERS_UPDATED',payload:timetableFolders});broadcast({type:'TIMETABLE_REVIEW_UPDATED',payload:timetableReview});
          const affected=new Set([r.from?.teacherId,r.swappedWith?.teacherId,r.teacherId].filter(Boolean).map(String));
          affected.forEach(tid=>{const t=portalStaff.find(x=>String(x.empId)===tid);addCommunicationWithReceipt({fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Faculty',toId:tid,toName:t?.name||tid,type:'TIMETABLE_SWAP_APPLIED',title:`Timetable V${r.version} updated`,body:`A period swap was applied by the Principal. Please open My Timetable to view the updated schedule.`,status:'Updated',details:r,actionRef:`TIMETABLE:${r.version}`})});
          portalStudents.forEach(stu=>{const folder=timetableFolders.find(f=>classEqualsStudent(f,stu)&&String(f.academicDivisionId||f.classKey||'')===String(r.divisionId||''));if(folder){const sid=studentPortalId(stu);addCommunicationWithReceipt({fromRole:'Principal',fromId:'principal',fromName:'Principal',toRole:'Student',toId:sid,toName:stu.name||sid,type:'TIMETABLE_SWAP_APPLIED',title:'Your class timetable was updated',body:'The Principal adjusted two periods in your class timetable. Open My Timetable to view the latest version.',status:'Updated',details:r,actionRef:`TIMETABLE:${r.version}`})}});
          persistRuntimeState('pius_communication_messages',communicationMessages);
          break;
        }

        case 'SYNC_DAILY_PORTION_PROGRESS': {
          const r=data.payload||{},rows=Array.isArray(r.records)?r.records:[];
          rows.forEach(row=>{const i=dailyPortionProgress.findIndex(x=>x.id===row.id);if(i>=0)dailyPortionProgress[i]=row;else dailyPortionProgress.unshift(row)});
          persistRuntimeState('pius_daily_portion_progress',dailyPortionProgress);
          broadcast({type:'DAILY_PORTION_PROGRESS_UPDATED',payload:dailyPortionProgress});
          break;
        }
        case 'PRINCIPAL_STUDENT_PROFILE_UPDATE': {
          const r=data.payload||{},sid=String(r.studentId||r.rollId||'');
          if(!sid)break;
          const i=portalStudents.findIndex(x=>studentPortalId(x)===sid);
          if(i<0)break;
          const before={...portalStudents[i]},changes=r.changes||{};
          portalStudents[i]={...portalStudents[i],...changes,updatedAt:new Date().toISOString(),updatedBy:'Principal'};
          broadcast({type:'PORTAL_STUDENTS_UPDATED',payload:portalStudents});
          persistRuntimeState('pius_students_data',portalStudents);
          addCommunicationWithReceipt({
            fromRole:'Principal',fromId:'principal',fromName:'Principal',
            toRole:'Student',toId:sid,toName:portalStudents[i].name||sid,
            type:'PRINCIPAL_PROFILE_UPDATE',title:'Your student profile was updated by the Principal',
            body:r.note||'The Principal updated information in your student profile.',
            status:'Updated',
            details:{previous:before,proposed:portalStudents[i],note:r.note||'',changedFields:Object.keys(changes)},
            actionRef:`STUDENT:${sid}`
          });
          break;
        }

        case 'PRINCIPAL_STUDENT_NOTICE': {
          const r=data.payload||{},ids=(r.studentIds||[]).map(String);
          const targets=portalStudents.filter(stu=>ids.includes(studentPortalId(stu)));
          targets.forEach(stu=>addCommunicationWithReceipt({
            fromRole:'Principal',fromId:'principal',fromName:'Principal',
            toRole:'Student',toId:studentPortalId(stu),toName:stu.name||studentPortalId(stu),
            type:'PRINCIPAL_STUDENT_NOTICE',title:r.title||'Principal Notice',
            body:r.body||'',status:'New',details:{priority:r.priority||'Standard',audience:'Selected Student'},actionRef:r.noticeId||''
          }));
          break;
        }

        case 'STUDENT_REQUEST_CREATE':
        case 'STUDENT_PROFILE_REQUEST_CREATE': {
          const r=data.payload||{},sid=String(r.studentId||r.rollId||'');
          const stu=portalStudents.find(x=>studentPortalId(x)===sid);
          if(!stu)break;
          ensureRequestNo(r,'SR');
          const ctId=classTeacherIdForStudent(stu);
          if(!ctId){
            r.status='Pending Class Teacher Assignment';
            upsertStudentRequest(r);
            persistRuntimeState('pius_student_profile_requests',studentProfileRequests);
            broadcast({type:'STUDENT_PROFILE_REQUEST_CREATED',payload:r});
            addCommunicationWithReceipt({
              requestNo:r.requestNo,fromRole:'Student',fromId:sid,fromName:stu.name||sid,
              toRole:'Principal',toId:'principal',toName:'Principal',
              type:'STUDENT_REQUEST_UNROUTED',title:r.title||'Student request awaiting Class Teacher assignment',
              body:r.reason||r.note||'A student request could not be routed because no Class Teacher is assigned.',
              status:'Pending Class Teacher Assignment',details:r.details||r,actionRef:r.id
            });
            break;
          }
          r.classTeacherId=ctId;r.status='Pending Class Teacher Approval';
          upsertStudentRequest(r);
          broadcast({type:'STUDENT_PROFILE_REQUEST_CREATED',payload:r});
          addCommunicationWithReceipt({
            requestNo:r.requestNo,fromRole:'Student',fromId:sid,fromName:stu.name||sid,
            toRole:'Faculty',toId:ctId,toName:classTeacherNameForStudent(stu),
            type:r.type||'STUDENT_APPROVAL_REQUEST',title:r.title||'Student approval request',
            body:r.reason||r.note||'A student has submitted a request for your approval.',
            status:'Pending Class Teacher Approval',
            details:{studentId:sid,studentName:stu.name||sid,className:stu.grade||stu.className||'',division:stu.section||stu.division||'',request:r.details||r},
            actionRef:r.id
          });
          break;
        }

        case 'CLASS_TEACHER_STUDENT_REQUEST_DECISION': {
          const r=data.payload||{},req=studentProfileRequests.find(x=>String(x.id)===String(r.requestId));
          if(!req)break;
          const sid=String(req.studentId||req.rollId||''),stu=portalStudents.find(x=>studentPortalId(x)===sid);
          if(!stu)break;
          const ctId=classTeacherIdForStudent(stu);
          if(String(r.teacherId)!==String(ctId))break;
          req.status=r.decision==='Approved'?'Approved':'Rejected';
          req.decisionBy=r.teacherName||classTeacherNameForStudent(stu);
          req.decisionById=String(r.teacherId);req.decisionAt=new Date().toISOString();req.decisionReason=r.reason||'';
          if(req.status==='Approved'&&r.appliedChanges&&typeof r.appliedChanges==='object'){
            const i=portalStudents.findIndex(x=>studentPortalId(x)===sid);
            portalStudents[i]={...portalStudents[i],...r.appliedChanges,updatedAt:new Date().toISOString(),updatedBy:req.decisionBy};
            broadcast({type:'PORTAL_STUDENTS_UPDATED',payload:portalStudents});
            persistRuntimeState('pius_students_data',portalStudents);
          }
          broadcast({type:'STUDENT_PROFILE_REQUEST_UPDATED',payload:req});
          persistRuntimeState('pius_student_profile_requests',studentProfileRequests);
          addCommunicationWithReceipt({
            requestNo:req.requestNo||req.id,fromRole:'Faculty',fromId:String(r.teacherId),fromName:req.decisionBy,
            toRole:'Student',toId:sid,toName:stu.name||sid,
            type:'STUDENT_REQUEST_DECISION',title:`Student request ${req.status}`,
            body:req.status==='Approved'?'Your Class Teacher approved your request.':`Your Class Teacher rejected your request.${r.reason?' Reason: '+r.reason:''}`,
            status:req.status,details:{requestId:req.id,reason:r.reason||'',decidedAt:req.decisionAt},actionRef:req.id
          });
          addCommunication({
            requestNo:req.requestNo||req.id,fromRole:'System',fromId:'system',fromName:'School Communication Log',
            toRole:'Principal',toId:'principal',toName:'Principal',
            type:'STUDENT_REQUEST_DECISION_COPY',title:`${stu.name||sid} — request ${req.status}`,
            body:`${req.decisionBy} ${req.status.toLowerCase()} the student request.`,
            status:req.status,details:{studentId:sid,teacherId:r.teacherId,requestId:req.id,reason:r.reason||''},actionRef:req.id,noSenderReceipt:true
          });
          break;
        }

        case 'FACULTY_STUDENT_NOTICE': {
          const r=data.payload||{},teacherId=String(r.teacherId||''),ids=(r.studentIds||[]).map(String);
          const requested=portalStudents.filter(stu=>ids.includes(studentPortalId(stu)));
          requested.filter(stu=>teacherCanMessageStudent(teacherId,stu)).forEach(stu=>{
            const sid=studentPortalId(stu),ctId=classTeacherIdForStudent(stu);
            addCommunicationWithReceipt({
              fromRole:'Faculty',fromId:teacherId,fromName:r.teacherName||teacherId,
              toRole:'Student',toId:sid,toName:stu.name||sid,
              type:'FACULTY_STUDENT_NOTICE',title:r.title||'Teacher Notice',
              body:r.body||'',status:'New',
              details:{className:stu.grade||stu.className||'',division:stu.section||stu.division||'',priority:r.priority||'Standard'},
              actionRef:r.noticeId||''
            });
            if(ctId&&ctId!==teacherId){
              addCommunication({
                fromRole:'System',fromId:'system',fromName:'School Communication Log',
                toRole:'Faculty',toId:ctId,toName:classTeacherNameForStudent(stu),
                type:'SUBJECT_TEACHER_NOTICE_COPY',title:`Copy: ${r.title||'Teacher Notice'} → ${stu.name||sid}`,
                body:`${r.teacherName||teacherId} sent information to ${stu.name||sid}. ${r.body||''}`,
                status:'Copy',
                details:{studentId:sid,subjectTeacherId:teacherId,subjectTeacherName:r.teacherName||teacherId,className:stu.grade||stu.className||'',division:stu.section||stu.division||''},
                actionRef:r.noticeId||'',noSenderReceipt:true
              });
            }
          });
          break;
        }

        case 'FACULTY_REQUEST_CREATE': {
          const r=data.payload||{};ensureRequestNo(r,'FR');
          const item=addCommunicationWithReceipt({
            requestNo:r.requestNo,fromRole:'Faculty',fromId:String(r.teacherId||r.fromId||''),fromName:r.teacherName||r.fromName||String(r.teacherId||'Faculty'),
            toRole:'Principal',toId:'principal',toName:'Principal',type:r.type||'FACULTY_APPROVAL_REQUEST',
            title:r.title||'Faculty approval request',body:r.body||r.reason||r.note||'',status:'Pending Principal Approval',
            details:{...(r.details||{}),request:r},actionRef:r.id||r.requestNo
          });
          break;
        }

        case 'STUDENT_GENERIC_REQUEST_CREATE': {
          const r=data.payload||{},sid=String(r.studentId||r.rollId||r.fromId||'');const stu=portalStudents.find(x=>studentPortalId(x)===sid);if(!stu)break;
          ensureRequestNo(r,'SR');const ctId=classTeacherIdForStudent(stu);
          if(!ctId){
            addCommunicationWithReceipt({requestNo:r.requestNo,fromRole:'Student',fromId:sid,fromName:stu.name||sid,toRole:'Principal',toId:'principal',toName:'Principal',type:'STUDENT_REQUEST_UNROUTED',title:r.title||'Student request awaiting Class Teacher assignment',body:r.body||r.reason||r.note||'',status:'Pending Class Teacher Assignment',details:{request:r},actionRef:r.id||r.requestNo});
            break;
          }
          addCommunicationWithReceipt({
            requestNo:r.requestNo,fromRole:'Student',fromId:sid,fromName:stu.name||sid,
            toRole:'Faculty',toId:ctId,toName:classTeacherNameForStudent(stu),type:r.type||'STUDENT_APPROVAL_REQUEST',
            title:r.title||'Student approval request',body:r.body||r.reason||r.note||'',status:'Pending Class Teacher Approval',
            details:{studentId:sid,studentName:stu.name||sid,className:stu.grade||stu.className||'',division:stu.section||stu.division||'',request:r},actionRef:r.id||r.requestNo
          });
          break;
        }

        case 'FACULTY_NOTIFICATION_SETTINGS_UPDATE': {
          const r=data.payload||{};if(!r.empId)break;
          facultyNotificationSettings[String(r.empId)]={...r,empId:String(r.empId),updatedAt:r.updatedAt||new Date().toISOString()};
          persistRuntimeState('pius_faculty_notification_settings',facultyNotificationSettings);
          broadcast({type:'FACULTY_NOTIFICATION_SETTINGS_UPDATED',payload:facultyNotificationSettings[String(r.empId)]});
          break;
        }

        case 'RESET_ALL_SCHOOL_DATA': {
          const r=data.payload||{};
          if(r.actorRole!=='Principal'||r.confirmText!=='DELETE ALL SCHOOL DATA')break;
          clearInMemorySchoolState();
          clearPersistentSchoolState().catch(e=>console.error('Reset persistence error:',e.message));
          broadcast({type:'ALL_SCHOOL_DATA_RESET',payload:{at:new Date().toISOString(),by:r.actorName||r.actorRole||'User'}});
          break;
        }

        case 'SYNC_STUDENT_ATTENDANCE': {
          const r=data.payload||{},rows=Array.isArray(r.records)?r.records:Array.isArray(r)?r:[];
          rows.forEach(row=>{const key=`${row.studentId||row.rollId||row.admissionNo||''}|${row.date||''}`,i=studentAttendanceRecords.findIndex(x=>`${x.studentId||x.rollId||x.admissionNo||''}|${x.date||''}`===key);if(i>=0)studentAttendanceRecords[i]=row;else studentAttendanceRecords.unshift(row)});
          persistRuntimeState('pius_student_attendance_records',studentAttendanceRecords);
          broadcast({type:'STUDENT_ATTENDANCE_UPDATED',payload:studentAttendanceRecords});
          break;
        }

        case 'PORTAL_IDENTIFY': {
          const r=data.payload||{};if(r.role)portalClientIdentity.set(ws,{role:r.role,id:String(r.id||''),name:r.name||'',lastSeen:new Date().toISOString()});
          break;
        }
        case 'ROUTING_AUDIT_REQUEST': {
          if(!principalMasterAllowed(ws))break;
          const rows=portalStudents.map(stu=>({studentId:studentPortalId(stu),studentName:stu.name||'',className:stu.grade||stu.className||'',division:stu.section||stu.division||'',classTeacherId:classTeacherIdForStudent(stu),classTeacherName:classTeacherNameForStudent(stu)}));
          sendWs(ws,{type:'ROUTING_AUDIT_RESULT',payload:{rows,staffCount:portalStaff.length,studentCount:portalStudents.length,classTeacherAssignments:Object.keys(classTeacherAssignments||{}).length,timetableFolders:timetableFolders.length,generatedAt:new Date().toISOString()}});
          break;
        }
        case 'PORTAL_SNAPSHOT_REQUEST': {
          sendWs(ws,{type:'PORTAL_SNAPSHOT',payload:currentPortalSnapshot()});
          break;
        }
        case 'PORTAL_DIAGNOSTIC_START': {
          startPortalDiagnostic(ws,data.payload||{});
          break;
        }
        case 'PORTAL_ROUTE_ACK': {
          const r=data.payload||{},run=portalDiagnosticRuns.get(r.probeId);
          if(run){run.acks.set(ws,{...r,at:new Date().toISOString()});if(r.role)portalClientIdentity.set(ws,{role:r.role,id:String(r.id||''),name:r.name||'',lastSeen:new Date().toISOString()})}
          break;
        }

        case 'PRESENCE_HEARTBEAT': {
          const r=data.payload||{};setPresence(r.role,r.id,r.name,true);break;
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
          if(r.type==='PORTAL_SHARE'){
            r.status=r.status||'Shared';
            r.details={...(r.details||{}),shared:true,hasAttachment:!!r.attachment,sharedAt:r.createdAt||new Date().toISOString(),replyTo:r.replyTo||null};
          }
          addCommunicationWithReceipt(r);
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
          addCommunicationWithReceipt({fromRole:data.type==='FACULTY_PUBLISH_CLASS'?'Faculty':'Principal',fromId:String(r.teacherId||'principal'),fromName:r.teacherName||'Principal',toRole:'Principal',toId:'principal',toName:'Principal',type:'CLASS_TIMETABLE_PUBLISHED',title:`${folder.className} — ${folder.division} timetable published`,body:`The confirmed timetable was published to the Student Portal by ${r.teacherName||'Principal'}.`,status:'Published',actionRef:folder.id});
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
          persistRuntimeState('pius_portion_progress',portionProgress);
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
          break;

        case 'PORTION_PROGRESS_UPDATE':
          upsertById(portionProgress,data.payload);
          persistRuntimeState('pius_portion_progress',portionProgress);
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
          break;

        case 'SYNC_LIBRARY_RESOURCES':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(libraryResources,item));
          persistRuntimeState('pius_digital_library_resources',libraryResources);
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'LIBRARY_RESOURCE_CREATE':
        case 'LIBRARY_RESOURCE_UPDATE':
          upsertById(libraryResources,data.payload);
          persistRuntimeState('pius_digital_library_resources',libraryResources);
          broadcast({type:'LIBRARY_RESOURCE_UPDATED',payload:data.payload});
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'LIBRARY_RESOURCE_DELETE':
          libraryResources=libraryResources.filter(x=>x.id!==data.payload?.id);
          persistRuntimeState('pius_digital_library_resources',libraryResources);
          broadcast({type:'LIBRARY_RESOURCES_UPDATED',payload:libraryResources});
          break;

        case 'SYNC_ADDITIONAL_DUTIES':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(additionalDutyAssignments, item));
          persistRuntimeState('pius_additional_duty_assignments',additionalDutyAssignments);
          broadcast({ type:'ADDITIONAL_DUTIES_UPDATED', payload:additionalDutyAssignments });
          break;

        case 'ADDITIONAL_DUTY_CREATE':
          upsertById(additionalDutyAssignments, data.payload);
          persistRuntimeState('pius_additional_duty_assignments',additionalDutyAssignments);
          broadcast({ type:'ADDITIONAL_DUTY_UPDATED', payload:data.payload });
          broadcast({ type:'ADDITIONAL_DUTIES_UPDATED', payload:additionalDutyAssignments });
          break;

        case 'ADDITIONAL_DUTY_DECISION':
          upsertById(additionalDutyAssignments, data.payload);
          persistRuntimeState('pius_additional_duty_assignments',additionalDutyAssignments);
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
          if(!principalMasterAllowed(ws)){sendWs(ws,{type:'ATTENDANCE_DATA_SYNCED',payload:{settings:attendanceSettings,records:attendanceRecords,leaves:leaveRecords}});break;}
          if (data.payload?.settings) attendanceSettings = { ...attendanceSettings, ...data.payload.settings };
          if (Array.isArray(data.payload?.records)) attendanceRecords = data.payload.records;
          if (Array.isArray(data.payload?.leaves)) leaveRecords = data.payload.leaves;
          persistRuntimeState('pius_attendance_settings',attendanceSettings);persistRuntimeState('pius_attendance_records',attendanceRecords);persistRuntimeState('pius_leave_records',leaveRecords);
          broadcast({ type:'ATTENDANCE_DATA_SYNCED', payload:{ settings:attendanceSettings, records:attendanceRecords, leaves:leaveRecords } });
          break;

        case 'ATTENDANCE_SETTINGS_UPDATE':
          attendanceSettings = { ...attendanceSettings, ...(data.payload || {}) };
          persistRuntimeState('pius_attendance_settings',attendanceSettings);
          broadcast({ type:'ATTENDANCE_SETTINGS_UPDATED', payload:attendanceSettings });
          break;

        case 'ATTENDANCE_MARK':
        case 'ATTENDANCE_MANUAL_UPDATE':
          upsertById(attendanceRecords, data.payload);
          persistRuntimeState('pius_attendance_records',attendanceRecords);
          broadcast({ type:'ATTENDANCE_RECORD_UPDATED', payload:data.payload });
          break;

        case 'LEAVE_REQUEST_CREATE':
          upsertById(leaveRecords, data.payload);
          persistRuntimeState('pius_leave_records',leaveRecords);
          broadcast({ type:'LEAVE_RECORD_UPDATED', payload:data.payload });
          break;

        case 'LEAVE_DECISION':
          upsertById(leaveRecords, data.payload);
          persistRuntimeState('pius_leave_records',leaveRecords);
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
          persistRuntimeState('pius_profile_verification_requests',profileVerificationRequests);
          broadcast({ type: 'PROFILE_VERIFICATION_CREATED', payload: r });
          const existing=communicationMessages.find(x=>x.type==='FACULTY_PROFILE_REQUEST'&&String(x.requestNo)===String(r.requestNo));
          if(!existing)addCommunicationWithReceipt({requestNo:r.requestNo,fromRole:'Faculty',fromId:String(r.empId||''),fromName:r.teacherName||r.empId||'Faculty',toRole:'Principal',toId:'principal',toName:'Principal',type:'FACULTY_PROFILE_REQUEST',title:'Faculty profile update request',body:r.note||'Faculty requested a profile update.',status:'Pending Principal Approval',details:{previous:r.previousSnapshot||{},proposed:r.snapshot||r.proposedChanges||{},note:r.note||'',source:r.source||'Teacher Profile Edit'},actionRef:r.id});
          break;
        }

        // Principal approves or rejects a faculty-originated request.
        case 'PROFILE_VERIFICATION_DECISION': {
          const r=data.payload||{};ensureRequestNo(r,'PV');
          upsertVerification(r);
          persistRuntimeState('pius_profile_verification_requests',profileVerificationRequests);
          if (r.appliedProfile){applyProfileToRoster(r.appliedProfile);persistRuntimeState('pius_staff_data',portalStaff);}
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

  ws.on('close', () => {portalClientIdentity.delete(ws);
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
