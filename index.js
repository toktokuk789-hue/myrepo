const express = require('express');
const QRCode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  let candidate = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Prioritize common local Wi-Fi/Ethernet IP ranges
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.0.') || iface.address.startsWith('172.')) {
          return iface.address;
        }
        candidate = iface.address;
      }
    }
  }
  return candidate;
}

const app = express();
const PORT = process.env.PORT || 3000;

fs.mkdirSync('./public/uploads', { recursive: true });

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

function buildMRZ(d) {
  const surname = (d.surname || '').toUpperCase().replace(/\s+/g, '<');
  const given = (d.givenNames || '').toUpperCase().replace(/\s+/g, '<');
  const line1 = ('V<PAK' + surname + '<<' + given).padEnd(44, '<').slice(0, 44);
  const dob = (d.dob || '').replace(/-/g, '').slice(2);
  const exp = (d.visaEndDate || '').replace(/-/g, '').slice(2);
  const nat = (d.nationality || '').slice(0, 3).toUpperCase().padEnd(3, '<');
  const ref = (d.visaRefNumber || '').slice(0, 9).padEnd(9, '0');
  const pass = (d.passportNumber || '').toUpperCase().padEnd(9, '<').slice(0, 9);
  const line2 = (ref + '<' + nat + dob + 'M' + exp + pass + '<<<<<<<<<<<<<<<<').slice(0, 44);
  return { line1, line2 };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const DB_FILE = './data/db.json';
fs.mkdirSync('./data', { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));

function getDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveToDB(entry) {
  const db = getDB();
  db.push(entry);
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function requireAuth(req, res, next) {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login && password && login === 'admin' && password === 'nadra123') {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin Access"');
  res.status(401).send('Authentication required.');
}

// =============================
// GET / — PREMIUM VERIFICATION SEARCH UI
// =============================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Portal - PakVisa</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #0c3823;
      --secondary: #1e3a5f;
      --accent: #1a6faf;
      --bg: #f8fafc;
      --text: #334155;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    
    /* TOP NAV */
    .top-header { background: #fff; border-bottom: 1px solid var(--border); padding: 15px 40px; display: flex; justify-content: space-between; align-items: center; }
    .top-header img { height: 60px; }
    
    /* BREADCRUMB */
    .breadcrumb-bar { background: #f1f5f9; padding: 12px 40px; border-bottom: 1px solid var(--border); }
    .breadcrumb-bar .inner { max-width: 1200px; margin: 0 auto; font-size: 0.85rem; color: #64748b; font-weight: 500; }
    .breadcrumb-bar span { color: var(--accent); }
    
    /* MAIN NAVBAR (Tabbed) */
    .main-navbar { background: #fff; border-bottom: 1px solid var(--border); display: flex; justify-content: center; }
    .main-navbar .nav-inner { display: flex; width: 100%; max-width: 1200px; }
    .main-navbar a { 
      flex: 1; text-align: center; padding: 20px 10px; text-decoration: none; color: #334354; font-weight: 700; font-size: 0.82rem; border-right: 1px solid var(--border); transition: all 0.2s; text-transform: uppercase; letter-spacing: 0.02em;
    }
    .main-navbar a:first-child { border-left: 1px solid var(--border); }
    .main-navbar a:hover { background: #f8fafc; color: var(--accent); }
    .main-navbar a.active { background: #1a6faf; color: #fff; border-right-color: #1a6faf; }
    @media (max-width: 900px) { .main-navbar { display: none; } }

    .hero-section { background: linear-gradient(135deg, var(--primary) 0%, #1a4a35 100%); padding: 60px 20px; text-align: center; color: #fff; }
    .hero-section h1 { font-size: 2.2rem; font-weight: 700; margin-bottom: 10px; letter-spacing: -0.02em; }
    .hero-section p { font-size: 1.1rem; opacity: 0.9; font-weight: 300; }

    .container { max-width: 900px; margin: -40px auto 60px; padding: 0 20px; position: relative; z-index: 10; }
    
    /* MAIN CARD */
    .verify-card { background: #fff; border-radius: 12px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.05); padding: 40px; }
    
    .grid-form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-bottom: 30px; }
    @media (max-width: 600px) { .grid-form { grid-template-columns: 1fr; } }
    
    .form-group label { display: block; font-weight: 600; font-size: 0.88rem; color: var(--secondary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.03em; }
    .form-control { width: 100%; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; font-size: 1rem; transition: all 0.2s; background: #fff; }
    .form-control:focus { outline: none; border-color: var(--accent); border-width: 2px; box-shadow: 0 0 0 4px rgba(26, 111, 175, 0.1); }
    
    /* CAPTCHA AREA */
    .captcha-container { display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 40px; padding-top: 10px; border-top: 1px solid var(--border); }
    .captcha-box { flex: 1; min-width: 200px; }
    .captcha-img-wrapper { display: flex; align-items: center; gap: 15px; }
    .fake-captcha { 
      background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px 20px; font-weight: 700; font-size: 1.3rem; font-family: 'Courier New', monospace; letter-spacing: 6px; color: var(--secondary); position: relative; overflow: hidden; user-select: none;
    }
    .fake-captcha::after { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(0,0,0,0.03) 10px, rgba(0,0,0,0.03) 20px); pointer-events: none; }
    .reload-btn { color: var(--accent); font-size: 0.85rem; font-weight: 600; text-decoration: none; cursor: pointer; transition: color 0.2s; }
    .reload-btn:hover { color: var(--secondary); text-decoration: underline; }

    .verify-action { text-align: center; }
    .btn-primary { 
      width: 100%; background: var(--secondary); color: #fff; border: none; padding: 16px; border-radius: 8px; font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); 
    }
    .btn-primary:hover { background: #132a4a; transform: translateY(-2px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
    .btn-primary:active { transform: translateY(0); }

    /* ERROR */
    .error-alert { background: #fef2f2; border: 1px solid #fee2e2; color: #b91c1c; padding: 16px; border-radius: 8px; margin-bottom: 24px; font-size: 0.95rem; display: flex; align-items: center; gap: 10px; }
    
    /* FOOTER */
    .site-footer { margin-top: 80px; background: #1e293b; color: #94a3b8; padding: 40px 20px; font-size: 0.85rem; text-align: center; }
    .site-footer strong { color: #f1f5f9; display: block; margin-bottom: 8px; }

  </style>
</head>
<body>

  <!-- TOP HEADER -->
  <header class="top-header">
    <img src="/pakvisa-logo.png" alt="PakVisa">
  </header>

  <!-- MAIN NAVIGATION -->
  <nav class="main-navbar">
    <div class="nav-inner">
      <a href="https://visa.nadra.gov.pk/e-visa/">HOME</a>
      <a href="https://visa.nadra.gov.pk/how-to-apply/">GUIDELINES</a>
      <a href="https://visa.nadra.gov.pk/download/">DOWNLOADS</a>
      <a href="https://visa.nadra.gov.pk/faqs/">FAQ</a>
      <a href="#" class="active">VERIFICATION</a>
      <a href="https://visa.nadra.gov.pk/contact/">CONTACT US</a>
      <a href="https://visa.nadra.gov.pk/how-to-apply/">APPLY NOW</a>
    </div>
  </nav>

  <!-- BREADCRUMB -->
  <div class="breadcrumb-bar">
    <div class="inner">Home / <span>Verification</span></div>
  </div>

  <!-- HERO -->
  <div class="hero-section">
    <h1>Verification Service</h1>
    <p>Track your application status and verify issued documents instantly.</p>
  </div>

  <div class="container">
    <div class="verify-card">
      <form action="/verify-search" method="POST">
        <div class="grid-form">
          <div class="form-group">
            <label>Visa Reference Number</label>
            <input type="text" name="refNum" class="form-control" placeholder="ABC-12345678" required>
          </div>
          <div class="form-group">
            <label>Passport Number</label>
            <input type="text" name="passportNum" class="form-control" placeholder="PXXXXXXXX" required>
          </div>
          <div class="form-group">
            <label>Passport Country</label>
            <select name="country" class="form-control">
              <option value="">Select Country</option>
              <option>Afghanistan</option><option>Australia</option><option>Canada</option>
              <option>Pakistan</option><option>United Kingdom</option><option>United States</option>
            </select>
          </div>
          <div class="form-group">
            <label>Verification Type</label>
            <select name="type" class="form-control">
              <option>Visa Grant Notice</option>
              <option>Electronic Travel Authorization (ETA)</option>
            </select>
          </div>
        </div>

        <div class="captcha-container">
          <div class="captcha-box">
            <label style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:8px; color:var(--secondary);">CAPTCHA</label>
            <input type="text" class="form-control" placeholder="Enter valid code">
          </div>
          <div class="captcha-img-wrapper">
            <div class="fake-captcha">rjm4</div>
            <span class="reload-btn">Reload Code</span>
          </div>
        </div>

        <div class="verify-action">
          <button type="submit" class="btn-primary">Verify Status</button>
        </div>
      </form>
    </div>
    </div>
  </div>

  <!-- FOOTER -->
  <footer class="site-footer">
    <strong>MINISTRY OF INTERIOR</strong>
    GOVERNMENT OF THE ISLAMIC REPUBLIC OF PAKISTAN<br>
    COPYRIGHT &copy; 2026. ALL RIGHTS RESERVED.
  </footer>

</body>
</html>`);
});

app.post('/verify-search', (req, res) => {
  const { refNum, passportNum } = req.body;
  const db = getDB();
  const match = db.find(v => v.visaRefNumber === refNum && v.passportNumber === passportNum);
  
  if (match) {
    const params = new URLSearchParams(match);
    res.redirect('/verify?' + params.toString());
  } else {
    res.redirect('https://visa.nadra.gov.pk/verify/');
  }
});

// =============================
// GET /admin-panel — SECURE FORM PAGE
// =============================
app.get('/admin-panel', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PakVisa Grant Notice Generator</title>
  <style>
    * { box-sizing: border-box; }
    body { background-color: #0c3823; font-family: Arial, sans-serif; margin: 0; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 30px 35px; border-radius: 6px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
    h1 { font-family: Georgia, serif; color: #1a5c38; font-size: 1.4rem; margin: 0; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1a5c38; padding-bottom: 15px; margin-bottom: 25px; }
    .header img { height: 60px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .full-width { grid-column: span 2; }
    .form-group { display: flex; flex-direction: column; }
    label { font-weight: bold; margin-bottom: 5px; color: #333; font-size: 0.88rem; }
    input, select { padding: 9px 10px; border: 1px solid #ccc; border-radius: 4px; font-family: Arial, sans-serif; font-size: 0.95rem; }
    input:focus, select:focus { outline: none; border-color: #1a5c38; }
    .submit-btn { grid-column: span 2; background-color: #1a5c38; color: white; border: none; padding: 13px; font-size: 1.05rem; border-radius: 4px; cursor: pointer; margin-top: 10px; font-weight: bold; }
    .submit-btn:hover { background-color: #124528; }
    @media (max-width: 600px) {
      .grid { grid-template-columns: 1fr; }
      .full-width, .submit-btn { grid-column: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="/pakvisa-logo.png" alt="PakVisa Logo">
      <h1>PakVisa Grant Notice Generator</h1>
    </div>
    <form action="/generate" method="POST" enctype="multipart/form-data" class="grid">
      <div class="form-group"><label>Surname</label><input type="text" name="surname" required></div>
      <div class="form-group"><label>Given Names</label><input type="text" name="givenNames" required></div>
      <div class="form-group"><label>Date of Birth</label><input type="date" name="dob" required></div>
      <div class="form-group"><label>Nationality</label><input type="text" name="nationality" required></div>
      <div class="form-group"><label>Passport Number</label><input type="text" name="passportNumber" required></div>
      <div class="form-group"><label>Travel Document Country</label><input type="text" name="travelDocCountry" required></div>
      <div class="form-group"><label>Visa Reference Number</label><input type="text" name="visaRefNumber" required></div>
      <div class="form-group"><label>Application Date</label><input type="date" name="applicationDate" required></div>
      <div class="form-group">
        <label>Visa Category</label>
        <select name="visaCategory" required>
          <option>Tourist/Visit</option><option>Business</option><option>Student</option>
          <option>Work</option><option>Transit</option><option>Official</option>
        </select>
      </div>
      <div class="form-group">
        <label>Visa Sub Category</label>
        <select name="visaSubCategory" required>
          <option>Individual (less Than 3 Months)</option><option>Individual (3 to 12 Months)</option>
          <option>Family Visit</option><option>Group Visit</option>
        </select>
      </div>
      <div class="form-group">
        <label>Application Type</label>
        <select name="applicationType" required>
          <option>Entry</option><option>Extension</option><option>Re-entry</option>
        </select>
      </div>
      <div class="form-group">
        <label>Stay Facility</label>
        <select name="stayFacility" required>
          <option>Multiple Entry - Upto 1 Year</option><option>Single Entry</option><option>Double Entry</option>
        </select>
      </div>
      <div class="form-group"><label>Visa Grant Date</label><input type="date" name="visaGrantDate" required></div>
      <div class="form-group"><label>Visa Start Date</label><input type="date" name="visaStartDate" required></div>
      <div class="form-group"><label>Visa End Date</label><input type="date" name="visaEndDate" required></div>
      <div class="form-group"><label>Visa Duration (days)</label><input type="number" name="visaDuration" required></div>
      <div class="form-group full-width"><label>Photo Upload</label><input type="file" name="photo" accept="image/*" required></div>
      <button type="submit" class="submit-btn">Generate Visa Notice</button>
    </form>
  </div>
</body>
</html>`);
});

// =============================
// POST /generate — VISA GRANT NOTICE
// =============================
app.post('/generate', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    let d = req.body;
    const photoFile = req.file ? req.file.filename : '';
    d.photo = photoFile;

    const db = getDB();
    const existing = db.find(v => v.visaRefNumber === d.visaRefNumber && v.passportNumber === d.passportNumber);
    
    if (existing) {
      // Record already in DB, just use existing data for display (Reprint mode)
      d = existing;
    } else {
      // New record, save it
      saveToDB(d);
    }

    // Simplified QR URL to make the QR code scan faster (less dense)
    const qrParams = new URLSearchParams({ 
      ref: d.visaRefNumber, 
      pass: d.passportNumber 
    });
    
    const ipAddress = getLocalIp();
    const port = req.socket.localPort || 3000;
    const verifyUrl = 'http://' + ipAddress + ':' + port + '/verify?' + qrParams.toString();
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 300, margin: 2, errorCorrectionLevel: 'M' });

    const mrz = buildMRZ(d);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Visa Grant Notice - ${d.givenNames} ${d.surname}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; background: #d0d0d0; padding: 20px; color: #222; }

    .no-print { text-align: center; margin-bottom: 20px; }
    .no-print a, .no-print button {
      padding: 10px 22px; background: #1a5c38; color: #fff; text-decoration: none;
      border-radius: 4px; cursor: pointer; border: none; font-size: 0.95rem;
      margin: 0 6px; display: inline-block;
    }
    .no-print a:hover, .no-print button:hover { background: #124528; }

    .page {
      background: #fff; width: 210mm; min-height: 297mm; margin: 0 auto;
      padding: 30px 40px 40px; box-shadow: 0 0 12px rgba(0,0,0,0.4);
    }

    /* HEADER */
    .doc-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding-bottom: 10px; border-bottom: 3px solid #1a5c38; margin-bottom: 18px;
    }
    .doc-header-left { display: flex; align-items: center; }
    .doc-header-left img { height: 70px; margin-right: 10px; }
    .doc-header-left .h-text { font-size: 0.6rem; color: #1a5c38; font-weight: bold; text-transform: uppercase; line-height: 1.5; }
    .doc-header h1 { font-size: 1.3rem; color: #777; text-transform: uppercase; font-weight: bold; letter-spacing: 0.08em; margin-top: 20px; }

    /* PHOTO + QR */
    .photo-qr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .photo-box img { width: 105px; height: 130px; object-fit: cover; border: 1px solid #bbb; display: block; }
    .photo-box .pname { color: #1a5c38; font-weight: bold; font-size: 0.8rem; margin-top: 5px; }
    .qr-box img { width: 105px; height: 105px; }

    /* SECTIONS */
    .stitle { font-weight: bold; color: #1a5c38; font-size: 0.9rem; margin: 14px 0 4px; }

    .plain-tbl { width: 100%; font-size: 0.82rem; margin-bottom: 6px; }
    .plain-tbl td { padding: 3px 0; vertical-align: top; }
    .plain-tbl .lb { color: #555; width: 190px; }

    .bordered-tbl { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 6px; }
    .bordered-tbl th, .bordered-tbl td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
    .bordered-tbl th { color: #444; font-weight: normal; width: 180px; }
    .bordered-tbl tr:nth-child(even) { background: #f9f9f9; }

    /* CONDITIONS */
    .cond { border: 1px solid #bbb; padding: 8px 12px; font-size: 0.68rem; margin-top: 8px; color: #333; }
    .cond h4 { font-size: 0.72rem; font-weight: bold; text-transform: uppercase; margin-bottom: 4px; }
    .cond p { margin: 0 0 4px; line-height: 1.45; }
    .cond ul { margin: 0; padding-left: 18px; }
    .cond li { margin-bottom: 1px; list-style-type: disc; }

    /* MRZ */
    .mrz {
      text-align: center; margin-top: 22px; padding: 10px 0;
      font-family: 'Courier New', Courier, monospace; font-size: 0.82rem;
      letter-spacing: 0.12em; color: #333; line-height: 1.9;
    }

    /* FOOTER */
    .doc-footer { margin-top: 18px; display: flex; align-items: center; }
    .doc-footer img { height: 48px; margin-right: 10px; }
    .doc-footer .ft { font-size: 0.58rem; color: #1a5c38; font-weight: bold; text-transform: uppercase; line-height: 1.5; }
    .doc-footer .fdate { color: #333; font-weight: normal; font-size: 0.78rem; margin-top: 2px; }

    @media print {
      body { background: #fff; padding: 0; }
      .page { box-shadow: none; margin: 0; padding: 15px 20px; width: 100%; min-height: auto; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <a href="/">&larr; New Application</a>
    <button onclick="window.print()">&#128424; Print / Save PDF</button>
  </div>

  <div class="page">
    <div class="doc-header">
      <div class="doc-header-left">
        <img src="/pakvisa-logo.png" alt="PakVisa">
        <div class="h-text">ISLAMIC REPUBLIC OF PAKISTAN<br>MINISTRY OF INTERIOR</div>
      </div>
      <h1>VISA GRANT NOTICE</h1>
    </div>

    <div class="photo-qr">
      <div class="photo-box">
        <img src="${photoFile ? '/uploads/' + photoFile : ''}" alt="Photo">
        <div class="pname">${d.surname} ${d.givenNames}</div>
      </div>
      <div class="qr-box">
        <img src="${qrDataUrl}" alt="QR">
      </div>
    </div>

    <div class="stitle">Application Details</div>
    <table class="plain-tbl">
      <tr><td class="lb">Date of Visa Application</td><td>${formatDate(d.applicationDate)}</td></tr>
      <tr><td class="lb">Visa Reference Number</td><td>${d.visaRefNumber}</td></tr>
    </table>

    <div class="stitle">Applicant's Details</div>
    <table class="bordered-tbl">
      <tr><th>Applicant Name</th><td>${d.surname} ${d.givenNames}</td></tr>
      <tr><th>Date of Birth</th><td>${formatDate(d.dob)}</td></tr>
      <tr><th>Nationality</th><td>${d.nationality}</td></tr>
      <tr><th>Passport Number</th><td>${d.passportNumber}</td></tr>
    </table>

    <div class="stitle">Visa Grant Details</div>
    <table class="bordered-tbl">
      <tr><th>Visa Category</th><td>${d.visaCategory}</td></tr>
      <tr><th>Visa Sub Category</th><td>${d.visaSubCategory}</td></tr>
      <tr><th>Application Type</th><td>${d.applicationType}</td></tr>
      <tr><th>Visa Grant Date</th><td>${formatDate(d.visaGrantDate)}</td></tr>
      <tr><th>Travel Document Country</th><td>${d.travelDocCountry}</td></tr>
      <tr><th>Stay Facility</th><td>${d.stayFacility}</td></tr>
      <tr><th>Visa Start Date</th><td>${formatDate(d.visaStartDate)}</td></tr>
      <tr><th>Visa End Date</th><td>${formatDate(d.visaEndDate)}</td></tr>
      <tr><th>Visa Duration</th><td>${d.visaDuration} Day(s)</td></tr>
    </table>

    <div class="cond">
      <h4>VISA CONDITIONS AND ENTITLEMENTS</h4>
      <p>Entry may be made on any date between visa start date &amp; visa end date.</p>
      <p>This visa is granted based upon information and documents provided by the applicant, hence, any incorrect or misleading information/documents provided may lead to legal consequences including (but not limit to):</p>
      <ul><li>Visa Cancellation</li><li>Detention</li><li>Removal from Pakistan</li></ul>
    </div>

    <div class="mrz">${mrz.line1}<br>${mrz.line2}</div>

    <div class="doc-footer">
      <img src="/pakvisa-logo.png" alt="PakVisa">
      <div>
        <div class="ft">ISLAMIC REPUBLIC OF PAKISTAN<br>MINISTRY OF INTERIOR</div>
        <div class="fdate">${formatDate(d.visaGrantDate)}</div>
      </div>
    </div>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generating notice.');
  }
});

// =============================
// GET /verify — VERIFICATION PAGE (NADRA Mobile Portal Replica)
// =============================
app.get('/verify', (req, res) => {
  let d = req.query;

  // If we only have Ref/Pass (from QR code), look up full details in DB
  if (d.ref && d.pass && !d.visaCategory) {
    const db = getDB();
    const match = db.find(v => v.visaRefNumber === d.ref && v.passportNumber === d.pass);
    if (match) d = match;
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; min-height: 100%; }
    body { background: #f5f5f5; font-family: 'Roboto', sans-serif; -webkit-font-smoothing: antialiased; }

    /* ---- WRAPPER to max 520px like mobile portal ---- */
    .wrapper { max-width: 520px; margin: 0 auto; position: relative; }

    /* ---- NAVBAR ---- */
    .header-container { background: #fff; width: 100%; border-bottom: 1px solid #e0e0e0; position: sticky; top: 0; z-index: 100; }
    .topbar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 16px; margin: 0 auto;
    }
    .topbar img { height: 58px; }
    .hamburger {
      background: none; border: none; outline: none; cursor: pointer;
      font-size: 2.2rem; color: #1a6faf; padding: 4px 0; line-height: 1; font-weight: 300;
    }
    .desktop-nav { display: none; }
    .desktop-nav a {
      color: #334354; font-weight: 700; font-size: 0.95rem; text-decoration: none; margin-left: 28px; text-transform: uppercase;
    }
    .desktop-nav a:hover { color: #1a6faf; }

    /* ---- DESKTOP MEDIA QUERY ---- */
    @media (min-width: 768px) {
      .topbar { padding: 15px 40px; }
      .hamburger { display: none; }
      .desktop-nav { display: flex; align-items: center; }
      .slidemenu { display: none !important; }
    }

    /* ---- SLIDE MENU ---- */
    .slidemenu {
      max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
      background: #1e3a5f; position: absolute; left: 0; right: 0; top: 100%;
      z-index: 99;
    }
    .slidemenu a {
      display: block; padding: 18px 22px; color: #fff; font-weight: 500;
      font-size: 0.9rem; text-decoration: none;
      border-bottom: 1px solid rgba(255,255,255,0.15);
    }
    .slidemenu a:last-child { border-bottom: none; }
    .slidemenu a:active { background: rgba(255,255,255,0.1); }

    /* ---- ACCENT BAR ---- */
    .blue-bar { width: 50px; height: 5px; background: #1a6faf; margin: 15px 25px 0; border-radius: 4px 4px 0 0; }

    /* ---- CARD ---- */
    .card {
      background: #fff; margin: 0 25px 30px; border-radius: 0 4px 4px 4px; border: 1px solid #e0e0e0;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05); overflow: hidden; padding-bottom: 20px;
    }

    /* ---- REF SECTION ---- */
    .ref-box { text-align: center; padding: 35px 16px 20px; }
    .ref-label { color: #1a6faf; font-size: 1.3rem; font-weight: 500; margin-bottom: 12px; }
    .ref-num { color: #1a6faf; font-size: 1.8rem; font-weight: 700; letter-spacing: 0.02em; border-bottom: 1px solid #eee; padding-bottom: 25px; margin: 0 20px; }

    /* ---- PHOTO AREA ---- */
    .photo-area {
      text-align: center; padding: 25px 16px; 
    }
    .photo-area img {
      max-width: 190px; width: 100%; height: auto; max-height: 240px;
      object-fit: contain; display: block; margin: 0 auto 25px;
    }

    /* ---- FIELD ---- */
    .field { text-align: center; padding: 12px 16px; }

    .lbl-upper {
      font-size: 0.8rem; color: #757575; text-transform: uppercase;
      margin-bottom: 6px; font-weight: 500;
    }
    .val-normal { font-size: 1.05rem; color: #424242; font-weight: 400; }

    .lbl-bold { font-size: 1.05rem; color: #757575; font-weight: 700; margin-bottom: 6px; }
    .val-light { font-size: 1.05rem; color: #424242; font-weight: 400; }

    /* ---- BACK BUTTON ---- */
    .back-btn {
      display: block; width: calc(100% - 40px); background: #1a6faf; color: #fff;
      text-align: center; font-weight: 700; padding: 14px; border-radius: 4px;
      font-size: 1.05rem; cursor: pointer; text-decoration: none; margin: 20px auto 0;
    }

    /* ---- PAGE FOOTER ---- */
    .pgfooter {
      text-align: center; font-size: 0.65rem; color: #aaa; padding: 16px 12px 24px;
      line-height: 1.5;
    }
  </style>
</head>
<body>

<!-- NAVBAR -->
<div class="header-container">
  <div class="topbar">
    <img src="/pakvisa-logo.png" alt="PakVisa">
    <div class="desktop-nav">
      <a href="https://visa.nadra.gov.pk/e-visa/">HOME</a>
      <a href="https://visa.nadra.gov.pk/how-to-apply/">GUIDELINES</a>
      <a href="https://visa.nadra.gov.pk/download/">DOWNLOADS</a>
      <a href="https://visa.nadra.gov.pk/faqs/">FAQ</a>
      <a href="https://visa.nadra.gov.pk/contact/">CONTACT US</a>
    </div>
    <button class="hamburger" id="menuBtn" onclick="toggleMenu()">&#9776;</button>
  </div>

  <!-- SLIDE MENU -->
  <div class="slidemenu" id="slideMenu">
    <a href="https://visa.nadra.gov.pk/e-visa/">HOME</a>
    <a href="https://visa.nadra.gov.pk/how-to-apply/">GUIDELINES</a>
    <a href="https://visa.nadra.gov.pk/download/">DOWNLOADS</a>
    <a href="https://visa.nadra.gov.pk/faqs/">FAQ</a>
    <a href="https://visa.nadra.gov.pk/contact/">CONTACT US</a>
  </div>
</div>

<div class="wrapper">

  <!-- ACCENT BAR -->
  <div class="blue-bar"></div>

  <!-- CARD -->
  <div class="card">

    <div class="ref-box">
      <div class="ref-label">Visa Reference Number &ndash;</div>
      <div class="ref-num">${d.visaRefNumber || ''}</div>
    </div>

    <div class="photo-area">
      ${d.photo ? '<img src="/uploads/' + d.photo + '" alt="Photo">' : ''}
      <div class="lbl-upper">NAME</div>
      <div class="val-normal">${d.surname || ''} &nbsp;&nbsp; ${d.givenNames || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-bold">Passport No</div>
      <div class="val-light">${d.passportNumber || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-bold">Passport Country</div>
      <div class="val-light">${d.travelDocCountry || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">VISA CATEGORY</div>
      <div class="val-normal">${d.visaCategory || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">VISA SUB CATEGORY</div>
      <div class="val-normal">${d.visaSubCategory || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">APPLICATION TYPE</div>
      <div class="val-normal">${d.applicationType || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">STAYING FACILITY</div>
      <div class="val-normal">${d.stayFacility || ''}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">VISA START DATE</div>
      <div class="val-normal">${formatDate(d.visaStartDate)}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">VISA END DATE</div>
      <div class="val-normal">${formatDate(d.visaEndDate)}</div>
    </div>

    <div class="field">
      <div class="lbl-upper">VISA DURATION</div>
      <div class="val-normal">${d.visaDuration ? d.visaDuration + ' Day(s)' : ''}</div>
    </div>

    <a href="https://visa.nadra.gov.pk/e-visa/authenticate" class="back-btn">Back to Login</a>

  </div>

  <!-- FOOTER -->
  <div class="pgfooter">
    COPYRIGHT &copy; 2015&ndash;2026 MINISTRY OF INTERIOR, GOVERNMENT OF PAKISTAN &ndash; V: 6.0.0
  </div>

</div>

<script>
  var menuOpen = false;
  function toggleMenu() {
    var menu = document.getElementById('slideMenu');
    var btn = document.getElementById('menuBtn');
    if (menuOpen) {
      menu.style.maxHeight = '0';
      btn.innerHTML = '&#9776;';
      menuOpen = false;
    } else {
      menu.style.maxHeight = '350px';
      btn.innerHTML = '&#10005;';
      menuOpen = true;
    }
  }
</script>

</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('Server running at http://localhost:' + PORT);
});
