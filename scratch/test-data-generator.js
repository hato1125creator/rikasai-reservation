const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { sequelize, Student, GuestSlot } = require('../server/db-postgres');
const crypto = require('crypto');

async function generateTestData() {
    try {
        console.log('Connecting to database...');
        await sequelize.authenticate();
        console.log('Connection established.');

        const studentCount = 800;
        const classes = ['1-1', '1-2', '1-3', '1-4', '1-E', '2-A', '2-B', '2-C', '2-D', '2-E', '3-A', '3-B', '3-C', '3-D', '3-E'];
        
        console.log(`Generating ${studentCount} students and their guest slots...`);

        const studentsToInsert = [];
        const slotsToInsert = [];

        for (let i = 1; i <= studentCount; i++) {
            const studentId = crypto.randomBytes(8).toString('hex');
            const name = `テスト生徒 ${i}`;
            const email = `test_student_${i}@biblos.ac.jp`;
            const gradeClass = classes[i % classes.length];

            studentsToInsert.push({
                id: studentId,
                email: email,
                name: name,
                grade_class: gradeClass,
                max_guest_slots: 3
            });

            // 各生徒にテスト用の1スロットを作成
            const slotId = crypto.randomBytes(8).toString('hex');
            const token = crypto.randomBytes(16).toString('hex');
            slotsToInsert.push({
                id: slotId,
                token: token,
                student_email: email,
                student_name: name,
                guest_name: `${name} (本人テスト用)`,
                used: false
            });

            if (i % 100 === 0) console.log(`${i} students prepared...`);
        }

        console.log('Inserting into database (Bulk)...');
        
        // トランザクションで一気に処理
        await sequelize.transaction(async (t) => {
            await Student.bulkCreate(studentsToInsert, { transaction: t, ignoreDuplicates: true });
            await GuestSlot.bulkCreate(slotsToInsert, { transaction: t, ignoreDuplicates: true });
        });

        console.log('Successfully generated test data!');
        console.log('-----------------------------------');
        console.log(`- Students: ${studentsToInsert.length}`);
        console.log(`- Guest Slots (Test): ${slotsToInsert.length}`);
        console.log('-----------------------------------');
        console.log('Scan the following URL format for testing:');
        console.log(`${process.env.FRONTEND_URL || 'http://localhost:3007'}/guest/verify?token=[TOKEN]`);
        
    } catch (error) {
        console.error('Error generating test data:', error);
    } finally {
        await sequelize.close();
    }
}

generateTestData();
