import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM doesn't have __dirname — recreate it early so dotenv can use it
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

import dotenv from 'dotenv';
dotenv.config({ path: join(__dirname, '..', '.env') }); // always loads from studyai-backend/.env

import express, { json } from 'express';           // web framework
import cors from 'cors';                           // allows Flutter to call this API
import admin from 'firebase-admin';                // Firebase server SDK (CommonJS default import)
import Groq from 'groq-sdk';

// ESM doesn't have __dirname — already defined above for dotenv
// createRequire lets us use require() inside an ESM file (needed for JSON)
const require = createRequire(import.meta.url);

// ─── App setup ────────────────────────────────────────────────
const app = express();
app.use(cors());    // allow all origins (Flutter, Postman, browser)
app.use(json());    // parse incoming JSON request bodies

// ─── Firebase init ────────────────────────────────────────────
// Locally: reads serviceAccountKey.json file directly
// On Vercel: reads FIREBASE_KEY env variable (set in Vercel dashboard)
const firebaseCredential = process.env.FIREBASE_KEY
  ? admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))    // Vercel
  : admin.credential.cert(                                          // Local
      require(join(__dirname, '..', 'serviceAccountKey.json.json'))
    );

admin.initializeApp({ credential: firebaseCredential });

const db = admin.firestore(); // Firestore database handle

// ─── Groq AI init ─────────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─── Health check route ───────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'StudyAI backend running ✅', version: '1.0.0' });
});

// ─── Route 1: Generate Quiz ───────────────────────────────────
// POST /generate-quiz
// Body: { "topic": "Python programming" }
// Returns: { "questions": [...5 MCQ objects] }
app.post('/generate-quiz', async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: 'topic is required' });
    }

    const prompt = `
Generate 5 multiple choice questions about "${topic}".

Return ONLY valid JSON.

[
 {
   "question":"...",
   "options":["A","B","C","D"],
   "answer":"A",
   "explanation":"..."
 }
]
`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = completion.choices[0].message.content;

    const cleaned = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const questions = JSON.parse(cleaned);

    res.json({ questions });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 2: Save Score ──────────────────────────────────────
// POST /save-score
// Body: { "uid": "user123", "name": "Arun", "score": 4, "topic": "Python" }
// Returns: { "success": true }
app.post('/save-score', async (req, res) => {
  try {
    const { uid, name, score, topic } = req.body;

    if (!uid || !name || score === undefined) {
      return res.status(400).json({ error: 'uid, name, score are required' });
    }

    await db.collection('leaderboard').doc(uid).set({
      name,
      score,
      topic: topic || 'General',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await db.collection('quiz_history').add({
      uid,
      name,
      score,
      topic: topic || 'General',
      takenAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });

  } catch (err) {
    console.error('save-score error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 3: Get Leaderboard ─────────────────────────────────
// GET /leaderboard
// Returns: { "leaderboard": [...top 10 users] }
app.get('/leaderboard', async (_req, res) => {
  try {
    const snap = await db.collection('leaderboard')
      .orderBy('score', 'desc')
      .limit(10)
      .get();

    const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ leaderboard: data });

  } catch (err) {
    console.error('leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route 4: Get User History ────────────────────────────────
// GET /history/:uid
// Returns: { "history": [...all quizzes this user took] }
app.get('/history/:uid', async (req, res) => {
  try {
    const { uid } = req.params;

    const snap = await db.collection('quiz_history')
      .where('uid', '==', uid)
      .orderBy('takenAt', 'desc')
      .limit(20)
      .get();

    const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ history: data });

  } catch (err) {
    console.error('history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server (local dev) ─────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ StudyAI backend running on port ${PORT}`));

export default app; // Vercel uses this export
