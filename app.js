
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
app.set('trust proxy', 1); // Vercelなどのリバースプロキシで正しいクライアントIPを取得するため
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
    windowMs: 15 * 60 * 1000,
    max: 2000, 
    message: { message: 'リクエストが多すぎます。しばらくしてから再度お試しください。' }
});
app.use('/api/', generalLimiter);

// ログイン用レート制限
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100, 
    message: { message: 'ログイン試行回数が上限に達しました。しばらくしてから再度お試しください。' },
    standardHeaders: true,
    legacyHeaders: false
});

// OTP用レート制限
const otpLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 50,
    message: { message: 'OTP送信回数が上限に達しました。しばらくしてから再度お試しください。' },
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
const { sequelize, User, Student, GuestSlot, Op } = require('./server/db-postgres');

// テスト用グローバル設定
let isFixedOtpMode = false;
const TEST_FIXED_OTP = '123456';

// データベース同期 (自動でテーブルを作成/変更)
sequelize.sync({ alter: true })
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

// ダッシュボード等で使用する共通関数
// (以前の招待コード生成関数などは削除済み)

// ログインエンドポイント (レート制限付き)
app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ where: { username } });

        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role },
                process.env.JWT_SECRET,
                { expiresIn: '4h' }
            );
            res.json({ success: true, token });
        } else {
            res.status(401).json({ success: false, message: '無効な資格情報' });
        }
    } catch (error) {
        next(error);
    }
});

