
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const multer = require('multer');
const fs = require('fs');
const csvParser = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3007;

// 環境変数の検証
if (!process.env.JWT_SECRET) {
    console.error("Please set JWT_SECRET in your environment variables.");
    process.exit(1);
}
if (!process.env.EMAIL_USER_1 || !process.env.EMAIL_PASSWORD_1) {
    console.warn("EMAIL_USER_1 or EMAIL_PASSWORD_1 not set. Email functionality may be limited.");
}

// CORS設定の厳格化
const corsOptions = {
    origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : 'http://localhost:3007', // 本番環境と開発環境でオリジンを分ける
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// セキュリティヘッダー (Helmet)
app.use(helmet({
    contentSecurityPolicy: false, // 静的ファイル・CDN利用のため無効化
    crossOriginEmbedderPolicy: false
}));

// レート制限 (全体)
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15分
    max: 100, // 15分あたり100リクエストまで
    message: { message: 'リクエスト数が制限を超えました。しばらくしてから再度お試しください。' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', generalLimiter);

// ログイン用レート制限 (ブルートフォース対策)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // 15分あたり5回まで
    message: { message: 'ログイン試行回数が上限に達しました。15分後に再度お試しください。' },
    standardHeaders: true,
    legacyHeaders: false
});

// OTP用レート制限 (1メールアドレスあたり5分に1回)
const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    message: { message: 'OTP送信回数が上限に達しました。5分後に再度お試しください。' },
    standardHeaders: true,
    legacyHeaders: false
});

// XSS対策ユーティリティ
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 静的ファイルの提供
app.use('/guest', express.static(path.join(__dirname, 'server/public/guest')));
app.use('/student', express.static(path.join(__dirname, 'server/public/student')));
app.use(express.static(path.join(__dirname, 'server/public')));

// DB initialization (PostgreSQL)
const { sequelize, User, InviteCode, Reservation, Student, GuestSlot, Op } = require('./server/db-postgres');

// データベース同期 (自動でテーブルを作成)
sequelize.sync()
    .then(async () => {
        console.log('Database synced (PostgreSQL)');
        // 初期ユーザーの作成 (開発用、本番では別途管理)
        const adminUser = await User.findOne({ where: { username: 'admin' } });
        if (!adminUser) {
            // パスワードハッシュ化は残すが、JSON DBに保存
            const hashedPassword = await bcrypt.hash('rikasai123', 10);
            await User.create({ username: 'admin', password: hashedPassword, role: 'admin' });
            console.log('Admin user created');
        }
    })
    .catch(err => console.error('Database sync error:', err));

// 注意: エラーハンドリングミドルウェアはファイル末尾に配置

// 認証ミドルウェア
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401); // トークンがない場合は認証失敗

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); // トークンが無効な場合はアクセス拒否
        req.user = user;
        next();
    });
};

// 認可ミドルウェア
const authorizeRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'アクセス権がありません。' });
        }
        next();
    };
};

// メールアカウント設定
const emailAccounts = {
    account1: {
        user: process.env.EMAIL_USER_1,
        pass: process.env.EMAIL_PASSWORD_1,
        active: true
    },
    account2: {
        user: process.env.EMAIL_USER_2,
        pass: process.env.EMAIL_PASSWORD_2,
        active: true
    },
    // 必要に応じて追加
};

let currentAccountIndex = 0;
const accountKeys = Object.keys(emailAccounts).filter(key =>
    emailAccounts[key].user && emailAccounts[key].pass
);

function getNextActiveAccount() {
    let attempts = 0;
    const accountCount = accountKeys.length;

    while (attempts < accountCount) {
        currentAccountIndex = (currentAccountIndex + 1) % accountCount;
        const nextAccountKey = accountKeys[currentAccountIndex];

        if (emailAccounts[nextAccountKey].active) {
            return nextAccountKey;
        }
        attempts++;
    }
    throw new Error('No active email accounts available');
}

function createTransporter(accountKey) {
    const account = emailAccounts[accountKey];
    if (!account || !account.active) {
        throw new Error(`Account ${accountKey} is not available`);
    }
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: account.user,
            pass: account.pass
        }
    });
}

