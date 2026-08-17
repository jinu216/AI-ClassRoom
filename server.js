const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve the public folder through both URL styles used by the project.
const publicDir = path.join(__dirname, 'public');
app.use(express.json());
app.use('/public', express.static(publicDir));
app.use(express.static(publicDir));
app.get('/', (req, res) => res.redirect('/public/principal.html'));

// ====================================================================
// 1. IN-MEMORY STATE STORE & SUPABASE SYNC HELPERS
// ====================================================================
let page1Data = {
  heading1: "Our History & Legacy",
  text1: "Founded with a vision of excellence, Pope Pius institution has been nurturing young minds for decades.",
  heading2: "Campus Facilities",
  text2: "Equipped with modern laboratories, digital classrooms, and extensive sports facilities."
};

let facultyData = [];
let noticesData = [];
let feeData = {
  term: 'Term 2 - 2026',
  amount: '$1,550',
  dueDate: '2026-09-15'
};

// Shared Principal / Faculty Portal state.
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

// Load initial data from Supabase if connected
async function loadDataFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('faculty').select('*');
    if (!error && data) {
      facultyData = data;
    }
  } catch (err) {
    console.error('Error loading data from Supabase:', err);
  }
}
loadDataFromSupabase();

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
      leaveRecords,
      portalStudents,
      studentProfileRequests,
      studentLeaveRecords,
      studentMailbox,
      classTeacherAssignments,
      timetableFolders,
      portionProgress
    }
  }));

  // Handle incoming messages from Principal or Student portals
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received Event:', data.type);

      switch (data.type) {
        case 'SYNC_PORTAL_STAFF':
          if (!Array.isArray(data.payload)) break;
          if (JSON.stringify(data.payload) === JSON.stringify(portalStaff)) break;
          portalStaff = data.payload;
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

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

        case 'PROFILE_VERIFICATION_CREATE':
          upsertVerification(data.payload);
          broadcast({ type: 'PROFILE_VERIFICATION_CREATED', payload: data.payload });
          break;

        case 'PROFILE_VERIFICATION_DECISION':
          upsertVerification(data.payload);
          if (data.payload?.appliedProfile) applyProfileToRoster(data.payload.appliedProfile);
          broadcast({ type: 'PROFILE_VERIFICATION_DECIDED', payload: data.payload });
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

        case 'PRINCIPAL_PROFILE_CONFIRMED':
        case 'PROFILE_VERIFICATION_UPDATE':
          upsertVerification(data.payload);
          if (data.payload?.appliedProfile) applyProfileToRoster(data.payload.appliedProfile);
          broadcast({ type: 'PROFILE_VERIFICATION_UPDATED', payload: data.payload });
          broadcast({ type: 'PORTAL_STAFF_UPDATED', payload: portalStaff });
          break;

        case 'UPDATE_PAGE_1':
          page1Data = data.payload;
          broadcast({ type: 'PAGE_1_UPDATED', payload: page1Data });
          break;

        case 'ADD_FACULTY':
          const newMember = {
            id: Date.now(),
            ...data.payload
          };
          facultyData.push(newMember);
          if (supabase) {
            await supabase.from('faculty').insert([newMember]);
          }
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        case 'UPDATE_FACULTY':
          facultyData = data.payload;
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        case 'DELETE_FACULTY':
          facultyData = facultyData.filter(f => f.id !== data.payload.id);
          if (supabase) {
            await supabase.from('faculty').delete().eq('id', data.payload.id);
          }
          broadcast({ type: 'FACULTY_UPDATE', payload: facultyData });
          break;

        case 'ADD_NOTICE':
          noticesData.unshift(data.payload);
          broadcast({ type: 'NOTICE_ADDED', payload: noticesData });
          break;

        case 'UPDATE_FEES':
          feeData = data.payload;
          broadcast({ type: 'FEES_UPDATED', payload: feeData });
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