// レポートエンドポイント (管理者のみ) — GuestSlot ベース
app.get('/api/report', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const slots = await GuestSlot.findAll();
        const students = await Student.findAll();

        const totalSlots = slots.length;
        const checkedInCount = slots.filter(s => s.used).length;
        const unusedCount = slots.filter(s => !s.used).length;
        const totalStudents = students.length;

        // 時間帯別・日別入場者数 (checked_in_at ベース)
        const hourlyDataMap = {};
        const dailyDataMap = {};

        slots.forEach(s => {
            if (s.used && s.checked_in_at) {
                const date = new Date(s.checked_in_at);
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
        const checkedInSlots = slots.filter(s => s.used && s.checked_in_at);
        const latestSlot = checkedInSlots.sort((a, b) => new Date(b.checked_in_at) - new Date(a.checked_in_at))[0];
        const latestCheckin = latestSlot ? latestSlot.checked_in_at : null;

        // 生徒別統計
        const studentStatsMap = {};
        slots.forEach(s => {
            const key = s.student_email || 'unknown';
            if (!studentStatsMap[key]) {
                studentStatsMap[key] = { name: s.student_name || key, total: 0, checkedIn: 0 };
            }
            studentStatsMap[key].total++;
            if (s.used) studentStatsMap[key].checkedIn++;
        });
        const studentStats = Object.values(studentStatsMap).sort((a, b) => b.total - a.total);

        // クラス別統計
        const classStatsMap = {};
        const studentClassMap = {};
        students.forEach(s => {
            if (s.grade_class) studentClassMap[s.email] = s.grade_class;
        });
        slots.forEach(s => {
            const gc = studentClassMap[s.student_email] || '未設定';
            if (!classStatsMap[gc]) classStatsMap[gc] = { grade_class: gc, total: 0, checkedIn: 0, students: new Set() };
            classStatsMap[gc].total++;
            if (s.used) classStatsMap[gc].checkedIn++;
            classStatsMap[gc].students.add(s.student_email);
        });
        const classStats = Object.values(classStatsMap).map(c => ({
            grade_class: c.grade_class, total: c.total, checkedIn: c.checkedIn, studentCount: c.students.size
        })).sort((a, b) => a.grade_class.localeCompare(b.grade_class, 'ja'));

        res.json({
            total_slots: totalSlots,
            checked_in_count: checkedInCount,
            unused_count: unusedCount,
            total_students: totalStudents,
            hourly_data: hourlyData,
            daily_data: dailyData,
            peak_time: peakTime,
            latest_checkin: latestCheckin,
            student_stats: studentStats,
            class_stats: classStats,
        });
    } catch (error) {
        next(error);
    }
});

// QRコード検証エンドポイント (認証必須)
app.post('/api/verify', authenticateToken, async (req, res, next) => {
    try {
        const { qrData } = req.body;
        let token = null;

        try {
            const url = new URL(qrData);
            token = url.searchParams.get('token');
        } catch (e) {
            return res.status(400).json({ message: '無効なQRコードデータです。' });
        }

        if (!token) {
            return res.status(400).json({ message: 'QRコードに有効なトークンが含まれていません。' });
        }

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
    } catch (error) {
        next(error);
    }
});

// 管理者: guest_slots一覧 (reception, scannerも閲覧可)
app.get('/api/admin/guest-slots', authenticateToken, authorizeRole(['admin', 'reception', 'scanner']), async (req, res, next) => {
    try {
        const slots = await GuestSlot.findAll({ raw: true });
        const students = await Student.findAll({ raw: true });
        const classMap = {};
        students.forEach(s => { if (s.grade_class) classMap[s.email] = s.grade_class; });
        
        const slotsWithClass = slots.map(s => ({
            ...s,
            grade_class: classMap[s.student_email] || null
        }));
        res.json({ slots: slotsWithClass });
    } catch (error) {
        next(error);
    }
});

// 管理者: guest_slot 手動チェックイン (reception, scannerも操作可)
app.post('/api/admin/guest-slots/:id/check-in', authenticateToken, authorizeRole(['admin', 'reception', 'scanner']), async (req, res, next) => {
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


// (以前の予約削除エンドポイントなどは削除済み)

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
                grade_class: s.grade_class || null,
                createdAt: s.createdAt,
                totalSlots: mySlots.length,
                usedSlots: mySlots.filter(sl => sl.used).length,
                max_slots: s.max_guest_slots || null,
                slots: mySlots.map(sl => ({
                    id: sl.id,
                    guest_name: sl.guest_name,
                    used: sl.used,
                    checked_in_at: sl.checked_in_at,
                    createdAt: sl.createdAt,
                    token: sl.token
                }))
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
        if (req.body.grade_class !== undefined) updates.grade_class = req.body.grade_class || null;
        
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

// 管理者によるゲスト強制追加
app.post('/api/admin/students/:id/guest-slots', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { guest_name } = req.body;
        if (!guest_name || guest_name.trim() === '') {
            return res.status(400).json({ message: '名前を入力してください。' });
        }

        const student = await Student.findOne({ where: { id: req.params.id } });
        if (!student) return res.status(404).json({ message: '生徒が見つかりません。' });

        const crypto = require('crypto');
        const token = crypto.randomBytes(24).toString('hex');
        const slot = await GuestSlot.create({
            id: crypto.randomBytes(8).toString('hex'),
            token,
            student_email: student.email,
            student_name: student.name,
            guest_name: guest_name.trim(), // assuming sanitization is done elsewhere or we don't strictly require escapeHtml since it's admin
            used: false
        });

        res.json({ message: 'ゲストを追加しました。', slot });
    } catch (error) { next(error); }
});

// 管理者によるゲスト名修正
app.put('/api/admin/guest-slots/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { guest_name } = req.body;
        if (!guest_name || guest_name.trim() === '') {
            return res.status(400).json({ message: '名前を入力してください。' });
        }

        const slot = await GuestSlot.findOne({ where: { id: req.params.id } });
        if (!slot) return res.status(404).json({ message: '指定された招待枠が見つかりません。' });

        await GuestSlot.update({ guest_name: guest_name.trim() }, { where: { id: req.params.id } });
        res.json({ message: 'ゲスト名を更新しました。' });
    } catch (error) { next(error); }
});

// チェックイン取り消し (reception も操作可)
app.post('/api/admin/guest-slots/:id/uncheck-in', authenticateToken, authorizeRole(['admin', 'reception']), async (req, res, next) => {
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

// ====== アカウント管理 (admin専用) ======
app.get('/api/admin/accounts', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const users = await User.findAll({ attributes: ['id', 'username', 'role', 'createdAt'] });
        res.json({ accounts: users });
    } catch (error) { next(error); }
});

app.post('/api/admin/accounts', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) return res.status(400).json({ message: '入力が不足しています。' });
        
        const existing = await User.findOne({ where: { username } });
        if (existing) return res.status(400).json({ message: 'そのユーザー名は既に使用されています。' });

        const hashed = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashed, role });
        res.json({ message: 'アカウントを作成しました。' });
    } catch (error) { next(error); }
});

app.delete('/api/admin/accounts/:id', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { id } = req.params;
        const user = await User.findByPk(id);
        if (!user) return res.status(404).json({ message: 'アカウントが見つかりません。' });
        if (user.username === req.user.username) {
            return res.status(400).json({ message: '自分自身のアカウントは削除できません。' });
        }
        await User.destroy({ where: { id } });
        res.json({ message: 'アカウントを削除しました。' });
    } catch (error) { next(error); }
});

