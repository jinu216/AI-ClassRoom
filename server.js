const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the public folder through both URL styles used by the project.
const publicDir = path.join(__dirname, 'public');
app.use('/public', express.static(publicDir));
app.use(express.static(publicDir));
app.get('/', (req, res) => res.redirect('/public/principal.html'));

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
    const headers = { apikey:supabaseKey, Authorization:`Bearer ${supabaseKey}`, Accept:'application/json' };
    const [dbResult, storageResult] = await Promise.allSettled([
      timedFetch(`${supabaseUrl}/rest/v1/portal_health_check?select=id,service_name&limit=1`, { headers }),
      timedFetch(`${supabaseUrl}/storage/v1/bucket`, { headers })
    ]);
    if (dbResult.status === 'fulfilled') {
      const { response, latencyMs } = dbResult.value;
      if (response.ok) checks.supabaseDatabase={status:'ok',message:'Database connection and health table are available.',latencyMs};
      else if (response.status===404) checks.supabaseDatabase={status:'warning',message:'Supabase responded, but portal_health_check is missing.',latencyMs,recommendation:'Run supabase-health-setup.sql in the Supabase SQL Editor, then test again.'};
      else checks.supabaseDatabase={status:'error',message:`Supabase database returned HTTP ${response.status}.`,latencyMs,recommendation:'Verify the Supabase URL/key in Render and confirm the portal_health_check table is accessible.'};
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
let portionProgress = [];
let attendanceSettings = { schoolName:'Pope Pius Academy', latitude:'', longitude:'', radiusMeters:150, gpsAccuracyMeters:100, checkInTime:'08:00', checkOutTime:'16:00', graceMinutes:10, minimumFullDayMinutes:420, halfDayMinutes:240, locationRequired:true };
let attendanceRecords = [];
let leaveRecords = [];

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

// ====================================================================
// 2. WEBSOCKET REAL-TIME ENGINE
// ====================================================================
wss.on('connection', (ws) => {
  console.log('Client connected.');

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
      ,portionProgress
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

        case 'SYNC_PORTION_PROGRESS':
          if (!Array.isArray(data.payload)) break;
          data.payload.forEach(item => upsertById(portionProgress,item));
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
          break;

        case 'PORTION_PROGRESS_UPDATE':
          upsertById(portionProgress,data.payload);
          broadcast({type:'PORTION_PROGRESS_UPDATED',payload:portionProgress});
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
        case 'PROFILE_VERIFICATION_CREATE':
          upsertVerification(data.payload);
          broadcast({ type: 'PROFILE_VERIFICATION_CREATED', payload: data.payload });
          break;

        // Principal approves or rejects a faculty-originated request.
        case 'PROFILE_VERIFICATION_DECISION':
          upsertVerification(data.payload);
          if (data.payload?.appliedProfile) applyProfileToRoster(data.payload.appliedProfile);
          broadcast({ type: 'PROFILE_VERIFICATION_DECIDED', payload: data.payload });
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

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
