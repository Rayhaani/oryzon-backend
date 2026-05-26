const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Storj S3 Configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.STORJ_ACCESS_KEY,
    secretAccessKey: process.env.STORJ_SECRET_KEY,
    endpoint: process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io',
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
    region: 'us-east-1'
});

const BUCKET = 'oryzon-media';

// Multer - memory storage (ba file ba, memory kawai)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// ============================================================
// UPLOAD ENDPOINT - Profile/Cover/Post media
// ============================================================
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Babu file' });

        const { type, username } = req.body; // type: 'profile' | 'cover' | 'post'
        const ext = path.extname(req.file.originalname) || 
                    (req.file.mimetype.includes('video') ? '.mp4' : '.jpg');
        const fileName = `${type}/${username}_${Date.now()}${ext}`;

        const params = {
            Bucket: BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read'
        };

        const result = await s3.upload(params).promise();
        
        // Public URL
        const publicUrl = `${process.env.STORJ_ENDPOINT}/${BUCKET}/${fileName}`;
        
        res.json({ 
            success: true, 
            url: publicUrl,
            key: fileName
        });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// DELETE ENDPOINT - Goge tsohuwar hoto
// ============================================================
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

// Health check
app.get('/', (req, res) => res.json({ status: 'Oryzon Media Server yana aiki!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server yana gudana a port ${PORT}`));
  