// CSVエクスポート（ゲストスロット全件）
app.get('/api/admin/export/csv', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const slots = await GuestSlot.findAll();
        const students = await Student.findAll();
        const classMap = {};
        students.forEach(s => { classMap[s.email] = s.grade_class || ''; });

        const rows = [['ゲスト名', '招待した生徒', '学年クラス', '生徒メール', '入場済み', 'チェックイン日時', '作成日時']];
        slots.forEach(s => {
            rows.push([
                s.guest_name, s.student_name || '', classMap[s.student_email] || '', s.student_email || '',
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

        const reportPath = require('path').join(require('os').tmpdir(), 'report_data.csv');
        const csvWriter = createCsvWriter({
            path: reportPath,
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

        res.download(reportPath, 'report_data.csv', () => {
            if (require('fs').existsSync(reportPath)) {
                require('fs').unlinkSync(reportPath);
            }
        });

    } catch (error) {
        next(error);
    }
});

// ===== テスト支援機能 API (管理者のみ) =====


// データ削除
app.post('/api/admin/test/clear', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { mode } = req.body; // "test_only" or "all"
        
        if (mode === 'all') {
            // 全消去
            await GuestSlot.destroy({ where: {}, truncate: true, cascade: true });
            await Student.destroy({ where: {}, truncate: true, cascade: true });
            await Reservation.destroy({ where: {}, truncate: true, cascade: true });
            await InviteCode.destroy({ where: {}, truncate: true, cascade: true });
            res.json({ message: 'データベースの全データを消去し、リセットしました。' });
        } else {
            // テストデータのみ削除
            const testStudents = await Student.findAll({ where: { name: { [Op.like]: 'テスト生徒%' } } });
            const testEmails = testStudents.map(s => s.email);
            
            await GuestSlot.destroy({ where: { student_email: { [Op.in]: testEmails } } });
            await Student.destroy({ where: { email: { [Op.in]: testEmails } } });
            
            res.json({ message: 'テストデータを消去しました。' });
        }
    } catch (error) { next(error); }
});

// 固定OTPモードの切り替え
app.post('/api/admin/test/toggle-otp', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { enabled } = req.body;
        isFixedOtpMode = !!enabled;
        res.json({ 
            enabled: isFixedOtpMode, 
            message: isFixedOtpMode ? "テストモードを有効にしました。全生徒が「123456」でログイン可能です。" : "テストモードを無効にしました（通常運用）。"
        });
    } catch (error) { next(error); }
});

// モード状態の取得
app.get('/api/admin/test/status', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    res.json({ isFixedOtpMode });
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

        const isTestAccount = normalizedEmail.startsWith('test_student_');
        const skipEmail = isFixedOtpMode || isTestAccount;

        if (skipEmail) {
            console.log(`[TEST MODE] Skip sending login OTP email to: ${normalizedEmail}. Use code: ${otp}`);
        } else {
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
        }

        const successMsg = skipEmail 
            ? '【テストモード】認証コード 123456 でログインしてください。' 
            : 'OTPを送信しました。メールをご確認ください。';
        res.json({ message: successMsg, name: student.name });
    } catch (error) {
        next(error);
    }
});

