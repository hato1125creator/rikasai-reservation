const bcrypt = require('bcryptjs');

async function generateHashes() {
    const adminPassword = 'rikasai123';
    const studentPassword = 'rikasai123';

    const hashedAdmin = await bcrypt.hash(adminPassword, 10);
    const hashedStudent = await bcrypt.hash(studentPassword, 10);

    console.log('Admin hash:', hashedAdmin);
    console.log('Student hash:', hashedStudent);
}

generateHashes();
