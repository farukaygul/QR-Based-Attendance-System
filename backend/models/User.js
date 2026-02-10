const mongoose = require('mongoose');

const usersSchema = new mongoose.Schema({
  name: String,
  universityRollNo: {
    type: String,
    unique: true,
    required: [true, "Öğrenci numarası zorunludur"],
    match: [/^\d{9}$/, "Öğrenci numarası 9 haneli bir sayı olmalıdır"],
  },
  section: String,
  classRollNo: String,
  registeredAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', usersSchema);