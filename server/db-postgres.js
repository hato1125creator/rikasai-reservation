const { Sequelize, DataTypes, Op } = require('sequelize');
const pg = require('pg'); // Vercelのバンドルエラー対策
const pgHstore = require('pg-hstore'); // 同上
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
    console.warn("WARNING: DATABASE_URL environment variable is not set. Database connection will fail.");
}

// 暗号化設定
const secret = process.env.JWT_SECRET || 'fallback_secret_key_for_development_encryption';
const key = crypto.scryptSync(secret, 'salt', 32);

function encrypt(text) {
    if (!text || typeof text !== 'string') return text;
    if (text.includes(':') && text.split(':').length === 2 && text.split(':')[0].length === 32) return text; // Already encrypted (iv:data)
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (e) {
        return text;
    }
}

function decrypt(text) {
    if (!text || typeof text !== 'string' || !text.includes(':')) return text;
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return text;
    }
}

function encryptDeterministic(text) {
    if (!text || typeof text !== 'string') return text;
    if (text.startsWith('det:')) return text; // Already encrypted
    try {
        const iv = crypto.scryptSync(secret, 'deterministic_iv', 16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return 'det:' + encrypted;
    } catch (e) {
        return text;
    }
}

function decryptDeterministic(text) {
    if (!text || typeof text !== 'string' || !text.startsWith('det:')) return text;
    try {
        const encryptedText = Buffer.from(text.substring(4), 'hex');
        const iv = crypto.scryptSync(secret, 'deterministic_iv', 16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return text;
    }
}

// Supabase (PostgreSQL) 接続設定
const sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectModule: pg, // 確実にVercel上でロードされるようにする
    protocol: 'postgres',
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false // 自己署名証明書などを許可するため（Render等でも必要になることが多い）
        }
    },
    logging: false // SQLログを無効化（開発時は console.log に変更してもOK）
});

// モデル定義 (db-local.js と完全互換のスキーマ)


const User = sequelize.define('User', {
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    role: {
        type: DataTypes.STRING,
        defaultValue: 'guest'
    }
});

const Student = sequelize.define('Student', {
    id: {
        type: DataTypes.STRING,
        primaryKey: true // db-local.js では hex string
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        get() {
            const rawValue = this.getDataValue('email');
            return decryptDeterministic(rawValue);
        },
        set(value) {
            this.setDataValue('email', encryptDeterministic(value));
        }
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        get() {
            const rawValue = this.getDataValue('name');
            return decrypt(rawValue);
        },
        set(value) {
            this.setDataValue('name', encrypt(value));
        }
    },
    otp: {
        type: DataTypes.STRING,
        allowNull: true
    },
    otp_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    max_guest_slots: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    grade_class: {
        type: DataTypes.STRING,
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('grade_class');
            return decrypt(rawValue);
        },
        set(value) {
            this.setDataValue('grade_class', encrypt(value));
        }
    },
    message_template: {
        type: DataTypes.TEXT,
        allowNull: true
    }
});

const GuestSlot = sequelize.define('GuestSlot', {
    id: {
        type: DataTypes.STRING,
        primaryKey: true
    },
    token: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    student_email: {
        type: DataTypes.STRING,
        allowNull: false,
        get() {
            const rawValue = this.getDataValue('student_email');
            return decryptDeterministic(rawValue);
        },
        set(value) {
            this.setDataValue('student_email', encryptDeterministic(value));
        }
    },
    student_name: {
        type: DataTypes.STRING,
        allowNull: false,
        get() {
            const rawValue = this.getDataValue('student_name');
            return decrypt(rawValue);
        },
        set(value) {
            this.setDataValue('student_name', encrypt(value));
        }
    },
    guest_name: {
        type: DataTypes.STRING,
        allowNull: false,
        get() {
            const rawValue = this.getDataValue('guest_name');
            return decrypt(rawValue);
        },
        set(value) {
            this.setDataValue('guest_name', encrypt(value));
        }
    },
    used: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    checked_in_at: {
        type: DataTypes.DATE, // db-local では ISO string
        allowNull: true
    }
});

// 検索時の where 句インターセプト用フック
const encryptWhere = (options) => {
    if (!options || !options.where) return;
    
    // emailの処理
    if (options.where.email) {
        if (typeof options.where.email === 'string') {
            options.where.email = encryptDeterministic(options.where.email);
        } else if (options.where.email[Op.in]) {
            options.where.email[Op.in] = options.where.email[Op.in].map(e => encryptDeterministic(e));
        }
    }
    
    // student_emailの処理
    if (options.where.student_email) {
        if (typeof options.where.student_email === 'string') {
            options.where.student_email = encryptDeterministic(options.where.student_email);
        } else if (options.where.student_email[Op.in]) {
            options.where.student_email[Op.in] = options.where.student_email[Op.in].map(e => encryptDeterministic(e));
        }
    }
};

['beforeFind', 'beforeCount', 'beforeUpdate', 'beforeDestroy'].forEach(hook => {
    Student.addHook(hook, encryptWhere);
    GuestSlot.addHook(hook, encryptWhere);
});

// Student に findOne と update メソッド以外の互換用メソッドが必要な場合はここに追加
Student.upsertOtp = async function(email, name, otp, otp_expires_at, grade_class) {
    let student = await Student.findOne({ where: { email } });
    if (student) {
        student.name = name;
        student.otp = otp;
        student.otp_expires_at = otp_expires_at;
        if (grade_class !== undefined) student.grade_class = grade_class;
        await student.save();
        return student;
    } else {
        const requireCrypto = require('crypto');
        const id = requireCrypto.randomBytes(8).toString('hex');
        student = await Student.create({
            id, email, name, otp, otp_expires_at, grade_class: grade_class || null
        });
        return student;
    }
};

module.exports = {
    sequelize,
    User,
    Student,
    GuestSlot,
    Op,
    encrypt,
    decrypt,
    encryptDeterministic,
    decryptDeterministic
};