async function sendEmailWithFailover(mailOptions, initialAccountKey = accountKeys[currentAccountIndex]) {
    let currentAccountKey = initialAccountKey;
    let attempts = 0;
    const maxAttempts = accountKeys.length;

    while (attempts < maxAttempts) {
        try {
            const transporter = createTransporter(currentAccountKey);
            mailOptions.from = emailAccounts[currentAccountKey].user;
            const result = await transporter.sendMail(mailOptions);
            console.log(`メール送信成功 (${currentAccountKey}): ${result.messageId}`);
            return result;
        } catch (error) {
            console.error(`メール送信エラー (${currentAccountKey}):`, error);
            if (error.message.includes('quota') ||
                error.message.includes('rate limit') ||
                error.message.includes('450') ||
                error.message.includes('550') ||
                error.message.includes('421')) {

                console.log(`アカウント${currentAccountKey}の制限に達しました。次のアカウントに切り替えます。`);
                emailAccounts[currentAccountKey].active = false;
                setTimeout(() => {
                    emailAccounts[currentAccountKey].active = true;
                    console.log(`アカウント${currentAccountKey}を再有効化しました`);
                }, 24 * 60 * 60 * 1000);

                try {
                    currentAccountKey = getNextActiveAccount();
                    console.log(`次のアカウント${currentAccountKey}に切り替えました`);
                } catch (e) {
                    throw new Error('すべてのメールアカウントが制限に達しました。後でもう一度お試しください。');
                }
            } else {
                throw error;
            }
        }
        attempts++;
    }
    throw new Error('最大試行回数に達しました。メールを送信できませんでした。');
}

// QRコード生成関数
async function generateQRCodeDataURL(qrData) {
    return await QRCode.toDataURL(qrData);
}

// 招待コード正規化関数（全角半角、スペース、大文字小文字の違いを吸収）
const normalizeCode = (code) => {
    if (!code) return '';
    return code
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[−ー—‐]/g, '-')
        .replace(/[\s\u200B]+/g, '')
        .toLowerCase();
};

// ルート定義

// ログインエンドポイント (レート制限付き)
app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ where: { username } });

        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '1h' } // トークンの有効期限を設定
            );
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, message: '無効な資格情報' });
        }
    } catch (error) {
        next(error);
    }
});

// 招待コード検証エンドポイント
app.post('/api/validate-invite-code', [body('inviteCode').isString().notEmpty()], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { inviteCode } = req.body;

        // 正規化して使用可能なコードを検索
        const normalizedInput = normalizeCode(inviteCode);
        const allCodes = await InviteCode.findAll({ where: { used: false } });
        const invite = allCodes.find(c => normalizeCode(c.code) === normalizedInput);

        if (!invite) {
            return res.json({ valid: false });
        }

        // 検証のみ行い、使用済みにはしない。DBの正確なコードを返す。
        res.json({ valid: true, normalizedCode: invite.code });
    } catch (error) {
        next(error);
    }
});


// 予約エンドポイント
app.post('/api/reserve', [
    body('name').isString().notEmpty().withMessage('Name is required'),
    body('contact').isEmail().withMessage('Valid email is required'),
    body('relationship').isString().notEmpty().withMessage('Relationship is required'),
    body('invite-code').isString().notEmpty().withMessage('Invite code is required'),
], async (req, res, next) => {
    const transaction = await sequelize.transaction(); // トランザクション開始
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            await transaction.rollback();
            return res.status(400).json({ errors: errors.array() });
        }

        const { name, contact, relationship, 'invite-code': inviteCode } = req.body;

        const normalizedInput = normalizeCode(inviteCode);
        const allCodes = await InviteCode.findAll({ where: { used: false } });
        const invite = allCodes.find(c => normalizeCode(c.code) === normalizedInput);

        if (!invite) {
            await transaction.rollback();
            return res.status(400).json({ message: '無効な招待コード、または既に使用済みです。' });
        }
        
        const exactInviteCode = invite.code;

        let reservationId;
        let isUnique = false;
        while (!isUnique) {
            const min = 100000;
            const max = 999999;
            reservationId = Math.floor(Math.random() * (max - min + 1)) + min;
            const existingReservation = await Reservation.findByPk(reservationId, { transaction });
            if (!existingReservation) {
                isUnique = true;
            }
        }

        const reservation = await Reservation.create({
            id: reservationId,
            name, contact, relationship, invite_code: exactInviteCode
        }, { transaction });

        await InviteCode.update({ used: true }, { where: { code: exactInviteCode }, transaction });

        const qrData = `${process.env.FRONTEND_URL || `http://localhost:${port}`}/guest/verify?id=${reservationId}`;
        const qrCodeDataURL = await generateQRCodeDataURL(qrData);

        // 先にトランザクションをコミット（DBの整合性を確保）
        await transaction.commit();

        // メール送信（トランザクション外で実行 — 失敗しても予約は保持される）
        const safeName = escapeHtml(name);
        const safeContact = escapeHtml(contact);
        const safeRelationship = escapeHtml(relationship);
        const safeInviteCode = escapeHtml(exactInviteCode);

        const mailOptions = {
            to: contact,
            subject: '梨花祭2025予約完了のお知らせ',
            html: `
                <p>${safeName} 様</p>
                <p>梨花祭2025へのご予約が完了しました。以下の詳細をご確認ください。</p>
                <ul>
                    <li>予約者名: ${safeName}</li>
                    <li>メールアドレス: ${safeContact}</li>
                    <li>人数: ${safeRelationship}</li>
                    <li>招待コード: ${safeInviteCode}</li>
                </ul>
                <p>ご参加をお待ちしております。</p>
                <p>—————————————————</p>
                <p>下記に入場用QRコードを添付いたします。<br>
                当日受付にて、こちらのQRコードをご提示ください。</p>
                <br>
                <img src="cid:entry_qrcode" alt="入場用QRコード" style="width: 200px; height: 200px; border: 1px solid #ddd;"/>
                <br><br>
                <p>開催日時：2025年6月◯日（土）9時00分～14時00分</p>
                <p>開催場所：千葉英和高等学校</p>
                <p>住所：〒276-0028 千葉県八千代市村上709-1</p>
                <p>—————————————————</p>
            `,
            attachments: [{
                filename: 'qrcode.png',
                content: qrCodeDataURL.split(';base64,').pop(),
                encoding: 'base64',
                cid: 'entry_qrcode'
            }]
        };

        try {
            await sendEmailWithFailover(mailOptions);
        } catch (emailError) {
            console.error('メール送信に失敗しましたが、予約は完了しています:', emailError.message);
        }

        res.json({ message: 'Reservation completed', id: reservationId });
    } catch (error) {
        // コミット前のエラーの場合のみロールバック
        try { await transaction.rollback(); } catch (rbErr) { /* already committed */ }
        next(error);
    }
});