// OTP送信
app.post('/api/student/request-otp', otpLimiter, [
    body('email').isEmail().withMessage('有効なメールアドレスを入力してください'),
    body('name').isString().trim().notEmpty().withMessage('名前は必須です'),
    body('grade_class').isString().trim().notEmpty().withMessage('学年クラスは必須です')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ message: errors.array()[0].msg });
        }

        const { email, name, grade_class } = req.body;
        const normalizedEmail = email.trim().toLowerCase();

        // ドメイン制限
        if (!normalizedEmail.endsWith(ALLOWED_DOMAIN)) {
            return res.status(403).json({ message: `学校配布のメールアドレス（${ALLOWED_DOMAIN}）のみ使用できます。` });
        }

        // OTP生成 (6桁)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10分後

        await Student.upsertOtp(normalizedEmail, escapeHtml(name.trim()), otp, otpExpiresAt, escapeHtml(grade_class.trim()));

        const isTestAccount = normalizedEmail.startsWith('test_student_');
        const skipEmail = isFixedOtpMode || isTestAccount;

        if (skipEmail) {
            console.log(`[TEST MODE] Skip sending Student Registration OTP email to: ${normalizedEmail}. Use code: ${otp}`);
        } else {
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
        }

        const successMsg = skipEmail 
            ? '【テストモード】認証コード 123456 で認証してください。' 
            : 'OTPを送信しました。メールをご確認ください。';
        res.json({ message: successMsg });
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

        // テストモード（全体）またはテスト用アカウントの判定
        const isTestAccount = normalizedEmail.startsWith('test_student_');
        const effectiveOtp = (isFixedOtpMode || isTestAccount) ? TEST_FIXED_OTP : null;

        const student = await Student.findOne({ where: { email: normalizedEmail } });

        // OTP検証 (テストモード中は固定値、それ以外はDBの値)
        const isValid = effectiveOtp ? (otp.trim() === effectiveOtp) : (student && student.otp === otp.trim());

        if (!student || !isValid) {
            return res.status(401).json({ message: '認証コードが正しくありません。' });
        }

        // 期限チェック (テストモード・テストアカウントは期限無視)
        if (!effectiveOtp && new Date() > new Date(student.otp_expires_at)) {
            return res.status(401).json({ message: '認証コードが期限切れです。再度送信してください。' });
        }

        // OTPを無効化 (テストモード・テストアカウント以外)
        if (!effectiveOtp) {
            await Student.update(
                { otp: null, otp_expires_at: null },
                { where: { email: normalizedEmail } }
            );
        }

        const token = jwt.sign(
            { id: student.id, email: student.email, name: student.name, grade_class: student.grade_class || null, role: 'student' },
            STUDENT_JWT_SECRET,
            { expiresIn: '4h' }
        );

        res.json({ success: true, token, name: student.name, grade_class: student.grade_class || null });
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
            grade_class: student ? student.grade_class || null : null,
            message_template: student ? student.message_template || null : null,
            slots: safeSlots,
            maxSlots: maxSlots
        });
    } catch (error) {

        next(error);
    }
});

// 招待メッセージテンプレートの更新
app.put('/api/student/message-template', authenticateStudent, [
    body('message_template').isString().withMessage('テンプレートは文字列で指定してください')
], async (req, res, next) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });

        const { message_template } = req.body;
        await Student.update(
            { message_template },
            { where: { email: req.student.email } }
        );
        res.json({ message: 'メッセージテンプレートを更新しました。' });
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

// 招待リンクの名前変更
app.put('/api/student/guest-slots/:id', authenticateStudent, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { guest_name } = req.body;

        if (!guest_name || guest_name.trim() === '') {
            return res.status(400).json({ message: '名前を入力してください。' });
        }

        // 当日判定 (環境変数でカンマ区切りの日付指定を対応)
        const festivalDatesStr = process.env.FESTIVAL_DATES || '2025-07-17,2025-07-18';
        const festivalDates = festivalDatesStr.split(',').map(d => d.trim());
        
        // 日本時間での今日の日付を取得(YYYY-MM-DD形式にするためフォーマット調整)
        const todayStr = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-');
        
        if (festivalDates.includes(todayStr)) {
            return res.status(403).json({ message: '当日は名前の変更ができません。' });
        }

        const slot = await GuestSlot.findOne({ where: { id, student_email: req.student.email } });
        
        if (!slot) {
            return res.status(404).json({ message: '指定された招待枠が見つかりません。' });
        }

        if (slot.used) {
            return res.status(400).json({ message: '既に使用済みの招待枠は変更できません。' });
        }

        await GuestSlot.update({ guest_name: escapeHtml(guest_name.trim()) }, { where: { id } });

        res.json({ message: '名前を更新しました。' });
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

// ===== 実験・テスト支援機能 (管理者) =====

// テストステータス取得
app.get('/api/admin/test/status', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    res.json({ isFixedOtpMode });
});

// 全体テストモード（固定OTP）の切り替え
app.post('/api/admin/test/toggle-otp', authenticateToken, authorizeRole(['admin']), async (req, res) => {
    const { enabled } = req.body;
    isFixedOtpMode = !!enabled;
    res.json({ 
        success: true, 
        enabled: isFixedOtpMode, 
        message: isFixedOtpMode ? 'テストモード（固定OTP: 123456）を有効にしました。' : 'テストモードを無効にしました。' 
    });
});

