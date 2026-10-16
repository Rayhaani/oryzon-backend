const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const sharp = require('sharp');

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
    ),
    databaseURL: "https://oryzon-50ea4-default-rtdb.firebaseio.com"
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

// ── GYARA: an ƙara requireAuth — a baya wannan endpoint din BABU login da ake bukata,
// wanda ke nufin duk wanda ya sami URL/script din zai iya turawa bucket ɗinku fayiloli
// marasa iyaka (har zuwa 500MB kowanne), yana iya cika sararin ajiyar ku kyauta. ──
app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
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
            ContentType: req.file.mimetype,
            CacheControl: 'public, max-age=31536000, immutable'
        };

        await s3.upload(params).promise();
        // Thumbnail (480px WebP) — idan hoto ne. Idan ya gaza, upload na asali ba ya lalacewa.
        let thumbUrl = null;
        try {
            if (req.file.mimetype.startsWith('image/') && !/gif|svg/.test(req.file.mimetype)) {
                const thumbKey = `thumbs/${fileName.replace(/\.[^./]+$/, '')}.webp`;
                const thumbBuf = await sharp(req.file.buffer).rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
                await s3.upload({ Bucket: BUCKET, Key: thumbKey, Body: thumbBuf, ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable' }).promise();
                thumbUrl = `https://${BUCKET}.s3.us-east-005.backblazeb2.com/${thumbKey}`;
            }
        } catch (thumbErr) {
            console.error('Thumbnail error:', thumbErr.message);
        }

        const url = `https://${BUCKET}.s3.us-east-005.backblazeb2.com/${fileName}`;

    res.json({ success: true, url, key: fileName, thumbUrl });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── GYARA: an ƙara requireAuth — a baya wannan endpoint din BABU login da ake bukata,
// wanda ke nufin duk wanda ya san (ko ya yi tsammani) wani 'key', zai iya share
// wani fayil daga bucket ɗinku ba tare da izini ba. ──
app.delete('/delete', requireAuth, async (req, res) => {
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

app.post('/upload-verification', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Babu file' });

        const { docType } = req.body;   // "id" ko "selfie"
        if (!['id', 'selfie'].includes(docType)) {
            return res.status(400).json({ error: 'docType dole ya zama id ko selfie' });
        }

        const ext = path.extname(req.file.originalname) || '.jpg';
        const fileName = `${req.uid}/${docType}_${Date.now()}${ext}`;

        await s3.upload({
            Bucket: VERIFICATION_BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }).promise();

        res.json({ success: true, key: fileName });

    } catch (err) {
        console.error('Verification upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/verification-url', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: 'Babu key' });

        const url = s3.getSignedUrl('getObject', {
            Bucket: VERIFICATION_BUCKET,
            Key: key,
            Expires: 600
        });

        res.json({ success: true, url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
//  LIVEKIT — token generation domin Live Streaming
// ════════════════════════════════════════════════════════════
const { AccessToken } = require('livekit-server-sdk');

app.post('/livekit-token', requireAuth, async (req, res) => {
    try {
        const { room, canPublish } = req.body;
        if (!room) return res.status(400).json({ error: 'Babu sunan room' });

        const at = new AccessToken(
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET,
            { identity: req.uid }
        );
        at.addGrant({
            room,
            roomJoin: true,
            canPublish: Boolean(canPublish),
            canSubscribe: true
        });

        const token = await at.toJwt();
        res.json({ success: true, token, url: process.env.LIVEKIT_URL });
    } catch (err) {
        console.error('livekit-token error:', err);
        res.status(500).json({ error: err.message });
    }
});
// ════════════════════════════════════════════════════════════
//  FCM PUSH NOTIFICATION ENDPOINTS
// ════════════════════════════════════════════════════════════

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

app.post('/send-push', async (req, res) => {
    try {
        const { username, title, body, data } = req.body;
        if (!username || !title || !body) {
            return res.status(400).json({ error: 'Babu username, title, ko body' });
        }

        const db = admin.database();
        const snap = await db.ref(`fcm_tokens/${username}`).once('value');

        if (!snap.exists()) {
            return res.status(404).json({ error: 'User ba shi da FCM token' });
        }

        const fcmToken = snap.val().token;

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

// ════════════════════════════════════════════════════════════
//  CUSTOM TOKEN (login)
// ════════════════════════════════════════════════════════════

app.post('/get-custom-token', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false });
    try {
        const db = admin.database();
        const snap = await db.ref(`usernames/${username}`).once('value');
        if (!snap.exists()) {
            return res.status(404).json({ success: false, error: 'Username ba a samu ba a usernames node' });
        }
        const realUid = snap.val();
        const token = await admin.auth().createCustomToken(realUid);
        res.json({ success: true, token });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
// ════════════════════════════════════════════════════════════
//  GROQ KEYS — jerin duk API keys ɗin Groq (za a iya ƙara nawa
//  kake so ta hanyar saka GROQ_API_KEY_4, GROQ_API_KEY_5, da sauransu
//  a matsayin environment variables akan Render — rotation ɗin zai
//  gane su kai-tsaye, babu bukatar canza code)
// ════════════════════════════════════════════════════════════
const GROQ_KEYS = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5
].filter(Boolean); // ya cire duk wanda babu shi (undefined)

// Function na gama-gari: kira Groq tare da automatic key rotation/failover.
// Ana amfani da wannan a duka /api/chat (Ali - vendor chat) da /ai-triage (free tier).
async function callGroqWithFailover(model, messages, maxTokens = 500, temperature = 0.5) {
    if (GROQ_KEYS.length === 0) {
        throw new Error('Babu Groq API key da aka saita a server');
    }

    let lastError = null;

    for (let i = 0; i < GROQ_KEYS.length; i++) {
        try {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_KEYS[i]}`
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_completion_tokens: maxTokens
                })
            });

            if (groqRes.status === 429 || groqRes.status === 401) {
                lastError = `Key #${i + 1} ya kasa (status ${groqRes.status})`;
                console.warn(`⚠️ Groq key #${i + 1} rate-limited/invalid, gwada na gaba...`);
                continue;
            }

            const data = await groqRes.json();

            if (data.error) {
                if (data.error.code === 'rate_limit_exceeded') {
                    lastError = data.error.message;
                    console.warn(`⚠️ Groq key #${i + 1} rate limit (in-body), gwada na gaba...`);
                    continue;
                }
                throw new Error(data.error.message);
            }

            return data.choices[0].message.content;

        } catch (err) {
            lastError = err.message;
            console.error(`Groq key #${i + 1} network error:`, err.message);
            continue;
        }
    }

    throw new Error('Duk Groq API keys sun cika ko sun kasa: ' + lastError);
}

app.post('/api/chat', async (req, res) => {
    const { systemPrompt, messages } = req.body;
    if (!systemPrompt || !messages) {
        return res.status(400).json({ error: 'Missing systemPrompt or messages' });
    }

    try {
        const reply = await callGroqWithFailover(
            TEXT_MODEL_CHAIN.simple,
            [{ role: 'system', content: systemPrompt }, ...messages]
        );
        res.json({ choices: [{ message: { content: reply } }] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server yana gudana a port ${PORT}`));


// ════════════════════════════════════════════════════════════
//  NEXUS AI TRIAGE —
//    • MedGemma 1.5 4B (Paid/Pro, Dedicated Endpoint) — hoto na
//      likitanci (X-ray, fata, nama) da tsararrun bayanan asibiti
//      (EHR/FHIR/lab reports) KAWAI.
//    • GPT-OSS 120B + Kimi K2 (Free tier akan Groq) — duk sauran
//      rubutu na yau da kullum, don DUKA free DA Pro users.
// ════════════════════════════════════════════════════════════

const HF_TOKEN = process.env.HF_TOKEN;

const MEDGEMMA_ENDPOINT_URL = process.env.MEDGEMMA_ENDPOINT_URL;
const CLINICAL_MODEL = "google/medgemma-1.5-4b-it"; // don rikodi/logging kawai

const TRANSLATION_MODEL = "meta-llama/Llama-3.2-3B-Instruct";

const TEXT_MODEL_CHAIN = {
    simple: 'openai/gpt-oss-120b',
    complex: 'moonshotai/kimi-k2-instruct-0905'
};

function classifyTextModel(text, historyTokenEstimate = 0) {
    const complexKeywords = [
        'differential diagnosis', 'interaction', 'multiple conditions',
        'tarihin likitanci', 'zurfin bincike', 'cikakken'
    ];
    const lower = (text || '').toLowerCase();
    const isComplex = complexKeywords.some(kw => lower.includes(kw));
    const longConversation = historyTokenEstimate > 4000;
    return (isComplex || longConversation) ? TEXT_MODEL_CHAIN.complex : TEXT_MODEL_CHAIN.simple;
}

async function callTextModelChain(messages, preferredModel) {
    const chain = preferredModel === TEXT_MODEL_CHAIN.complex
        ? [TEXT_MODEL_CHAIN.complex, TEXT_MODEL_CHAIN.simple]
        : [TEXT_MODEL_CHAIN.simple, TEXT_MODEL_CHAIN.complex];

    let lastError = null;
    for (const model of chain) {
        try {
            return await callGroqWithFailover(model, messages, 2000, 0.3);
        } catch (err) {
            lastError = err.message;
            console.warn(`⚠️ Text model ${model} ya kasa, ana gwada na gaba... (${err.message})`);
            continue;
        }
    }
    throw new Error(`Dukkan text models sun kasa: ${lastError}`);
}

async function callMedGemmaEndpoint(messages) {
    if (!MEDGEMMA_ENDPOINT_URL) {
        throw new Error("MEDGEMMA_ENDPOINT_URL ba a saita ba tukuna a environment variables — dole a fara 'deploy' Dedicated Endpoint a Hugging Face kafin wannan ya yi aiki.");
    }

    const response = await fetch(`${MEDGEMMA_ENDPOINT_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${HF_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            messages,
            max_tokens: 500,
            temperature: 0.3
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`MedGemma Endpoint error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function callHuggingFaceRouter(model, messages) {
    const response = await fetch(`https://router.huggingface.co/v1/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${HF_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.3 })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HF Router error (${response.status}) for ${model}: ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

app.get('/meds/:profileId', requireAuth, async (req, res) => {
    try {
        const db = admin.database();
        const snap = await db.ref(`users/${req.uid}/meds/${req.params.profileId}`).once('value');
        res.json({ success: true, meds: snap.val() || {} });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/share/:username', async (req, res) => {
    try {
        const db = admin.database();
        const snap = await db.ref('providers/' + req.params.username).once('value');
        const data = snap.val();

        const appUrl = 'https://rayhaani.github.io/Oryzon/services.html?pro=' + encodeURIComponent(req.params.username);

        if (!data) {
            return res.redirect(appUrl);
        }

        const title = (data.businessName || req.params.username) + ' — Nexus';
        const description = data.bio || (data.categoryLabel ? 'Order from ' + (data.businessName || req.params.username) + ' on Nexus' : 'View this business on Nexus');
        const image = data.menuImageUrl || 'https://rayhaani.github.io/Oryzon/default-share-image.png';

        res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:type" content="website">
<meta property="og:url" content="${appUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0;url=${appUrl}">
</head>
<body>
<p>Redirecting to <a href="${appUrl}">${title}</a>...</p>
</body>
</html>`);
    } catch (err) {
        console.error('Share preview error:', err.message);
        res.redirect('https://rayhaani.github.io/Oryzon/services.html');
    }
});

app.post('/meds/:profileId', requireAuth, async (req, res) => {
    try {
        const { name, time, freq } = req.body;
        if (!name || !time) return res.status(400).json({ error: 'Babu name ko time' });
        const db = admin.database();
        const ref = db.ref(`users/${req.uid}/meds/${req.params.profileId}`).push();
        await ref.set({ name, time, freq: freq || 'Once daily', createdAt: Date.now(), lastNotified: null });
        res.json({ success: true, id: ref.key });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/meds/:profileId/:medId', requireAuth, async (req, res) => {
    try {
        const db = admin.database();
        await db.ref(`users/${req.uid}/meds/${req.params.profileId}/${req.params.medId}`).remove();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/check-due-reminders', async (req, res) => {
    try {
        const db = admin.database();
        const usersSnap = await db.ref('users').once('value');
        const users = usersSnap.val() || {};
        const now = new Date();
        const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        let sentCount = 0;

        for (const uid of Object.keys(users)) {
            const profiles = users[uid].meds || {};
            for (const profileId of Object.keys(profiles)) {
                const meds = profiles[profileId] || {};
                for (const medId of Object.keys(meds)) {
                    const med = meds[medId];
                    if (med.time !== currentHHMM) continue;
                    const lastNotified = med.lastNotified || 0;
                    if (Date.now() - lastNotified < 55 * 1000) continue;

                    const fcmSnap = await db.ref(`fcm_tokens/${uid}`).once('value');
                    if (!fcmSnap.exists()) continue;

                    await admin.messaging().send({
                        token: fcmSnap.val().token,
                        notification: {
                            title: '💊 Lokacin Magani',
                            body: `Lokaci yayi na ${med.name} (${med.freq})`
                        },
                        webpush: { fcm_options: { link: '/health.html' } }
                    });

                    await db.ref(`users/${uid}/meds/${profileId}/${medId}/lastNotified`).set(Date.now());
                    sentCount++;
                }
            }
        }
        res.json({ success: true, sent: sentCount });
    } catch (err) {
        console.error('check-due-reminders error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PROFILE_SUMMARY_PROMPT = `You are a clinical documentation assistant. You will be given (1) a patient's EXISTING medical profile summary for this specific specialty unit, and (2) a NEW conversation transcript from today's visit to the same unit.

Produce an UPDATED profile summary that merges the old and new information. Rules:
- Keep it concise: bullet points, clinical shorthand style, under 150 words total.
- Preserve important persistent facts from the old summary (allergies, chronic conditions, recurring symptoms, past advice given) unless the new conversation contradicts or updates them.
- Add new relevant facts from today's conversation: new symptoms, patterns, dates if mentioned, self-care tried, outcomes.
- Do NOT invent information that wasn't stated. If uncertain, omit it.
- Write in plain clinical English, third person (e.g., "Patient reports recurring morning headaches since ~3 weeks, denies vision changes. Advised hydration + OTC analgesic; outcome unknown.").
- Output ONLY the updated summary text. No preamble, no markdown headers.`;

async function updateMedicalProfile(uid, contextKey, conversationHistory) {
    try {
        const db = admin.database();
        const profileSnap = await db.ref(`users/${uid}/medicalProfile/${contextKey}`).once('value');
        const existingSummary = profileSnap.exists() ? profileSnap.val().summary : '(No prior visits to this unit.)';

        const transcript = conversationHistory
            .map(m => `${m.role === 'user' ? 'Patient' : 'Assistant'}: ${m.content}`)
            .join('\n');

        const messages = [
            { role: 'system', content: PROFILE_SUMMARY_PROMPT },
            { role: 'user', content: `EXISTING PROFILE SUMMARY:\n${existingSummary}\n\nNEW CONVERSATION TRANSCRIPT:\n${transcript}` }
        ];

        const updatedSummary = await callGroqWithFailover(TEXT_MODEL_CHAIN.simple, messages, 300, 0.2);

        await db.ref(`users/${uid}/medicalProfile/${contextKey}`).set({
            summary: updatedSummary.trim(),
            updatedAt: Date.now()
        });
    } catch (err) {
        console.error('updateMedicalProfile error:', err.message);
    }
}
app.post('/ai-triage', requireAuth, async (req, res) => {
    try {
        const { text, image, structuredData, lang, history, contextKey } = req.body;
        const conversationHistory = Array.isArray(history) ? history : [];
        const safeContextKey = (contextKey && typeof contextKey === 'string') ? contextKey : 'general';
        if (!text && !image && !structuredData) {
            return res.status(400).json({ error: "No text, image, or structured data provided." });
        }

        const db = admin.database();
        const tierSnap = await db.ref(`subscriptions/${req.uid}/isPro`).once('value');
        const isPro = tierSnap.exists() && tierSnap.val() === true;

        const MEDGEMMA_SYSTEM_PROMPT = "You are Nexus Intelligence, a careful medical triage assistant. You are NOT a doctor and must never give a final diagnosis. Assess the symptom described and clearly state: (1) whether this seems safe to self-manage at home, (2) practical self-care advice if safe, (3) whether the person should see a doctor and how urgently. Always end by reminding them this is not a diagnosis.";

        const TEXT_MODEL_SYSTEM_PROMPT = `You are Nexus Intelligence, a warm, highly knowledgeable clinical triage assistant. You are NOT a licensed doctor and must NEVER state a definitive diagnosis or write a formal prescription — your role is structured triage guidance, like the intake conversation a skilled doctor has with a patient before deciding on treatment.

## HOW TO CONDUCT THE CONVERSATION (very important)

Do not dump a full report after a single vague message (e.g. just "Headache"). Instead, behave like a real clinician taking a history:

- If the person's message is brief or lacks detail, ask ONE focused, relevant follow-up question at a time (e.g. duration, severity 1-10, location, what makes it better/worse, associated symptoms, past medical history, current medications, allergies). Wait for their answer before asking the next question.
- Keep gathering information (typically 3-6 short exchanges) until you have enough to reason confidently — but don't drag it out unnecessarily once you have a clear picture.
- The ONLY exception: if the very first message already contains a clear red-flag/emergency sign (e.g. chest pain, severe bleeding, difficulty breathing, sudden confusion, stroke signs), skip the questions and immediately urge emergency care.
- Once you have gathered enough information, deliver a single comprehensive closing summary structured as below. Do not repeat this full structure at every turn — only at the end once you're ready to conclude.

## FINAL SUMMARY STRUCTURE (once you have enough information)

1. **Acknowledge** what the person described, briefly and warmly.
2. **Red flags** — confirm none are present (or escalate immediately if they appear at any point).
3. **What's likely going on** — explain, in real depth and plain language, the 2-4 most probable explanations for their symptoms, ordered by likelihood, including *why* each one fits what they told you. Teach them about their body and condition the way a great doctor would — thorough, not a one-line guess.
4. **Self-care guidance** — complete, practical, step-by-step home-care advice where it is genuinely safe (rest, hydration, diet adjustments, warm/cold compress, sleep position, triggers to avoid, etc).
5. **Over-the-counter recommendation** — if appropriate, recommend ONE specific, well-established OTC option that is the standard first-line choice for this symptom. Speak with the confidence of an experienced clinician making a routine recommendation. Do NOT suggest options the patient has already told you they cannot take. Give a typical adult OTC dosing range as general information, clearly framed as general guidance. ALWAYS close this section with: "Please check with a pharmacist or doctor before taking anything, especially if you have any existing health conditions, take other medications, or could be pregnant."
6. **If testing seems warranted** — suggest they visit a lab or hospital for it, without issuing a formal referral order.
7. **Clear next step** — tell them plainly whether this can likely be managed at home, or whether and how urgently they should see a doctor, and why.
8. **Honest closing note** — a brief, warm reminder that this is guidance only, not a diagnosis.

## LANGUAGE
Always detect the language the patient is writing in from their message, and respond ENTIRELY in that same language. If the patient switches languages mid-conversation, switch with them.

## TONE
Confident, warm, and reassuring — like a trusted, excellent doctor who has time for you. Never robotic or dismissive.`;

        const needsClinicalSpecialist = Boolean(image) || Boolean(structuredData);

        let clinicalReply;

        if (needsClinicalSpecialist) {
            if (!isPro) {
                return res.status(403).json({
                    error: "image_requires_pro",
                    reply: image
                        ? "Nazarin hoto na bukatar asusun Pro. Da fatan za ka rubuta alamomin cutar a matsayin rubutu, ko ka koma Pro don nazarin hoto."
                        : "Fassara/nazarin bayanan asibiti masu tsari (lab report/EHR) na bukatar asusun Pro. Ka koma Pro don wannan fasalin."
                });
            }

            const userContent = image
                ? [
                    { type: "text", text: text || "Please look at this photo and tell me what you see." },
                    { type: "image_url", image_url: { url: image } }
                  ]
                : `${text || ''}\n\nStructured clinical data:\n${JSON.stringify(structuredData)}`;

            const messages = [
                { role: "system", content: MEDGEMMA_SYSTEM_PROMPT },
                { role: "user", content: userContent }
            ];
            clinicalReply = await callMedGemmaEndpoint(messages);

        } else {
            const profileSnap = await db.ref(`users/${req.uid}/medicalProfile/${safeContextKey}`).once('value');
            const priorProfile = profileSnap.exists() ? profileSnap.val().summary : null;

            let systemPromptWithMemory = TEXT_MODEL_SYSTEM_PROMPT;
            if (priorProfile) {
                systemPromptWithMemory += `\n\n## PATIENT MEMORY FOR THIS UNIT\nYou have seen this patient before in this specific unit. Here is their known background from prior visits:\n${priorProfile}\n\nUse this naturally, the way an experienced specialist would recall a returning patient's chart.`;
            }
            const cleanHistory = conversationHistory.map(m => ({ role: m.role, content: m.content }));
            const messages = [
                { role: "system", content: systemPromptWithMemory },
                ...cleanHistory,
                { role: "user", content: text }
            ];
            const historyTokenEstimate = conversationHistory.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0) / 4;
            const preferredModel = classifyTextModel(text, historyTokenEstimate);
            clinicalReply = await callTextModelChain(messages, preferredModel);
        }

        let finalReply = clinicalReply;
        if (needsClinicalSpecialist && lang && lang !== 'en') {
            const translationMessages = [
                { role: "system", content: `Translate the following medical guidance into ${lang}, keeping it warm, clear, and accurate. Do not add or remove any medical information.` },
                { role: "user", content: clinicalReply }
            ];
            finalReply = await callHuggingFaceRouter(TRANSLATION_MODEL, translationMessages);
        }

        res.json({ reply: finalReply, tier: isPro ? 'pro' : 'free' });
        if (!needsClinicalSpecialist) {
            const fullTranscript = [...conversationHistory, { role: 'user', content: text }, { role: 'assistant', content: clinicalReply }];
            updateMedicalProfile(req.uid, safeContextKey, fullTranscript);
        }

    } catch (err) {
        console.error("AI Triage error:", err.message);
        res.status(500).json({
            error: "AI service unavailable",
            detail: err.message,
            reply: "Sorry, I'm having trouble reaching the AI service right now. If your symptom is serious, please see a doctor directly."
        });
    }
});