// 予約ステータス更新エンドポイント (管理者のみ)
app.post('/api/reservations/:id', authenticateToken, authorizeRole(['admin']), [
    body('status').isString().isIn(['pending', 'checked-in', 'cancelled']).withMessage('Invalid status'),
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { status } = req.body;
        const { id } = req.params;

        const reservation = await Reservation.findByPk(id);
        if (reservation) {
            if (reservation.status !== 'cancelled' && status === 'cancelled') {
                await InviteCode.update({ used: false }, { where: { code: reservation.invite_code } });
            } else if (reservation.status === 'cancelled' && status !== 'cancelled') {
                await InviteCode.update({ used: true }, { where: { code: reservation.invite_code } });
            }
        }

        const [affectedRows] = await Reservation.update({ status }, { where: { id } });

        if (affectedRows > 0) {
            res.json({ message: 'ステータスが更新されました' });
        } else {
            res.status(404).json({ message: '指定された予約が見つかりません' });
        }
    } catch (error) {
        next(error);
    }
});

// 予約履歴取得エンドポイント (管理者のみ)
app.get('/api/reservations/history', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const reservations = await Reservation.findAll({
            where: { status: { [Op.in]: ['checked-in', 'cancelled'] } },
            order: [['updatedAt', 'DESC']] // Sequelizeではupdated_atはupdatedAtとなる
        });
        res.json(reservations);
    } catch (error) {
        next(error);
    }
});

// 予約データ取得エンドポイント (管理者のみ)
app.get('/api/reservations', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { status } = req.query;
        const whereClause = status ? { status } : {};
        const reservations = await Reservation.findAll({ where: whereClause });

        // QRコードをBase64でエンコードして返す
        const reservationsWithQr = await Promise.all(reservations.map(async (r) => {
            const qrData = `${process.env.FRONTEND_URL || `http://localhost:${port}`}/guest/verify?id=${r.id}`;
            const qrCodeDataURL = await generateQRCodeDataURL(qrData);
            return { ...r.toJSON(), qr_code_data_url: qrCodeDataURL };
        }));

        res.json(reservationsWithQr);
    } catch (error) {
        next(error);
    }
});

// 共通関数: ユニークコード生成
function generateUniqueCode(prefix1, prefix2, name, type, existingSet) {
    let code;
    do {
        const randomPart = crypto.randomBytes(4).toString('hex'); // 8文字の16進数
        code = `${prefix1}-${prefix2}-${name}-${type}-${randomPart}`;
    } while (existingSet.has(code));
    existingSet.add(code);
    return code;
}

// 招待コードテンプレートダウンロード (管理者のみ)
app.get('/api/download-template', authenticateToken, authorizeRole(['admin']), (req, res) => {
    const csvContent = '名前,連絡先,備考\n山田 太郎,email@example.com,保護者\n鈴木 次郎,,ゲスト';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=invite_code_template.csv');
    res.send(csvContent);
});

// 招待コード個別生成 (管理者のみ)
app.post('/api/generate-individual-invite-code', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { name, prefixPart1, prefixPart2 } = req.body;

        if (!name || !prefixPart1 || !prefixPart2) {
            return res.status(400).json({ error: '名前とクラス情報は必須です。' });
        }

        const codesToInsert = [];
        const existingCodesSet = new Set();

        // 既存コード取得
        const existingDbCodes = await InviteCode.findAll({ attributes: ['code'] });
        existingDbCodes.forEach(ic => existingCodesSet.add(ic.code));

        // 生成
        const guardianCode = generateUniqueCode(prefixPart1, prefixPart2, name, '保護者', existingCodesSet);
        codesToInsert.push({ code: guardianCode, used: false, name });

        for (let i = 0; i < 3; i++) {
            const guestCode = generateUniqueCode(prefixPart1, prefixPart2, name, 'ゲスト', existingCodesSet);
            codesToInsert.push({ code: guestCode, used: false, name });
        }

        await InviteCode.bulkCreate(codesToInsert);

        res.json({ message: '招待コードが生成されました', codes: codesToInsert });
    } catch (error) {
        next(error);
    }
});

