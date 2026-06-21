const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ────────────────────────────────────────────────────────────
//  FIREBASE ADMIN — don tabbatar wanene yake kira API ɗinmu
// ────────────────────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert(
        require(process.env.NODE_ENV === 'production'
            ? '/etc/secrets/serviceAccountKey.json'
            : './serviceAccountKey.json')
    )
});

const ADMIN_UID = "3w81YH5QG6gH61II7jVCKfTRYo72"; // Admin UID
// Middleware: tabbatar mai kira ya login (Firebase Auth token)
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;
    if (!token) return res.status(401).json({ error: 'Babu login token' });

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.uid = decoded.uid;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token ba daidai ba ne ko ya ƙare' });
    }
}

// Middleware: tabbatar mai kira shine ADMIN
function requireAdmin(req, res, next) {
    if (req.uid !== ADMIN_UID) {
        return res.status(403).json({ error: 'Kai ba admin ba ne' });
    }
    next();
}

// ────────────────────────────────────────────────────────────
//  BACKBLAZE B2 (S3-compatible)
// ────────────────────────────────────────────────────────────
const s3 = new AWS.S3({
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
    endpoint: process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
    region: 'us-east-005'
});

const BUCKET = 'social-media-storage';                       // bucket na yanzu — PUBLIC (hoto/video na app)
const VERIFICATION_BUCKET = 'social-media-verification-private';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINTS NA YAU DA KULLUM (social media — public bucket)
// ════════════════════════════════════════════════════════════

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Babu file' });

        const { type, username } = req.body;
        const ext = path.extname(req.file.originalname) ||
                    (req.file.mimetype.includes('video') ? '.mp4' : '.jpg');
        const fileName = `${type}/${username}_${Date.now()}${ext}`;

        const params = {
            Bucket: BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        };

        await s3.upload(params).promise();

        const url = `https://${BUCKET}.s3.us-east-005.backblazeb2.com/${fileName}`;

        res.json({ success: true, url, key: fileName });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/delete', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'Babu key' });
        await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINTS NA ID/SELFIE VERIFICATION (private bucket + auth)
// ════════════════════════════════════════════════════════════

// Pro ya tura ID ko Selfie — dole ya zama logged in (Firebase token)
app.post('/upload-verification', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Babu file' });

        const { docType } = req.body;   // "id" ko "selfie"
        if (!['id', 'selfie'].includes(docType)) {
            return res.status(400).json({ error: 'docType dole ya zama id ko selfie' });
        }

        const ext = path.extname(req.file.originalname) || '.jpg';
        // req.uid ya fito daga token da aka tabbatar — BA daga frontend body ba,
        // don kada mutum ya rubuta wani UID ya kwaikwayi wani Pro.
        const fileName = `${req.uid}/${docType}_${Date.now()}${ext}`;

        await s3.upload({
            Bucket: VERIFICATION_BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
            // LURA: babu ACL public-read anan — file ɗin ya rage private
        }).promise();

        res.json({ success: true, key: fileName });   // BABU public url da ake mayarwa

    } catch (err) {
        console.error('Verification upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin kawai zai iya samun signed URL don kallon hoto (yana mutuwa bayan minti 10)
app.post('/verification-url', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'Babu key' });

        const url = s3.getSignedUrl('getObject', {
            Bucket: VERIFICATION_BUCKET,
            Key: key,
            Expires: 600   // minti 10 kawai
        });

        res.json({ success: true, url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin kawai zai iya share hoton ID/selfie bayan an gama review (privacy compliance)
app.delete('/verification-delete', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'Babu key' });
        await s3.deleteObject({ Bucket: VERIFICATION_BUCKET, Key: key }).promise();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Oryzon Media Server yana aiki!' }));

// ════════════════════════════════════════════════════════════
//  FCM PUSH NOTIFICATION ENDPOINTS
// ════════════════════════════════════════════════════════════

// Save FCM token na user zuwa Firebase RTDB
app.post('/save-fcm-token', async (req, res) => {
    try {
        const { username, token } = req.body;
        if (!username || !token) {
            return res.status(400).json({ error: 'Babu username ko token' });
        }

        const db = admin.database();
        await db.ref(`fcm_tokens/${username}`).set({
            token: token,
            updatedAt: Date.now()
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Save FCM token error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Aika Push Notification zuwa user
app.post('/send-push', async (req, res) => {
    try {
        const { username, title, body, data } = req.body;
        if (!username || !title || !body) {
            return res.status(400).json({ error: 'Babu username, title, ko body' });
        }

        // Samu FCM token na user daga RTDB
        const db = admin.database();
        const snap = await db.ref(`fcm_tokens/${username}`).once('value');
        
        if (!snap.exists()) {
            return res.status(404).json({ error: 'User ba shi da FCM token' });
        }

        const fcmToken = snap.val().token;

        // Aika notification
        const message = {
            token: fcmToken,
            notification: {
                title: title,
                body: body
            },
            data: data || {},
            webpush: {
                notification: {
                    icon: '/icon-192.png',
                    badge: '/badge-72.png',
                    vibrate: [200, 100, 200]
                },
                fcm_options: {
                    link: data && data.url ? data.url : '/services.html'
                }
            }
        };

        const response = await admin.messaging().send(message);
        res.json({ success: true, messageId: response });

    } catch (err) {
        console.error('Send push error:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server yana gudana a port ${PORT}`));
           
