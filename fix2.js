const fs = require('fs');
let content = fs.readFileSync('app.js', 'utf8');

const target1 = `    try {
        const students = await Student.findAll();
        const slots = await GuestSlot.findAll();
        const result = students.map(s => {
            const mySlots = slots.filter(sl => sl.student_email === s.email);`;

const replacement1 = `    try {
        const studentsRaw = await Student.findAll({ raw: true });
        const slotsRaw = await GuestSlot.findAll({ raw: true });
        const result = studentsRaw.map(s => {
            const mySlots = slotsRaw.filter(sl => sl.student_email === s.email);`;

content = content.replace(target1, replacement1);

const target2 = `            return {
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
                    checked_in_at: sl.checked_in_at
                }))
            };`;

const replacement2 = `            return {
                id: s.id,
                name: decrypt(s.name),
                email: decryptDeterministic(s.email),
                grade_class: decrypt(s.grade_class) || null,
                createdAt: s.createdAt,
                totalSlots: mySlots.length,
                usedSlots: mySlots.filter(sl => sl.used).length,
                max_slots: s.max_guest_slots || null,
                slots: mySlots.map(sl => ({
                    id: sl.id,
                    guest_name: decrypt(sl.guest_name),
                    used: sl.used,
                    checked_in_at: sl.checked_in_at
                }))
            };`;

content = content.replace(target2, replacement2);
fs.writeFileSync('app.js', content);
console.log("Done");