// 招待コード一括生成 (管理者のみ)
app.post(
    '/api/generate-invite-codes',
    authenticateToken,
    authorizeRole(['admin']),
    multer({ dest: 'uploads/' }).single('csvFile'),
    async (req, res, next) => {
        if (!req.file) {
            return res.status(400).json({ error: 'CSVファイルが必要です。' });
        }

        const { prefixPart1, prefixPart2 } = req.body;
        if (!prefixPart1 || !prefixPart2) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'コードプレフィックスが必要です。' });
        }

        const filePath = req.file.path;
        const codesToInsert = [];
        const existingCodesSet = new Set();

        const transaction = await sequelize.transaction();

        try {
            // CSV 読み込み
            const names = [];
            await new Promise((resolve, reject) => {
                fs.createReadStream(filePath)
                    .pipe(csvParser())
                    .on('data', (row) => {
                        // カラム名の揺らぎに対応
                        const name = row['名前'] || row['name'] || row['Name'] || Object.values(row)[0];
                        if (name) names.push(name.trim());
                    })
                    .on('end', resolve)
                    .on('error', reject);
            });

            // 既存コードをセットに追加
            const existingDbCodes = await InviteCode.findAll({ attributes: ['code'], transaction });
            existingDbCodes.forEach(ic => existingCodesSet.add(ic.code));

            // コード生成
            for (const name of names) {
                // 保護者コード
                const guardianCode = generateUniqueCode(prefixPart1, prefixPart2, name, '保護者', existingCodesSet);
                codesToInsert.push({ code: guardianCode, used: false, name });

                // ゲストコード 3つ
                for (let i = 0; i < 3; i++) {
                    const guestCode = generateUniqueCode(prefixPart1, prefixPart2, name, 'ゲスト', existingCodesSet);
                    codesToInsert.push({ code: guestCode, used: false, name });
                }
            }

            // DB にバルク登録
            await InviteCode.bulkCreate(codesToInsert, { transaction });
            await transaction.commit();

            // CSV 出力
            const tmpFileName = `generated_invite_codes_${Date.now()}.csv`;
            const csvWriter = createObjectCsvWriter({
                path: tmpFileName,
                header: [
                    { id: 'code', title: 'Code' },
                    { id: 'name', title: 'Name' } // 名前も出力
                ]
            });
            await csvWriter.writeRecords(codesToInsert);

            // ダウンロード
            res.download(tmpFileName, () => {
                fs.unlinkSync(tmpFileName);
                fs.unlinkSync(filePath);
            });

        } catch (error) {
            await transaction.rollback();
            fs.unlinkSync(filePath);
            next(error);
        }
    }
);

// 検索エンドポイント (管理者のみ)
app.get('/api/search', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { q } = req.query;

        if (!q || q.trim() === '') {
            return res.status(400).json({ error: '検索クエリが必要です。' });
        }

        const searchResults = await Reservation.findAll({
            where: {
                [Op.or]: [
                    { name: { [Op.like]: `%${q}%` } },
                    { contact: { [Op.like]: `%${q}%` } },
                    { id: q }, // IDは完全一致で検索
                    { invite_code: { [Op.like]: `%${q}%` } }
                ]
            }
        });

        res.json(searchResults);
    } catch (error) {
        next(error);
    }
});

