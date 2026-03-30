const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'server/database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

console.log('Resetting used status for all invite codes...');
let count = 0;
db.invite_codes.forEach(code => {
    if (code.used) {
        code.used = false;
        code.updatedAt = new Date().toISOString();
        count++;
    }
});

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(`Reset ${count} codes to unused.`);
