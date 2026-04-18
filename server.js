const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());

// STATIC DOSYALARI SERVIS ET (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// SQLite veritabanı (dosya bazlı, kurulum yok)
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

const JWT_SECRET = process.env.JWT_SECRET || 'mobilya-secret-key';

// Tabloları oluştur
const initDB = () => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS scheduled_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      media_type TEXT NOT NULL,
      media_url TEXT,
      caption TEXT,
      hashtags TEXT,
      scheduled_at DATETIME NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  });
  console.log('✅ SQLite database hazır');
};

// Promisify db.run
const runAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID });
    });
  });
};

const allAsync = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Auth middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error('Token yok');
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Yetkisiz' });
  }
};

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Mobilya Instagram API calisiyor!' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await runAsync(
      'INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)',
      [email, hashedPassword, fullName]
    );
    
    const token = jwt.sign({ id: result.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: result.id, email, fullName } });
  } catch (error) {
    res.status(500).json({ error: 'Kayit basarisiz' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await allAsync('SELECT * FROM users WHERE email = ?', [email]);
    
    if (rows.length === 0) return res.status(401).json({ error: 'Kullanici yok' });
    
    const isValid = await bcrypt.compare(password, rows[0].password_hash);
    if (!isValid) return res.status(401).json({ error: 'Sifre yanlis' });
    
    const token = jwt.sign({ id: rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email, fullName: rows[0].full_name } });
  } catch (error) {
    res.status(500).json({ error: 'Giris basarisiz' });
  }
});

app.post('/api/ai/generate', auth, async (req, res) => {
  const { mediaType } = req.body;
  const captions = {
    reel: 'Yeni urunumuz! ✨ Kalite ve siklik. Siparis icin DM 📩 #mobilya #dekorasyon',
    post: 'Ozel tasarim mobilya! 🪑 Dogal ahsap. DM ile ulasin. #ozeluretim',
    story: 'Yeni gelenler! Kaydir 👆 #yeni #mobilya'
  };
  
  res.json({
    caption: captions[mediaType] || captions.post,
    hashtags: ['#mobilya', '#dekorasyon', '#ozeluretim', '#interiordesign', '#ahs'],
    aiGenerated: true
  });
});

app.post('/api/scheduler/schedule', auth, async (req, res) => {
  try {
    const { mediaType, mediaUrl, caption, scheduledAt, useAI } = req.body;
    let finalCaption = caption;
    
    if (useAI) {
      finalCaption = 'AI ile uretilmis caption: Yeni urunumuz! ✨ #mobilya';
    }
    
    const result = await runAsync(
      'INSERT INTO scheduled_posts (user_id, media_type, media_url, caption, scheduled_at) VALUES (?, ?, ?, ?, ?)',
      [req.userId, mediaType, mediaUrl, finalCaption, scheduledAt]
    );
    
    res.json({ success: true, post: { id: result.id } });
  } catch (error) {
    res.status(500).json({ error: 'Planlama basarisiz' });
  }
});

app.get('/api/scheduler/posts', auth, async (req, res) => {
  try {
    const rows = await allAsync(
      'SELECT * FROM scheduled_posts WHERE user_id = ? ORDER BY scheduled_at DESC',
      [req.userId]
    );
    res.json({ posts: rows });
  } catch (error) {
    res.status(500).json({ error: 'Listeleme basarisiz' });
  }
});

// Otomatik gonderi kontrolu (her dakika)
cron.schedule('* * * * *', async () => {
  try {
    const rows = await allAsync(
      "SELECT * FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now')"
    );
    
    for (const post of rows) {
      console.log('📤 Gonderi yayinlanmali:', post.id);
      await runAsync('UPDATE scheduled_posts SET status = ? WHERE id = ?', ['published', post.id]);
    }
  } catch (error) {
    console.error('Cron hatasi:', error);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  initDB();
  console.log('🚀 Server calisiyor: http://localhost:' + PORT);
});