// レポートエンドポイント (管理者のみ)
// レポートエンドポイント (管理者のみ)
app.get('/api/report', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const reservations = await Reservation.findAll();

        const totalReservations = reservations.length;
        const checkedInCount = reservations.filter(r => r.status === 'checked-in').length;
        const cancelledCount = reservations.filter(r => r.status === 'cancelled').length;
        const pendingCount = reservations.filter(r => r.status === 'pending').length;

        // 時間帯別入場者数
        const hourlyDataMap = {};
        const dailyDataMap = {};

        reservations.forEach(r => {
            if (r.status === 'checked-in') {
                const date = new Date(r.updatedAt);
                const hour = date.getHours();
                const day = date.toISOString().split('T')[0];

                hourlyDataMap[hour] = (hourlyDataMap[hour] || 0) + 1;
                dailyDataMap[day] = (dailyDataMap[day] || 0) + 1;
            }
        });

        const hourlyData = Object.keys(hourlyDataMap).map(h => ({ hour: parseInt(h), count: hourlyDataMap[h] })).sort((a, b) => a.hour - b.hour);
        const dailyData = Object.keys(dailyDataMap).map(d => ({ date: d, count: dailyDataMap[d] })).sort((a, b) => a.date.localeCompare(b.date));

        // ピーク時間帯
        let peakTime = 'データなし';
        if (hourlyData.length > 0) {
            const maxCountEntry = hourlyData.reduce((prev, current) => (prev.count > current.count) ? prev : current);
            peakTime = `${maxCountEntry.hour}:00 - ${maxCountEntry.hour + 1}:00`;
        }

        // 最新入場
        const checkedInReservations = reservations.filter(r => r.status === 'checked-in');
        const latestCheckinReservation = checkedInReservations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
        const latestCheckin = latestCheckinReservation ? latestCheckinReservation.updatedAt : null;

        res.json({
            total_reservations: totalReservations,
            checked_in_count: checkedInCount,
            cancelled_count: cancelledCount,
            pending_count: pendingCount,
            hourly_data: hourlyData,
            daily_data: dailyData,
            peak_time: peakTime,
            latest_checkin: latestCheckin,
        });
    } catch (error) {
        next(error);
    }
});

// QRコード検証エンドポイント (認証必須) - token方式・id方式両対応
app.post('/api/verify', authenticateToken, async (req, res, next) => {
    try {
        const { qrData } = req.body;
        let token = null;
        let reservationId = null;

        try {
            const url = new URL(qrData);
            token = url.searchParams.get('token');
            reservationId = url.searchParams.get('id');
        } catch (e) {
            return res.status(400).json({ message: '無効なQRコードデータです。' });
        }

        // ===== 新方式: guest_slot token =====
        if (token) {
            const slot = await GuestSlot.findOne({ where: { token } });

            if (!slot) {
                return res.status(404).json({ message: '招待リンクが見つかりません。' });
            }

            if (slot.used) {
                return res.json({
                    message: '既に入場済みです。',
                    slot: {
                        guest_name: slot.guest_name,
                        student_name: slot.student_name,
                        status: 'checked-in'
                    }
                });
            }

            await GuestSlot.update({ used: true, checked_in_at: new Date().toISOString() }, { where: { token } });

            return res.json({
                message: '入場が承認されました。',
                slot: {
                    guest_name: slot.guest_name,
                    student_name: slot.student_name,
                    status: 'checked-in'
                }
            });
        }

        // ===== 旧方式: reservation id（後方互換）=====
        if (reservationId) {
            const reservation = await Reservation.findByPk(reservationId);

            if (!reservation) {
                return res.status(404).json({ message: '予約が見つかりません。' });
            }

            if (reservation.status === 'checked-in') {
                return res.json({ message: '既に入場済みです。', reservation });
            }

            await reservation.update({ status: 'checked-in' });
            return res.json({ message: '入場が承認されました。', reservation });
        }

        return res.status(400).json({ message: 'QRコードに有効なトークンまたはIDが含まれていません。' });

    } catch (error) {
        next(error);
    }
});

// 管理者: guest_slots一覧
app.get('/api/admin/guest-slots', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const slots = await GuestSlot.findAll();
        res.json({ slots });
    } catch (error) {
        next(error);
    }
});

// 管理者: guest_slot 手動チェックイン
app.post('/api/admin/guest-slots/:id/check-in', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const slot = await GuestSlot.findOne({ where: { id } });
        if (!slot) return res.status(404).json({ message: 'スロットが見つかりません。' });
        await GuestSlot.update({ used: true, checked_in_at: new Date().toISOString() }, { where: { id } });
        res.json({ message: 'チェックイン完了' });
    } catch (error) {
        next(error);
    }
});


app.delete('/api/reservations/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { id } = req.params;

        const reservation = await Reservation.findByPk(id);
        if (reservation && reservation.status !== 'cancelled') {
            await InviteCode.update({ used: false }, { where: { code: reservation.invite_code } });
        }

        const deletedRows = await Reservation.destroy({ where: { id } });

        if (deletedRows > 0) {
            res.json({ message: '予約が削除されました。' });
        } else {
            res.status(404).json({ message: '指定された予約が見つかりません。' });
        }
    } catch (error) {
        next(error);
    }
});

// ===== 拡張管理者API =====

// 生徒一覧（招待スロット数付き）
app.get('/api/admin/students', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const students = await Student.findAll();
        const slots = await GuestSlot.findAll();
        const result = students.map(s => {
            const mySlots = slots.filter(sl => sl.student_email === s.email);
            return {
                id: s.id,
                name: s.name,
                email: s.email,
                createdAt: s.createdAt,
                totalSlots: mySlots.length,
                usedSlots: mySlots.filter(sl => sl.used).length,
                max_slots: s.max_guest_slots || null
            };
        });
        res.json({ students: result });
    } catch (error) { next(error); }
});

