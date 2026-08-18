# Supabase Central Data Sync — Installation

This build replaces browser-only business data with a Supabase-backed central
state. The existing portal screens still use their current storage functions,
while `public/cloud-sync.js` transparently loads and saves those records through
the Render server.

## 1. Create the database tables

1. Open the Supabase project.
2. Select **SQL Editor**.
3. Select **New query**.
4. Open `supabase-portal-schema.sql` from this project.
5. Copy its complete contents into the SQL Editor.
6. Press **Run**.
7. Confirm that `portal_state`, `portal_audit_log`, and `portal_health_check`
   appear under **Table Editor**.

Do not add public RLS policies to these tables. The Render server uses the
secret/service-role key and is the only component intended to access them.

## 2. Replace the project files

Replace the current GitHub project with the files from this package. Important
new or changed files are:

- `server.js`
- `public/cloud-sync.js`
- `public/principal.html`
- `public/faculty.html`
- `public/student.html`
- `.gitignore`
- `.env.example`
- `supabase-portal-schema.sql`

Never copy a real `.env` file into GitHub.

## 3. Confirm Render environment variables

Render must contain:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_CURRENT_SECRET_KEY
APP_VERSION=supabase-central-sync-v1
```

The URL must be the project root. Do not append `/rest/v1/`.

## 4. Commit and deploy

From VS Code PowerShell:

```powershell
git status
git add .gitignore .env.example server.js package.json package-lock.json supabase-portal-schema.sql SUPABASE-INSTALLATION.md public/cloud-sync.js public/principal.html public/faculty.html public/student.html
git commit -m "Store portal data centrally in Supabase"
git push origin main
```

Wait for the Render deployment to finish.

## 5. Verify the deployment

Open:

```text
https://ai-classroom-vp8d.onrender.com/api/system-health
```

Both Supabase checks must report `ok`.

Then open the Principal portal with `Ctrl+F5`. The first Principal load uploads
eligible pre-migration browser records only when the corresponding cloud key is
still empty. Once a cloud record exists, the Supabase copy always wins.

## 6. Test synchronization

1. Open the Principal portal in Chrome.
2. Open the same portal in an Incognito window or a second device.
3. Add one test faculty member in the first window.
4. Wait for the **New cloud data is available** message in the other window.
5. Press the message to refresh.
6. Confirm that the faculty member appears.
7. Repeat with one student, one notice and one timetable.
8. Restart/redeploy Render and confirm the records are still present.

## Important security status

This is a centralized synchronization foundation suitable for the present test
data. The existing portal login generates a demonstration OTP in the browser;
it is not production authentication. Do not enter real student, medical,
financial or biometric data until Supabase Auth/server sessions and role-based
API authorization are added in the next security phase.

Photos and small embedded resources currently follow the existing JSON data
path. Large notes, audio, video and documents must be moved to private Supabase
Storage using signed server routes in the media migration phase.

