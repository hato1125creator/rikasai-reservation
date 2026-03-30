const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'database.json');

// Initialize DB if not exists
if (!fs.existsSync(DB_FILE)) {
    const initialData = {
        users: [],
        invite_codes: [],
        reservations: [],
        students: [],
        guest_slots: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// Migrate existing DB: add missing collections
(function migrateDb() {
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let changed = false;
        if (!data.students) { data.students = []; changed = true; }
        if (!data.guest_slots) { data.guest_slots = []; changed = true; }
        if (changed) fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('DB migration error:', e);
    }
})();

function readData() {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
}

function writeData(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Helper for filtering
function applyFilter(item, filter) {
    for (const key in filter) {
        if (filter[key] !== undefined && item[key] !== filter[key]) {
            return false;
        }
    }
    return true;
}

const db = {
    users: {
        async findOne({ where }) {
            const data = readData();
            return data.users.find(u => applyFilter(u, where)) || null;
        },
        async create(user) {
            const data = readData();
            user.id = data.users.length + 1;
            user.createdAt = new Date().toISOString();
            user.updatedAt = new Date().toISOString();
            data.users.push(user);
            writeData(data);
            return user;
        }
    },
    invite_codes: {
        async findOne({ where }) {
            const data = readData();
            const invites = data.invite_codes.filter(i => applyFilter(i, where));
            return invites.length > 0 ? { ...invites[0], save: async function () { await db.invite_codes.update(this, { where: { id: this.id } }); } } : null;
        },
        async findAll({ where, attributes }) {
            const data = readData();
            let result = data.invite_codes;
            if (where) {
                result = result.filter(i => applyFilter(i, where));
            }
            if (attributes) {
                // Simplified attribute picking
                return result.map(i => {
                    const picked = {};
                    attributes.forEach(attr => picked[attr] = i[attr]);
                    return picked;
                });
            }
            return result;
        },
        async bulkCreate(codes) {
            const data = readData();
            codes.forEach(c => {
                c.id = data.invite_codes.length + 1;
                c.createdAt = new Date().toISOString();
                c.updatedAt = new Date().toISOString();
                data.invite_codes.push(c);
            });
            writeData(data);
            return codes;
        },
        async update(values, { where }) {
            const data = readData();
            let count = 0;
            data.invite_codes.forEach(i => {
                if (applyFilter(i, where)) {
                    Object.assign(i, values);
                    i.updatedAt = new Date().toISOString();
                    count++;
                }
            });
            writeData(data);
            return [count];
        }
    },
    reservations: {
        async findByPk(id) {
            const data = readData();
            // ID can be string or number in JSON, handle loosely
            const res = data.reservations.find(r => r.id == id);
            if (!res) return null;
            if (!res.status) res.status = 'pending';
            return { ...res, update: async function (v) { await db.reservations.update(v, { where: { id: this.id } }); }, toJSON: () => res };
        },
        async findOne({ where, order }) {
            // Basic find one with simple filter
            const data = readData();
            let results = data.reservations.filter(r => applyFilter(r, where));

            if (order) {
                // minimal sort support for createdAt/updatedAt
                const [field, direction] = order[0];
                results.sort((a, b) => {
                    if (a[field] < b[field]) return direction === 'DESC' ? 1 : -1;
                    if (a[field] > b[field]) return direction === 'DESC' ? -1 : 1;
                    return 0;
                });
            }

            const res = results[0];
            if (!res) return null;
            if (!res.status) res.status = 'pending';
            return { ...res, update: async function (v) { await db.reservations.update(v, { where: { id: this.id } }); }, toJSON: () => res };
        },
        async findAll({ where, order } = {}) {
            const data = readData();
            let results = data.reservations;

            // Handle complex Op.or or Op.in manually if needed, or simple exact match
            // This is a naive implementation for the exact matches used in app.js
            // If the where clause contains symbols (Op.or), we need special handling.

            // NOTE: app.js uses Op.or for search. We need to handle that.

            if (where) {
                // Check if it's a simple object or has symbols
                // app.js search uses: { [Op.or]: ... }
                // We will handle specific known queries from app.js manually here or make applyFilter smarter?
                // Let's implement a custom filter mostly for 'status' or 'search'.

                // If 'status' is an array (Op.in equivalent logic)
                if (where.status && Array.isArray(where.status)) { // This handles checking strictly array matching if passed directly, 
                    // But Sequelize uses { status: { [Op.in]: [] } }
                    // We simplified app.js logic to pass simple objects if possible, but let's check.
                }

                results = results.filter(row => {
                    // Custom search logic for Op.or
                    const symbols = Object.getOwnPropertySymbols(where);
                    if (symbols.length > 0) {
                        for (const sym of symbols) {
                            if (sym.toString() === 'Symbol(or)') { // Op.or
                                const conditions = where[sym];
                                return conditions.some(cond => {
                                    // cond is like { name: { [Op.like]: ... } }
                                    // or { id: q }
                                    return Object.keys(cond).every(key => {
                                        const val = cond[key];
                                        // Handle Op.like
                                        if (typeof val === 'object' && val !== null) {
                                            const ops = Object.getOwnPropertySymbols(val);
                                            if (ops.length > 0 && ops[0].toString() === 'Symbol(like)') {
                                                const pattern = val[ops[0]].replace(/%/g, '');
                                                return String(row[key]).includes(pattern);
                                            }
                                        }
                                        return row[key] == val; // flexible equality
                                    });
                                });
                            }
                            if (sym.toString() === 'Symbol(in)') {
                                // Not used in top level, usually field level
                            }
                        }
                    }

                    // Field level logic
                    for (const key of Object.keys(where)) {
                        const val = where[key];
                        if (typeof val === 'object' && val !== null) {
                            const syms = Object.getOwnPropertySymbols(val);
                            if (syms.length > 0 && syms[0].toString() === 'Symbol(in)') {
                                // { status: { [Op.in]: [...] } }
                                if (!val[syms[0]].includes(row[key])) return false;
                            } else {
                                // unknown op
                            }
                        } else {
                            if (row[key] != val) return false;
                        }
                    }
                    return true;
                });
            }

            if (order) {
                const [field, direction] = order[0];
                results.sort((a, b) => {
                    const va = a[field] || '';
                    const vb = b[field] || '';
                    if (va < vb) return direction === 'DESC' ? 1 : -1;
                    if (va > vb) return direction === 'DESC' ? -1 : 1;
                    return 0;
                });
            }

            // Map to instances and ensure default status
            return results.map(r => {
                if (!r.status) r.status = 'pending';
                return { ...r, toJSON: () => r };
            });
        },
        async create(reservation) {
            const data = readData();
            reservation.status = reservation.status || 'pending';
            reservation.createdAt = new Date().toISOString();
            reservation.updatedAt = new Date().toISOString();
            // id is provided by app.js (random 6 digits)
            data.reservations.push(reservation);
            writeData(data);
            return reservation;
        },
        async update(values, { where }) {
            const data = readData();
            let count = 0;
            data.reservations.forEach(r => {
                if (r.id == where.id) { // Assume update by ID usually
                    Object.assign(r, values);
                    r.updatedAt = new Date().toISOString();
                    count++;
                }
            });
            writeData(data);
            return [count];
        },
        async destroy({ where }) {
            const data = readData();
            const initialLen = data.reservations.length;
            data.reservations = data.reservations.filter(r => r.id != where.id);
            writeData(data);
            return initialLen - data.reservations.length;
        },
        async count({ where } = {}) {
            const data = readData();
            if (!where) return data.reservations.length;
            return data.reservations.filter(r => applyFilter(r, where)).length;
        }
    },
    // Mock Sequelize object components
    fn: (fnName, col) => ({ fn: fnName, col }),
    col: (colName) => colName,
    transaction: async () => ({
        commit: async () => { }, // No-op for JSON file
        rollback: async () => { }
    })
};

// --- Students ---
db.students = {
    async findOne({ where }) {
        const data = readData();
        return data.students.find(s => applyFilter(s, where)) || null;
    },
    async findAll({ where } = {}) {
        const data = readData();
        let result = data.students;
        if (where) result = result.filter(s => applyFilter(s, where));
        return result;
    },
    async upsertOtp(email, name, otp, otp_expires_at) {
        const data = readData();
        const existing = data.students.find(s => s.email === email);
        if (existing) {
            // 既存アカウント: OTPと名前だけ更新（id・ゲスト枠は保持）
            existing.name = name;
            existing.otp = otp;
            existing.otp_expires_at = otp_expires_at;
            existing.updatedAt = new Date().toISOString();
            writeData(data);
            return existing;
        }
        // 新規アカウント作成
        const student = {
            id: require('crypto').randomBytes(8).toString('hex'),
            email, name, otp, otp_expires_at,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        data.students.push(student);
        writeData(data);
        return student;
    },
    async update(values, { where }) {
        const data = readData();
        let count = 0;
        data.students.forEach(s => {
            if (applyFilter(s, where)) {
                Object.assign(s, values);
                s.updatedAt = new Date().toISOString();
                count++;
            }
        });
        writeData(data);
        return [count];
    }
};

// --- Guest Slots ---
db.guest_slots = {
    async findOne({ where }) {
        const data = readData();
        return data.guest_slots.find(g => applyFilter(g, where)) || null;
    },
    async findAll({ where } = {}) {
        const data = readData();
        let result = data.guest_slots;
        if (where) result = result.filter(g => applyFilter(g, where));
        return result;
    },
    async create(slot) {
        const data = readData();
        slot.createdAt = new Date().toISOString();
        slot.updatedAt = new Date().toISOString();
        data.guest_slots.push(slot);
        writeData(data);
        return slot;
    },
    async update(values, { where }) {
        const data = readData();
        let count = 0;
        data.guest_slots.forEach(g => {
            if (applyFilter(g, where)) {
                Object.assign(g, values);
                g.updatedAt = new Date().toISOString();
                count++;
            }
        });
        writeData(data);
        return [count];
    },
    async count({ where } = {}) {
        const data = readData();
        if (!where) return data.guest_slots.length;
        return data.guest_slots.filter(g => applyFilter(g, where)).length;
    }
};

// Op mock
const Op = {
    or: Symbol('or'),
    like: Symbol('like'),
    in: Symbol('in'),
    ne: Symbol('ne')
};

module.exports = {
    sequelize: {
        sync: async () => console.log("JSON DB Synced"),
        transaction: async () => ({ commit: () => { }, rollback: () => { } }),
        fn: (fn, col) => ({ fn, col }),
        col: c => c
    },
    User: db.users,
    InviteCode: db.invite_codes,
    Reservation: db.reservations,
    Student: db.students,
    GuestSlot: db.guest_slots,
    Op
};