// 生徒情報編集（名前、個別枠数）
app.put('/api/admin/students/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { name, max_guest_slots } = req.body;
        const student = await Student.findOne({ where: { id: req.params.id } });
        if (!student) return res.status(404).json({ message: '生徒が見つかりません。' });
        
        const updates = {};
        if (name) updates.name = name;
        if (max_guest_slots !== undefined) updates.max_guest_slots = max_guest_slots === '' ? null : parseInt(max_guest_slots, 10);
        
        await Student.update(updates, { where: { id: req.params.id } });
        res.json({ message: '生徒情報を更新しました。' });
    } catch (error) { next(error); }
});

// 生徒削除（関連スロットごと削除）
app.delete('/api/admin/students/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const student = await Student.findOne({ where: { id: req.params.id } });
        if (!student) return res.status(404).json({ message: '生徒が見つかりません。' });
        await GuestSlot.destroy({ where: { student_email: student.email } });
        await Student.destroy({ where: { id: req.params.id } });
        res.json({ message: `${student.name} のアカウントと招待スロットを削除しました。` });
    } catch (error) { next(error); }
});

// ゲストスロット削除
app.delete('/api/admin/guest-slots/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const deleted = await GuestSlot.destroy({ where: { id: req.params.id } });
        if (deleted > 0) res.json({ message: 'スロットを削除しました。' });
        else res.status(404).json({ message: 'スロットが見つかりません。' });
    } catch (error) { next(error); }
});

// チェックイン取り消し
app.post('/api/admin/guest-slots/:id/uncheck-in', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const slot = await GuestSlot.findOne({ where: { id: req.params.id } });
        if (!slot) return res.status(404).json({ message: 'スロットが見つかりません。' });
        await GuestSlot.update({ used: false, checked_in_at: null }, { where: { id: req.params.id } });
        res.json({ message: 'チェックインを取り消しました。' });
    } catch (error) { next(error); }
});

// システム設定取得
app.get('/api/admin/settings', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const allSlots = await GuestSlot.findAll();
        res.json({
            guestSlotsPerStudent: parseInt(process.env.GUEST_SLOTS_PER_STUDENT || '3'),
            systemName: process.env.SYSTEM_NAME || '梨花祭2025',
            totalStudents: (await Student.findAll()).length,
            totalSlots: allSlots.length,
            checkedInSlots: allSlots.filter(s => s.used).length
        });
    } catch (error) { next(error); }
});

// 管理者パスワード変更
app.post('/api/admin/change-password', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword)
            return res.status(400).json({ message: '現在のパスワードと新しいパスワードを入力してください。' });
        if (newPassword.length < 8)
            return res.status(400).json({ message: 'パスワードは8文字以上で設定してください。' });
        const admin = await User.findOne({ where: { username: req.user.username } });
        if (!admin) return res.status(404).json({ message: '管理者が見つかりません。' });
        const isValid = await bcrypt.compare(currentPassword, admin.password);
        if (!isValid) return res.status(401).json({ message: '現在のパスワードが正しくありません。' });
        const hashed = await bcrypt.hash(newPassword, 10);
        await User.update({ password: hashed }, { where: { username: req.user.username } });
        res.json({ message: 'パスワードを変更しました。' });
    } catch (error) { next(error); }
});

// CSVエクスポート（ゲストスロット全件）
app.get('/api/admin/export/csv', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const slots = await GuestSlot.findAll();
        const rows = [['ゲスト名', '招待した生徒', '生徒メール', '入場済み', 'チェックイン日時', '作成日時']];
        slots.forEach(s => {
            rows.push([
                s.guest_name, s.student_name || '', s.student_email || '',
                s.used ? '済み' : '未', s.checked_in_at || '', s.createdAt
            ]);
        });
        const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="guest_list.csv"');
        res.send('\uFEFF' + csv); // UTF-8 BOM for Excel
    } catch (error) { next(error); }
});

// レポートデータエクスポートエンドポイント (管理者のみ)
app.get('/api/export-report', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const reservations = await Reservation.findAll({ raw: true });

        const csvWriter = createCsvWriter({
            path: 'report_data.csv',
            header: [
                { id: 'id', title: 'ID' },
                { id: 'name', title: '名前' },
                { id: 'contact', title: '連絡先' },
                { id: 'relationship', title: '関係' },
                { id: 'invite_code', title: '招待コード' },
                { id: 'status', title: 'ステータス' },
                { id: 'createdAt', title: '予約日時' },
                { id: 'updatedAt', title: '更新日時' },
            ]
        });

        await csvWriter.writeRecords(reservations);

        res.download('report_data.csv', () => {
            fs.unlinkSync('report_data.csv');
        });

    } catch (error) {
        next(error);
    }
});

