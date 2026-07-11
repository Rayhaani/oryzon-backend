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
        const token = await admin.auth().createCustomToken(username);
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
            'meta-llama/llama-4-scout-17b-16e-instruct',
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

// Sabuwar MedGemma 1.5 — ana gudanar da ita ta Dedicated Inference
// Endpoint (T4), BA ta hanyar $9/wata PRO ba. Bayan ka "deploy" ta a
// HF, sai ka saka URL ɗin endpoint ɗin nan a Render environment variables:
// MEDGEMMA_ENDPOINT_URL = https://xxxxxxxxxx.us-east-1.aws.endpoints.huggingface.cloud
const MEDGEMMA_ENDPOINT_URL = process.env.MEDGEMMA_ENDPOINT_URL;
const CLINICAL_MODEL = "google/medgemma-1.5-4b-it"; // don rikodi/logging kawai

// Karamin model — ana amfani da shi KAWAI don fassara (translation) idan
// harshen da aka zaba ba Turanci ba ne. Ba a horar da wannan (ko
// Llama-3.3-70B) musamman akan Hausa, don haka fassarar Hausa ba za a
// iya tabbatar da cikakkiyar daidaito ba tukuna — dole a gwada da
// masu magana da Hausa kafin a ba da tabbacin inganci ga users.
const TRANSLATION_MODEL = "meta-llama/Llama-3.2-3B-Instruct";

// ════════════════════════════════════════════════════════════
//  TEXT MODEL CHAIN — GPT-OSS 120B + Kimi K2 (dukkansu FREE akan
//  Groq). Maye gurbin llama-3.3-70b-versatile. Ana amfani da wannan
//  don DUKA free da Pro users idan tambaya rubutu ce ba tare da
//  hoto ko tsararrun bayanan asibiti ba — MedGemma an ajiye ta
//  KAWAI don hoto (X-ray, fata, nama) da bayanan tsari (EHR/FHIR/
//  lab reports), domin ita ce mafi kwarewa a wannan fanni.
// ════════════════════════════════════════════════════════════
const TEXT_MODEL_CHAIN = {
    simple: 'openai/gpt-oss-120b',              // default: tambaya gajarta/yau da kullum
    complex: 'moonshotai/kimi-k2-instruct-0905'  // dogon tarihi/tambaya mai sarkakiya
};

// Gano wane model a chain ɗin ya kamata a fara amfani da shi, bisa
// nau'in tambaya (kalmomin sarkakiya) da tsawon tarihin tattaunawa.
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

// Kira text-model chain: idan model na farko ya kasa (429/rate limit,
// ko duk GROQ_KEYS nasa sun ƙare), a juya zuwa model na biyu kai tsaye
// maimakon mai amfani ya samu kuskure.
async function callTextModelChain(messages, preferredModel) {
    const chain = preferredModel === TEXT_MODEL_CHAIN.complex
        ? [TEXT_MODEL_CHAIN.complex, TEXT_MODEL_CHAIN.simple]
        : [TEXT_MODEL_CHAIN.simple, TEXT_MODEL_CHAIN.complex];

    let lastError = null;
    for (const model of chain) {
        try {
            return await callGroqWithFailover(model, messages, 500, 0.3);
        } catch (err) {
            lastError = err.message;
            console.warn(`⚠️ Text model ${model} ya kasa, ana gwada na gaba... (${err.message})`);
            continue;
        }
    }
    throw new Error(`Dukkan text models sun kasa: ${lastError}`);
}

// Kira MedGemma 1.5 ta hanyar Dedicated Endpoint (Paid tier)
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

// Kira karamin model na fassara ta hanyar HF Router (ba dedicated endpoint ba, wannan yana kan free serverless)
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

// ════════════════════════════════════════════════════════════
//  MEDICATION REMINDERS — ajiya a Firebase (don push notifications)
//  da FAMILY PROFILES support (kowane profile na da meds dinsa)
// ════════════════════════════════════════════════════════════

app.get('/meds/:profileId', requireAuth, async (req, res) => {
    try {
        const db = admin.database();
        const snap = await db.ref(`users/${req.uid}/meds/${req.params.profileId}`).once('value');
        res.json({ success: true, meds: snap.val() || {} });
    } catch (err) {
        res.status(500).json({ error: err.message });
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

// Wannan endpoint din ana KIRAN SA TA WANI CRON JOB (misali Render Cron
// Job ko cron-job.org) KOWACE MINTI 1, domin ya duba wadanne magunguna
// suka kai lokacin da za a tunatar da user. Ba a bukatar user ya bude
// app din domin ya samu wannan tunatarwa — wannan shine ainihin "Push
// Reminder" na gaskiya (ba kawai in-app ba).
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

app.post('/ai-triage', requireAuth, async (req, res) => {
    try {
        const { text, image, structuredData, lang } = req.body;

        if (!text && !image && !structuredData) {
            return res.status(400).json({ error: "No text, image, or structured data provided." });
        }

        // ── Duba ko user ɗin Pro/Paid ne ──
        // Sabon, dedicated node don subscription status, ba ya taɓa
        // "customers"/"providers" da ke akwai — domin UID koyaushe
        // tabbatacce ne (ya fito daga Firebase Auth token kai-tsaye).
        const db = admin.database();
        const tierSnap = await db.ref(`subscriptions/${req.uid}/isPro`).once('value');
        const isPro = tierSnap.exists() && tierSnap.val() === true;

        const systemPrompt = "You are Nexus Intelligence, a careful medical triage assistant. You are NOT a doctor and must never give a final diagnosis. Assess the symptom described and clearly state: (1) whether this seems safe to self-manage at home, (2) practical self-care advice if safe, (3) whether the person should see a doctor and how urgently. Always end by reminding them this is not a diagnosis.";

        // MedGemma na bukatar Pro don DUKA hoto (X-ray, fata, nama) DA
        // tsararrun bayanan asibiti (EHR/FHIR/lab reports) — waɗannan su
        // ne fannonin da ta fi kwarewa a kai fiye da GPT-OSS/Kimi K2.
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

            // ── PAID: MedGemma 1.5 4B (multimodal — hoto + bayanan tsari) ──
            const userContent = image
                ? [
                    { type: "text", text: text || "Please look at this photo and tell me what you see." },
                    { type: "image_url", image_url: { url: image } }
                  ]
                : `${text || ''}\n\nStructured clinical data:\n${JSON.stringify(structuredData)}`;

            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
            ];
            clinicalReply = await callMedGemmaEndpoint(messages);

        } else {
            // ── RUBUTU NA YAU DA KULLUM (Free DA Pro duka): GPT-OSS 120B / Kimi K2 ──
            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: text }
            ];
            const preferredModel = classifyTextModel(text);
            clinicalReply = await callTextModelChain(messages, preferredModel);
        }

        // ── Fassara zuwa wani harshe (misali Hausa) idan aka bukaci ──
        let finalReply = clinicalReply;
        if (lang && lang !== 'en') {
            const translationMessages = [
                { role: "system", content: `Translate the following medical guidance into ${lang}, keeping it warm, clear, and accurate. Do not add or remove any medical information.` },
                { role: "user", content: clinicalReply }
            ];
            finalReply = await callHuggingFaceRouter(TRANSLATION_MODEL, translationMessages);
        }

        res.json({ reply: finalReply, tier: isPro ? 'pro' : 'free' });

    } catch (err) {
        console.error("AI Triage error:", err.message);
        res.status(500).json({
            error: "AI service unavailable",
            detail: err.message,
            reply: "Sorry, I'm having trouble reaching the AI service right now. If your symptom is serious, please see a doctor directly."
        });
    }
});
