const { Sequelize, DataTypes, Op } = require('sequelize');
const pg = require('pg'); // Vercelのバンドルエラー対策
const pgHstore = require('pg-hstore'); // 同上

if (!process.env.DATABASE_URL) {
    console.warn("WARNING: DATABASE_URL environment variable is not set. Database connection will fail.");
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

const InviteCode = sequelize.define('InviteCode', {
    code: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    used: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: true // 生成時に名前がない場合もあるため
    }
});

const Reservation = sequelize.define('Reservation', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true, // app.js 側で乱数を指定しているため autoIncrement は不要
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    contact: {
        type: DataTypes.STRING,
        allowNull: false
    },
    relationship: {
        type: DataTypes.STRING,
        allowNull: false
    },
    invite_code: {
        type: DataTypes.STRING,
        allowNull: false
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'pending' // pending, checked-in, cancelled
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
        unique: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    otp: {
        type: DataTypes.STRING,
        allowNull: true
    },
    otp_expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

const GuestSlot = sequelize.define('GuestSlot', {
    token: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    student_email: {
        type: DataTypes.STRING,
        allowNull: false
    },
    student_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    guest_name: {
        type: DataTypes.STRING,
        allowNull: false
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

// Student に findOne と update メソッド以外の互換用メソッドが必要な場合はここに追加
Student.upsertOtp = async function(email, name, otp, otp_expires_at) {
    let student = await Student.findOne({ where: { email } });
    if (student) {
        student.name = name;
        student.otp = otp;
        student.otp_expires_at = otp_expires_at;
        await student.save();
        return student;
    } else {
        const requireCrypto = require('crypto');
        const id = requireCrypto.randomBytes(8).toString('hex');
        student = await Student.create({
            id, email, name, otp, otp_expires_at
        });
        return student;
    }
};

module.exports = {
    sequelize,
    User,
    InviteCode,
    Reservation,
    Student,
    GuestSlot,
    Op
};