// テストデータ生成 (クラス指定対応)
app.post('/api/admin/test/generate', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { count, classes } = req.body; // classes: [{ gradeClass: '1-1', count: 40 }, ...]
        let generatedTotal = 0;
        
        const studentsToInsert = [];
        const slotsToInsert = [];
        const fixedOtp = '123456';
        const farFuture = new Date('2099-12-31').toISOString();
        
        if (classes && Array.isArray(classes)) {
            // クラス指定がある場合
            for (const item of classes) {
                for (let i = 1; i <= item.count; i++) {
                    const studentIndex = generatedTotal + i;
                    const email = `test_student_${studentIndex}@biblos.ac.jp`;
                    const name = `テスト生徒 ${studentIndex}`;
                    const gradeClass = item.gradeClass;
                    const studentId = require('crypto').randomBytes(8).toString('hex');

                    studentsToInsert.push({
                        id: studentId,
                        email,
                        name,
                        grade_class: gradeClass,
                        otp: fixedOtp,
                        otp_expires_at: farFuture,
                        max_guest_slots: 3
                    });

                    const slotId = require('crypto').randomBytes(8).toString('hex');
                    const token = require('crypto').randomBytes(16).toString('hex');
                    slotsToInsert.push({
                        id: slotId,
                        token,
                        student_email: email,
                        student_name: name,
                        guest_name: `${name} (本人テスト用)`,
                        used: false
                    });
                }
                generatedTotal += item.count;
            }
        } else {
            // 単純な人数指定の場合
            const totalToGen = parseInt(count) || 100;
            const defaultClasses = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4', '2-5', '3-1', '3-2', '3-3', '3-4', '3-5'];
            for (let i = 1; i <= totalToGen; i++) {
                const email = `test_student_${i}@biblos.ac.jp`;
                const name = `テスト生徒 ${i}`;
                const gradeClass = defaultClasses[i % defaultClasses.length];
                const studentId = require('crypto').randomBytes(8).toString('hex');

                studentsToInsert.push({
                    id: studentId,
                    email,
                    name,
                    grade_class: gradeClass,
                    otp: fixedOtp,
                    otp_expires_at: farFuture,
                    max_guest_slots: 3
                });

                const slotId = require('crypto').randomBytes(8).toString('hex');
                const token = require('crypto').randomBytes(16).toString('hex');
                slotsToInsert.push({
                    id: slotId,
                    token,
                    student_email: email,
                    student_name: name,
                    guest_name: `${name} (本人テスト用)`,
                    used: false
                });
            }
            generatedTotal = totalToGen;
        }

        await sequelize.transaction(async (t) => {
            // Postgresで Upsert を実現するために updateOnDuplicate を使用 (emailがUNIQUEキーである前提)
            await Student.bulkCreate(studentsToInsert, { 
                transaction: t, 
                updateOnDuplicate: ['name', 'grade_class', 'otp', 'otp_expires_at', 'max_guest_slots'] 
            });
            await GuestSlot.bulkCreate(slotsToInsert, { 
                transaction: t, 
                ignoreDuplicates: true 
            });
        });

        res.json({ success: true, message: `${generatedTotal}名のテストデータを生成しました。認証コードは「${fixedOtp}」で固定されています。` });
    } catch (error) { next(error); }
});

// テストデータ削除
app.post('/api/admin/test/clear', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const { mode } = req.body;
        if (mode === 'all') {
            // 全削除 (管理者以外)
            await GuestSlot.destroy({ where: {} });
            await Student.destroy({ where: {} });
            return res.json({ message: '管理アカウント以外の全データを削除しました。' });
        } else {
            // テスト生徒のみ削除
            const testStudents = await Student.findAll({ where: { email: { [Op.like]: 'test_student_%' } } });
            const emails = testStudents.map(s => s.email);
            await GuestSlot.destroy({ where: { student_email: emails } });
            await Student.destroy({ where: { email: emails } });
            return res.json({ message: 'テストデータに関連する生徒とスロットを削除しました。' });
        }
    } catch (error) {
        next(error);
    }
});

// 配布用名簿データ取得
app.get('/api/admin/student-distribution-data', authenticateToken, authorizeRole(['admin']), async (req, res, next) => {
    try {
        const students = await Student.findAll({ order: [['grade_class', 'ASC'], ['name', 'ASC']] });
        
        // クラスごとにグループ化
        const grouped = {};
        students.forEach(s => {
            const gc = s.grade_class || '未設定';
            if (!grouped[gc]) grouped[gc] = [];
            grouped[gc].push({
                name: s.name,
                email: s.email,
                otp: '123456' // テスト用固定
            });
        });

        res.json({ groups: grouped, baseUrl: process.env.FRONTEND_URL || `http://localhost:${port}` });
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

// サーバー起動 (ローカル実行時のみ)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server started on http://localhost:${port}/`);
    });
}

// Vercel等のサーバーレス環境用にアプリをエクスポート
module.exports = app;