// ゲスト用 予約ステータス確認エンドポイント (認証不要・読み取り専用)
app.get('/api/reservation-status/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const reservation = await Reservation.findByPk(id);

        if (!reservation) {
            return res.status(404).json({ found: false, message: '予約が見つかりません。' });
        }

        // プライバシー保護: 名前を部分マスキング
        const fullName = reservation.name || '';
        let maskedName = fullName;
        if (fullName.length > 1) {
            maskedName = fullName[0] + '＊'.repeat(fullName.length - 1);
        }

        res.json({
            found: true,
            id: reservation.id,
            name: maskedName,
            status: reservation.status,
            createdAt: reservation.createdAt
        });
    } catch (error) {
        next(error);
    }
});

// ルート定義 (重複を解消)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/guest/index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/admin/index.html'));
});

app.get('/guest/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/guest/verify.html'));
});

app.get('/student', (req, res) => {
    res.sendFile(path.join(__dirname, 'server/public/student/index.html'));
});

// ===== 生徒本人確認 (OTP) =====

const ALLOWED_DOMAIN = '@biblos.ac.jp';
const GUEST_SLOTS_PER_STUDENT = parseInt(process.env.GUEST_SLOTS_PER_STUDENT || '3', 10);
const STUDENT_JWT_SECRET = process.env.JWT_SECRET + '_student';

// ログイン用OTP送信（既存アカウント、メールのみ）
app.post('/api/student/login-otp', otpLimiter, [
    body('email').isEmail().withMessage('有効なメールアドレスを入力してください')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: errors.array()[0].msg });
        }

        const normalizedEmail = req.body.email.trim().toLowerCase();

        if (!normalizedEmail.endsWith(ALLOWED_DOMAIN)) {
            return res.status(403).json({ message: `学校配布のメールアドレス（${ALLOWED_DOMAIN}）のみ使用できます。` });
        }

        const student = await Student.findOne({ where: { email: normalizedEmail } });
        if (!student) {
            return res.status(404).json({ message: 'このメールアドレスで登録されたアカウントが見つかりません。初回は「新規登録」から登録してください。' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await Student.upsertOtp(normalizedEmail, student.name, otp, otpExpiresAt);

        const mailOptions = {
            to: normalizedEmail,
            subject: '梨花祭2025 ログイン認証コード',
            html: `
                <p>${escapeHtml(student.name)} さん</p>
                <p>以下の認証コードを入力してください。</p>
                <p style="font-size: 2rem; font-weight: bold; letter-spacing: 0.3em;">${otp}</p>
                <p>このコードは<strong>10分間</strong>有効です。</p>
                <p>このメールに心当たりがない場合は無視してください。</p>
            `
        };

        try {
            await sendEmailWithFailover(mailOptions);
        } catch (emailError) {
            console.error('ログインOTPメール送信エラー:', emailError.message);
            return res.status(500).json({ message: 'メールの送信に失敗しました。しばらくしてから再度お試しください。' });
        }

        res.json({ message: 'OTPを送信しました。メールをご確認ください。', name: student.name });
    } catch (error) {
        next(error);
    }
});

// OTP送信
app.post('/api/student/request-otp', otpLimiter, [
    body('email').isEmail().withMessage('有効なメールアドレスを入力してください'),
    body('name').isString().trim().notEmpty().withMessage('名前は必須です')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: errors.array()[0].msg });
        }

        const { email, name } = req.body;
        const normalizedEmail = email.trim().toLowerCase();

        // ドメイン制限
        if (!normalizedEmail.endsWith(ALLOWED_DOMAIN)) {
            return res.status(403).json({ message: `学校配布のメールアドレス（${ALLOWED_DOMAIN}）のみ使用できます。` });
        }

        // OTP生成 (6桁)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10分後

        await Student.upsertOtp(normalizedEmail, escapeHtml(name.trim()), otp, otpExpiresAt);

        // メール送信
        const mailOptions = {
            to: normalizedEmail,
            subject: '梨花祭2025 生徒認証コード',
            html: `
                <p>${escapeHtml(name.trim())} さん</p>
                <p>以下の認証コードを入力してください。</p>
                <p style="font-size: 2rem; font-weight: bold; letter-spacing: 0.3em;">${otp}</p>
                <p>このコードは<strong>10分間</strong>有効です。</p>
                <p>このメールに心当たりがない場合は無視してください。</p>
            `
        };

        try {
            await sendEmailWithFailover(mailOptions);
        } catch (emailError) {
            console.error('OTPメール送信エラー:', emailError.message);
            return res.status(500).json({ message: 'メールの送信に失敗しました。しばらくしてから再度お試しください。' });
        }

        res.json({ message: 'OTPを送信しました。メールをご確認ください。' });
    } catch (error) {
        next(error);
    }
});

