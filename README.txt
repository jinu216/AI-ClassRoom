POPE PIUS PRINCIPAL <-> FACULTY LOCAL SERVER

IMPORTANT: The Principal and Faculty HTML files are the original complete files supplied by the user.
No existing Principal features or UI sections were removed.

1. Put this folder on the laptop that will act as the school server.
2. Open Command Prompt in this folder.
3. Run:
   npm init -y
   npm install express ws
   node server.js
4. Open Principal:
   http://localhost:3000/principal.html
5. Open Faculty:
   http://localhost:3000/faculty.html
6. Other computers on the same LAN can use:
   http://SERVER-LAPTOP-IP:3000/principal.html
   http://SERVER-LAPTOP-IP:3000/faculty.html

The first Principal connection bootstraps the existing Principal local data into school-data.json.
After that the server is the shared source for staff, timetable, academic settings, class subjects,
notices, leave requests and profile approval requests.

The existing localStorage is intentionally retained as a local cache/fallback. Existing UI/features
were not removed. WebSocket sync is added on top.
