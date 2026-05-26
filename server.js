const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const s3 = new AWS.S3({
    accessKeyId: process.env.STORJ_ACCESS_KEY,
    secretAccessKey: process.env.STORJ_SECRET_KEY,
    endpoint: 'https://gateway.storjshare.io',
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
    region: 'us-east-1'
});

const BUCKET = 'oryzon media';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }
});

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

        // Generate presigned URL - 1 year
        const url = s3.getSignedUrl('getObject', {
            Bucket: BUCKET,
            Key: fileName,
            Expires: 31536000
        });

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

app.get('/', (req, res) => res.json({ status: 'Oryzon Media Server yana aiki!' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server yana gudana a port ${PORT}`));