// OTP検証・JWT発行
app.post('/api/student/verify-otp', loginLimiter, [
    body('email').isEmail(),
    body('otp').isString().isLength({ min: 6, max: 6 }).withMessage('OTPは6桁の数字です')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: errors.array()[0].msg });
        }

        const { email, otp } = req.body;
        const normalizedEmail = email.trim().toLowerCase();

        const student = await Student.findOne({ where: { email: normalizedEmail } });

        if (!student || student.otp !== otp.trim()) {
            return res.status(401).json({ message: '認証コードが正しくありません。' });
        }

        if (new Date() > new Date(student.otp_expires_at)) {
            return res.status(401).json({ message: '認証コードが期限切れです。再度送信してください。' });
        }

        // OTPを無効化
        await Student.update(
            { otp: null, otp_expires_at: null },
            { where: { email: normalizedEmail } }
        );

        const token = jwt.sign(
            { id: student.id, email: student.email, name: student.name, role: 'student' },
            STUDENT_JWT_SECRET,
            { expiresIn: '4h' }
        );

        res.json({ success: true, token, name: student.name });
    } catch (error) {
        next(error);
    }
});

// 生徒JWT検証ミドルウェア
const authenticateStudent = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, STUDENT_JWT_SECRET, (err, student) => {
        if (err) return res.sendStatus(403);
        req.student = student;
        next();
    });
};

// ダッシュボード: 自分のスロット一覧（個人情報なし）
app.get('/api/student/dashboard', authenticateStudent, async (req, res, next) => {
    try {
        const student = await Student.findOne({ where: { email: req.student.email } });
        const maxSlots = student && student.max_guest_slots !== null ? student.max_guest_slots : GUEST_SLOTS_PER_STUDENT;

        const slots = await GuestSlot.findAll({ where: { student_email: req.student.email } });
        // ゲスト個人情報は返さない: token, used, guest_name のみ
        const safeSlots = slots.map(s => ({
            id: s.id,
            token: s.token,
            guest_name: s.guest_name,
            used: s.used,
            createdAt: s.createdAt
        }));
        res.json({
            name: req.student.name,
            slots: safeSlots,
            maxSlots: maxSlots
        });
    } catch (error) {

        next(error);
    }
});

// 招待リンク生成（ゲスト名を生徒が入力）
app.post('/api/student/generate-links', authenticateStudent, [
    body('guest_name').isString().trim().notEmpty().withMessage('ゲストの名前は必須です')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: errors.array()[0].msg });
        }

        // 既存スロット数と上限チェック
        const student = await Student.findOne({ where: { email: req.student.email } });
        const maxSlots = student && student.max_guest_slots !== null ? student.max_guest_slots : GUEST_SLOTS_PER_STUDENT;
        
        const existingCount = await GuestSlot.count({ where: { student_email: req.student.email } });
        if (existingCount >= maxSlots) {
            return res.status(400).json({
                message: `招待枠の上限（${maxSlots}枠）に達しています。`
            });
        }

        const token = crypto.randomBytes(24).toString('hex');
        const slot = await GuestSlot.create({
            id: crypto.randomBytes(8).toString('hex'),
            token,
            student_email: req.student.email,
            student_name: req.student.name,
            guest_name: escapeHtml(req.body.guest_name.trim()),
            used: false
        });

        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${port}`;
        const inviteUrl = `${baseUrl}/?token=${token}`;

        res.json({
            id: slot.id,
            token: slot.token,
            guest_name: slot.guest_name,
            used: slot.used,
            invite_url: inviteUrl
        });
    } catch (error) {
        next(error);
    }
});

// ===== ゲスト入場QR =====

// トークン検証 → QRデータ返却（ゲスト側の入力なし）
app.get('/api/guest-entry/:token', async (req, res, next) => {
    try {
        const { token } = req.params;

        if (!token || token.length < 10) {
            return res.status(400).json({ message: '無効なトークンです。' });
        }

        const slot = await GuestSlot.findOne({ where: { token } });

        if (!slot) {
            return res.status(404).json({ message: 'この招待リンクは無効です。' });
        }

        if (slot.used) {
            return res.status(410).json({ message: 'この招待リンクは既に使用済みです。' });
        }

        // QRデータ生成
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:${port}`;
        const qrPayload = `${baseUrl}/guest/verify?token=${token}`;
        const qrCodeDataURL = await generateQRCodeDataURL(qrPayload);

        res.json({
            valid: true,
            guest_name: slot.guest_name,
            student_name: slot.student_name,
            qr_code: qrCodeDataURL,
            qr_payload: qrPayload
        });
    } catch (error) {
        next(error);
    }
});

// 共通エラーハンドリングミドルウェア (すべてのルート定義の後に配置)
app.use((err, req, res, next) => {
    console.error(`[${new Date().toISOString()}] Unhandled Error:`, err.stack || err.message);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({ message: 'サーバー内部エラーが発生しました。' });
});

// サーバー起動
app.listen(port, () => {
    console.log(`Server started on http://localhost:${port}/`);
});
