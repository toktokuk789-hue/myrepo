require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const QRCode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars like 0, O, 1, I
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

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

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'pakvisa-default-secret-2026',
  resave: false,
  saveUninitialized: true
}));

// Use memory storage for photos to convert them to Base64 (Atlas storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

function buildMRZ(d) {
  const surname = (d.surname || '').toUpperCase().replace(/[\s-]/g, '<');
  const given = (d.givenNames || '').toUpperCase().replace(/[\s-]/g, '<');
  const line1 = ('V<PAK' + surname + '<<' + given).padEnd(44, '<').slice(0, 44);
  
  const dob = (d.dob || '').replace(/-/g, '').slice(2);
  const exp = (d.visaEndDate || '').replace(/-/g, '').slice(2);
  const line2_raw = (d.passportNumber || '').toUpperCase().padEnd(9, '<') + 
                    '<PAK' + dob + '<<<<<<' + exp;
  const line2 = line2_raw.padEnd(44, '<').slice(0, 44);
  return { line1, line2 };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// =============================
// MONGODB CONNECTION
// =============================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

mongoose.connection.on('error', err => console.error('❌ MongoDB Connection Error:', err));
mongoose.connection.on('connected', () => console.log('✅ MongoDB Cloud Connected'));

const visaSchema = new mongoose.Schema({
  visaRefNumber: { type: String, index: true },
  passportNumber: { type: String, index: true },
  surname: String,
  givenNames: String,
  dob: String,
  nationality: String,
  visaCategory: String,
  visaSubCategory: String,
  applicationType: String,
  visaGrantDate: String,
  travelDocCountry: String,
  stayFacility: String,
  visaStartDate: String,
  visaEndDate: String,
  visaDuration: String,
  photo: String
}, { timestamps: true });

const Visa = mongoose.model('Visa', visaSchema);

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
  const captcha = generateCaptcha();
  req.session.captcha = captcha;
  const error = req.query.error;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Portal - PakVisa</title>
  <link rel="icon" type="image/png" href="/pakistan-crest.png">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">
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
    .top-header { background: #fff; padding: 15px 20px; text-align: left; border-bottom: 1px solid var(--border); }
    .top-header img { height: 50px; width: auto; object-fit: contain; }
    
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

    .form-group label i { margin-right: 8px; color: var(--accent); font-size: 0.9rem; }
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
        ${error === 'captcha' ? `<div class="error-alert">Invalid CAPTCHA code. Please try again.</div>` : ''}
        <div class="grid-form">
          <div class="form-group">
            <label><i class="fa-solid fa-file-signature"></i> Visa Reference Number</label>
            <input type="text" name="refNum" class="form-control" placeholder="ABC-12345678" required>
          </div>
          <div class="form-group">
            <label><i class="fa-solid fa-passport"></i> Passport Number</label>
            <input type="text" name="passportNum" class="form-control" placeholder="PXXXXXXXX" required>
          </div>
          <div class="form-group">
            <label><i class="fa-solid fa-earth-asia"></i> Passport Country</label>
            <select name="country" class="form-control">
              <option value="">Select Country</option>
              <option>Afghanistan</option><option>Australia</option><option>Canada</option>
              <option>Pakistan</option><option>United Kingdom</option><option>United States</option>
            </select>
          </div>
          <div class="form-group">
            <label><i class="fa-solid fa-list-check"></i> Verification Type</label>
            <select name="type" class="form-control">
              <option>Visa Grant Notice</option>
              <option>Electronic Travel Authorization (ETA)</option>
            </select>
          </div>
        </div>

        <div class="captcha-container">
          <div class="captcha-box">
            <label style="display:block; font-weight:600; font-size:0.88rem; margin-bottom:8px; color:var(--secondary);"><i class="fa-solid fa-shield-halved"></i> CAPTCHA</label>
            <input type="text" name="captcha" class="form-control" placeholder="Enter valid code" required>
          </div>
          <div class="captcha-img-wrapper">
            <div class="fake-captcha">${captcha}</div>
            <span class="reload-btn" onclick="location.reload()">Reload Code</span>
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

app.post('/verify-search', async (req, res) => {
  const { refNum, passportNum, captcha } = req.body;
  
  // Validate CAPTCHA
  if (!captcha || captcha.toUpperCase() !== (req.session.captcha || '').toUpperCase()) {
    return res.redirect('/?error=captcha');
  }

  try {
    const match = await Visa.findOne({ 
      visaRefNumber: refNum, 
      passportNumber: passportNum 
    });
    
    if (match) {
      const params = new URLSearchParams(match.toObject());
      res.redirect('/verify?' + params.toString());
    } else {
      res.redirect('https://visa.nadra.gov.pk/verify/');
    }
  } catch (error) {
    console.error(error);
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
  <link rel="icon" type="image/png" href="/pakistan-crest.png">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">
  <style>
    :root { --primary: #0c3823; --secondary: #1a5c38; --bg: #f4f6f8; }
    * { box-sizing: border-box; }
    body { background-color: var(--primary); font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 40px 20px; }
    .container { max-width: 900px; margin: 0 auto; background: #fff; padding: 40px; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--secondary); padding-bottom: 20px; margin-bottom: 30px; }
    .header-icons { display: flex; align-items: center; gap: 20px; }
    .header img { height: 60px; width: auto; object-fit: contain; }
    .header .crest { height: 85px; }
    h1 { font-family: Georgia, serif; color: var(--secondary); font-size: 1.6rem; margin: 0; }
    
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .full-width { grid-column: span 2; }
    .form-group { display: flex; flex-direction: column; }
    label { font-weight: bold; margin-bottom: 8px; color: #444; font-size: 0.9rem; display: flex; align-items: center; }
    label i { margin-right: 8px; color: var(--secondary); width: 16px; text-align: center; }
    
    input, select { padding: 12px 15px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95rem; transition: border 0.3s; }
    input:focus, select:focus { outline: none; border-color: var(--secondary); box-shadow: 0 0 0 3px rgba(26, 92, 56, 0.1); }
    
    .submit-btn { grid-column: span 2; background-color: var(--secondary); color: white; border: none; padding: 16px; font-size: 1.1rem; border-radius: 6px; cursor: pointer; margin-top: 15px; font-weight: bold; transition: background 0.3s; }
    .submit-btn:hover { background-color: #124528; }
    
    .success-msg { background: #dcfce7; color: #166534; padding: 15px; border-radius: 6px; margin-bottom: 25px; border: 1px solid #bbf7d0; display: flex; align-items: center; font-weight: 500; }
    .success-msg i { margin-right: 12px; font-size: 1.2rem; }
    
    @media (max-width: 600px) {
      .grid { grid-template-columns: 1fr; }
      .full-width, .submit-btn { grid-column: 1; }
      .container { padding: 25px 20px; }
      .header { flex-direction: column; text-align: center; gap: 15px; }
    }
  </style>
</head>
<body>
  <div class="container">
    ${req.query.success ? `<div class="success-msg"><i class="fa-solid fa-circle-check"></i> Visa Grant Notice generated successfully and saved to MongoDB Atlas.</div>` : ''}
    <div class="header">
      <div class="header-icons">
        <img src="/pakistan-crest.png" alt="Crest" class="crest">
        <img src="/pakvisa-logo.png" alt="PakVisa Logo">
      </div>
      <h1>Grant Notice Generator</h1>
    </div>
    <form action="/generate" method="POST" enctype="multipart/form-data" class="grid">
      <div class="form-group"><label><i class="fa-solid fa-user"></i> Surname</label><input type="text" name="surname" placeholder="e.g. KHAN" required></div>
      <div class="form-group"><label><i class="fa-solid fa-user-tag"></i> Given Names</label><input type="text" name="givenNames" placeholder="e.g. MOHAMMED ALI" required></div>
      <div class="form-group"><label><i class="fa-solid fa-calendar-day"></i> Date of Birth</label><input type="date" name="dob" required></div>
      <div class="form-group"><label><i class="fa-solid fa-flag"></i> Nationality</label><input type="text" name="nationality" placeholder="PAKISTAN" required></div>
      <div class="form-group"><label><i class="fa-solid fa-passport"></i> Passport Number</label><input type="text" name="passportNumber" placeholder="P12345678" required></div>
      <div class="form-group"><label><i class="fa-solid fa-earth-asia"></i> Travel Document Country</label><input type="text" name="travelDocCountry" placeholder="PAKISTAN" required></div>
      <div class="form-group"><label><i class="fa-solid fa-file-invoice"></i> Visa Reference Number</label><input type="text" name="visaRefNumber" placeholder="ABC-12345678" required></div>
      <div class="form-group"><label><i class="fa-solid fa-calendar-plus"></i> Application Date</label><input type="date" name="applicationDate" required></div>
      <div class="form-group">
        <label><i class="fa-solid fa-list-ul"></i> Visa Category</label>
        <select name="visaCategory" required>
          <option>Tourist/Visit</option><option>Business</option><option>Student</option>
          <option>Work</option><option>Transit</option><option>Official</option>
        </select>
      </div>
      <div class="form-group">
        <label><i class="fa-solid fa-tags"></i> Visa Sub Category</label>
        <select name="visaSubCategory" required>
          <option>Individual (less Than 3 Months)</option><option>Individual (3 to 12 Months)</option>
          <option>Family Visit</option><option>Group Visit</option>
        </select>
      </div>
      <div class="form-group">
        <label><i class="fa-solid fa-file-circle-check"></i> Application Type</label>
        <select name="applicationType" required>
          <option>Entry</option><option>Extension</option><option>Re-entry</option>
        </select>
      </div>
      <div class="form-group">
        <label><i class="fa-solid fa-plane-arrival"></i> Stay Facility</label>
        <select name="stayFacility" required>
          <option>Multiple Entry - Upto 1 Year</option><option>Single Entry</option><option>Double Entry</option>
        </select>
      </div>
      <div class="form-group"><label><i class="fa-solid fa-calendar-check"></i> Visa Grant Date</label><input type="date" name="visaGrantDate" required></div>
      <div class="form-group"><label><i class="fa-solid fa-calendar-day"></i> Visa Start Date</label><input type="date" name="visaStartDate" required></div>
      <div class="form-group"><label><i class="fa-solid fa-calendar-xmark"></i> Visa End Date</label><input type="date" name="visaEndDate" required></div>
      <div class="form-group"><label><i class="fa-solid fa-clock"></i> Visa Duration (days)</label><input type="number" name="visaDuration" placeholder="e.g. 60" required></div>
      <div class="form-group full-width"><label><i class="fa-solid fa-camera"></i> Applicant Photo</label><input type="file" name="photo" accept="image/*" required></div>
      <button type="submit" class="submit-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate Official Visa Notice</button>
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
    if (req.file) {
      const b64 = req.file.buffer.toString('base64');
      const mimetype = req.file.mimetype;
      d.photo = `data:${mimetype};base64,${b64}`;
    }

    let visaData = await Visa.findOne({ visaRefNumber: d.visaRefNumber, passportNumber: d.passportNumber });
    if (visaData) {
      if (d.photo) visaData.photo = d.photo;
      await visaData.save();
    } else {
      visaData = await Visa.create(d);
    }
    
    d = visaData.toObject();
    const qrParams = new URLSearchParams({ ref: d.visaRefNumber, pass: d.passportNumber });
    const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://${getLocalIp()}:${PORT}`;
    const verifyUrl = `${baseUrl}/verify?${qrParams.toString()}`;
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
      border-radius: 4px; cursor: pointer; border: none; font-size: 0.95rem; margin: 0 6px; display: inline-block;
    }
    .page {
      background: #fff; width: 210mm; min-height: 297mm; margin: 0 auto;
      padding: 30px 40px 40px; box-shadow: 0 0 12px rgba(0,0,0,0.4); position: relative;
    }
    .doc-header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 10px; border-bottom: 3px solid #1a5c38; margin-bottom: 18px; }
    .doc-header-left { display: flex; align-items: center; }
    .doc-header-left .crest-main { height: 80px; width: auto; margin-right: 15px; }
    .doc-header-left .logo-main { height: 65px; width: auto; object-fit: contain; margin-right: 15px; }
    .doc-header-left .h-text { font-size: 0.6rem; color: #1a5c38; font-weight: bold; text-transform: uppercase; line-height: 1.5; }
    .doc-header h1 { font-size: 1.3rem; color: #777; text-transform: uppercase; font-weight: bold; letter-spacing: 0.08em; margin-top: 20px; }
    .photo-qr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .photo-box img { width: 105px; height: 130px; object-fit: cover; border: 1px solid #bbb; display: block; }
    .photo-box .pname { color: #1a5c38; font-weight: bold; font-size: 0.8rem; margin-top: 5px; }
    .qr-box img { width: 105px; height: 105px; }
    .stitle { font-weight: bold; color: #1a5c38; font-size: 0.9rem; margin: 14px 0 4px; }
    .plain-tbl { width: 100%; font-size: 0.82rem; margin-bottom: 6px; }
    .plain-tbl td { padding: 3px 0; vertical-align: top; }
    .plain-tbl .lb { color: #555; width: 190px; }
    .bordered-tbl { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 6px; }
    .bordered-tbl th, .bordered-tbl td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
    .bordered-tbl th { color: #444; font-weight: normal; width: 180px; }
    .bordered-tbl tr:nth-child(even) { background: #f9f9f9; }
    .cond { border: 1px solid #bbb; padding: 8px 12px; font-size: 0.68rem; margin-top: 8px; color: #333; }
    .cond h4 { font-size: 0.72rem; font-weight: bold; text-transform: uppercase; margin-bottom: 4px; }
    .mrz { text-align: center; margin-top: 22px; padding: 10px 0; font-family: monospace; font-size: 0.82rem; letter-spacing: 0.12em; color: #333; line-height: 1.9; }
    .doc-footer { margin-top: 18px; display: flex; align-items: center; }
    .doc-footer img { height: 48px; margin-right: 10px; }
    .doc-footer .ft { font-size: 0.58rem; color: #1a5c38; font-weight: bold; text-transform: uppercase; line-height: 1.5; }
    @media print { body { background: #fff; padding: 0; } .page { box-shadow: none; margin: 0; padding: 15px 20px; width: 100%; } .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print">
    <a href="/admin-panel">&larr; Back to Dashboard</a>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="page">
    <img src="/pakistan-crest.png" alt="Watermark" style="position: absolute; top: 38%; left: 22%; width: 55%; opacity: 0.08; pointer-events: none;">
    <div class="doc-header">
      <div class="doc-header-left">
        <img src="/pakistan-crest.png" alt="Crest" class="crest-main">
        <img src="/pakvisa-logo.png" alt="PakVisa" class="logo-main">
        <div class="h-text">ISLAMIC REPUBLIC OF PAKISTAN<br>MINISTRY OF INTERIOR</div>
      </div>
      <h1>VISA GRANT NOTICE</h1>
    </div>
    <div class="photo-qr">
      <div class="photo-box"><img src="${d.photo || ''}" alt="Photo"><div class="pname">${d.surname} ${d.givenNames}</div></div>
      <div class="qr-box"><img src="${qrDataUrl}" alt="QR"></div>
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
app.get('/verify', async (req, res) => {
  let d = req.query;

  // If we only have Ref/Pass (from QR code), look up full details in DB
  if (d.ref && d.pass && !d.visaCategory) {
    try {
      const match = await Visa.findOne({ 
        visaRefNumber: d.ref, 
        passportNumber: d.pass 
      });
      if (match) d = match.toObject();
    } catch (err) {
      console.error(err);
    }
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/pakistan-crest.png">
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
    .topbar img { height: 58px; width: auto; object-fit: contain; }
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
      object-fit: cover; display: block; margin: 0 auto 25px; border-radius: 4px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 2px solid #fff;
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

    /* ---- MOBILE REFINEMENTS ---- */
    @media (max-width: 480px) {
      .topbar { padding: 8px 12px; }
      .topbar img { height: 48px; }
      .blue-bar { margin: 15px 12px 0; }
      .card { margin: 0 12px 30px; }
      .ref-label { font-size: 1.15rem; }
      .ref-num { font-size: 1.6rem; margin: 0 10px; word-break: break-all; }
      .val-normal, .val-light { font-size: 0.95rem; }
      .photo-area img { max-width: 160px; margin-bottom: 20px; }
      .back-btn { width: calc(100% - 24px); font-size: 0.95rem; }
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

    <!-- PHOTO -->
    <div class="photo-area">
      ${d.photo ? `<img src="${d.photo}" alt="Photo">` : ''}
    </div>

    <div class="field">
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
