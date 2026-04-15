const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// PostgreSQL bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/instagram_automation'
});

const JWT_SECRET = process.env.JWT_SECRET || 'mobilya-secret-key';

// Tabloları oluştur
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      media_type VARCHAR(50) NOT NULL,
      media_url TEXT,
      caption TEXT,
      scheduled_at TIMESTAMP NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Database hazır');
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
  res.json({ status: 'OK', message: 'Mobilya Instagram API çalışıyor!' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(`
      INSERT INTO users (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      RETURNING id, email, full_name
    `, [email, hashedPassword, fullName]);
    
    const token = jwt.sign({ id: rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Kayıt başarısız' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Kullanıcı yok' });
    
    const isValid = await bcrypt.compare(password, rows[0].password_hash);
    if (!isValid) return res.status(401).json({ error: 'Şifre yanlış' });
    
    const token = jwt.sign({ id: rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: rows[0].id, email: rows[0].email, fullName: rows[0].full_name } });
  } catch (error) {
    res.status(500).json({ error: 'Giriş başarısız' });
  }
});

// AI Caption üret
app.post('/api/ai/generate', auth, async (req, res) => {
  const { mediaType } = req.body;
  const captions = {
    reel: 'Yeni ürünümüz! ✨ Kalite ve şıklık. Sipariş için DM 📩 #mobilya #dekorasyon',
    post: 'Özel tasarım mobilya! 🪑 Doğal ahşap. DM ile ulaşın. #özelüretim',
    story: 'Yeni gelenler! Kaydır 👆 #yeni #mobilya'
  };
  
  res.json({
    caption: captions[mediaType] || captions.post,
    hashtags: ['#mobilya', '#dekorasyon', '#özelüretim', '#interiordesign', '#ahşap'],
    aiGenerated: true
  });
});

// Gönderi planla
app.post('/api/scheduler/schedule', auth, async (req, res) => {
  try {
    const { mediaType, mediaUrl, caption, scheduledAt, useAI } = req.body;
    let finalCaption = caption;
    
    if (useAI) {
      finalCaption = 'AI ile üretilmiş caption: Yeni ürünümüz! ✨ #mobilya';
    }
    
    const { rows } = await pool.query(`
      INSERT INTO scheduled_posts (user_id, media_type, media_url, caption, scheduled_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.userId, mediaType, mediaUrl, finalCaption, scheduledAt]);
    
    res.json({ success: true, post: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Planlama başarısız' });
  }
});

// Planlanmış gönderileri listele
app.get('/api/scheduler/posts', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM scheduled_posts 
      WHERE user_id = $1 
      ORDER BY scheduled_at DESC
    `, [req.userId]);
    res.json({ posts: rows });
  } catch (error) {
    res.status(500).json({ error: 'Listeleme başarısız' });
  }
});

// Otomatik gönderi kontrolü (her dakika)
cron.schedule('* * * * *', async () => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM scheduled_posts 
      WHERE status = 'pending' AND scheduled_at <= NOW()
    `);
    
    for (const post of rows) {
      console.log('📤 Gönderi yayınlanmalı:', post.id);
      await pool.query('UPDATE scheduled_posts SET status = $1 WHERE id = $2', ['published', post.id]);
    }
  } catch (error) {
    console.error('Cron hatası:', error);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await initDB();
  console.log('🚀 Server çalışıyor: http://localhost:' + PORT);
});
      
