require('dotenv').config();
const { sequelize, GuestSlot } = require('./server/db-postgres');
const crypto = require('crypto');

(async () => {
    try {
        console.log('Deleting test guest...');
        await GuestSlot.destroy({ where: { student_email: 'test@biblos.ac.jp' } });
        console.log('Deleted.');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        process.exit();
    }
})();
